/**
 * Pure energy-gate segmenter for meeting audio.
 *
 * Splits a PCM16 channel into utterance segments using per-frame RMS with an
 * adaptive noise floor and hysteresis. No I/O, no logging — deterministic on
 * its inputs so it is trivially unit-testable.
 */

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
    if (
      gap <= o.maxGapMs &&
      merged <= o.maxSegmentMs &&
      last.endMs - last.startMs < o.targetMs
    ) {
      last.endMs = next.endMs;
    } else {
      out.push({ ...next });
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

/**
 * Segment a mono PCM16 channel into utterance chunks.
 *
 * Permissive by design: borderline audio is emitted as a segment rather than
 * dropped, since a false positive only costs an extra STT call.
 */
export function segmentPcm(
  pcm: Int16Array,
  sampleRate: number,
  optsIn?: Partial<SegmenterOptions>,
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

  return segments.map((s) => ({
    startMs: Math.round(s.startMs),
    endMs: Math.round(s.endMs),
  }));
}
