/**
 * Meeting diarization Phase 1 (specs/meeting-diarization.md).
 *
 * Opt-in, system-channel-only speaker labeling: after transcription
 * completes, `runDiarizationPass` spawns the `fluidaudio-diarize` native
 * helper against the meeting's raw `system.wav`, matches its output against
 * the meeting's already-persisted `meeting_segments` rows by timestamp
 * overlap (`assignSpeakerLabels`, spec §7), and writes the result as a
 * `speaker_label` column value ("1", "2", ... or NULL).
 *
 * Every failure mode here degrades silently to today's behavior (NULL label
 * → renders "Them") — this module never throws past `runDiarizationPass` in
 * normal operation; `assignSpeakerLabels` is the one pure, exception-free
 * piece, kept free of any `getDb()` call so it's importable and testable
 * without a database (mirrors why `merge.ts` is pure).
 *
 * Model bundling (amended 2026-08-25): the ~22MB offline model set ships
 * pre-bundled inside the app (`resources/models/speaker-diarization/`,
 * fetched at build time by `compile-native.js`) instead of being downloaded
 * on first opt-in. `getFluidAudioModelsDirPath` resolves the bundle the same
 * way `getFluidAudioDiarizeBinaryPath` resolves the binary, and every helper
 * invocation gets `--models-dir <dir>`. There is no download orchestration
 * left in this module — a missing bundle is a build/packaging gap, not a
 * user-triggerable action.
 */

import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { createAppLogger } from "@openstyle/utils";
import { getDb } from "../db.js";
import {
  isDictationActive,
  waitForDictationIdle,
} from "../dictation-activity.js";

const log = createAppLogger("meeting-diarize");

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Mirrors `getTranslateModeSetting()` (`lib/language.ts`) exactly — the
 * existing flat settings pattern, no new validation route logic needed
 * (spec §8).
 */
export function getMeetingDiarizationEnabledSetting(): boolean {
  const row = getDb()
    .prepare(
      "SELECT value FROM settings WHERE key = 'meeting_diarization_enabled'",
    )
    .get() as { value: string } | undefined;
  return row?.value === "true";
}

// ---------------------------------------------------------------------------
// Binary path resolution
//
// Not `getNativeBinaryPath` (apps/electron/src/main/native-binary.ts) — that
// resolver imports `electron` and reads `app.isPackaged`, Electron-main-only
// code that apps/server cannot import. Follows the same precedent
// whisper-local's binary already uses from apps/server:
// `getResourcesDir()` in apps/server/src/lib/whisper/constants.ts, which
// checks `process.resourcesPath` directly (set because apps/server runs
// embedded, in-process, inside Electron main) and falls back to a
// process.cwd()-relative dev path otherwise (spec §4).
// ---------------------------------------------------------------------------

export function getFluidAudioDiarizeBinaryPath(): string | null {
  const proc = process as NodeJS.Process & { resourcesPath?: string };
  const dir = proc.resourcesPath
    ? join(proc.resourcesPath, "bin")
    : join(
        process.cwd(),
        "resources",
        "bin",
        `${process.platform}-${process.arch}`,
      );
  const p = join(dir, "fluidaudio-diarize");
  return existsSync(p) ? p : null;
}

/**
 * Pre-bundled offline diarization models (spec §4, amended 2026-08-25 — the
 * models ship inside the app instead of being downloaded on first opt-in).
 * Same resolution precedent as `getFluidAudioDiarizeBinaryPath` above: not
 * platform/arch-scoped like `resources/bin/${platform}-${arch}` — the
 * ~22MB .mlmodelc set is the same regardless of host arch, and diarization
 * is macOS-only already, so there's nothing to key this directory on
 * (electron-builder.yml ships it under mac's `extraResources` as `models`).
 *
 * Returns the directory to pass as `--models-dir` — the parent of
 * `speaker-diarization/`, not that subfolder itself; `fluidaudio-diarize`
 * resolves the `speaker-diarization/` layer internally
 * (`OfflineDiarizerModels.load(from:)`). Null when the bundle is missing
 * (a build/packaging gap — compile-native.js failed to fetch it, or this is
 * a checkout that never ran `npm run compile:native`).
 */
export function getFluidAudioModelsDirPath(): string | null {
  const proc = process as NodeJS.Process & { resourcesPath?: string };
  const dir = proc.resourcesPath
    ? join(proc.resourcesPath, "models")
    : join(process.cwd(), "resources", "models");
  return existsSync(join(dir, "speaker-diarization")) ? dir : null;
}

// ---------------------------------------------------------------------------
// Label assignment (spec §7) — pure, no I/O.
// ---------------------------------------------------------------------------

/** A system-channel `meeting_segments` row, raw/undrifted timestamps. */
export interface WhisperSegmentForDiarization {
  id: string;
  startMs: number;
  endMs: number;
}

/** One entry of the diarizer helper's JSON stdout (spec §4). */
export interface DiarizerSegment {
  speakerId: string;
  startTimeSeconds: number;
  endTimeSeconds: number;
  qualityScore?: number;
}

/** The `speaker_label` value to persist for one `meeting_segments` row. */
export interface SpeakerLabelAssignment {
  id: string;
  speakerLabel: string | null;
}

/** Nearest-neighbor fallback window (spec §7 step 4). */
const NEAREST_NEIGHBOR_WINDOW_MS = 2000;

interface InternalDiarSegment {
  speakerId: string;
  startMs: number;
  endMs: number;
}

/**
 * Overlap-ms between a whisper segment and a diarizer segment, clamped to
 * >= 0 (spec §7 step 1).
 */
function overlapMs(
  w: { startMs: number; endMs: number },
  d: InternalDiarSegment,
): number {
  return Math.max(
    0,
    Math.min(w.endMs, d.endMs) - Math.max(w.startMs, d.startMs),
  );
}

/**
 * Winner = largest overlap. Tie-break: midpoint closer to the whisper
 * segment's midpoint, then the earlier (smaller startMs) diarizer segment
 * (spec §7 steps 2-3). Returns null when every diarizer segment has zero
 * overlap — the caller falls back to nearest-neighbor.
 */
function pickOverlapWinner(
  w: { startMs: number; endMs: number },
  diar: InternalDiarSegment[],
): InternalDiarSegment | null {
  let best: InternalDiarSegment | null = null;
  let bestOverlap = 0;
  const wMid = (w.startMs + w.endMs) / 2;

  for (const d of diar) {
    const overlap = overlapMs(w, d);
    if (overlap <= 0) continue;
    if (best === null || overlap > bestOverlap) {
      best = d;
      bestOverlap = overlap;
      continue;
    }
    if (overlap === bestOverlap) {
      const bestMid = (best.startMs + best.endMs) / 2;
      const dMid = (d.startMs + d.endMs) / 2;
      const bestDist = Math.abs(bestMid - wMid);
      const dDist = Math.abs(dMid - wMid);
      if (
        dDist < bestDist ||
        (dDist === bestDist && d.startMs < best.startMs)
      ) {
        best = d;
      }
    }
  }
  return best;
}

/**
 * Nearest diarizer segment by endpoint distance, within a bounded
 * look-around window either side. Null when nothing qualifies (spec §7 step
 * 4).
 */
function pickNearestWithinWindow(
  w: { startMs: number; endMs: number },
  diar: InternalDiarSegment[],
  windowMs: number,
): InternalDiarSegment | null {
  let best: InternalDiarSegment | null = null;
  let bestDist = Number.POSITIVE_INFINITY;

  for (const d of diar) {
    const dist = Math.min(
      Math.abs(w.startMs - d.startMs),
      Math.abs(w.startMs - d.endMs),
      Math.abs(w.endMs - d.startMs),
      Math.abs(w.endMs - d.endMs),
    );
    if (
      dist < bestDist ||
      (dist === bestDist && best && d.startMs < best.startMs)
    ) {
      best = d;
      bestDist = dist;
    }
  }
  return best && bestDist <= windowMs ? best : null;
}

/**
 * Assign `speaker_label` values to whisper (system-channel) segments from a
 * diarizer segment list, per spec §7. Pure and deterministic: same inputs,
 * same output, no randomness in any tie-break.
 *
 * `whisperSegments` must be ordered by `idx` (ascending startMs) — label
 * numbering (step 5) walks them in the given order to find each speaker's
 * first appearance.
 */
export function assignSpeakerLabels(
  whisperSegments: WhisperSegmentForDiarization[],
  diarSegments: DiarizerSegment[],
): SpeakerLabelAssignment[] {
  const diar: InternalDiarSegment[] = diarSegments.map((d) => ({
    speakerId: d.speakerId,
    startMs: d.startTimeSeconds * 1000,
    endMs: d.endTimeSeconds * 1000,
  }));

  const winners = whisperSegments.map((w) => {
    const overlapWinner = pickOverlapWinner(w, diar);
    if (overlapWinner) return overlapWinner;
    return pickNearestWithinWindow(w, diar, NEAREST_NEIGHBOR_WINDOW_MS);
  });

  // Label numbering: first-appearance order by whisper-segment order (i.e.
  // by startMs, since callers pass segments ordered by idx) — not
  // diarizer-clustering order (spec §7 step 5). A single distinct speaker
  // still maps to index 1 (the collapse rule, step 6) falls out of this
  // naturally: the first (and only) speaker seen gets index 1.
  const indexBySpeaker = new Map<string, number>();
  for (const winner of winners) {
    if (!winner) continue;
    if (!indexBySpeaker.has(winner.speakerId)) {
      indexBySpeaker.set(winner.speakerId, indexBySpeaker.size + 1);
    }
  }

  return whisperSegments.map((w, i) => {
    const winner = winners[i];
    const speakerLabel = winner
      ? String(indexBySpeaker.get(winner.speakerId))
      : null;
    return { id: w.id, speakerLabel };
  });
}

// ---------------------------------------------------------------------------
// Pipeline integration (spec §9)
// ---------------------------------------------------------------------------

type ExecFileFn = (
  file: string,
  args: string[],
  options: { timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExecFile: ExecFileFn = promisify(execFileCb) as ExecFileFn;

export interface DiarizeDeps {
  /** Resolve the fluidaudio-diarize binary path. Null = not found/built. */
  resolveBinaryPath: () => string | null;
  /** Resolve the bundled models dir (spec §4). Null = missing from bundle. */
  resolveModelsDirPath: () => string | null;
  /** Spawn the helper and collect its output. Injected for tests. */
  execFile: ExecFileFn;
  /** Dictation-priority lease, same source as MeetingTranscriber's. */
  isDictationActive?: () => boolean;
}

export function createDefaultDiarizeDeps(): DiarizeDeps {
  return {
    resolveBinaryPath: getFluidAudioDiarizeBinaryPath,
    resolveModelsDirPath: getFluidAudioModelsDirPath,
    execFile: defaultExecFile,
    isDictationActive,
  };
}

/** Probe timeout — cheap, local-only check, generous but bounded. */
const PROBE_TIMEOUT_MS = 30_000;
/** Diarization timeout floor (spec §11): duration x 1.0, minimum 120s. */
const MIN_TIMEOUT_MS = 120_000;
/** Bounds the helper's JSON stdout for a long meeting's full segment list. */
const DIARIZE_MAX_BUFFER = 8 * 1024 * 1024;

interface SystemSegmentRow {
  id: string;
  start_ms: number;
  end_ms: number;
}

/**
 * Run the diarization pass for one meeting's `system.wav` and persist
 * per-segment `speaker_label` values. Every expected failure mode (spec
 * §9-10) logs a warning and returns — this function never throws in normal
 * operation, so the `.catch` at the call site in `runTranscribeJob` is
 * defense-in-depth, not the primary error path.
 */
export async function runDiarizationPass(
  meetingId: string,
  audioDir: string,
  deps: DiarizeDeps = createDefaultDiarizeDeps(),
): Promise<void> {
  const wavPath = join(audioDir, "system.wav");
  if (!existsSync(wavPath)) {
    log.warn(
      `meeting ${meetingId}: diarization skipped, no system.wav at ${wavPath}`,
    );
    return;
  }

  const binaryPath = deps.resolveBinaryPath();
  if (!binaryPath) {
    log.warn(
      `meeting ${meetingId}: diarization skipped, fluidaudio-diarize binary not found`,
    );
    return;
  }

  const modelsDir = deps.resolveModelsDirPath();
  if (!modelsDir) {
    log.warn(
      `meeting ${meetingId}: diarization skipped, models missing from bundle`,
    );
    return;
  }

  // The diarizer runs on-device via CoreML/ANE, the same physical resource
  // whisper-local targets — yield to live dictation exactly like chunk
  // transcription does (spec §11), unconditionally (diarization always runs
  // on-device regardless of which STT provider transcribed the meeting).
  await waitForDictationIdle({ isDictationActive: deps.isDictationActive });

  // Defensive probe before the real run — the bundle is expected to always
  // be present and loadable once `resolveModelsDirPath` returns non-null,
  // but a corrupted/partial install (e.g. an interrupted copy) shouldn't
  // surface as an opaque diarize failure when a cheap probe can call it out
  // as "models missing from bundle" instead (spec §10).
  let probeStdout: string;
  try {
    const probe = await deps.execFile(
      binaryPath,
      ["--probe", "--models-dir", modelsDir],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    probeStdout = probe.stdout.trim();
  } catch (err) {
    log.warn(`meeting ${meetingId}: diarization probe failed: ${String(err)}`);
    return;
  }
  if (probeStdout !== "READY") {
    log.warn(
      `meeting ${meetingId}: diarization models missing from bundle (${probeStdout || "no output"}), skipping`,
    );
    return;
  }

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, start_ms, end_ms FROM meeting_segments
       WHERE meeting_id = ? AND source = 'system' ORDER BY idx`,
    )
    .all(meetingId) as unknown as SystemSegmentRow[];

  // Timeout: meeting duration x 1.0, minimum 120s, no fixed ceiling (spec
  // §11). `meetings.duration_ms` is the primary source; fall back to the
  // system channel's own last segment end when it's unset (e.g. a still-
  // recording edge case shouldn't happen here, but costs nothing to guard).
  const durationRow = db
    .prepare("SELECT duration_ms FROM meetings WHERE id = ?")
    .get(meetingId) as { duration_ms: number | null } | undefined;
  const durationMs =
    durationRow?.duration_ms ??
    rows.reduce((max, r) => Math.max(max, r.end_ms), 0);
  const timeoutMs = Math.max(MIN_TIMEOUT_MS, durationMs);

  let stdout: string;
  try {
    const result = await deps.execFile(
      binaryPath,
      [wavPath, "--models-dir", modelsDir],
      { timeout: timeoutMs, maxBuffer: DIARIZE_MAX_BUFFER },
    );
    stdout = result.stdout;
  } catch (err) {
    log.warn(`meeting ${meetingId}: diarization run failed: ${String(err)}`);
    return;
  }

  let diarSegments: DiarizerSegment[];
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) throw new Error("stdout JSON is not an array");
    diarSegments = parsed as DiarizerSegment[];
  } catch (err) {
    log.warn(
      `meeting ${meetingId}: diarization returned malformed JSON: ${String(err)}`,
    );
    return;
  }

  const whisperSegments: WhisperSegmentForDiarization[] = rows.map((r) => ({
    id: r.id,
    startMs: r.start_ms,
    endMs: r.end_ms,
  }));
  const assignments = assignSpeakerLabels(whisperSegments, diarSegments);

  // Explicit NULL write for every row (spec §7 step 7) — correct behavior on
  // a future re-run, not just "leave whatever was there".
  const update = db.prepare(
    "UPDATE meeting_segments SET speaker_label = ? WHERE id = ?",
  );
  db.exec("BEGIN");
  try {
    for (const a of assignments) update.run(a.speakerLabel, a.id);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    log.warn(
      `meeting ${meetingId}: failed to persist speaker labels: ${String(err)}`,
    );
    return;
  }

  log.info(
    `meeting ${meetingId}: diarization labeled ${assignments.filter((a) => a.speakerLabel).length}/${assignments.length} system segments`,
  );
}

// ---------------------------------------------------------------------------
// Model readiness probe (spec §8, simplified 2026-08-25).
//
// Models are pre-bundled (spec §4) — there's no download to orchestrate or
// progress to poll any more. The settings UI still wants a real
// "ready"/"not ready" signal instead of assuming (same reasoning as
// system-audio-probe.ts avoiding assuming TCC grant state), so this stays as
// a plain, stateless probe: run `--probe --models-dir <dir>` fresh on every
// call and report the result. No persisted module state, no polling.
// ---------------------------------------------------------------------------

export type DiarizationReadiness =
  | "ready"
  | "not-ready"
  | "unavailable"
  | "error";

export interface DiarizationReadinessResult {
  status: DiarizationReadiness;
  error?: string;
}

/**
 * `--probe --models-dir <dir>` (spec §4): no network, no diarization,
 * reports whether the bundled models actually load. `unavailable` covers
 * both the build/packaging gaps this can hit — binary not built, or models
 * missing from the bundle — since either one means the same thing to a user
 * looking at the settings toggle: diarization isn't usable on this install.
 */
export async function probeDiarizationModels(
  deps: Pick<
    DiarizeDeps,
    "resolveBinaryPath" | "resolveModelsDirPath" | "execFile"
  > = createDefaultDiarizeDeps(),
): Promise<DiarizationReadinessResult> {
  const binaryPath = deps.resolveBinaryPath();
  const modelsDir = deps.resolveModelsDirPath();
  if (!binaryPath || !modelsDir) {
    return { status: "unavailable" };
  }
  try {
    const { stdout } = await deps.execFile(
      binaryPath,
      ["--probe", "--models-dir", modelsDir],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    return stdout.trim() === "READY"
      ? { status: "ready" }
      : { status: "not-ready" };
  } catch (err) {
    return { status: "error", error: String(err) };
  }
}
