/**
 * Repair of a system track with a known sample-rate mismatch (issue #170).
 *
 * The old meeting helper converted the system audio with the rate that the
 * tap stream reported (for example 48 kHz), while the buffers ran at the
 * device rate (for example 16 kHz with a Bluetooth headset in call mode).
 * Then `systemSamples / micSamples` in sync.json is exactly
 * actual rate / assumed rate (16000 / 48000 = 0.3333), and the system track
 * plays too fast. This module finds such a factor and resamples system.wav
 * by the exact rational factor. The original file stays next to it.
 *
 * The repair runs only when all of these are true:
 *   - the native helper recorded both tracks on one clock (sharedClock),
 *     and the recording did not change to the fallback path;
 *   - the ratio is outside 0.95..1.05 (trackRatioWarning) and within
 *     RATE_MATCH_TOLERANCE of a factor between two candidate rates;
 *   - every SYNC interval of MIN_INTERVAL_MS or more shows the system track
 *     at that same factor. A mixed recording (a rate change, a lost mic, a
 *     sleep) has other rates in some intervals, so it gets no repair.
 * Any other bad ratio keeps the warning on the meeting page.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  SYNC_JSON,
  SYSTEM_ORIGINAL_WAV,
  SYSTEM_WAV,
  trackRatioWarning,
} from "@openstyle/validations";
import { createResampler } from "../audio/resample.js";
import { readWavInfo, readWavPcm16, wavHeader } from "../audio/wav.js";

/**
 * Rates that a Core Audio device or stream can run at. The order is the
 * preference for the reported pair when two pairs give the same factor
 * (16000/48000 and 8000/24000 are both 1/3): common rates first.
 */
const CANDIDATE_RATES = [
  48000, 44100, 16000, 24000, 32000, 96000, 88200, 22050, 12000, 11025, 8000,
];

/**
 * Largest relative difference between the measured ratio and a factor that
 * still counts as a match (0.1 %). A true mismatch measures closer than
 * this: one IO buffer (512 frames) at the end of a 60 s track is 5.3e-4,
 * and the three meetings of 2026-10-15 were within 1e-4 of 1/3. Two
 * distinct candidate factors are at least 3.4 % apart, so a match never
 * picks the wrong factor. The windows cover only 1.75 % of the ratios
 * below 0.95, so a random bad ratio (for example a dropout) rarely matches.
 */
export const RATE_MATCH_TOLERANCE = 1e-3;

/** SYNC intervals shorter than this are not checked. */
const MIN_INTERVAL_MS = 10_000;
/** Largest relative difference of one SYNC interval from the factor. */
const INTERVAL_TOLERANCE = 0.02;

export interface RateMismatch {
  /** The rate that the old conversion assumed ("read as"). */
  fromRate: number;
  /** The real rate of the buffers ("recorded at"). */
  toRate: number;
}

/** What sync.json records after a repair. */
export interface TrackRepair extends RateMismatch {
  /** toRate / fromRate: the system/mic ratio before the repair. */
  factor: number;
  /** Samples of system.original.wav. */
  originalSystemSamples: number;
  /** Wallclock ms of the repair. */
  repairedAt: number;
}

/**
 * Returns the rate pair whose factor `toRate / fromRate` is within
 * RATE_MATCH_TOLERANCE of `ratio` (systemSamples / micSamples), or null.
 */
export function matchRateMismatch(ratio: number): RateMismatch | null {
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  let best: { pair: RateMismatch; error: number; rank: number } | null = null;
  for (const [i, fromRate] of CANDIDATE_RATES.entries()) {
    for (const [j, toRate] of CANDIDATE_RATES.entries()) {
      if (fromRate === toRate) continue;
      const factor = toRate / fromRate;
      const error = Math.abs(ratio - factor) / factor;
      if (error > RATE_MATCH_TOLERANCE) continue;
      // Equal factors give the same error. Then the more common pair wins.
      if (
        best === null ||
        error < best.error ||
        (error === best.error && i + j < best.rank)
      ) {
        best = { pair: { fromRate, toRate }, error, rank: i + j };
      }
    }
  }
  return best?.pair ?? null;
}

interface SyncMarkerLike {
  wallclockMs?: unknown;
  totalSamples?: unknown;
}

/**
 * True when every SYNC interval of MIN_INTERVAL_MS or more has the system
 * track at `factor` (system samples per wallclock second / sample rate),
 * and at least one such interval exists.
 */
function systemRateIsUniform(
  markers: unknown,
  sampleRate: number,
  factor: number,
): boolean {
  if (!Array.isArray(markers)) return false;
  const points = (markers as SyncMarkerLike[])
    .filter(
      (m): m is { wallclockMs: number; totalSamples: number } =>
        typeof m?.wallclockMs === "number" &&
        typeof m.totalSamples === "number",
    )
    .sort((a, b) => a.wallclockMs - b.wallclockMs);
  let intervals = 0;
  for (let i = 1; i < points.length; i++) {
    const ms = points[i].wallclockMs - points[i - 1].wallclockMs;
    if (ms < MIN_INTERVAL_MS) continue;
    const rate =
      (points[i].totalSamples - points[i - 1].totalSamples) /
      ((ms / 1000) * sampleRate);
    if (Math.abs(rate - factor) > INTERVAL_TOLERANCE * factor) return false;
    intervals++;
  }
  return intervals > 0;
}

/**
 * The repair that sync.json calls for, or null. Pure: reads the parsed
 * journal only. Null when a repair is already recorded.
 */
export function planTrackRepair(
  journal: Record<string, unknown>,
): RateMismatch | null {
  if (journal.repair !== undefined) return null;
  if (journal.sharedClock !== true) return null;
  const epochs = Array.isArray(journal.epochs) ? journal.epochs : [];
  if (epochs.some((e) => (e as { reason?: unknown })?.reason === "fallback")) {
    return null;
  }
  const ratio = trackRatioWarning(
    journal.micSamples,
    journal.systemSamples,
    journal.sampleRate,
  );
  if (ratio === null) return null;
  const match = matchRateMismatch(ratio);
  if (!match) return null;
  const factor = match.toRate / match.fromRate;
  if (
    !systemRateIsUniform(
      journal.syncMarkers,
      journal.sampleRate as number,
      factor,
    )
  ) {
    return null;
  }
  return match;
}

function recordedRepair(value: unknown): RateMismatch | null {
  const repair = value as { fromRate?: unknown; toRate?: unknown } | null;
  if (
    typeof repair?.fromRate !== "number" ||
    typeof repair.toRate !== "number"
  ) {
    return null;
  }
  return { fromRate: repair.fromRate, toRate: repair.toRate };
}

/**
 * What the meeting page shows for the tracks: the info note for a repair
 * (done or to do), or the warning for a bad ratio that has no repair. After
 * a failed repair (`repairError` in sync.json) the page shows the warning,
 * and the next transcription tries the repair again.
 */
export function trackRepairState(journal: Record<string, unknown>): {
  ratioWarning: number | null;
  repair: (RateMismatch & { repaired: boolean }) | null;
} {
  const done = recordedRepair(journal.repair);
  if (done) return { ratioWarning: null, repair: { ...done, repaired: true } };
  const plan = planTrackRepair(journal);
  if (plan && journal.repairError === undefined) {
    return { ratioWarning: null, repair: { ...plan, repaired: false } };
  }
  return {
    ratioWarning: trackRatioWarning(
      journal.micSamples,
      journal.systemSamples,
      journal.sampleRate,
    ),
    repair: null,
  };
}

/** Output samples per write. Keeps the memory flat for long meetings. */
const BLOCK_SAMPLES = 1 << 20;

/**
 * Repairs system.wav in `audioDir` when sync.json calls for it. Returns the
 * recorded repair, or null when nothing was done. Idempotent: sync.json
 * records the repair, and a second call does nothing.
 *
 * Synchronous, like the other file work of the transcribe job. The cost is
 * about 1.7 s of CPU per hour of a 1/3 meeting (24 taps per output sample),
 * once per meeting.
 *
 * Steps: resample into a temp file, keep the original as
 * system.original.wav, put the temp file in place, then write sync.json
 * (the last step commits the repair). When an earlier call stopped half
 * way, system.original.wav exists, and it is the source again.
 */
export function repairSystemTrack(audioDir: string): TrackRepair | null {
  const syncPath = join(audioDir, SYNC_JSON);
  let journal: Record<string, unknown>;
  try {
    journal = JSON.parse(readFileSync(syncPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
  if (journal === null || typeof journal !== "object") return null;
  const plan = planTrackRepair(journal);
  if (!plan) return null;

  const systemPath = join(audioDir, SYSTEM_WAV);
  const originalPath = join(audioDir, SYSTEM_ORIGINAL_WAV);
  const sourcePath = existsSync(originalPath) ? originalPath : systemPath;
  let info: ReturnType<typeof readWavInfo>;
  try {
    info = readWavInfo(sourcePath);
  } catch {
    return null;
  }
  // The recorder writes 16 kHz mono PCM16. Anything else is not ours.
  if (
    info.formatTag !== 1 ||
    info.channels !== 1 ||
    info.bitsPerSample !== 16 ||
    info.sampleRate !== journal.sampleRate
  ) {
    return null;
  }
  const source = readWavPcm16(sourcePath);
  if (!source) return null;

  // Output = input × fromRate / toRate: 48000 -> 16000 makes it 3 times longer.
  const resampler = createResampler(source.pcm, plan.fromRate, plan.toRate);
  const tempPath = join(audioDir, `${SYSTEM_WAV}.repair-tmp`);
  const tempSync = `${syncPath}.repair-tmp`;
  let replaced = false;
  try {
    const fd = openSync(tempPath, "w");
    try {
      writeSync(
        fd,
        wavHeader(
          { sampleRate: info.sampleRate, channels: 1, bitsPerSample: 16 },
          resampler.total * 2,
        ),
      );
      const block = new Int16Array(BLOCK_SAMPLES);
      for (let count = resampler.read(block); count > 0; ) {
        writeSync(fd, new Uint8Array(block.buffer, 0, count * 2));
        count = resampler.read(block);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    if (sourcePath === systemPath) renameSync(systemPath, originalPath);
    renameSync(tempPath, systemPath);
    replaced = true;
    const repair: TrackRepair = {
      ...plan,
      factor: plan.toRate / plan.fromRate,
      originalSystemSamples: source.pcm.length,
      repairedAt: Date.now(),
    };
    const { repairError: _oldError, ...rest } = journal;
    writeFileSync(
      tempSync,
      `${JSON.stringify({ ...rest, systemSamples: resampler.total, repair }, null, 2)}\n`,
      "utf8",
    );
    renameSync(tempSync, syncPath);
    return repair;
  } catch (err) {
    // Leave the folder as it was before the repair, then record the failure
    // so that the meeting page shows the warning. Each step is best effort.
    for (const path of [tempPath, tempSync]) {
      try {
        unlinkSync(path);
      } catch {
        // Not there.
      }
    }
    // Put the original back as system.wav, so the files match sync.json.
    if ((replaced || !existsSync(systemPath)) && existsSync(originalPath)) {
      try {
        renameSync(originalPath, systemPath);
      } catch {
        // The original stays as system.original.wav. The next run uses it.
      }
    }
    try {
      writeFileSync(
        syncPath,
        `${JSON.stringify({ ...journal, repairError: { message: String(err), at: Date.now() } }, null, 2)}\n`,
        "utf8",
      );
    } catch {
      // The disk can be full. The repair is retried at the next transcription.
    }
    throw err;
  }
}
