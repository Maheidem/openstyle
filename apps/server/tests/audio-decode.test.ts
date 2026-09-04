import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AudioDecodeError,
  buildFfmpegArgs,
  type DecodeDeps,
  decodeFileToWav16kMono,
  needsDecode,
  needsDecodeFile,
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
  stderr = new PassThrough();
  kill = vi.fn((_signal?: NodeJS.Signals | number) => true);
}

interface SpawnRecord {
  file: string;
  args: string[];
  options: { stdio: unknown; windowsHide: boolean; cwd?: string };
  proc: FakeProc;
  inputPath: string;
  outputPath: string;
}

/**
 * Deps with a fake spawn. `script` runs on the next macrotask so listeners
 * are attached; it writes whatever it wants to the output path (last argv
 * element) and closes the fake process.
 */
function makeDeps(
  script: (proc: FakeProc, rec: SpawnRecord) => void | Promise<void>,
  overrides: Partial<DecodeDeps> = {},
) {
  const spawns: SpawnRecord[] = [];
  const deps: DecodeDeps = {
    resolveBinaryPath: () => "/fake/bin/ffmpeg",
    spawn: ((file, args, options) => {
      const proc = new FakeProc();
      const rec: SpawnRecord = {
        file,
        args,
        options,
        proc,
        inputPath: args[args.indexOf("-i") + 1],
        outputPath: args[args.length - 1],
      };
      spawns.push(rec);
      setImmediate(() => void script(proc, rec));
      return proc as unknown as ChildProcess;
    }) as DecodeDeps["spawn"],
    timeoutMs: 1000,
    maxOutputBytes: 1024 * 1024,
    pollIntervalMs: 10_000, // off by default; the cap tests opt in
    ...overrides,
  };
  return { deps, spawns };
}

/** Decode into a fresh temp dir; returns the paths used. */
function freshPaths() {
  const dir = mkdtempSync(join(tmpdir(), "decode-test-"));
  return {
    dir,
    input: join(dir, "input"),
    output: join(dir, "out.wav"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function succeed(bytes: Buffer, stderr = "") {
  return (proc: FakeProc, rec: SpawnRecord) => {
    if (stderr) proc.stderr.write(stderr);
    writeFileSync(rec.outputPath, bytes);
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
  throw new Error("expected decodeFileToWav16kMono to reject");
}

function fileSize(path: string): number {
  const fd = openSync(path, "r");
  try {
    return fstatSync(fd).size;
  } finally {
    closeSync(fd);
  }
}

function readAll(path: string): Buffer {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const b = Buffer.alloc(size);
    readSync(fd, b, 0, size, 0);
    return b;
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// needsDecode / needsDecodeFile
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

describe("needsDecodeFile", () => {
  it("agrees with needsDecode on the same bytes", async () => {
    const { dir, input, cleanup } = freshPaths();
    try {
      const cases = [
        buildWav(),
        buildWav({ listChunk: true }),
        buildWav({ streamSizes: true }),
        buildWav({ sampleRate: 44_100, channels: 2 }),
        Buffer.concat([Buffer.from("ID3\x04"), Buffer.alloc(64)]),
      ];
      for (const bytes of cases) {
        writeFileSync(input, bytes);
        expect(needsDecodeFile(input)).toBe(needsDecode(bytes));
      }
      expect(needsDecodeFile(join(dir, "missing-file"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("is true for trailing garbage after an otherwise-canonical WAV", () => {
    const { input, cleanup } = freshPaths();
    try {
      writeFileSync(input, Buffer.concat([buildWav(), Buffer.alloc(7)]));
      expect(needsDecodeFile(input)).toBe(true);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// buildFfmpegArgs
// ---------------------------------------------------------------------------

describe("buildFfmpegArgs", () => {
  it("produces the exact argv (file in, file out, bitexact)", () => {
    expect(buildFfmpegArgs("/tmp/x/input", "/tmp/y/out.wav")).toEqual([
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
      "-fflags",
      "+bitexact",
      "-f",
      "wav",
      "/tmp/y/out.wav",
    ]);
  });
});

// ---------------------------------------------------------------------------
// decodeFileToWav16kMono
// ---------------------------------------------------------------------------

describe("decodeFileToWav16kMono", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  it("spawns ffmpeg with the exact argv against the caller's paths", async () => {
    const { input, output, cleanup } = freshPaths();
    writeFileSync(input, "not really audio, ffmpeg is faked");
    const out = buildWav({ samples: 320 });
    const { deps, spawns } = makeDeps(succeed(out));
    try {
      const r = await decodeFileToWav16kMono(input, output, deps);
      expect(r.bytes).toBe(out.length);

      expect(spawns).toHaveLength(1);
      const rec = spawns[0];
      expect(rec.file).toBe("/fake/bin/ffmpeg");
      expect(rec.args).toEqual(buildFfmpegArgs(input, output));
      expect(rec.options).toEqual({
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
        cwd: "/fake/bin",
      });
      // Pass-through: a canonical output is left byte-identical.
      expect(readAll(output).equals(out)).toBe(true);
      expect(existsSync(`${output}.canonical`)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("rewrites a streamed (LIST + 0xFFFFFFFF) WAV to a canonical 44-byte header", async () => {
    const { input, output, cleanup } = freshPaths();
    writeFileSync(input, Buffer.alloc(10));
    const out = buildWav({ samples: 1600, listChunk: true, streamSizes: true });
    const { deps } = makeDeps(succeed(out));
    try {
      const r = await decodeFileToWav16kMono(input, output, deps);

      expect(r.bytes).toBe(44 + 1600 * 2);
      const result = readAll(output);
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
      expect(existsSync(`${output}.canonical`)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("canonicalizes a multi-MiB output without buffering it (file size preserved)", async () => {
    const { input, output, cleanup } = freshPaths();
    writeFileSync(input, Buffer.alloc(10));
    const { deps } = makeDeps(
      succeed(buildWav({ samples: 1_000_000, streamSizes: true })),
      { maxOutputBytes: 64 * 1024 * 1024 },
    );
    try {
      const r = await decodeFileToWav16kMono(input, output, deps);
      expect(r.bytes).toBe(44 + 2_000_000);
      expect(fileSize(output)).toBe(44 + 2_000_000);
      expect(parseWavHeader(readAll(output)).dataOffset).toBe(44);
    } finally {
      cleanup();
    }
  });

  it("maps a non-zero exit to decode_failed with exitCode and a 500-char stderr tail", async () => {
    const { input, output, cleanup } = freshPaths();
    writeFileSync(input, Buffer.alloc(10));
    const stderr = `${"x".repeat(900)}Invalid data found when processing input`;
    const { deps } = makeDeps((proc) => {
      proc.stderr.write(stderr);
      proc.stderr.end();
      setImmediate(() => proc.emit("close", 1, null));
    });
    try {
      const err = await expectDecodeError(
        decodeFileToWav16kMono(input, output, deps),
      );
      expect(err.code).toBe("AUDIO_DECODE_FAILED");
      expect(err.reason).toBe("decode_failed");
      expect(err.details.exitCode).toBe(1);
      expect(err.details.stderrTail).toHaveLength(500);
      expect(err.details.stderrTail).toBe(stderr.slice(-500));
      expect(err.message).toContain("Invalid data found");
    } finally {
      cleanup();
    }
  });

  it("redacts the output dir path from the message and stderr tail", async () => {
    const { dir, input, output, cleanup } = freshPaths();
    writeFileSync(input, Buffer.alloc(10));
    const { deps } = makeDeps((proc, rec) => {
      proc.stderr.write(`${rec.outputPath}: Invalid data found`);
      proc.stderr.end();
      setImmediate(() => proc.emit("close", 1, null));
    });
    try {
      const err = await expectDecodeError(
        decodeFileToWav16kMono(input, output, deps),
      );
      expect(err.message).not.toContain(dir);
      expect(err.details.stderrTail).not.toContain(dir);
      expect(err.details.stderrTail).toBe("<tmp>/out.wav: Invalid data found");
      expect(err.message).toContain("<tmp>/out.wav: Invalid data found");
    } finally {
      cleanup();
    }
  });

  it("maps a header-only WAV (zero samples) to empty_output", async () => {
    const { input, output, cleanup } = freshPaths();
    writeFileSync(input, Buffer.alloc(10));
    const { deps } = makeDeps(succeed(buildWav({ samples: 0 })));
    try {
      const err = await expectDecodeError(
        decodeFileToWav16kMono(input, output, deps),
      );
      expect(err.reason).toBe("empty_output");
    } finally {
      cleanup();
    }
  });

  it("maps a streamed header with no payload to empty_output", async () => {
    const { input, output, cleanup } = freshPaths();
    writeFileSync(input, Buffer.alloc(10));
    const { deps } = makeDeps(
      succeed(buildWav({ samples: 0, streamSizes: true })),
    );
    try {
      const err = await expectDecodeError(
        decodeFileToWav16kMono(input, output, deps),
      );
      expect(err.reason).toBe("empty_output");
    } finally {
      cleanup();
    }
  });

  it("maps a garbage output with exit 0 to decode_failed", async () => {
    const { input, output, cleanup } = freshPaths();
    writeFileSync(input, Buffer.alloc(10));
    const { deps } = makeDeps(succeed(Buffer.from("this is not a wav file")));
    try {
      const err = await expectDecodeError(
        decodeFileToWav16kMono(input, output, deps),
      );
      expect(err.reason).toBe("decode_failed");
      expect(err.message).toContain("not a RIFF/WAVE file");
    } finally {
      cleanup();
    }
  });

  it("returns binary_missing without spawning when no binary resolves", async () => {
    const { input, output, cleanup } = freshPaths();
    writeFileSync(input, Buffer.alloc(10));
    const { deps, spawns } = makeDeps(succeed(buildWav()), {
      resolveBinaryPath: () => null,
    });
    try {
      const err = await expectDecodeError(
        decodeFileToWav16kMono(input, output, deps),
      );
      expect(err.reason).toBe("binary_missing");
      expect(spawns).toHaveLength(0);
      expect(existsSync(output)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("maps a spawn ENOENT to binary_missing", async () => {
    const { input, output, cleanup } = freshPaths();
    writeFileSync(input, Buffer.alloc(10));
    const { deps } = makeDeps((proc) => {
      proc.emit(
        "error",
        Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" }),
      );
    });
    try {
      const err = await expectDecodeError(
        decodeFileToWav16kMono(input, output, deps),
      );
      expect(err.reason).toBe("binary_missing");
    } finally {
      cleanup();
    }
  });

  it("maps other spawn errors to decode_failed", async () => {
    const { input, output, cleanup } = freshPaths();
    writeFileSync(input, Buffer.alloc(10));
    const { deps } = makeDeps((proc) => {
      proc.emit(
        "error",
        Object.assign(new Error("spawn EACCES"), { code: "EACCES" }),
      );
    });
    try {
      const err = await expectDecodeError(
        decodeFileToWav16kMono(input, output, deps),
      );
      expect(err.reason).toBe("decode_failed");
    } finally {
      cleanup();
    }
  });

  it("times out: SIGKILL, later close does not double-settle", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const { input, output, cleanup } = freshPaths();
    writeFileSync(input, Buffer.alloc(10));
    let hung: FakeProc | null = null;
    const { deps } = makeDeps(
      (proc) => {
        hung = proc;
        proc.stderr.write("still working");
      },
      { timeoutMs: 5000, pollIntervalMs: 10_000 },
    );

    const p = decodeFileToWav16kMono(input, output, deps);
    const caught = expectDecodeError(p);
    // Let the spawn script + stderr listeners run, then fire the timer.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);

    const err = await caught;
    expect(err.reason).toBe("timeout");
    expect(err.details.stderrTail).toBe("still working");
    expect(hung).not.toBeNull();
    expect(hung!.kill).toHaveBeenCalledWith("SIGKILL");

    // The kill eventually produces a close; it must be a no-op.
    hung!.emit("close", null, "SIGKILL");
    await vi.advanceTimersByTimeAsync(0);
    expect(err.reason).toBe("timeout");
    cleanup();
  });

  it("kills ffmpeg mid-run when the output file passes the size cap (poller)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const { input, output, cleanup } = freshPaths();
    writeFileSync(input, Buffer.alloc(10));
    let proc: FakeProc | null = null;
    const { deps } = makeDeps(
      (p, rec) => {
        proc = p;
        // Oversized output, but ffmpeg "never exits" — only the poller
        // can cut it short.
        writeFileSync(
          rec.outputPath,
          Buffer.concat([buildWav({ samples: 600 }), Buffer.alloc(16)]),
        );
        p.stderr.write("still writing");
      },
      { maxOutputBytes: 1000, pollIntervalMs: 100, timeoutMs: 60_000 },
    );

    const p = decodeFileToWav16kMono(input, output, deps);
    const caught = expectDecodeError(p);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);
    const err = await caught;
    expect(err.reason).toBe("decode_failed");
    expect(err.message).toContain("exceeds 1000 bytes");
    expect(proc!.kill).toHaveBeenCalledWith("SIGKILL");
    cleanup();
  });

  it("fails with decode_failed when a finished output exceeds the cap (final check)", async () => {
    const { input, output, cleanup } = freshPaths();
    writeFileSync(input, Buffer.alloc(10));
    const { deps } = makeDeps(succeed(buildWav({ samples: 600 })), {
      maxOutputBytes: 1000,
      pollIntervalMs: 10_000,
    });
    try {
      const err = await expectDecodeError(
        decodeFileToWav16kMono(input, output, deps),
      );
      expect(err.reason).toBe("decode_failed");
      expect(err.message).toContain("exceeds 1000 bytes");
    } finally {
      cleanup();
    }
  });

  it("leaves no .canonical siblings behind across runs", async () => {
    const base = mkdtempSync(join(tmpdir(), "decode-root-"));
    const { deps } = makeDeps(succeed(buildWav({ streamSizes: true })));
    try {
      for (let i = 0; i < 2; i++) {
        const input = join(base, `in${i}`);
        const output = join(base, `out${i}.wav`);
        writeFileSync(input, Buffer.alloc(10));
        await decodeFileToWav16kMono(input, output, deps);
      }
      expect(readdirSync(base).filter((f) => f.endsWith(".canonical"))).toEqual(
        [],
      );
      // Only the two inputs + two outputs remain.
      expect(readdirSync(base).sort()).toEqual([
        "in0",
        "in1",
        "out0.wav",
        "out1.wav",
      ]);
      unlinkSync(join(base, "out0.wav"));
      unlinkSync(join(base, "out1.wav"));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
