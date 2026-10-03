/**
 * Opt-in integration test against a real ffmpeg binary.
 *
 * vitest runs with cwd = apps/server, so the bundled
 * `resources/bin/<platform>-<arch>/ffmpeg` never resolves here; point
 * `OPENSTYLE_FFMPEG_PATH` at a binary to run these.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import {
  AudioDecodeError,
  createDefaultDecodeDeps,
  type DecodeDeps,
  decodeFileToWav16kMono,
  getFfmpegBinaryPath,
} from "../src/lib/audio/decode.js";
import { parseWavHeader, wavDurationMs } from "../src/lib/audio/wav.js";

const envPath = process.env.OPENSTYLE_FFMPEG_PATH;
const bin =
  envPath && existsSync(envPath) ? envPath : (getFfmpegBinaryPath() ?? null);

const TEST_TIMEOUT = 30_000;

function deps(): DecodeDeps {
  return { ...createDefaultDecodeDeps(), resolveBinaryPath: () => bin };
}

/** Fresh temp paths. The dir is removed when the calling test ends. */
function freshPaths(): { input: string; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "decode-ffmpeg-test-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return {
    input: join(dir, "input"),
    output: join(dir, "out.wav"),
  };
}

/** Sine-wave PCM WAV. */
function sineWav(opts: {
  sampleRate: number;
  channels: number;
  bitsPerSample: 8 | 16;
  durationMs: number;
  amplitude?: number;
}): Buffer {
  const { sampleRate, channels, bitsPerSample, durationMs } = opts;
  const amplitude = opts.amplitude ?? 0.5;
  const frames = Math.round((durationMs / 1000) * sampleRate);
  const blockAlign = (channels * bitsPerSample) / 8;
  const data = Buffer.alloc(frames * blockAlign);
  for (let i = 0; i < frames; i++) {
    const v = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * amplitude;
    for (let c = 0; c < channels; c++) {
      const at = (i * channels + c) * (bitsPerSample / 8);
      if (bitsPerSample === 16) data.writeInt16LE(Math.round(v * 32767), at);
      else data.writeUInt8(Math.round(128 + v * 127), at);
    }
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * blockAlign, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bitsPerSample, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Await a promise that must reject with an AudioDecodeError; return it. */
async function decodeError(p: Promise<unknown>): Promise<AudioDecodeError> {
  const caught = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(caught).toBeInstanceOf(AudioDecodeError);
  return caught as AudioDecodeError;
}

function rms(wav: Buffer): number {
  const info = parseWavHeader(wav);
  const n = info.dataLength / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = wav.readInt16LE(info.dataOffset + i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / Math.max(1, n));
}

const suite = bin ? describe : describe.skip;

suite(`decodeFileToWav16kMono (real ffmpeg: ${bin ?? "none found"})`, () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  it(
    "resamples 44.1k stereo to a canonical 16k mono PCM16 file with matching duration",
    async () => {
      const { input, output } = freshPaths();
      writeFileSync(
        input,
        sineWav({
          sampleRate: 44_100,
          channels: 2,
          bitsPerSample: 16,
          durationMs: 1500,
        }),
      );
      const r = await decodeFileToWav16kMono(input, output, deps());
      const out = readFileSync(output);
      expect(r.bytes).toBe(out.length);
      const info = parseWavHeader(out);
      expect(info).toMatchObject({
        formatTag: 1,
        sampleRate: 16_000,
        channels: 1,
        bitsPerSample: 16,
        // bitexact + seekable output: canonical straight from the muxer.
        dataOffset: 44,
      });
      expect(out.length).toBe(44 + info.dataLength);
      expect(Math.abs(wavDurationMs(info) - 1500)).toBeLessThanOrEqual(10);
      expect(rms(out)).toBeGreaterThan(1000);
    },
    TEST_TIMEOUT,
  );

  it(
    "upsamples 8k mono 8-bit to 16k mono PCM16",
    async () => {
      const { input, output } = freshPaths();
      writeFileSync(
        input,
        sineWav({
          sampleRate: 8_000,
          channels: 1,
          bitsPerSample: 8,
          durationMs: 1500,
        }),
      );
      await decodeFileToWav16kMono(input, output, deps());
      const info = parseWavHeader(readFileSync(output));
      expect(info).toMatchObject({
        formatTag: 1,
        sampleRate: 16_000,
        channels: 1,
        bitsPerSample: 16,
      });
      expect(Math.abs(wavDurationMs(info) - 1500)).toBeLessThanOrEqual(10);
      expect(rms(readFileSync(output))).toBeGreaterThan(1000);
    },
    TEST_TIMEOUT,
  );

  it(
    "rejects corrupt bytes with decode_failed and ffmpeg's stderr",
    async () => {
      const { input, output } = freshPaths();
      const junk = Buffer.alloc(4096);
      for (let i = 0; i < junk.length; i++) junk[i] = (i * 7919) & 0xff;
      writeFileSync(input, junk);
      const err = await decodeError(
        decodeFileToWav16kMono(input, output, deps()),
      );
      expect(err.reason).toBe("decode_failed");
      expect(err.details.exitCode).not.toBe(0);
      expect(err.details.stderrTail).toMatch(/Invalid data/);
    },
    TEST_TIMEOUT,
  );

  it(
    "rejects a zero-sample WAV with empty_output",
    async () => {
      const { input, output } = freshPaths();
      writeFileSync(
        input,
        sineWav({
          sampleRate: 44_100,
          channels: 2,
          bitsPerSample: 16,
          durationMs: 0,
        }),
      );
      const err = await decodeError(
        decodeFileToWav16kMono(input, output, deps()),
      );
      expect(err.reason).toBe("empty_output");
    },
    TEST_TIMEOUT,
  );
});
