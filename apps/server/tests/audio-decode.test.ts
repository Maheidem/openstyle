import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AudioDecodeError,
  buildFfmpegArgs,
  type DecodeDeps,
  decodeToWav16kMono,
  needsDecode,
} from "../src/lib/audio/decode.js";
import { parseWavHeader, wavHeader } from "../src/lib/audio/wav.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface WavOpts {
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
  formatTag?: number;
  samples?: number;
  listChunk?: boolean;
  streamSizes?: boolean;
}

function buildWav(opts: WavOpts = {}): Buffer {
  const sampleRate = opts.sampleRate ?? 16_000;
  const channels = opts.channels ?? 1;
  const bits = opts.bitsPerSample ?? 16;
  const blockAlign = (channels * bits) / 8;
  const samples = opts.samples ?? 160;
  const data = Buffer.alloc(samples * blockAlign);
  for (let i = 0; i + 1 < data.length; i += 2) data.writeInt16LE(i % 1000, i);

  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, "ascii");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(opts.formatTag ?? 1, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * blockAlign, 16);
  fmt.writeUInt16LE(blockAlign, 20);
  fmt.writeUInt16LE(bits, 22);

  let list = Buffer.alloc(0);
  if (opts.listChunk) {
    list = Buffer.alloc(12);
    list.write("LIST", 0, "ascii");
    list.writeUInt32LE(4, 4);
    list.write("INFO", 8, "ascii");
  }
  const dataHeader = Buffer.alloc(8);
  dataHeader.write("data", 0, "ascii");
  dataHeader.writeUInt32LE(opts.streamSizes ? 0xffffffff : data.length, 4);

  const body = Buffer.concat([fmt, list, dataHeader, data]);
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(opts.streamSizes ? 0xffffffff : 4 + body.length, 4);
  riff.write("WAVE", 8, "ascii");
  return Buffer.concat([riff, body]);
}

class FakeProc extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn((_signal?: NodeJS.Signals | number) => true);
}

interface SpawnRecord {
  file: string;
  args: string[];
  options: { stdio: unknown; windowsHide: boolean; cwd?: string };
  proc: FakeProc;
  /** Bytes of the temp input file, captured at spawn time. */
  inputBytes: Buffer;
  inputPath: string;
}

/**
 * Deps with a fake spawn. `script` runs after the process is handed back to
 * the module (next macrotask) so listeners are attached.
 */
function makeDeps(
  script: (proc: FakeProc, rec: SpawnRecord) => void | Promise<void>,
  overrides: Partial<DecodeDeps> = {},
) {
  const spawns: SpawnRecord[] = [];
  const tempDirs: string[] = [];
  const deps: DecodeDeps = {
    resolveBinaryPath: () => "/fake/bin/ffmpeg",
    makeTempDir: () => {
      const d = mkdtempSync(join(tmpdir(), "decode-test-"));
      tempDirs.push(d);
      return d;
    },
    spawn: ((file, args, options) => {
      const proc = new FakeProc();
      const inputPath = args[args.indexOf("-i") + 1];
      const rec: SpawnRecord = {
        file,
        args,
        options,
        proc,
        inputPath,
        inputBytes: readFileSync(inputPath),
      };
      spawns.push(rec);
      setImmediate(() => void script(proc, rec));
      return proc as unknown as ChildProcess;
    }) as DecodeDeps["spawn"],
    timeoutMs: 1000,
    maxOutputBytes: 1024 * 1024,
    ...overrides,
  };
  return { deps, spawns, tempDirs };
}

function succeed(bytes: Buffer, stderr = "") {
  return (proc: FakeProc) => {
    if (stderr) proc.stderr.write(stderr);
    proc.stdout.write(bytes);
    proc.stdout.end();
    proc.stderr.end();
    setImmediate(() => proc.emit("close", 0, null));
  };
}

async function expectDecodeError(
  p: Promise<unknown>,
): Promise<AudioDecodeError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(AudioDecodeError);
    return err as AudioDecodeError;
  }
  throw new Error("expected decodeToWav16kMono to reject");
}

// ---------------------------------------------------------------------------
// needsDecode
// ---------------------------------------------------------------------------

describe("needsDecode", () => {
  it("is false for a canonical 16 kHz mono PCM16 WAV", () => {
    expect(needsDecode(buildWav())).toBe(false);
  });

  it.each([
    [
      "16k mono PCM with a LIST chunk before data",
      buildWav({ listChunk: true }),
    ],
    ["16k mono PCM with 0xFFFFFFFF sizes", buildWav({ streamSizes: true })],
    [
      "16k mono PCM with trailing garbage",
      Buffer.concat([buildWav(), Buffer.alloc(7)]),
    ],
    ["44.1k stereo", buildWav({ sampleRate: 44_100, channels: 2 })],
    ["16k stereo", buildWav({ channels: 2 })],
    ["48k mono", buildWav({ sampleRate: 48_000 })],
    ["24-bit", buildWav({ bitsPerSample: 24 })],
    ["8-bit", buildWav({ bitsPerSample: 8 })],
    ["float tag", buildWav({ formatTag: 3 })],
    ["extensible tag", buildWav({ formatTag: 0xfffe })],
    [
      "ID3 (mp3)",
      Buffer.concat([Buffer.from("ID3\x04\x00"), Buffer.alloc(64)]),
    ],
    [
      "ftyp (m4a)",
      Buffer.concat([
        Buffer.from([0, 0, 0, 0x20]),
        Buffer.from("ftypM4A "),
        Buffer.alloc(64),
      ]),
    ],
    ["truncated header", buildWav().subarray(0, 30)],
    ["empty", new Uint8Array(0)],
  ])("is true for %s", (_name, bytes) => {
    expect(needsDecode(bytes)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildFfmpegArgs
// ---------------------------------------------------------------------------

describe("buildFfmpegArgs", () => {
  it("produces the exact argv", () => {
    expect(buildFfmpegArgs("/tmp/x/input")).toEqual([
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-i",
      "/tmp/x/input",
      "-map",
      "0:a:0",
      "-vn",
      "-sn",
      "-dn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      "-map_metadata",
      "-1",
      "-f",
      "wav",
      "pipe:1",
    ]);
  });
});

// ---------------------------------------------------------------------------
// decodeToWav16kMono
// ---------------------------------------------------------------------------

describe("decodeToWav16kMono", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  it("writes the input to a temp file, spawns ffmpeg with the exact argv, and cleans up", async () => {
    const input = Buffer.from("not really audio, ffmpeg is faked");
    const out = buildWav({ samples: 320 });
    const { deps, spawns, tempDirs } = makeDeps(succeed(out));

    await decodeToWav16kMono(input, deps);

    expect(spawns).toHaveLength(1);
    const rec = spawns[0];
    expect(rec.file).toBe("/fake/bin/ffmpeg");
    expect(rec.args).toEqual(buildFfmpegArgs(rec.inputPath));
    expect(rec.inputPath.startsWith(tempDirs[0])).toBe(true);
    expect(rec.inputBytes.equals(input)).toBe(true);
    expect(rec.options).toEqual({
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      cwd: "/fake/bin",
    });
    expect(existsSync(tempDirs[0])).toBe(false);
  });

  it("rewrites a streamed (LIST + 0xFFFFFFFF) WAV to a canonical 44-byte header", async () => {
    const out = buildWav({ samples: 1600, listChunk: true, streamSizes: true });
    const { deps } = makeDeps(succeed(out));

    const result = Buffer.from(
      await decodeToWav16kMono(Buffer.alloc(10), deps),
    );

    expect(result.length).toBe(44 + 1600 * 2);
    expect(parseWavHeader(result)).toEqual({
      formatTag: 1,
      sampleRate: 16_000,
      channels: 1,
      bitsPerSample: 16,
      dataOffset: 44,
      dataLength: 3200,
    });
    // Header is byte-identical to wavHeader() and payload is untouched.
    const expectedHeader = wavHeader(
      { sampleRate: 16_000, channels: 1, bitsPerSample: 16 },
      3200,
    );
    expect(result.subarray(0, 44).equals(expectedHeader)).toBe(true);
    expect(result.subarray(44).equals(out.subarray(56))).toBe(true);
  });

  it("handles stdout arriving in many small chunks", async () => {
    const out = buildWav({ samples: 4000, streamSizes: true });
    const { deps } = makeDeps((proc) => {
      for (let i = 0; i < out.length; i += 777) {
        proc.stdout.write(out.subarray(i, i + 777));
      }
      proc.stdout.end();
      proc.stderr.end();
      setImmediate(() => proc.emit("close", 0, null));
    });
    const result = await decodeToWav16kMono(Buffer.alloc(10), deps);
    expect(result.length).toBe(44 + 8000);
  });

  it("maps a non-zero exit to decode_failed with exitCode and a 500-char stderr tail", async () => {
    const stderr = `${"x".repeat(900)}Invalid data found when processing input`;
    const { deps, tempDirs } = makeDeps((proc) => {
      proc.stderr.write(stderr);
      proc.stdout.end();
      proc.stderr.end();
      setImmediate(() => proc.emit("close", 1, null));
    });

    const err = await expectDecodeError(
      decodeToWav16kMono(Buffer.alloc(10), deps),
    );
    expect(err.code).toBe("AUDIO_DECODE_FAILED");
    expect(err.reason).toBe("decode_failed");
    expect(err.details.exitCode).toBe(1);
    expect(err.details.stderrTail).toHaveLength(500);
    expect(err.details.stderrTail).toBe(stderr.slice(-500));
    expect(err.message).toContain("Invalid data found");
    expect(existsSync(tempDirs[0])).toBe(false);
  });

  it("maps a header-only WAV (zero samples) to empty_output", async () => {
    const { deps } = makeDeps(succeed(buildWav({ samples: 0 })));
    const err = await expectDecodeError(
      decodeToWav16kMono(Buffer.alloc(10), deps),
    );
    expect(err.reason).toBe("empty_output");
  });

  it("maps a streamed header with no payload to empty_output", async () => {
    const { deps } = makeDeps(
      succeed(buildWav({ samples: 0, streamSizes: true })),
    );
    const err = await expectDecodeError(
      decodeToWav16kMono(Buffer.alloc(10), deps),
    );
    expect(err.reason).toBe("empty_output");
  });

  it("maps garbage stdout with exit 0 to decode_failed", async () => {
    const { deps } = makeDeps(succeed(Buffer.from("this is not a wav file")));
    const err = await expectDecodeError(
      decodeToWav16kMono(Buffer.alloc(10), deps),
    );
    expect(err.reason).toBe("decode_failed");
    expect(err.message).toContain("not a RIFF/WAVE file");
  });

  it("returns binary_missing without spawning or touching disk when no binary resolves", async () => {
    const { deps, spawns, tempDirs } = makeDeps(succeed(buildWav()), {
      resolveBinaryPath: () => null,
    });
    const err = await expectDecodeError(
      decodeToWav16kMono(Buffer.alloc(10), deps),
    );
    expect(err.reason).toBe("binary_missing");
    expect(spawns).toHaveLength(0);
    expect(tempDirs).toHaveLength(0);
  });

  it("maps a spawn ENOENT to binary_missing and cleans up", async () => {
    const { deps, tempDirs } = makeDeps((proc) => {
      const e = Object.assign(new Error("spawn ffmpeg ENOENT"), {
        code: "ENOENT",
      });
      proc.emit("error", e);
    });
    const err = await expectDecodeError(
      decodeToWav16kMono(Buffer.alloc(10), deps),
    );
    expect(err.reason).toBe("binary_missing");
    expect(existsSync(tempDirs[0])).toBe(false);
  });

  it("maps other spawn errors to decode_failed", async () => {
    const { deps } = makeDeps((proc) => {
      proc.emit(
        "error",
        Object.assign(new Error("spawn EACCES"), { code: "EACCES" }),
      );
    });
    const err = await expectDecodeError(
      decodeToWav16kMono(Buffer.alloc(10), deps),
    );
    expect(err.reason).toBe("decode_failed");
  });

  it("times out: SIGKILL, temp dir removed, later close does not double-settle", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    let hung: FakeProc | null = null;
    const { deps, tempDirs } = makeDeps(
      (proc) => {
        hung = proc;
        proc.stderr.write("still working");
      },
      { timeoutMs: 5000 },
    );

    const p = decodeToWav16kMono(Buffer.alloc(10), deps);
    const caught = expectDecodeError(p);
    // Let the spawn script + stderr listeners run, then fire the timer.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);

    const err = await caught;
    expect(err.reason).toBe("timeout");
    expect(err.details.stderrTail).toBe("still working");
    expect(hung).not.toBeNull();
    expect(hung!.kill).toHaveBeenCalledWith("SIGKILL");
    expect(existsSync(tempDirs[0])).toBe(false);

    // The kill eventually produces a close; it must be a no-op.
    hung!.emit("close", null, "SIGKILL");
    await vi.advanceTimersByTimeAsync(0);
    expect(err.reason).toBe("timeout");
  });

  it("kills ffmpeg and fails with decode_failed when the output cap is exceeded", async () => {
    let proc: FakeProc | null = null;
    const { deps, tempDirs } = makeDeps(
      (p) => {
        proc = p;
        p.stdout.write(Buffer.alloc(600));
        p.stdout.write(Buffer.alloc(600));
      },
      { maxOutputBytes: 1000 },
    );
    const err = await expectDecodeError(
      decodeToWav16kMono(Buffer.alloc(10), deps),
    );
    expect(err.reason).toBe("decode_failed");
    expect(err.message).toContain("exceeds 1000 bytes");
    expect(proc!.kill).toHaveBeenCalledWith("SIGKILL");
    expect(existsSync(tempDirs[0])).toBe(false);
  });

  it("leaves no temp dirs behind across runs", async () => {
    const base = mkdtempSync(join(tmpdir(), "decode-root-"));
    const { deps } = makeDeps(succeed(buildWav()), {
      makeTempDir: () => mkdtempSync(join(base, "d-")),
    });
    try {
      await decodeToWav16kMono(Buffer.alloc(10), deps);
      await decodeToWav16kMono(Buffer.alloc(10), deps);
      expect(readdirSync(base)).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
