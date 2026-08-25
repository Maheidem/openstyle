/**
 * Pure transcript-merge helpers for meeting mode.
 *
 * Takes the per-channel chunk transcripts (mic = "Me", system = "Them"),
 * applies optional clock-drift correction, filters common whisper silence
 * hallucinations and stuck-loop repeats, dedups speaker echo (my mic picking
 * up the remote speaker), and interleaves everything by corrected start time.
 *
 * No I/O and no dependencies — deterministic on its inputs.
 */

export type Speaker = "Me" | "Them";

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface MergedSegment {
  speaker: Speaker;
  startMs: number;
  endMs: number;
  text: string;
}

/**
 * Drift-correction inputs. Each channel's recorder emits periodic sync
 * markers pairing a wallclock timestamp with the total samples written so
 * far; `epochs` give each channel's recording-start wallclock. From two or
 * more markers per channel we fit wallclock ≈ a·streamMs + b and map both
 * channels onto a shared timeline.
 */
export interface SyncEpoch {
  channel: "mic" | "system";
  t0WallclockMs: number;
}

export interface SyncMarker {
  channel: "mic" | "system";
  wallclockMs: number;
  totalSamples: number;
}

export interface SyncData {
  sampleRate: number;
  epochs?: SyncEpoch[];
  syncMarkers?: SyncMarker[];
}

/** Corrections below this are noise — leave timestamps untouched. */
const DRIFT_APPLY_THRESHOLD_MS = 500;

/** Echo dedup: mic copy must overlap the system segment within this slack. */
const ECHO_WINDOW_MS = 1000;
const ECHO_SIMILARITY_THRESHOLD = 0.7;

/** Repeat filter: identical normalized text this many times in a row. */
const REPEAT_MIN_RUN = 3;

/**
 * Common whisper hallucinations on silence/noise. Matched against the whole
 * normalized segment text (or, for the phrase-y ones, as a prefix).
 */
const HALLUCINATION_EXACT = new Set([
  "thank you",
  "thanks",
  "thank you for watching",
  "thanks for watching",
  "bye",
  "bye bye",
  "you",
  "the end",
  "silence",
  "music",
  "applause",
  "laughter",
]);

const HALLUCINATION_PREFIXES = [
  "subtitles by",
  "subtitled by",
  "captions by",
  "captioning by",
  "transcribed by",
  "translated by",
  "copyright",
  "www.",
  "please subscribe",
  "don't forget to subscribe",
  "thanks for watching",
  "thank you for watching",
];

/** Lowercase, strip punctuation, collapse whitespace. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Token-based Jaccard similarity over normalized text. */
export function textSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeText(a).split(" ").filter(Boolean));
  const tb = new Set(normalizeText(b).split(" ").filter(Boolean));
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** True when the segment is a known silence hallucination. */
export function isHallucination(seg: TranscriptSegment): boolean {
  const norm = normalizeText(seg.text);
  if (norm.length === 0) return true;
  // Only short, low-content segments qualify — real speech saying "thank
  // you" mid-sentence lives inside longer text and survives.
  const words = norm.split(" ").length;
  const shortEnough = words <= 8;
  if (shortEnough && HALLUCINATION_EXACT.has(norm)) return true;
  if (shortEnough && HALLUCINATION_PREFIXES.some((p) => norm.startsWith(p))) {
    return true;
  }
  return false;
}

/**
 * Same-channel consecutive-repeat filter: whisper stuck-loop output repeats
 * one phrase over and over. Runs of >= REPEAT_MIN_RUN identical normalized
 * texts keep only the first occurrence.
 */
export function filterConsecutiveRepeats(
  segments: TranscriptSegment[],
): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  let i = 0;
  while (i < segments.length) {
    const norm = normalizeText(segments[i].text);
    let j = i + 1;
    while (j < segments.length && normalizeText(segments[j].text) === norm) j++;
    const runLength = j - i;
    if (runLength >= REPEAT_MIN_RUN) {
      out.push(segments[i]);
    } else {
      for (let k = i; k < j; k++) out.push(segments[k]);
    }
    i = j;
  }
  return out;
}

interface ChannelCorrection {
  /** wallclock ≈ a·streamMs + b */
  a: number;
  b: number;
}

/** Least-squares fit of wallclockMs against streamMs for one channel. */
function fitChannel(
  channel: "mic" | "system",
  sync: SyncData,
): ChannelCorrection | null {
  const points: Array<[number, number]> = [];
  const epoch = sync.epochs?.find((e) => e.channel === channel);
  if (epoch) points.push([0, epoch.t0WallclockMs]);
  for (const m of sync.syncMarkers ?? []) {
    if (m.channel !== channel) continue;
    points.push([(m.totalSamples / sync.sampleRate) * 1000, m.wallclockMs]);
  }
  if (points.length === 0) return null;
  if (points.length === 1) return { a: 1, b: points[0][1] - points[0][0] };

  const n = points.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const [x, y] of points) {
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { a: 1, b: (sy - sx) / n };
  const a = (n * sxy - sx * sy) / denom;
  const b = (sy - a * sx) / n;
  return { a, b };
}

/**
 * Map both channels' segment times onto a shared timeline anchored at the
 * earlier channel's start. Corrections are only applied when the implied
 * shift exceeds DRIFT_APPLY_THRESHOLD_MS somewhere in that channel's
 * segments; small deltas are treated as measurement noise.
 */
function applyDrift(
  mic: TranscriptSegment[],
  system: TranscriptSegment[],
  sync: SyncData | undefined,
): { mic: TranscriptSegment[]; system: TranscriptSegment[] } {
  if (!sync) return { mic, system };
  const micFit = fitChannel("mic", sync);
  const sysFit = fitChannel("system", sync);
  if (!micFit || !sysFit) return { mic, system };

  const base = Math.min(micFit.b, sysFit.b);
  const correct = (segs: TranscriptSegment[], fit: ChannelCorrection) => {
    const map = (t: number) => fit.a * t + fit.b - base;
    const maxDelta = segs.reduce(
      (acc, s) =>
        Math.max(
          acc,
          Math.abs(map(s.startMs) - s.startMs),
          Math.abs(map(s.endMs) - s.endMs),
        ),
      0,
    );
    if (maxDelta <= DRIFT_APPLY_THRESHOLD_MS) return segs;
    return segs.map((s) => ({
      ...s,
      startMs: Math.round(map(s.startMs)),
      endMs: Math.round(map(s.endMs)),
    }));
  };

  return { mic: correct(mic, micFit), system: correct(system, sysFit) };
}

/** Overlap (with slack) between two segments in ms-domain. */
function overlapsWithin(
  a: TranscriptSegment,
  b: TranscriptSegment,
  slackMs: number,
): boolean {
  return a.startMs <= b.endMs + slackMs && b.startMs <= a.endMs + slackMs;
}

/**
 * Merge per-channel transcripts into one interleaved, speaker-labeled
 * transcript ordered by (drift-corrected) start time.
 *
 * Pipeline: drift correction → hallucination filter → same-channel repeat
 * filter → speaker-echo dedup (system audio leaking into the mic: when a Me
 * segment overlaps a Them segment within ±1 s and the texts are >0.7
 * similar, the mic copy is dropped — Them wins) → sort.
 */
export function mergeTranscript(
  micSegments: TranscriptSegment[],
  systemSegments: TranscriptSegment[],
  syncData?: SyncData,
): MergedSegment[] {
  const { mic, system } = applyDrift(micSegments, systemSegments, syncData);

  const clean = (segs: TranscriptSegment[]) =>
    filterConsecutiveRepeats(segs.filter((s) => !isHallucination(s)));

  const micClean = clean(mic);
  const systemClean = clean(system);

  const micKept = micClean.filter(
    (m) =>
      !systemClean.some(
        (s) =>
          overlapsWithin(m, s, ECHO_WINDOW_MS) &&
          textSimilarity(m.text, s.text) > ECHO_SIMILARITY_THRESHOLD,
      ),
  );

  const merged: MergedSegment[] = [
    ...micKept.map((s) => ({ speaker: "Me" as const, ...s })),
    ...systemClean.map((s) => ({ speaker: "Them" as const, ...s })),
  ];
  merged.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return merged;
}

/** `mm:ss` (or `h:mm:ss` past an hour) clock timestamp for a segment start. */
function formatClockMs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

/**
 * Render a merged, speaker-labeled transcript as a standalone markdown
 * document — `[timestamp] Speaker: text` per segment — so a meeting's audio
 * directory is self-contained without requiring the app or DB.
 */
export function formatTranscriptMarkdown(segments: MergedSegment[]): string {
  const lines = segments.map(
    (s) => `**[${formatClockMs(s.startMs)}] ${s.speaker}:** ${s.text}`,
  );
  return `# Transcript\n\n${lines.length > 0 ? lines.join("\n\n") : "_No speech was detected in this recording._"}\n`;
}
