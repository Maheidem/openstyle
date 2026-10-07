/**
 * Pure energy-gate segmenter for meeting audio.
 *
 * Splits a PCM16 channel into utterance segments using per-frame RMS with an
 * adaptive noise floor and hysteresis. No logging. Every function is
 * deterministic on its inputs, so it is easy to unit-test. Only
 * `segmentWavFile` reads a file.
 */

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
 * Raw gate openings in frame indices [startFrame, endFrame).
 *
 * The adaptive noise floor is computed online as the rolling minimum of
 * lightly smoothed RMS over the configured window, clamped to
 * `minNoiseFloorDb` — and frozen while the gate is open so sustained speech
 * cannot raise the floor and choke itself off.
 */
function gateFrames(
  rmsDb: Float64Array,
  opts: SegmenterOptions,
): Array<[number, number]> {
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

  for (let i = 0; i < rmsDb.length; i++) {
    acc = 0.7 * acc + 0.3 * rmsDb[i];
    if (!open) {
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
  return raw.filter(([s, e]) => e - s >= minSpeechFrames);
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
 */
export function splitAlignedChunk(
  chunk: { startMs: number; endMs: number },
  words: AlignedWord[],
  turns: DiarizerSegment[],
  sourceText?: string,
): AlignedPart[] {
  if (turns.length === 0) return [];
  const ts = turns
    .map((t) => ({
      speaker: t.speakerId,
      startMs: Math.round(t.startTimeSeconds * 1000),
      endMs: Math.round(t.endTimeSeconds * 1000),
    }))
    .sort((a, b) => a.startMs - b.startMs);

  const parts: AlignedPart[] = [];
  let run: AlignedPart | null = null;
  let runSpeaker: string | null = null;

  const sourceTokens =
    sourceText !== undefined
      ? sourceText.split(/\s+/).filter((t) => t.length > 0)
      : null;
  const oneToOne =
    sourceTokens !== null && sourceTokens.length === words.length;
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
    if (run && runSpeaker === speaker) {
      run.endMs = Math.max(run.endMs, absEnd);
      run.text = `${run.text} ${text}`;
    } else {
      run = {
        startMs: absStart,
        endMs: Math.max(absEnd, absStart + 1),
        text,
        speakerId: speaker,
      };
      runSpeaker = speaker;
      parts.push(run);
    }
  }
  return parts;
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
  const openings = gateFrames(rmsDb, opts);
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
  return mergeSegmentsToward(
    segmentPcm(channel.pcm, channel.sampleRate, undefined, turns),
  );
}
