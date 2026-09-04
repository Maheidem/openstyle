/**
 * ffmpeg decode/normalize helper: any accepted audio/video container →
 * 16 kHz mono PCM16 WAV, via the bundled ffmpeg binary.
 *
 * Every clip handed to a `TranscriptionProvider` must already be 16 kHz mono
 * WAV (that is what the renderer produces for dictation and meetings). Imported
 * files are normalized here, on the server, *before* any provider call, so no
 * provider needs per-format branching (spec decision `dec_85b72ede`).
 *
 * File-to-file (specs/import-streaming.md): the input is an on-disk upload and
 * the output a caller-provided temp path — nothing is collected from ffmpeg's
 * stdout, so decoding adds only bounded chunks to RSS regardless of file
 * size. Writing to a seekable output (instead of `pipe:1`) also lets ffmpeg
 * emit real chunk sizes; `-fflags +bitexact` suppresses its `LIST INFO ISFT`
 * chunk, so the common case is a canonical 44-byte-header WAV straight from
 * the muxer. A defensive streaming canonicalizer covers non-canonical output.
 *
 * Only the first audio track is decoded (`-map 0:a:0`); a video-only or
 * audio-less input is a deterministic ffmpeg failure, surfaced as
 * `decode_failed`.
 *
 * Nothing in here imports Hono, routes, the DB, or electron.
 */

import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  renameSync,
  statSync,
} from "node:fs";
import { type FileHandle, open, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  parseWavHeader,
  type WavInfo,
  wavDurationMs,
  wavHeader,
} from "./wav.js";

export type AudioDecodeReason =
  | "binary_missing"
  | "decode_failed"
  | "empty_output"
  | "timeout";

export interface AudioDecodeErrorDetails {
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stderrTail?: string;
}

/**
 * Decode-specific failure, distinct from an STT-provider failure so the route
 * can answer with its own status/code (`fr_7827ac39`).
 */
export class AudioDecodeError extends Error {
  readonly code = "AUDIO_DECODE_FAILED";
  constructor(
    message: string,
    readonly reason: AudioDecodeReason,
    readonly details: AudioDecodeErrorDetails = {},
  ) {
    super(message);
    this.name = "AudioDecodeError";
  }
}

export const TARGET_SAMPLE_RATE = 16_000;
export const TARGET_CHANNELS = 1;
export const TARGET_BITS_PER_SAMPLE = 16;
/** Wall-clock budget for one decode. A 1 GiB file is well under this. */
export const DECODE_TIMEOUT_MS = 10 * 60_000;
/** Hard cap on the decoded output file (1 GiB), enforced on file size. */
export const MAX_DECODED_BYTES = 1024 * 1024 * 1024;
/** How often the running decode's output size is checked against the cap. */
export const DECODE_POLL_INTERVAL_MS = 1_000;
/** How much of ffmpeg's stderr to keep in the error (whisper/server.ts convention). */
export const STDERR_TAIL_CHARS = 500;
/** Block size for the (defensive) streaming canonicalize pass. */
const CANONICALIZE_CHUNK_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// Binary path resolution
//
// Same candidate-list shape as `fluidAudioBinaryCandidates()` in
// lib/meetings/diarize.ts (see the long comment there): NOT a
// `resourcesPath ? packaged : dev` ternary, because `process.resourcesPath`
// is always defined under Electron — dev or packaged — so branching on it
// always picks the "packaged" path in `npm run dev`. Build every plausible
// location and take the first that exists on disk.
// ---------------------------------------------------------------------------

function ffmpegBinaryCandidates(): string[] {
  const name = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const proc = process as NodeJS.Process & { resourcesPath?: string };
  const candidates: string[] = [];
  if (proc.resourcesPath) {
    candidates.push(join(proc.resourcesPath, "bin", name));
  }
  candidates.push(
    join(
      process.cwd(),
      "resources",
      "bin",
      `${process.platform}-${process.arch}`,
      name,
    ),
  );
  return candidates;
}

export function getFfmpegBinaryPath(): string | null {
  return ffmpegBinaryCandidates().find(existsSync) ?? null;
}

// ---------------------------------------------------------------------------
// Dependency seam (same idea as DiarizeDeps in lib/meetings/diarize.ts)
// ---------------------------------------------------------------------------

export type SpawnFn = (
  file: string,
  args: string[],
  options: {
    stdio: ["ignore", "ignore", "pipe"];
    windowsHide: boolean;
    cwd?: string;
  },
) => ChildProcess;

export interface DecodeDeps {
  /** Resolve the bundled ffmpeg binary. Null = not bundled/found. */
  resolveBinaryPath: () => string | null;
  /** Spawn ffmpeg. Injected for tests. */
  spawn: SpawnFn;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Decoded-size poll interval (runaway-kill cadence). */
  pollIntervalMs: number;
}

export function createDefaultDecodeDeps(): DecodeDeps {
  return {
    resolveBinaryPath: getFfmpegBinaryPath,
    spawn: nodeSpawn as SpawnFn,
    timeoutMs: DECODE_TIMEOUT_MS,
    maxOutputBytes: MAX_DECODED_BYTES,
    pollIntervalMs: DECODE_POLL_INTERVAL_MS,
  };
}

/**
 * ffmpeg argv. Input and output are *file paths* (not pipes): MP4/M4A with a
 * trailing `moov` atom cannot be demuxed from a non-seekable pipe ("moov atom
 * not found"), and a seekable output lets the muxer write real chunk sizes
 * instead of the streamed `0xFFFFFFFF`. `-fflags +bitexact` suppresses the
 * `LIST INFO ISFT` chunk so the output is the canonical 44-byte layout the
 * pipeline's `(len-44)/32` math and whisper expect.
 */
export function buildFfmpegArgs(
  inputPath: string,
  outputPath: string,
): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-i",
    inputPath,
    "-map",
    "0:a:0",
    "-vn",
    "-sn",
    "-dn",
    "-ac",
    String(TARGET_CHANNELS),
    "-ar",
    String(TARGET_SAMPLE_RATE),
    "-c:a",
    "pcm_s16le",
    "-map_metadata",
    "-1",
    "-fflags",
    "+bitexact",
    "-f",
    "wav",
    outputPath,
  ];
}

/**
 * True unless `buffer` already is a plain PCM (format tag 1) 16 kHz mono
 * 16-bit WAV that is conforming AND canonical (44-byte header, `data` chunk
 * spanning exactly the rest of the file), so downstream `(len-44)/32` math
 * and whisper see a clean file. Extra chunks, streamed 0xFFFFFFFF sizes or
 * trailing garbage → true. Anything unparseable (mp3, m4a, truncated,
 * empty) → true.
 */
export function needsDecode(buffer: Uint8Array): boolean {
  try {
    const info = parseWavHeader(buffer);
    if (
      info.formatTag !== 1 ||
      info.sampleRate !== TARGET_SAMPLE_RATE ||
      info.channels !== TARGET_CHANNELS ||
      info.bitsPerSample !== TARGET_BITS_PER_SAMPLE ||
      info.dataOffset !== 44
    ) {
      return true;
    }
    // parseWavHeader clamps dataLength to the bytes present, so read the
    // declared `data` size ourselves: a streamed 0xFFFFFFFF is not canonical.
    const declared = Buffer.from(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength,
    ).readUInt32LE(40);
    return declared !== buffer.byteLength - 44;
  } catch {
    return true;
  }
}

/**
 * `needsDecode` for an on-disk file (same semantics, same verdicts): open the
 * path, parse the header off the fd, and compare the declared `data` size
 * against the real file size.
 */
export function needsDecodeFile(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const info = parseWavHeader(fd);
    if (
      info.formatTag !== 1 ||
      info.sampleRate !== TARGET_SAMPLE_RATE ||
      info.channels !== TARGET_CHANNELS ||
      info.bitsPerSample !== TARGET_BITS_PER_SAMPLE ||
      info.dataOffset !== 44
    ) {
      return true;
    }
    const declared = Buffer.alloc(4);
    readSync(fd, declared, 0, 4, 40);
    return declared.readUInt32LE(0) !== size - 44;
  } catch {
    return true;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function tail(stderr: string): string {
  return stderr.trim().slice(-STDERR_TAIL_CHARS);
}

/**
 * ffmpeg echoes the paths it worked on in its diagnostics; the temp dir is a
 * server-side detail that must reach neither the client nor the logs.
 */
function redactTempDir(text: string, tempDir: string): string {
  return tempDir ? text.split(tempDir).join("<tmp>") : text;
}

/**
 * Decode the file at `inputPath` (any container ffmpeg was built with) to a
 * canonical 44-byte-header 16 kHz mono PCM16 WAV at `outputPath` (which must
 * not exist; the caller owns both paths and their cleanup). Rejects with
 * `AudioDecodeError`. Resolves with the final output size.
 */
export async function decodeFileToWav16kMono(
  inputPath: string,
  outputPath: string,
  deps: DecodeDeps = createDefaultDecodeDeps(),
): Promise<{ bytes: number }> {
  const binary = deps.resolveBinaryPath();
  if (!binary) {
    throw new AudioDecodeError(
      "ffmpeg binary not found in the app bundle",
      "binary_missing",
    );
  }

  const stderr = await runFfmpeg(binary, inputPath, outputPath, deps);

  // Size cap (belt to the poller's suspenders: ffmpeg may finish between polls).
  const written = statSync(outputPath).size;
  if (written > deps.maxOutputBytes) {
    throw new AudioDecodeError(
      `decoded audio exceeds ${deps.maxOutputBytes} bytes`,
      "decode_failed",
      { stderrTail: tail(redactTempDir(stderr, dirname(outputPath))) },
    );
  }

  let info: WavInfo;
  let fd: number | undefined;
  try {
    fd = openSync(outputPath, "r");
    info = parseWavHeader(fd);
  } catch (err) {
    throw new AudioDecodeError(
      `ffmpeg produced an unreadable WAV: ${(err as Error).message}`,
      "decode_failed",
      {
        exitCode: 0,
        stderrTail: tail(redactTempDir(stderr, dirname(outputPath))),
      },
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (info.dataLength === 0 || wavDurationMs(info) === 0) {
    throw new AudioDecodeError(
      "decoded audio is empty (zero duration)",
      "empty_output",
      {
        exitCode: 0,
        stderrTail: tail(redactTempDir(stderr, dirname(outputPath))),
      },
    );
  }

  await ensureCanonicalWavFile(outputPath, info);
  return { bytes: statSync(outputPath).size };
}

function runFfmpeg(
  binary: string,
  inputPath: string,
  outputPath: string,
  deps: DecodeDeps,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = deps.spawn(binary, buildFfmpegArgs(inputPath, outputPath), {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      // Static build, no companion DLLs — cwd = binary dir purely for safety
      // (mirrors whisperSpawnEnv()).
      cwd: dirname(binary),
    });

    let stderr = "";
    /** Redacted stderr, safe for messages, details and logs. */
    const safeStderr = () => redactTempDir(stderr, dirname(outputPath));
    const stderrTail = () => tail(safeStderr());

    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let poller: NodeJS.Timeout | undefined;
    const kill = () => {
      try {
        proc.kill("SIGKILL");
      } catch {}
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poller);
      fn();
    };

    timer = setTimeout(() => {
      settle(() => {
        kill();
        reject(
          new AudioDecodeError(
            `ffmpeg did not finish within ${Math.round(deps.timeoutMs / 1000)} s`,
            "timeout",
            { stderrTail: stderrTail() },
          ),
        );
      });
    }, deps.timeoutMs);

    // Runaway guard: kill a decode whose output file passes the cap instead
    // of letting it eat the disk until the wall-clock timeout.
    poller = setInterval(() => {
      try {
        if (statSync(outputPath).size > deps.maxOutputBytes) {
          settle(() => {
            kill();
            reject(
              new AudioDecodeError(
                `decoded audio exceeds ${deps.maxOutputBytes} bytes`,
                "decode_failed",
                { stderrTail: stderrTail() },
              ),
            );
          });
        }
      } catch {
        // Output not created yet (or already removed) — nothing to check.
      }
    }, deps.pollIntervalMs);

    proc.stderr?.on("data", (data: Buffer) => {
      // Bounded: only the tail ever reaches an error message.
      stderr = (stderr + data.toString()).slice(-STDERR_TAIL_CHARS * 4);
    });
    // Windows pipes can emit `error` after TerminateProcess; an unhandled
    // stream error would crash the process.
    proc.stderr?.on("error", () => {});

    proc.on("error", (err: NodeJS.ErrnoException) => {
      settle(() => {
        const missing = err.code === "ENOENT";
        reject(
          new AudioDecodeError(
            missing
              ? `ffmpeg binary not found: ${binary}`
              : `failed to start ffmpeg: ${err.message}`,
            missing ? "binary_missing" : "decode_failed",
            { stderrTail: stderrTail() },
          ),
        );
      });
    });

    proc.on("close", (code, signal) => {
      settle(() => {
        if (code !== 0) {
          const t = stderrTail();
          reject(
            new AudioDecodeError(
              `ffmpeg exited with ${code === null ? `signal ${signal}` : `code ${code}`}: ${t || "(no stderr)"}`,
              "decode_failed",
              { exitCode: code, signal, stderrTail: t },
            ),
          );
          return;
        }
        resolve(safeStderr());
      });
    });
  });
}

/**
 * Rewrite a decoded WAV under a canonical 44-byte header if ffmpeg produced
 * anything else (extra chunks before `data`, or a streamed size). Streams the
 * `data` chunk through a 1 MiB buffer, so even a 1 GiB file never lives in
 * memory. No-op for an already-canonical file — with `-fflags +bitexact` and
 * a seekable output that is the expected case.
 */
async function ensureCanonicalWavFile(
  path: string,
  info: WavInfo,
): Promise<void> {
  const size = statSync(path).size;
  const fd = openSync(path, "r");
  let declared: number;
  try {
    const b = Buffer.alloc(4);
    readSync(fd, b, 0, 4, 40);
    declared = b.readUInt32LE(0);
  } finally {
    closeSync(fd);
  }
  if (info.dataOffset === 44 && declared === size - 44) return;

  const tmp = `${path}.canonical`;
  const src = await open(path, "r");
  let dst: FileHandle | null = null;
  try {
    dst = await open(tmp, "wx");
    await writeAll(dst, wavHeader(info, info.dataLength));
    const buf = Buffer.alloc(CANONICALIZE_CHUNK_BYTES);
    let off = info.dataOffset;
    let remaining = info.dataLength;
    while (remaining > 0) {
      const want = Math.min(buf.length, remaining);
      const { bytesRead } = await src.read(buf, 0, want, off);
      if (bytesRead <= 0) {
        throw new AudioDecodeError(
          "ffmpeg produced a truncated WAV",
          "decode_failed",
        );
      }
      await writeAll(dst, buf.subarray(0, bytesRead));
      off += bytesRead;
      remaining -= bytesRead;
    }
    await dst.close();
    dst = null;
    await src.close();
    renameSync(tmp, path);
  } catch (err) {
    try {
      await dst?.close();
    } catch {}
    try {
      await src.close();
    } catch {}
    await unlink(tmp).catch(() => {});
    if (err instanceof AudioDecodeError) throw err;
    throw new AudioDecodeError(
      `failed to canonicalize the decoded WAV: ${(err as Error).message}`,
      "decode_failed",
    );
  }
}

async function writeAll(handle: FileHandle, buf: Buffer): Promise<void> {
  let off = 0;
  while (off < buf.length) {
    const { bytesWritten } = await handle.write(buf, off, buf.length - off);
    if (bytesWritten <= 0) throw new Error("short write");
    off += bytesWritten;
  }
}
