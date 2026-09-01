/**
 * ffmpeg decode/normalize helper: any accepted audio/video container →
 * 16 kHz mono PCM16 WAV, via the bundled ffmpeg binary.
 *
 * Every clip handed to a `TranscriptionProvider` must already be 16 kHz mono
 * WAV (that is what the renderer produces for dictation and meetings). Imported
 * files are normalized here, on the server, *before* any provider call, so no
 * provider needs per-format branching (spec decision `dec_85b72ede`).
 *
 * Only the first audio track is decoded (`-map 0:a:0`); a video-only or
 * audio-less input is a deterministic ffmpeg failure, surfaced as
 * `decode_failed`.
 *
 * Nothing in here imports Hono, routes, the DB, or electron.
 */

import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseWavHeader, wavDurationMs, wavHeader } from "./wav.js";

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
/** Hard cap on decoded bytes collected from ffmpeg's stdout (1 GiB). */
export const MAX_DECODED_BYTES = 1024 * 1024 * 1024;
/** How much of ffmpeg's stderr to keep in the error (whisper/server.ts convention). */
export const STDERR_TAIL_CHARS = 500;

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
    stdio: ["ignore", "pipe", "pipe"];
    windowsHide: boolean;
    cwd?: string;
  },
) => ChildProcess;

export interface DecodeDeps {
  /** Resolve the bundled ffmpeg binary. Null = not bundled/found. */
  resolveBinaryPath: () => string | null;
  /** Spawn ffmpeg. Injected for tests. */
  spawn: SpawnFn;
  /** Create the scratch dir the input is written to. Injected for tests. */
  makeTempDir: () => string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export function createDefaultDecodeDeps(): DecodeDeps {
  return {
    resolveBinaryPath: getFfmpegBinaryPath,
    spawn: nodeSpawn as SpawnFn,
    makeTempDir: () => mkdtempSync(join(tmpdir(), "openstyle-decode-")),
    timeoutMs: DECODE_TIMEOUT_MS,
    maxOutputBytes: MAX_DECODED_BYTES,
  };
}

/**
 * ffmpeg argv. Input is a *file path* (not `pipe:0`): MP4/M4A with a trailing
 * `moov` atom cannot be demuxed from a non-seekable pipe ("moov atom not
 * found"). Output goes to stdout; the WAV header ffmpeg writes there carries
 * `0xFFFFFFFF` sizes, which `decodeToWav16kMono` rewrites.
 */
export function buildFfmpegArgs(inputPath: string): string[] {
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
    "-f",
    "wav",
    "pipe:1",
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

function tail(stderr: string): string {
  return stderr.trim().slice(-STDERR_TAIL_CHARS);
}

/**
 * ffmpeg echoes the input path in its diagnostics; the scratch dir is a
 * server-side detail that must reach neither the client nor the logs.
 */
function redactTempDir(text: string, tempDir: string): string {
  return tempDir ? text.split(tempDir).join("<tmp>") : text;
}

/**
 * Decode `input` (any container ffmpeg was built with) to a canonical
 * 44-byte-header 16 kHz mono PCM16 WAV. Rejects with `AudioDecodeError`.
 */
export async function decodeToWav16kMono(
  input: Uint8Array,
  deps: DecodeDeps = createDefaultDecodeDeps(),
): Promise<Uint8Array> {
  const binary = deps.resolveBinaryPath();
  if (!binary) {
    throw new AudioDecodeError(
      "ffmpeg binary not found in the app bundle",
      "binary_missing",
    );
  }

  const tempDir = deps.makeTempDir();
  try {
    // No extension on purpose: ffmpeg probes by content, and the client's
    // filename is not to be trusted.
    const inputPath = join(tempDir, "input");
    writeFileSync(inputPath, input);
    const { stdout, stderr } = await runFfmpeg(
      binary,
      inputPath,
      tempDir,
      deps,
    );
    return finalizeWav(stdout, stderr);
  } finally {
    // Never let cleanup mask the real error: on Windows the input file can
    // still be locked (EBUSY) briefly after a SIGKILL.
    try {
      rmSync(tempDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      });
    } catch (err) {
      console.warn(
        `[audio/decode] failed to remove temp dir ${tempDir}: ${(err as Error).message}`,
      );
    }
  }
}

function runFfmpeg(
  binary: string,
  inputPath: string,
  tempDir: string,
  deps: DecodeDeps,
): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = deps.spawn(binary, buildFfmpegArgs(inputPath), {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // Static build, no companion DLLs — cwd = binary dir purely for safety
      // (mirrors whisperSpawnEnv()).
      cwd: dirname(binary),
    });

    let settled = false;
    const chunks: Buffer[] = [];
    let outBytes = 0;
    let stderr = "";
    /** Redacted stderr, safe for messages, details and logs. */
    const safeStderr = () => redactTempDir(stderr, tempDir);
    const stderrTail = () => tail(safeStderr());

    const kill = () => {
      try {
        proc.kill("SIGKILL");
      } catch {}
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
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

    proc.stdout?.on("data", (data: Buffer) => {
      if (settled) return;
      outBytes += data.length;
      if (outBytes > deps.maxOutputBytes) {
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
        return;
      }
      chunks.push(data);
    });

    proc.stderr?.on("data", (data: Buffer) => {
      // Bounded: only the tail ever reaches an error message.
      stderr = (stderr + data.toString()).slice(-STDERR_TAIL_CHARS * 4);
    });
    // Windows pipes can emit `error` after TerminateProcess; an unhandled
    // stream error would crash the process.
    proc.stdout?.on("error", () => {});
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
        resolve({ stdout: Buffer.concat(chunks), stderr: safeStderr() });
      });
    });
  });
}

/** Validate ffmpeg's stdout WAV and rewrite it under a canonical 44-byte header. */
function finalizeWav(stdout: Buffer, stderr: string): Uint8Array {
  let info: ReturnType<typeof parseWavHeader>;
  try {
    info = parseWavHeader(stdout);
  } catch (err) {
    throw new AudioDecodeError(
      `ffmpeg produced an unreadable WAV: ${(err as Error).message}`,
      "decode_failed",
      { exitCode: 0, stderrTail: tail(stderr) },
    );
  }
  if (info.dataLength === 0 || wavDurationMs(info) === 0) {
    throw new AudioDecodeError(
      "decoded audio is empty (zero duration)",
      "empty_output",
      { exitCode: 0, stderrTail: tail(stderr) },
    );
  }
  const data = stdout.subarray(
    info.dataOffset,
    info.dataOffset + info.dataLength,
  );
  // ffmpeg wrote 0xFFFFFFFF sizes (can't seek back on a pipe) and may have
  // added LIST chunks; downstream `(len - 44) / byteRate` math and whisper
  // both want the plain 44-byte layout.
  return Buffer.concat([wavHeader(info, data.length), data]);
}
