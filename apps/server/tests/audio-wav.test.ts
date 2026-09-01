import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  parseWavHeader,
  sliceWav,
  type WavInfo,
  wavDurationMs,
  wavHeader,
} from "../src/lib/audio/wav.js";

const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface BuildOpts {
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
  formatTag?: number;
  samples?: number;
  listChunk?: boolean;
  /** Override the `data` chunk size field (e.g. 0xFFFFFFFF). */
  declaredDataSize?: number;
  /** Override the RIFF size field. */
  declaredRiffSize?: number;
}

/** Build an in-memory WAV with a ramp payload; mirrors meeting-transcriber's writeWav. */
function buildWav(opts: BuildOpts = {}): Buffer {
  const sampleRate = opts.sampleRate ?? 16_000;
  const channels = opts.channels ?? 1;
  const bits = opts.bitsPerSample ?? 16;
  const formatTag = opts.formatTag ?? 1;
  const samples = opts.samples ?? 160;
  const blockAlign = (channels * bits) / 8;
  const dataBytes = samples * blockAlign;

  const data = Buffer.alloc(dataBytes);
  if (bits === 16) {
    for (let i = 0; i < dataBytes / 2; i++) {
      data.writeInt16LE(i % 32768, i * 2);
    }
  }

  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, "ascii");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(formatTag, 8);
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
  dataHeader.writeUInt32LE(opts.declaredDataSize ?? dataBytes, 4);

  const body = Buffer.concat([fmt, list, dataHeader, data]);
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(opts.declaredRiffSize ?? 4 + body.length, 4);
  riff.write("WAVE", 8, "ascii");
  return Buffer.concat([riff, body]);
}

function withFd<T>(bytes: Buffer, fn: (fd: number) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "audio-wav-test-"));
  dirs.push(dir);
  const path = join(dir, "t.wav");
  writeFileSync(path, bytes);
  const fd = openSync(path, "r");
  try {
    return fn(fd);
  } finally {
    closeSync(fd);
  }
}

/** Run the parser against both sources and assert they agree. */
function parseBoth(bytes: Buffer): WavInfo {
  const fromBuf = parseWavHeader(bytes);
  const fromFd = withFd(bytes, (fd) => parseWavHeader(fd));
  expect(fromFd).toEqual(fromBuf);
  return fromBuf;
}

describe("parseWavHeader", () => {
  it("parses a canonical 44-byte header identically from fd and buffer", () => {
    const info = parseBoth(buildWav({ samples: 160 }));
    expect(info).toEqual({
      formatTag: 1,
      sampleRate: 16_000,
      channels: 1,
      bitsPerSample: 16,
      dataOffset: 44,
      dataLength: 320,
    });
  });

  it("walks past a LIST chunk (dataOffset 56) from fd and buffer", () => {
    const info = parseBoth(buildWav({ samples: 160, listChunk: true }));
    expect(info.dataOffset).toBe(56);
    expect(info.dataLength).toBe(320);
  });

  it("accepts a Uint8Array view with a non-zero byteOffset", () => {
    const wav = buildWav({ samples: 10 });
    const padded = Buffer.concat([Buffer.alloc(7), wav]);
    const view = new Uint8Array(
      padded.buffer,
      padded.byteOffset + 7,
      wav.length,
    );
    expect(parseWavHeader(view)).toEqual(parseWavHeader(wav));
  });

  it("clamps 0xFFFFFFFF stream sizes to the bytes present", () => {
    const info = parseBoth(
      buildWav({
        samples: 100,
        declaredDataSize: 0xffffffff,
        declaredRiffSize: 0xffffffff,
      }),
    );
    expect(info.dataLength).toBe(200);
  });

  it("clamps the data length of a truncated file", () => {
    const full = buildWav({ samples: 1000 });
    const truncated = full.subarray(0, 44 + 500);
    const info = parseBoth(Buffer.from(truncated));
    expect(info.dataLength).toBe(500);
  });

  it("returns dataLength 0 (not negative) when the file ends at the data header", () => {
    const full = buildWav({ samples: 1000 });
    const info = parseBoth(Buffer.from(full.subarray(0, 44)));
    expect(info.dataLength).toBe(0);
  });

  it("reports formatTag for float and extensible WAVs", () => {
    expect(parseBoth(buildWav({ formatTag: 3 })).formatTag).toBe(3);
    expect(parseBoth(buildWav({ formatTag: 0xfffe })).formatTag).toBe(0xfffe);
  });

  it("reports sampleRate/channels/bits for a 44.1k stereo file", () => {
    const info = parseBoth(
      buildWav({ sampleRate: 44_100, channels: 2, samples: 441 }),
    );
    expect(info.sampleRate).toBe(44_100);
    expect(info.channels).toBe(2);
    expect(info.dataLength).toBe(441 * 4);
  });

  it("keeps the existing error messages", () => {
    const short = Buffer.from("RIFF");
    expect(() => parseWavHeader(short)).toThrow(
      "WAV too short for RIFF header",
    );
    expect(() => withFd(short, (fd) => parseWavHeader(fd))).toThrow(
      "WAV too short for RIFF header",
    );

    const notRiff = Buffer.alloc(64);
    notRiff.write("ID3\x03", 0, "ascii");
    expect(() => parseWavHeader(notRiff)).toThrow("not a RIFF/WAVE file");
    expect(() => withFd(notRiff, (fd) => parseWavHeader(fd))).toThrow(
      "not a RIFF/WAVE file",
    );

    // data before fmt
    const wav = buildWav({ samples: 4 });
    const dataFirst = Buffer.concat([
      wav.subarray(0, 12),
      wav.subarray(36, 44),
      wav.subarray(44),
      wav.subarray(12, 36),
    ]);
    expect(() => parseWavHeader(dataFirst)).toThrow(
      "WAV data chunk before fmt chunk",
    );

    // fmt only, no data chunk
    const noData = wav.subarray(0, 36);
    expect(() => parseWavHeader(noData)).toThrow("WAV data chunk not found");
    expect(() =>
      withFd(Buffer.from(noData), (fd) => parseWavHeader(fd)),
    ).toThrow("WAV data chunk not found");

    expect(() => parseWavHeader(new Uint8Array(0))).toThrow(
      "WAV too short for RIFF header",
    );
  });
});

describe("wavDurationMs", () => {
  const base = { formatTag: 1, dataOffset: 44 };
  it("computes duration from dataLength and byte rate", () => {
    expect(
      wavDurationMs({
        ...base,
        sampleRate: 16_000,
        channels: 1,
        bitsPerSample: 16,
        dataLength: 32_000,
      }),
    ).toBe(1000);
    expect(
      wavDurationMs({
        ...base,
        sampleRate: 44_100,
        channels: 2,
        bitsPerSample: 16,
        dataLength: 44_100 * 4 * 1.5,
      }),
    ).toBe(1500);
  });

  it("is 0 for an empty data chunk", () => {
    expect(
      wavDurationMs({
        ...base,
        sampleRate: 16_000,
        channels: 1,
        bitsPerSample: 16,
        dataLength: 0,
      }),
    ).toBe(0);
  });

  it("is 0 (not NaN/Infinity) when the byte rate is 0", () => {
    expect(
      wavDurationMs({
        ...base,
        sampleRate: 0,
        channels: 0,
        bitsPerSample: 0,
        dataLength: 1234,
      }),
    ).toBe(0);
  });
});

describe("wavHeader", () => {
  it("round-trips through parseWavHeader", () => {
    const header = wavHeader(
      { sampleRate: 16_000, channels: 1, bitsPerSample: 16 },
      32_000,
    );
    expect(header.length).toBe(44);
    const bytes = Buffer.concat([header, Buffer.alloc(32_000)]);
    expect(parseWavHeader(bytes)).toEqual({
      formatTag: 1,
      sampleRate: 16_000,
      channels: 1,
      bitsPerSample: 16,
      dataOffset: 44,
      dataLength: 32_000,
    });
    expect(header.readUInt32LE(4)).toBe(36 + 32_000);
    expect(header.readUInt32LE(28)).toBe(32_000); // byte rate
    expect(header.readUInt16LE(32)).toBe(2); // block align
  });
});

describe("sliceWav", () => {
  it("slices the requested window using the clamped data length", () => {
    const wav = buildWav({ samples: 16_000, declaredDataSize: 0xffffffff });
    withFd(wav, (fd) => {
      const info = parseWavHeader(fd);
      const out = Buffer.from(sliceWav(fd, info, 250, 500));
      expect(out.length).toBe(44 + 4000 * 2);
      expect(out.readInt16LE(44)).toBe(4000);
      // Past-the-end window clamps to what exists.
      const tailSlice = sliceWav(fd, info, 900, 5000);
      expect(tailSlice.length).toBe(44 + (16_000 - 14_400) * 2);
    });
  });
});
