/**
 * Meeting speaker naming — resolution pass (specs/meeting-speaker-naming.md
 * §4). Turns the `meeting_speakers` name/merge mapping into effective
 * `speakerLabel`/`speakerName` values on an already-built `MergedSegment[]`.
 *
 * Runs strictly *after* `mergeTranscript` (merge.ts) returns, as a
 * post-process pass — `mergeTranscript` itself stays pure, so every existing
 * `meeting-merge.test.ts` assertion about its own contract (drift,
 * hallucination filter, repeat collapse, dedup) is untouched by this
 * feature.
 */

import type { MergedSegment } from "./merge.js";

export interface SpeakerMapRow {
  speakerLabel: string;
  displayName: string | null;
  mergedInto: string | null;
}

/**
 * Mutates `segments` in place: for each system-channel segment with a
 * speaker_label, resolves any merge (one hop — merged_into targets are
 * never themselves merged, §3.2) to an effective label, and — only when
 * that effective label has a confirmed display_name — attaches it as
 * `speakerName`. `suggested_name` is never read here: suggestions are
 * dialog-only data (ground rule #1), never fed into rendering.
 *
 * The merge target does NOT need its own `meeting_speakers` row to be a
 * valid target — §3.1's rows are lazy, and the common real case is exactly
 * "merge a singleton into a speaker nobody has named or suggested yet."
 * Resolving against `row.mergedInto` (a label string) rather than against
 * `byLabel.get(row.mergedInto)` (a row that may not exist) is what makes
 * that case work: a missing row means "this label exists, unnamed," never
 * "this merge doesn't apply."
 */
export function resolveSpeakerNames(
  segments: MergedSegment[],
  rows: SpeakerMapRow[],
): void {
  const byLabel = new Map(rows.map((r) => [r.speakerLabel, r]));
  for (const seg of segments) {
    if (seg.speaker !== "Them" || !seg.speakerLabel) continue;
    const row = byLabel.get(seg.speakerLabel);
    const effectiveLabel = row?.mergedInto ?? seg.speakerLabel;
    seg.speakerLabel = effectiveLabel; // collapses merged clusters to one
    // visible label, even when neither side has ever been named
    const name = byLabel.get(effectiveLabel)?.displayName;
    if (name) seg.speakerName = name;
  }
}
