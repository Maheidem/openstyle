/**
 * Meeting VAD gate: Silero VAD speech spans before meeting ASR.
 *
 * `detectSpeechSpans` runs the `fluidaudio-diarize --vad` helper on one
 * track. `attachSpeechSpans` gives each segment the spans that overlap it,
 * clipped to the segment. The transcriber then sends only the speech spans
 * to the ASR provider, and skips a chunk with no span.
 *
 * Every failure returns null and logs one line. Null means "no VAD data":
 * the transcriber keeps the old path (the voicedMs gate). This module
 * never throws. It runs also when diarization is off.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createAppLogger } from "@openstyle/utils";
import {
  defaultExecFile,
  type ExecFileFn,
  fluidAudioModelsDirCandidates,
  getFluidAudioDiarizeBinaryPath,
} from "./diarize.js";
import type { Segment, SpeechSpan } from "./segmenter.js";

const log = createAppLogger("meeting-vad");

/** The model folder that the helper reads under `--models-dir`. */
const VAD_MODEL_SUBDIR = "silero-vad";
/** Timeout floor. The real timeout is max(floor, duration / 2). */
const MIN_VAD_TIMEOUT_MS = 60_000;
/** Bounds the helper's JSON stdout for a long track. */
const VAD_MAX_BUFFER = 8 * 1024 * 1024;

export interface VadDeps {
  resolveBinaryPath: () => string | null;
  /** The `--models-dir` value (the parent of `silero-vad/`), or null. */
  resolveModelsDirPath: () => string | null;
  execFile: ExecFileFn;
}

/** Same candidates as the diarizer models, but checks for `silero-vad/`. */
function getVadModelsDirPath(): string | null {
  return (
    fluidAudioModelsDirCandidates().find((dir) =>
      existsSync(join(dir, VAD_MODEL_SUBDIR)),
    ) ?? null
  );
}

function createDefaultVadDeps(): VadDeps {
  return {
    resolveBinaryPath: getFluidAudioDiarizeBinaryPath,
    resolveModelsDirPath: getVadModelsDirPath,
    execFile: defaultExecFile,
  };
}

/** Keep only finite spans with end > start, sorted by start. */
function sanitizeSpans(parsed: unknown[]): SpeechSpan[] | null {
  const spans: SpeechSpan[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) return null;
    const { startMs, endMs } = item as Partial<SpeechSpan>;
    if (
      typeof startMs !== "number" ||
      typeof endMs !== "number" ||
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs)
    ) {
      return null;
    }
    if (endMs > startMs) spans.push({ startMs, endMs });
  }
  spans.sort((a, b) => a.startMs - b.startMs);
  return spans;
}

/**
 * Run the Silero VAD on one WAV track. Returns the speech spans (ms from
 * the start of the track; an empty array means no speech), or null on
 * any failure: missing wav, binary or model, a failed run, bad JSON.
 */
export async function detectSpeechSpans(
  wavPath: string,
  durationMs: number,
  deps: VadDeps = createDefaultVadDeps(),
): Promise<SpeechSpan[] | null> {
  try {
    if (!existsSync(wavPath)) {
      log.info(`vad skipped, no wav at ${wavPath}`);
      return null;
    }
    const binaryPath = deps.resolveBinaryPath();
    if (!binaryPath) {
      log.info("vad skipped, fluidaudio-diarize binary not found");
      return null;
    }
    const modelsDir = deps.resolveModelsDirPath();
    if (!modelsDir) {
      log.info("vad skipped, silero-vad model missing from bundle");
      return null;
    }
    const timeoutMs = Math.max(MIN_VAD_TIMEOUT_MS, durationMs / 2);
    const { stdout } = await deps.execFile(
      binaryPath,
      ["--vad", wavPath, "--models-dir", modelsDir],
      { timeout: timeoutMs, maxBuffer: VAD_MAX_BUFFER },
    );
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) throw new Error("stdout JSON is not an array");
    const spans = sanitizeSpans(parsed);
    if (spans === null) throw new Error("malformed span in stdout JSON");
    return spans;
  } catch (err) {
    log.warn(`vad failed, sending full chunks: ${String(err)}`);
    return null;
  }
}

/**
 * Give each segment the spans that overlap it, clipped to [startMs, endMs].
 * The segment times do not change. Null spans return the segments as they
 * are (no `speechSpans` field, the old path).
 */
export function attachSpeechSpans(
  segments: Segment[],
  spans: SpeechSpan[] | null,
): Segment[] {
  if (spans === null) return segments;
  return segments.map((seg) => ({
    ...seg,
    speechSpans: spans
      .filter((s) => s.endMs > seg.startMs && s.startMs < seg.endMs)
      .map((s) => ({
        startMs: Math.max(s.startMs, seg.startMs),
        endMs: Math.min(s.endMs, seg.endMs),
      })),
  }));
}
