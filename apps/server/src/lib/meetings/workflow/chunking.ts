import { type MergedSegment, speakerDisplayLabel } from "../merge.js";

// Transcript chunking helpers, moved out of the old Enhance and Summarize
// modules with no behavior change (specs/meeting-enhance-agentic.md 11.5).
// WP5b deleted those modules; the workflow nodes import these.

/**
 * Rough token estimate (~4 chars/token), mirroring `@openstyle/stt`
 * tokens.ts. Shared by every meeting feature that chunks a transcript to a
 * token budget (`summarize.ts`, `enhance.ts`).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Overlap carried from the tail of one chunk into the head of the next, as a
 * fraction of the chunk budget (capped in tokens). Whole segments only — a
 * chunk never starts or ends mid-segment.
 */
const OVERLAP_FRACTION = 0.1;
const OVERLAP_MAX_TOKENS = 400;

/** Overlap budget for one chunk — shared by the chunker and the call-count
 *  math above so the two cannot drift apart. */
export function overlapTokens(budgetTokens: number): number {
  return Math.min(
    OVERLAP_MAX_TOKENS,
    Math.floor(budgetTokens * OVERLAP_FRACTION),
  );
}

/** One transcript line, `id` kept in the visible text so the model can address it. */
export function formatEnhanceLine(
  id: string,
  speaker: string,
  text: string,
): string {
  return `[${id}] ${speaker}: ${text}`;
}

export interface EnhanceSegment {
  id: string;
  speaker: string;
  text: string;
  /** Structured diarization label, kept alongside the formatted `speaker`
   *  display string (specs/meeting-speaker-naming.md §5.1/§5.3) — reading
   *  the label count for the maxOutputTokens bump below, or the phantom-
   *  label allowlist, must never re-parse `speaker`'s formatted text: once
   *  a speaker has a confirmed name, `speaker` renders as e.g. "Ana", not
   *  "Them 3". Undefined for "Me" segments and undiarized "Them" segments. */
  speakerLabel?: string;
}

export function lineTokensOf(s: EnhanceSegment): number {
  return estimateTokens(formatEnhanceLine(s.id, s.speaker, s.text)) + 1; // +1 for the newline
}

/**
 * Split id-bearing segments into whole-segment chunks bounded by
 * `budgetTokens` (a single oversized segment still becomes its own chunk).
 * Unlike `chunkTranscript` (`summarize.ts`), no overlap is carried between
 * chunks — corrections don't need cross-chunk continuity the way
 * summarization does, and carrying one would make a chunk's ids no longer
 * disjoint, breaking the per-chunk `validIds` guard below.
 */
export function chunkForEnhance(
  segments: EnhanceSegment[],
  budgetTokens: number,
): EnhanceSegment[][] {
  const chunks: EnhanceSegment[][] = [];
  let start = 0;
  while (start < segments.length) {
    let used = 0;
    let end = start;
    while (
      end < segments.length &&
      (end === start || used + lineTokensOf(segments[end]) <= budgetTokens)
    ) {
      used += lineTokensOf(segments[end]);
      end++;
    }
    chunks.push(segments.slice(start, end));
    start = end;
  }
  return chunks;
}

/** Format one merged segment as a labeled transcript line. The label rule
 * (named, numbered, or "Unidentified") lives in `speakerDisplayLabel`.
 * I2 (specs/meeting-transcription-v2.md §3.2): renders the enhanced text
 * when present, else the raw text — Enhance can change only some chunks,
 * so one summary can mix enhanced and raw lines. */
export function formatSegment(segment: MergedSegment): string {
  const text = segment.enhancedText ?? segment.text;
  return `${speakerDisplayLabel(segment, "Unidentified")}: ${text}`;
}

/**
 * Split the transcript into chunks of whole segments, each at most
 * `budgetTokens` (a single oversized segment still becomes its own chunk),
 * prepending a token-capped tail of the previous chunk as overlap.
 */
export function chunkTranscript(
  segments: readonly MergedSegment[],
  budgetTokens: number,
): string[] {
  const lines = segments.map(formatSegment);
  const lineTokens = lines.map((l) => estimateTokens(l) + 1); // +1 for the newline
  const overlapBudget = overlapTokens(budgetTokens);

  const chunks: string[] = [];
  let index = 0;
  while (index < lines.length) {
    // Fresh (non-overlap) segments for this chunk. Always take at least one
    // so an oversized single segment cannot stall the loop.
    const freshStart = index;
    let used = 0;
    while (
      index < lines.length &&
      (index === freshStart || used + lineTokens[index] <= budgetTokens)
    ) {
      used += lineTokens[index];
      index++;
    }

    // Overlap: trailing whole segments of the previous chunk, newest-last,
    // within the overlap budget.
    const overlap: string[] = [];
    let overlapUsed = 0;
    for (let j = freshStart - 1; j >= 0; j--) {
      if (overlapUsed + lineTokens[j] > overlapBudget) break;
      overlap.unshift(lines[j]);
      overlapUsed += lineTokens[j];
    }

    chunks.push([...overlap, ...lines.slice(freshStart, index)].join("\n"));
  }
  return chunks;
}
