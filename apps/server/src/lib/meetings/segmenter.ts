/**
 * Pure energy-gate segmenter for meeting audio.
 *
 * Splits a PCM16 channel into utterance segments using per-frame RMS with an
 * adaptive noise floor and hysteresis. No logging. Every function is
 * deterministic on its inputs, so it is easy to unit-test. Only
 * `segmentWavFile` reads a file.
 */

import { wordEndsSentence, wordEndsTurn } from "@openstyle/stt";
import { readWavPcm16 } from "../audio/wav.js";
import type { DiarizerSegment } from "./diarize.js";

export interface SegmenterOptions {
  /** Analysis frame length in ms. */
  frameMs: number;
  /** Window (ms) for the adaptive noise-floor rolling minimum. */
  noiseFloorWindowMs: number;
  /** Noise floor never drops below this (dBFS). */
  minNoiseFloorDb: number;
  /** Gate opens when frame RMS exceeds floor + this (dB). */
  openThresholdDb: number;
  /** Gate closes when frame RMS falls below floor + this (dB). */
  closeThresholdDb: number;
  /** Openings shorter than this (ms) are discarded. */
  minSpeechMs: number;
  /** Gate stays open this long (ms) after the level drops. */
  hangoverMs: number;
  /** Extend each segment backward by this many ms. */
  padBeforeMs: number;
  /** Extend each segment forward by this many ms. */
  padAfterMs: number;
  /** Merge segments whose gap is smaller than this (ms). */
  coalesceGapMs: number;
  /** Force-split segments longer than this (ms). */
  maxSegmentMs: number;
}

export interface Segment {
  startMs: number;
  endMs: number;
  /** The diarizer speaker this part belongs to (specs/meeting-
   *  transcription-v2.md §3.4, system channel only). Set by
   *  `cutAtSpeakerChanges`; undefined for parts with no overlapping turn
   *  and for every mic-channel segment. */
  speaker?: string;
  /**
   * Speech evidence (PR #38): total ms of 20 ms frames in [startMs,
   * endMs) whose RMS exceeds the channel noise floor + SILENCE_GATE_DB.
   * Set by `annotateSpeechEvidence` (via `segmentWavFile`); undefined on
   * segments that skip the annotation (e.g. retry-failed rebuilds from the
   * DB), which disables the pre-ASR silence gate for them.
   */
  voicedMs?: number;
}

export const DEFAULT_SEGMENTER_OPTIONS: SegmenterOptions = {
  frameMs: 20,
  noiseFloorWindowMs: 10_000,
  minNoiseFloorDb: -70,
  openThresholdDb: 9,
  closeThresholdDb: 6,
  minSpeechMs: 250,
  hangoverMs: 700,
  padBeforeMs: 300,
  padAfterMs: 400,
  coalesceGapMs: 2000,
  maxSegmentMs: 30_000,
};

export interface MergeTowardOptions {
  /** Target segment length (ms) — merging stops once a segment reaches this. */
  targetMs: number;
  /** Never bridge a gap wider than this (ms) — a real pause stays a pause. */
  maxGapMs: number;
  /** Hard cap — matches segmentPcm's existing maxSegmentMs default. */
  maxSegmentMs: number;
}

export const DEFAULT_MERGE_TOWARD_OPTIONS: MergeTowardOptions = {
  targetMs: 22_500, // midpoint of the ~20-25s WhisperX-style target
  maxGapMs: 4000,
  maxSegmentMs: DEFAULT_SEGMENTER_OPTIONS.maxSegmentMs, // 30_000, single source of truth
};

/**
 * Greedily merge adjacent same-channel segments toward `targetMs`, never
 * crossing a gap wider than `maxGapMs` and never exceeding `maxSegmentMs`.
 * Input must already be time-ordered (segmentPcm's output is).
 *
 * Purely a post-processing pass over already-detected segment boundaries —
 * does not touch the VAD gate itself (specs/meeting-transcription-quality.md
 * §5, §7 non-goal: "Phase B does not retune the VAD gate").
 */
export function mergeSegmentsToward(
  segments: Segment[],
  opts: Partial<MergeTowardOptions> = {},
): Segment[] {
  const o = { ...DEFAULT_MERGE_TOWARD_OPTIONS, ...opts };
  if (segments.length === 0) return [];
  const out: Segment[] = [{ ...segments[0] }];
  for (let i = 1; i < segments.length; i++) {
    const last = out[out.length - 1];
    const next = segments[i];
    const gap = next.startMs - last.endMs;
    const merged = next.endMs - last.startMs;
    // A speaker cut is a hard boundary (specs/meeting-transcription-v2.md
    // §3.4): two parts that carry DIFFERENT speakers never merge. Parts of
    // the same speaker (or a part with no speaker) still merge toward the
    // target as before. When they merge, an unlabeled part absorbs the
    // neighbor's attribution — otherwise "no-turn, A, B" merges into one
    // unlabeled chunk and swallows the A|B boundary (the part's speech
    // came from the labeled neighbor).
    const differentSpeakers =
      last.speaker !== undefined &&
      next.speaker !== undefined &&
      last.speaker !== next.speaker;
    if (
      gap <= o.maxGapMs &&
      merged <= o.maxSegmentMs &&
      last.endMs - last.startMs < o.targetMs &&
      !differentSpeakers
    ) {
      last.endMs = next.endMs;
      last.speaker ??= next.speaker;
    } else {
      // The speaker cut blocks the merge, but the gap audio (speech that
      // the VAD found between the two parts) must still be sent to the
      // model — otherwise a word in the gap is lost (council finding,
      // 2026-10-07: a 2660 ms gap between two speakers' parts went
      // unsent in R4b). Give the gap to a neighbor: extend the new part
      // back to `last.endMs` (preferred — the cut stays at the speaker
      // boundary) unless that would pass the 30 s cap; otherwise extend
      // `last` forward to `next.startMs`; if both would pass the cap,
      // keep the gap (it is shorter than 4 s and neither side can take
      // it).
      const part = { ...next };
      if (differentSpeakers && gap > 0 && gap <= o.maxGapMs) {
        if (next.endMs - last.endMs <= o.maxSegmentMs) {
          part.startMs = last.endMs;
        } else if (next.startMs - last.startMs <= o.maxSegmentMs) {
          last.endMs = next.startMs;
        }
      }
      out.push(part);
    }
  }
  return out;
}

const SILENCE_DB = -100;

/** Per-frame RMS in dBFS for PCM16 samples. */
function frameRmsDb(
  pcm: Int16Array,
  frameSamples: number,
  frameCount: number,
): Float64Array {
  const out = new Float64Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    const start = f * frameSamples;
    const end = Math.min(start + frameSamples, pcm.length);
    let sumSq = 0;
    for (let i = start; i < end; i++) {
      const s = pcm[i] / 32768;
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, end - start));
    out[f] = rms > 0 ? Math.max(SILENCE_DB, 20 * Math.log10(rms)) : SILENCE_DB;
  }
  return out;
}

/**
 * Raw gate openings in frame indices [startFrame, endFrame), plus the
 * adaptive noise floor the run ends with (dBFS).
 *
 * The adaptive noise floor is computed online as the rolling minimum of
 * lightly smoothed RMS over the configured window, clamped to
 * `minNoiseFloorDb` — and frozen while the gate is open so sustained speech
 * cannot raise the floor and choke itself off. Because it only updates
 * while the gate is CLOSED, it tracks the silence level even when the
 * stream ends mid-speech.
 *
 * `floorDb` (the returned channel floor, used by the speech-evidence
 * count, PR #38) is the MEDIAN of the smoothed levels over ALL gate-
 * CLOSED frames of the channel, excluding digital silence (≤
 * NO_FLOOR_LEVEL_DB — recorder-muted frames). A trailing silence can be
 * digital (recorder off), so the online floor's end state is not the
 * channel's noise level; and a speech-dense channel makes any plain
 * percentile speech-biased. Gate-closed frames are pauses — the true
 * noise regime — in either case. Fallback (no usable closed frames):
 * the online floor's end state.
 */
/** Frames at or below this (dBFS) are digital silence, not noise. */
const NO_FLOOR_LEVEL_DB = -90;

function gateFrames(
  rmsDb: Float64Array,
  opts: SegmenterOptions,
): { openings: Array<[number, number]>; floorDb: number } {
  const framesPerMs = 1 / opts.frameMs;
  const hangoverFrames = Math.round(opts.hangoverMs * framesPerMs);
  const minSpeechFrames = Math.max(
    1,
    Math.round(opts.minSpeechMs * framesPerMs),
  );
  const windowFrames = Math.max(
    1,
    Math.round(opts.noiseFloorWindowMs * framesPerMs),
  );

  const raw: Array<[number, number]> = [];
  let open = false;
  let start = 0;
  let lastLoud = 0;

  // Online floor state: smoothed RMS + monotonic min-deque of recent
  // gate-closed frames (values with their "age" position).
  let acc = rmsDb.length > 0 ? rmsDb[0] : SILENCE_DB;
  const dequeVal: number[] = [];
  const dequePos: number[] = [];
  let pos = 0;
  let floor = Math.max(opts.minNoiseFloorDb, acc);
  // Channel floor (PR #38): smoothed levels of every gate-closed frame.
  const closedLevels: number[] = [];

  for (let i = 0; i < rmsDb.length; i++) {
    acc = 0.7 * acc + 0.3 * rmsDb[i];
    if (!open) {
      closedLevels.push(acc);
      while (dequeVal.length > 0 && dequeVal[dequeVal.length - 1] >= acc) {
        dequeVal.pop();
        dequePos.pop();
      }
      dequeVal.push(acc);
      dequePos.push(pos);
      pos++;
      while (dequePos[0] <= pos - windowFrames) {
        dequeVal.shift();
        dequePos.shift();
      }
      floor = Math.max(opts.minNoiseFloorDb, dequeVal[0]);
    }

    const loud = rmsDb[i] > floor + opts.openThresholdDb;
    const quiet = rmsDb[i] < floor + opts.closeThresholdDb;
    if (!open) {
      if (loud) {
        open = true;
        start = i;
        lastLoud = i;
      }
    } else {
      if (!quiet) lastLoud = i;
      else if (i - lastLoud >= hangoverFrames) {
        raw.push([start, lastLoud + 1]);
        open = false;
      }
    }
  }
  if (open) raw.push([start, rmsDb.length]);

  // Min speech duration measured on the pre-hangover opening.
  const live = closedLevels.filter((v) => v > NO_FLOOR_LEVEL_DB);
  let channelFloor = floor;
  if (live.length > 0) {
    live.sort((a, b) => a - b);
    channelFloor = live[Math.floor(live.length / 2)]!;
  }
  return {
    openings: raw.filter(([s, e]) => e - s >= minSpeechFrames),
    floorDb: Math.max(opts.minNoiseFloorDb, channelFloor),
  };
}

/** Pad, clamp, and merge overlapping segments (ms domain). */
function padAndMerge(
  segments: Segment[],
  totalMs: number,
  opts: SegmenterOptions,
): Segment[] {
  const padded = segments.map((s) => ({
    startMs: Math.max(0, s.startMs - opts.padBeforeMs),
    endMs: Math.min(totalMs, s.endMs + opts.padAfterMs),
  }));
  return mergeWithGap(padded, 0);
}

/** Merge segments whose gap is smaller than `gapMs`. */
function mergeWithGap(segments: Segment[], gapMs: number): Segment[] {
  const out: Segment[] = [];
  for (const seg of segments) {
    const last = out[out.length - 1];
    if (last && seg.startMs - last.endMs < gapMs + Number.EPSILON) {
      last.endMs = Math.max(last.endMs, seg.endMs);
    } else {
      out.push({ ...seg });
    }
  }
  return out;
}

/**
 * Split segments longer than `maxSegmentMs` at the lowest-energy frame within
 * the middle portion (25%–75%) of the segment, recursively.
 */
function forceSplit(
  segments: Segment[],
  rmsDb: Float64Array,
  opts: SegmenterOptions,
): Segment[] {
  const out: Segment[] = [];
  const stack = [...segments].reverse();
  while (stack.length > 0) {
    const seg = stack.pop() as Segment;
    if (seg.endMs - seg.startMs <= opts.maxSegmentMs) {
      out.push(seg);
      continue;
    }
    const startFrame = Math.floor(seg.startMs / opts.frameMs);
    const endFrame = Math.min(
      rmsDb.length,
      Math.ceil(seg.endMs / opts.frameMs),
    );
    const span = endFrame - startFrame;
    const lo = startFrame + Math.floor(span * 0.25);
    const hi = startFrame + Math.ceil(span * 0.75);
    let minIdx = lo;
    for (let i = lo; i < hi; i++) {
      if (rmsDb[i] < rmsDb[minIdx]) minIdx = i;
    }
    const splitMs = Math.round((minIdx + 0.5) * opts.frameMs);
    if (splitMs <= seg.startMs || splitMs >= seg.endMs) {
      // Degenerate span; split down the middle rather than dropping audio.
      const mid = Math.round((seg.startMs + seg.endMs) / 2);
      stack.push({ startMs: mid, endMs: seg.endMs });
      stack.push({ startMs: seg.startMs, endMs: mid });
      continue;
    }
    stack.push({ startMs: splitMs, endMs: seg.endMs });
    stack.push({ startMs: seg.startMs, endMs: splitMs });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Speaker cuts (specs/meeting-transcription-v2.md §3.4, I4)
// ---------------------------------------------------------------------------

/** Turns shorter than this join the previous turn (flicker absorption). */
const FLICKER_MS = 1000;
/** A cut part shorter than this merges into a neighbor. */
const SHORT_PART_MS = 1500;
/** Cuts snap to the lowest-energy frame within this window. */
const SNAP_WINDOW_MS = 300;

interface TurnSlice {
  speaker: string;
  startMs: number;
  endMs: number;
}

/** Join neighbor turns of the same speaker (spec §3.4 step 2/4). */
function mergeSameSpeakerTurns(turns: TurnSlice[]): TurnSlice[] {
  const out: TurnSlice[] = [];
  for (const t of turns) {
    const last = out[out.length - 1];
    if (last && last.speaker === t.speaker) {
      last.endMs = Math.max(last.endMs, t.endMs);
    } else {
      out.push({ ...t });
    }
  }
  return out;
}

/** Remove flicker (spec §3.4 step 3): a turn under 1 s joins the previous
 * turn; the first turn, if under 1 s, joins the next. */
function absorbFlicker(turns: TurnSlice[]): TurnSlice[] {
  if (turns.length === 0) return [];
  const out: TurnSlice[] = [];
  for (const t of turns) {
    const last = out[out.length - 1];
    if (last && t.endMs - t.startMs < FLICKER_MS) {
      last.endMs = Math.max(last.endMs, t.endMs);
    } else {
      out.push({ ...t });
    }
  }
  if (out.length >= 2 && out[0].endMs - out[0].startMs < FLICKER_MS) {
    out[1].startMs = out[0].startMs;
    out.shift();
  }
  return out;
}

/**
 * Snap a cut to the lowest-energy frame within +/- SNAP_WINDOW_MS of the
 * turn start (spec §3.4 step 5), kept strictly inside the segment.
 */
function snapCut(
  cutMs: number,
  segStartMs: number,
  segEndMs: number,
  rmsDb: Float64Array,
  frameMs: number,
): number {
  const lo = Math.max(segStartMs, cutMs - SNAP_WINDOW_MS);
  const hi = Math.min(segEndMs, cutMs + SNAP_WINDOW_MS);
  const loFrame = Math.max(0, Math.ceil(lo / frameMs));
  const hiFrame = Math.min(rmsDb.length, Math.floor(hi / frameMs) + 1);
  if (hiFrame <= loFrame) {
    return Math.min(Math.max(cutMs, segStartMs + 1), segEndMs - 1);
  }
  let best = loFrame;
  for (let i = loFrame; i < hiFrame; i++) {
    if (rmsDb[i] < rmsDb[best]) best = i;
  }
  const snapped = Math.round((best + 0.5) * frameMs);
  return Math.min(Math.max(snapped, segStartMs + 1), segEndMs - 1);
}

/** The turn with the most overlap with the part; undefined when no turn
 * overlaps it at all (spec §3.4 step 7: that part gets no speaker). */
function ownerSpeaker(part: Segment, turns: TurnSlice[]): string | undefined {
  let best: string | undefined;
  let bestMs = 0;
  for (const t of turns) {
    const overlap =
      Math.min(part.endMs, t.endMs) - Math.max(part.startMs, t.startMs);
    if (overlap > bestMs) {
      best = t.speaker;
      bestMs = overlap;
    }
  }
  return best;
}

/**
 * A part shorter than SHORT_PART_MS merges into the previous part, taking
 * the speaker of the longer of the two (spec §3.4 step 8). This is where a
 * sub-1.5 s sliver of one speaker joins a longer neighbor of the other —
 * the deliberate opposite of `mergeSegmentsToward`, which never merges
 * across different speakers.
 *
 * Step 8 also covers the FIRST part: the loop only ever merges a part into
 * the one before it, so a short opening part (a cut that lands 1.2 s in)
 * would otherwise survive as a near-empty chunk of its own. After the loop
 * it merges into the next part, keeping the longer part's speaker.
 */
function mergeShortParts(parts: Segment[]): Segment[] {
  if (parts.length <= 1) return parts;
  const out: Segment[] = [{ ...parts[0] }];
  for (let i = 1; i < parts.length; i++) {
    const last = out[out.length - 1];
    const cur = parts[i];
    if (cur.endMs - cur.startMs < SHORT_PART_MS) {
      const lastDur = last.endMs - last.startMs;
      if (cur.endMs - cur.startMs > lastDur) last.speaker = cur.speaker;
      last.endMs = cur.endMs;
    } else {
      out.push({ ...cur });
    }
  }
  if (out.length > 1 && out[0].endMs - out[0].startMs < SHORT_PART_MS) {
    const firstDur = out[0].endMs - out[0].startMs;
    if (firstDur > out[1].endMs - out[1].startMs)
      out[1].speaker = out[0].speaker;
    out[1].startMs = out[0].startMs;
    out.shift();
  }
  return out;
}

function cutSegment(
  seg: Segment,
  turns: TurnSlice[],
  rmsDb: Float64Array,
  frameMs: number,
): Segment[] {
  // Step 1: the turns that overlap the segment, clipped to it.
  const clipped: TurnSlice[] = [];
  for (const t of turns) {
    if (t.endMs <= seg.startMs || t.startMs >= seg.endMs) continue;
    clipped.push({
      speaker: t.speaker,
      startMs: Math.max(t.startMs, seg.startMs),
      endMs: Math.min(t.endMs, seg.endMs),
    });
  }
  if (clipped.length === 0) return [seg];

  // Steps 2-4: same-speaker neighbors, flicker, same-speaker again.
  let live = mergeSameSpeakerTurns(clipped);
  live = absorbFlicker(live);
  live = mergeSameSpeakerTurns(live);

  if (live.length === 1) {
    return [{ ...seg, speaker: live[0].speaker }];
  }

  // Steps 5-6: one cut per speaker change (each turn start after the
  // first), snapped to the lowest-energy frame.
  const bounds = [seg.startMs];
  for (let i = 1; i < live.length; i++) {
    bounds.push(
      snapCut(live[i].startMs, seg.startMs, seg.endMs, rmsDb, frameMs),
    );
  }
  bounds.push(seg.endMs);
  // Snapping can push a cut onto its neighbor: keep bounds strictly
  // increasing so no part is empty. The +1 ms nudge must stay inside the
  // segment (a second-to-last cut snapped to seg.endMs would otherwise
  // push the final bound past it).
  for (let i = 1; i < bounds.length; i++) {
    if (bounds[i] <= bounds[i - 1]) {
      bounds[i] = Math.min(bounds[i - 1] + 1, seg.endMs);
    }
  }

  const parts: Segment[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const part: Segment = { startMs: bounds[i], endMs: bounds[i + 1] };
    const speaker = ownerSpeaker(part, live);
    if (speaker !== undefined) part.speaker = speaker;
    parts.push(part);
  }

  // Step 8: short parts merge into a neighbor.
  return mergeShortParts(parts);
}

/**
 * One aligned word span (specs/meeting-transcription-v2.md §3.6): start and
 * end in ms RELATIVE to the aligned audio's start (the chunk slice).
 */
export interface AlignedWord {
  text: string;
  startMs: number;
  endMs: number;
}

/**
 * One part of a split mixed chunk (§3.6): absolute times from the part's
 * first and last word, the words' text, and the diarizer speaker whose turn
 * holds each word's midpoint.
 */
export interface AlignedPart {
  startMs: number;
  endMs: number;
  text: string;
  speakerId: string;
}

export interface AlignedSplitResult {
  parts: AlignedPart[];
  /** Candidate speaker cuts DROPPED (no sentence end within one word). */
  cutsDropped: number;
  /** Kept cuts whose two parts carried the SAME speaker label and were
   * merged back together (2.14.1: the split did no visible work). */
  sameSpeakerMerges: number;
}

/**
 * Decision (owner, 2026-10-07, spec 3.6): after the sentence-end snap, a
 * part shorter than this merges into its neighbor. The phase 4
 * `mergeShortParts` 1500 ms rule does not apply here: its input was
 * ENERGY segments, while here the parts are word-aligned and the
 * sub-second parts are the diarizer's false changes inside continuous
 * speech.
 */
const MIN_ALIGNED_PART_MS = 1000;

/** One kept word: absolute times, the display text (source token when
 * available), and the speaker by the midpoint rule. */
interface KeptWord {
  startMs: number;
  endMs: number;
  text: string;
  speaker: string;
}

/** A part under construction: the share bookkeeping (words per speaker,
 * word time per speaker, first-appearance order) decides the label of a
 * mixed part — the words stay with the speaker of the larger share. */
interface PartAcc {
  startMs: number;
  endMs: number;
  text: string;
  words: Map<string, number>;
  time: Map<string, number>;
  order: string[];
}

function accOf(word: KeptWord): PartAcc {
  return {
    startMs: word.startMs,
    endMs: word.endMs,
    text: word.text,
    words: new Map([[word.speaker, 1]]),
    time: new Map([[word.speaker, word.endMs - word.startMs]]),
    order: [word.speaker],
  };
}

function accAdd(acc: PartAcc, word: KeptWord): void {
  acc.startMs = Math.min(acc.startMs, word.startMs);
  acc.endMs = Math.max(acc.endMs, word.endMs);
  acc.text = `${acc.text} ${word.text}`;
  acc.words.set(word.speaker, (acc.words.get(word.speaker) ?? 0) + 1);
  acc.time.set(
    word.speaker,
    (acc.time.get(word.speaker) ?? 0) + (word.endMs - word.startMs),
  );
  if (!acc.order.includes(word.speaker)) acc.order.push(word.speaker);
}

/** The larger share: most words; tie: longer total word time; tie: the
 * speaker seen first in the part. */
function accSpeaker(acc: PartAcc): string {
  let best = acc.order[0]!;
  let bestWords = acc.words.get(best) ?? 0;
  let bestTime = acc.time.get(best) ?? 0;
  for (const s of acc.order.slice(1)) {
    const w = acc.words.get(s) ?? 0;
    const t = acc.time.get(s) ?? 0;
    if (w > bestWords || (w === bestWords && t > bestTime)) {
      best = s;
      bestWords = w;
      bestTime = t;
    }
  }
  return best;
}

function accToPart(acc: PartAcc): AlignedPart {
  return {
    startMs: acc.startMs,
    endMs: Math.max(acc.endMs, acc.startMs + 1),
    text: acc.text,
    speakerId: accSpeaker(acc),
  };
}

/**
 * Decision (owner, 2026-10-07, spec 3.6), rule 2a: merge a part shorter
 * than MIN_ALIGNED_PART_MS into its LARGER neighbor (tie: the previous
 * part). A merge only grows parts, so one restart loop terminates.
 */
/** Combine parts (in time order) into one: the span, the joined text
 * and the share bookkeeping; the label is the larger share of ALL the
 * merged words. */
function mergeAccs(parts: PartAcc[]): PartAcc {
  const merged: PartAcc = {
    startMs: Math.min(...parts.map((p) => p.startMs)),
    endMs: Math.max(...parts.map((p) => p.endMs)),
    text: parts.map((p) => p.text).join(" "),
    words: new Map(),
    time: new Map(),
    order: [],
  };
  for (const p of parts) {
    for (const [s, n] of p.words) {
      merged.words.set(s, (merged.words.get(s) ?? 0) + n);
    }
    for (const [s, t] of p.time) {
      merged.time.set(s, (merged.time.get(s) ?? 0) + t);
    }
    for (const s of p.order) {
      if (!merged.order.includes(s)) merged.order.push(s);
    }
  }
  return merged;
}

function mergeShortAlignedParts(accs: PartAcc[]): PartAcc[] {
  const out = [...accs];
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < out.length; i += 1) {
      const p = out[i]!;
      if (p.endMs - p.startMs >= MIN_ALIGNED_PART_MS) continue;
      const prevDur = i > 0 ? out[i - 1]!.endMs - out[i - 1]!.startMs : -1;
      const nextDur =
        i + 1 < out.length ? out[i + 1]!.endMs - out[i + 1]!.startMs : -1;
      const j = nextDur > prevDur ? i + 1 : i - 1;
      if (j < 0 || j >= out.length) continue;
      const q = out[j]!;
      const ordered = j < i ? [q, p] : [p, q]; // time order
      const merged = mergeAccs(ordered);
      // i and j are adjacent: remove both, insert the merged part once.
      out.splice(Math.min(i, j), 2, merged);
      changed = true;
      break; // indices shifted
    }
  }
  return out;
}

/**
 * Decision (owner, 2026-10-07, spec 3.6), rule 2b: an A-B-A middle part
 * merges into the surrounding A WHEN the middle part does not START
 * after a sentence end (the previous part's last word must end a
 * sentence for the B to be a real reply and stay separate).
 */
/**
 * Decision (owner, 2026-10-07, spec 3.6, 2.14.1): merge neighboring
 * parts that carry the SAME speaker label into one part. A kept cut can
 * snap so that both sides' word-midpoint majority is one speaker — the
 * split did no visible work (a24a70ec #20 in the council round 4 read).
 * Returns the merged parts and how many merges happened.
 */
function mergeSameSpeakerParts(accs: PartAcc[]): {
  parts: PartAcc[];
  merges: number;
} {
  const out: PartAcc[] = [];
  let merges = 0;
  for (const p of accs) {
    const last = out[out.length - 1];
    if (last !== undefined && accSpeaker(last) === accSpeaker(p)) {
      out[out.length - 1] = mergeAccs([last, p]);
      merges += 1;
    } else {
      out.push(p);
    }
  }
  return { parts: out, merges };
}

function mergeAbbaParts(accs: PartAcc[]): PartAcc[] {
  const lastWordEndsSentence = (acc: PartAcc): boolean => {
    const words = acc.text.split(/\s+/).filter((t) => t.length > 0);
    return words.length > 0 && wordEndsSentence(words[words.length - 1]!);
  };
  const out = [...accs];
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 1; i + 1 < out.length; i += 1) {
      const a = out[i - 1]!;
      const b = out[i]!;
      const c = out[i + 1]!;
      if (accSpeaker(a) !== accSpeaker(c)) continue;
      if (accSpeaker(a) === accSpeaker(b)) continue;
      // The middle part STARTS after a sentence end when the previous
      // part's last word ends a sentence: then it is a real reply.
      if (lastWordEndsSentence(a)) continue;
      out.splice(i - 1, 3, mergeAccs([a, b, c]));
      changed = true;
      break; // indices shifted
    }
  }
  return out;
}

/** The snap window of the cut rule; overlaps within it are noise. */
export const SPEAKER_OVERLAP_TOLERANCE_MS = 300;

/**
 * Does this span hold turns of two or more distinct speakers beyond the
 * snap window? The same rule as the `multiTurnChunks` metric (§3.4) and the
 * phase 4 cut rule: same-speaker multi-turn overlap is normal, only a
 * second speaker makes a chunk mixed. Pure.
 */
export function isMixedChunk(
  startMs: number,
  endMs: number,
  turns: DiarizerSegment[],
  toleranceMs: number = SPEAKER_OVERLAP_TOLERANCE_MS,
): boolean {
  const speakers = new Set<string>();
  for (const t of turns) {
    const overlap =
      Math.min(endMs, t.endTimeSeconds * 1000) -
      Math.max(startMs, t.startTimeSeconds * 1000);
    if (overlap > toleranceMs) {
      speakers.add(t.speakerId);
      if (speakers.size >= 2) return true;
    }
  }
  return false;
}

/** The turn whose span holds `ms`; null when none does (a gap). */
function turnAt(
  ms: number,
  turns: Array<{ speaker: string; startMs: number; endMs: number }>,
): string | null {
  for (const t of turns) {
    if (ms >= t.startMs && ms <= t.endMs) return t.speaker;
  }
  return null;
}

/** Nearest turn by distance of `ms` to the turn span (ties: earlier). */
function nearestTurn(
  ms: number,
  turns: Array<{ speaker: string; startMs: number; endMs: number }>,
): { speaker: string; startMs: number } | null {
  let best: { speaker: string; startMs: number } | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const t of turns) {
    const dist =
      ms < t.startMs ? t.startMs - ms : ms > t.endMs ? ms - t.endMs : 0;
    if (
      dist < bestDist ||
      (dist === bestDist && best !== null && t.startMs < best.startMs)
    ) {
      best = { speaker: t.speaker, startMs: t.startMs };
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Split a mixed chunk's aligned words at the diarizer's change times
 * (specs/meeting-transcription-v2.md §3.6, step 3). Pure: same inputs, same
 * output. Each word goes to the speaker whose turn holds the word's
 * MIDPOINT; a word in a gap between turns takes the NEAREST turn (the
 * diarizer leaves small gaps; the word was spoken, so it must land
 * somewhere). Each run of words of one speaker becomes one part, with
 * start/end from its first and last word (absolute ms: the chunk's start
 * plus the word's relative time). Words with no usable text are skipped;
 * when no part survives, the caller keeps the chunk unsplit.
 *
 * `sourceText` (the chunk's original ASR text): the aligner's words are
 * normalized (no punctuation, no case). When the ASR text's token count
 * matches the word count 1:1, each part is built from the ORIGINAL
 * tokens in order, so punctuation and sentence capitals survive the
 * split — joining the parts with a single space reproduces the chunk
 * text. On a count mismatch the normalized words are used (the previous
 * behavior); the metrics' `punctRatio` keeps such a chunk visible.
 *
 * 2.14.1: a cut must snap onto a TURN end (not a Portuguese tag
 * question, `wordEndsTurn`), and neighboring parts that carry the SAME
 * speaker label are merged into one part (the split did no visible
 * work) — the count of those merges comes back as `sameSpeakerMerges`.
 */
export function splitAlignedChunk(
  chunk: { startMs: number; endMs: number },
  words: AlignedWord[],
  turns: DiarizerSegment[],
  sourceText?: string,
): AlignedSplitResult {
  if (turns.length === 0)
    return { parts: [], cutsDropped: 0, sameSpeakerMerges: 0 };
  const ts = turns
    .map((t) => ({
      speaker: t.speakerId,
      startMs: Math.round(t.startTimeSeconds * 1000),
      endMs: Math.round(t.endTimeSeconds * 1000),
    }))
    .sort((a, b) => a.startMs - b.startMs);

  const sourceTokens =
    sourceText !== undefined
      ? sourceText.split(/\s+/).filter((t) => t.length > 0)
      : null;
  const oneToOne =
    sourceTokens !== null && sourceTokens.length === words.length;

  // The kept words, in order, with the speaker by the midpoint rule.
  const kept: KeptWord[] = [];
  let tokenIdx = 0;
  for (const w of words) {
    // The token cursor advances for EVERY word (skipped ones included):
    // the mapping is positional over the whole word list.
    const srcToken = oneToOne ? (sourceTokens as string[])[tokenIdx] : null;
    tokenIdx += 1;
    if (!Number.isFinite(w.startMs) || !Number.isFinite(w.endMs)) continue;
    const absStart = Math.round(chunk.startMs + w.startMs);
    const absEnd = Math.round(chunk.startMs + w.endMs);
    const mid = (absStart + absEnd) / 2;
    const speaker = turnAt(mid, ts) ?? nearestTurn(mid, ts)?.speaker ?? null;
    if (speaker === null) continue;
    const text = srcToken ?? w.text.trim();
    // A word is a unit with letters or digits; a punctuation-only item
    // (the aligner can split "!" off) carries no speech and no part.
    if (!/\p{L}|\p{N}/u.test(text)) continue;
    kept.push({ startMs: absStart, endMs: absEnd, text, speaker });
  }
  if (kept.length === 0)
    return { parts: [], cutsDropped: 0, sameSpeakerMerges: 0 };

  // Decision (owner, 2026-10-07, spec 3.6), rule 1: the diarizer makes
  // false speaker changes inside continuous speech (24 of 25 bad cuts in
  // the council data came after a word with no sentence end). A cut is
  // only kept when it can be snapped onto the NEAREST word boundary
  // within +-1 word of the change that FOLLOWS a sentence end (. ? !
  // and the Portuguese/Spanish equivalents, incl. closing quotes);
  // otherwise it is DROPPED and the words stay with the speaker of the
  // larger share of the chunk (the part's label rule below).
  // 2.14.1 (council round 4): the end must be a TURN end, not just a
  // sentence end — a Portuguese tag question ("sabe?", "tá?") ends the
  // clause but the speaker continues, so a cut there lands inside one
  // speaker's own explanation (wordEndsTurn; English "?" still ends a
  // turn).
  const n = kept.length;
  const cuts = new Set<number>(); // boundary index 1..n-1: after word i-1
  let cutsDropped = 0;
  for (let b = 1; b < n; b += 1) {
    if (kept[b - 1]!.speaker === kept[b]!.speaker) continue;
    let snapped: number | null = null;
    for (const cand of [b, b - 1, b + 1]) {
      if (cand < 1 || cand > n - 1) continue;
      if (wordEndsTurn(kept[cand - 1]!.text)) {
        snapped = cand;
        break;
      }
    }
    if (snapped === null) cutsDropped += 1;
    else cuts.add(snapped);
  }

  // The parts: word groups between the kept cuts.
  const groups: PartAcc[] = [];
  let cur = accOf(kept[0]!);
  for (let i = 1; i < n; i += 1) {
    if (cuts.has(i)) {
      groups.push(cur);
      cur = accOf(kept[i]!);
    } else {
      accAdd(cur, kept[i]!);
    }
  }
  groups.push(cur);

  // Decision rule 2: post-snap cleanup (short parts, A-B-A, and — 2.14.1 —
  // same-label neighbor merge). A merge can only REMOVE parts, and each
  // merge strictly reduces the part count, so running the passes to a
  // fixed point terminates. (A merged part's label is recomputed over ALL
  // its words, so one pass can expose a new same-label adjacency.)
  let accs = groups;
  let sameSpeakerMerges = 0;
  for (;;) {
    const next = mergeSameSpeakerParts(
      mergeAbbaParts(mergeShortAlignedParts(accs)),
    );
    sameSpeakerMerges += next.merges;
    if (next.parts.length === accs.length) break;
    accs = next.parts;
  }
  return {
    parts: accs.map(accToPart),
    cutsDropped,
    sameSpeakerMerges,
  };
}

/**
 * Cut system-channel segments at speaker changes (specs/meeting-
 * transcription-v2.md §3.4). Pure: same inputs, same output. `turns` are the
 * diarizer turns in time order; `rmsDb` is the per-frame energy in the same
 * frame layout `segmentPcm` computes (frame length `frameMs`). Segments
 * with no overlapping turn are returned untouched (no speaker).
 */
export function cutAtSpeakerChanges(
  segments: Segment[],
  turns: DiarizerSegment[],
  rmsDb: Float64Array,
  frameMs: number,
): Segment[] {
  if (turns.length === 0) return segments.map((s) => ({ ...s }));
  // The cut rule (flicker absorption, same-speaker re-join) assumes time
  // order. The diarizer output is sanitized at the source (diarize.ts),
  // but this is a pure function with a public contract — sort here too,
  // cheaply, so a caller with unsorted turns still gets correct parts.
  const turnSlices: TurnSlice[] = turns
    .map((t) => ({
      speaker: t.speakerId,
      startMs: Math.round(t.startTimeSeconds * 1000),
      endMs: Math.round(t.endTimeSeconds * 1000),
    }))
    .sort((a, b) => a.startMs - b.startMs);
  const out: Segment[] = [];
  for (const seg of segments) {
    out.push(...cutSegment(seg, turnSlices, rmsDb, frameMs));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Speech evidence (PR #38: skip noise-floor-only mic chunks before ASR)
// ---------------------------------------------------------------------------

/**
 * A frame counts as voiced for `chunkVoicedMs` when its RMS exceeds the
 * channel noise floor + this (dB). Owner decision (PR #38), final: +6 dB
 * with MIN_MIC_VOICED_MS = 60. Source: a grid over 6 real meetings. In
 * meeting ca70f895 the mic noise floor is about -51 dBFS, and the model
 * wrote "Okay." for at least 11 chunks at that floor. At +6 dB / 60 ms the
 * grid showed: 13 of 28 silent "Okay." rows removed, 18 of 586 mic ASR
 * calls saved, and 1 kept row at risk.
 */
export const SILENCE_GATE_DB = 6;

/**
 * Minimum voiced evidence (ms) for a mic chunk to be sent to the ASR
 * provider. Below it the transcriber marks the chunk `empty` and does not
 * call the provider. A model asked to transcribe noise floor writes
 * "Okay." or echoes the prompt. Owner decision (PR #38): 60 ms, chosen
 * with SILENCE_GATE_DB above (see the grid numbers there). A higher value
 * removes more "Okay." rows but puts more real short replies at risk.
 */
export const MIN_MIC_VOICED_MS = 60;

/**
 * Total ms of the 20 ms frames inside [startMs, endMs) whose RMS exceeds
 * `floorDb + gateDb`. Pure and deterministic.
 */
export function chunkVoicedMs(
  rmsDb: Float64Array,
  frameMs: number,
  startMs: number,
  endMs: number,
  floorDb: number,
  gateDb: number = SILENCE_GATE_DB,
): number {
  const first = Math.max(0, Math.floor(startMs / frameMs));
  const last = Math.min(rmsDb.length, Math.ceil(endMs / frameMs));
  const gate = floorDb + gateDb;
  let voiced = 0;
  for (let f = first; f < last; f++) {
    if (rmsDb[f]! > gate) voiced += frameMs;
  }
  return voiced;
}

/**
 * The channel noise floor (dBFS) for a whole channel: the median of the
 * gate-closed smoothed levels, excluding digital silence (see
 * `gateFrames` for why the online floor's end state is not used). The
 * speech-evidence gate level is `floor + SILENCE_GATE_DB`. Deterministic
 * on the input.
 */
export function channelNoiseFloorDb(
  pcm: Int16Array,
  sampleRate: number,
  optsIn?: Partial<SegmenterOptions>,
): number {
  const opts: SegmenterOptions = { ...DEFAULT_SEGMENTER_OPTIONS, ...optsIn };
  const frameSamples = Math.max(
    1,
    Math.round((opts.frameMs / 1000) * sampleRate),
  );
  const frameCount = Math.max(1, Math.ceil(pcm.length / frameSamples));
  const rmsDb = frameRmsDb(pcm, frameSamples, frameCount);
  return gateFrames(rmsDb, opts).floorDb;
}

/**
 * Annotate FINAL segments (post merge / force-split / speaker cuts) with
 * `voicedMs` — the speech-evidence count the transcriber uses to skip
 * noise-floor-only chunks (PR #38). The floor is the segmenter's own
 * adaptive noise floor for the whole channel (`channelNoiseFloorDb`), so
 * the gate level is consistent with what opened the VAD.
 *
 * Re-derives the per-frame RMS (the segmenter already did once in
 * `segmentPcm`); for a one-hour channel that is a couple of hundred ms of
 * pure CPU — cheap next to the STT calls it saves.
 */
export function annotateSpeechEvidence(
  pcm: Int16Array,
  sampleRate: number,
  segments: Segment[],
  optsIn?: Partial<SegmenterOptions>,
): Segment[] {
  if (segments.length === 0) return segments;
  const opts: SegmenterOptions = { ...DEFAULT_SEGMENTER_OPTIONS, ...optsIn };
  const frameSamples = Math.max(
    1,
    Math.round((opts.frameMs / 1000) * sampleRate),
  );
  const frameCount = Math.max(1, Math.ceil(pcm.length / frameSamples));
  const rmsDb = frameRmsDb(pcm, frameSamples, frameCount);
  const floorDb = gateFrames(rmsDb, opts).floorDb;
  return segments.map((s) => ({
    ...s,
    voicedMs: chunkVoicedMs(rmsDb, opts.frameMs, s.startMs, s.endMs, floorDb),
  }));
}

/**
 * Segment a mono PCM16 channel into utterance chunks.
 *
 * Permissive by design: borderline audio is emitted as a segment rather than
 * dropped, since a false positive only costs an extra STT call.
 *
 * `turns` (specs/meeting-transcription-v2.md §3.4): diarizer turns that cut
 * the segments at speaker changes. Only the CALLER decides which channel
 * gets them (the system track only — the mic is never cut).
 */
export function segmentPcm(
  pcm: Int16Array,
  sampleRate: number,
  optsIn?: Partial<SegmenterOptions>,
  turns?: DiarizerSegment[],
): Segment[] {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`segmentPcm: invalid sampleRate ${sampleRate}`);
  }
  const opts: SegmenterOptions = { ...DEFAULT_SEGMENTER_OPTIONS, ...optsIn };
  if (pcm.length === 0) return [];

  const frameSamples = Math.max(
    1,
    Math.round((opts.frameMs / 1000) * sampleRate),
  );
  const frameCount = Math.ceil(pcm.length / frameSamples);
  const totalMs = (pcm.length / sampleRate) * 1000;

  const rmsDb = frameRmsDb(pcm, frameSamples, frameCount);
  const openings = gateFrames(rmsDb, opts).openings;
  if (openings.length === 0) return [];

  let segments: Segment[] = openings.map(([s, e]) => ({
    startMs: s * opts.frameMs,
    endMs: Math.min(totalMs, e * opts.frameMs),
  }));

  segments = padAndMerge(segments, totalMs, opts);
  segments = mergeWithGap(segments, opts.coalesceGapMs);
  segments = forceSplit(segments, rmsDb, opts);
  if (turns && turns.length > 0) {
    segments = cutAtSpeakerChanges(segments, turns, rmsDb, opts.frameMs);
  }

  return segments.map((s) => ({
    ...s,
    startMs: Math.round(s.startMs),
    endMs: Math.round(s.endMs),
  }));
}

/**
 * Segment one on-disk WAV channel. Returns null when the file is missing. A
 * bad header still throws. Only the segments leave this function, so the PCM
 * can be freed before the next channel is read. `turns` are diarizer speaker
 * cuts (specs/meeting-transcription-v2.md §3.4); pass them only for the
 * system channel.
 */
export function segmentWavFile(
  path: string,
  turns?: DiarizerSegment[],
): Segment[] | null {
  const channel = readWavPcm16(path);
  if (!channel) return null;
  // Speech evidence for every final chunk (PR #38): the transcriber skips
  // mic chunks whose voicedMs is under MIN_MIC_VOICED_MS instead of asking
  // the model to transcribe noise floor.
  return annotateSpeechEvidence(
    channel.pcm,
    channel.sampleRate,
    mergeSegmentsToward(
      segmentPcm(channel.pcm, channel.sampleRate, undefined, turns),
    ),
  );
}
