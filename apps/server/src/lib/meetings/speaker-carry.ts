/**
 * Keep the confirmed speaker names over a re-transcribe
 * (specs/meeting-folder-batch.md 4). A re-transcribe writes new segments and
 * new speaker labels: label "2" of the new run has no fixed relationship to
 * label "2" of the old run. This rule maps each new label to an old label by
 * time overlap and moves the old name only when the match is clear.
 *
 * Rule: for a new label N and an old label O, overlap(N, O) is the sum of the
 * time that the system segments of N and of O share. N takes the row (name,
 * merge, suggestions) of O when O has the largest overlap with N, and:
 * - that overlap is at least MATCH_SHARE of all the overlap of N with old
 *   labeled segments, and
 * - that overlap is at least MATCH_SHARE of all the overlap of O with new
 *   labeled segments.
 * With MATCH_SHARE above 0.5, the two tests make the map one to one. Any
 * other case leaves N with no name, and the old name goes in the "not kept"
 * list that the meeting page shows. A name never moves to a speaker on a
 * guess.
 */

/** The share of the overlap that a match needs, in both directions. */
export const MATCH_SHARE = 0.8;

/** One system segment with its speaker label. */
export interface LabeledSpan {
  startMs: number;
  endMs: number;
  label: string;
}

/** One `meeting_speakers` row, without the meeting id. */
export interface SpeakerRow {
  speaker_label: string;
  display_name: string | null;
  suggested_name: string | null;
  suggested_evidence: string | null;
  suggested_kind: string | null;
  merged_into: string | null;
  confirmed_at: number | null;
  updated_at: number;
}

/** The map new label -> old label, for the clear matches only. */
export function matchSpeakerLabels(
  oldSpans: LabeledSpan[],
  newSpans: LabeledSpan[],
): Map<string, string> {
  const overlap = new Map<string, Map<string, number>>();
  const byOld = new Map<string, number>();
  for (const n of newSpans) {
    for (const o of oldSpans) {
      const ms = Math.min(n.endMs, o.endMs) - Math.max(n.startMs, o.startMs);
      if (ms <= 0) continue;
      const row = overlap.get(n.label) ?? new Map<string, number>();
      row.set(o.label, (row.get(o.label) ?? 0) + ms);
      overlap.set(n.label, row);
      byOld.set(o.label, (byOld.get(o.label) ?? 0) + ms);
    }
  }
  const map = new Map<string, string>();
  for (const [newLabel, row] of overlap) {
    let best: string | null = null;
    let bestMs = 0;
    let sum = 0;
    for (const [oldLabel, ms] of row) {
      sum += ms;
      // Ties go to the smaller label, so the result does not depend on the
      // order of the rows.
      if (ms > bestMs || (ms === bestMs && best !== null && oldLabel < best)) {
        best = oldLabel;
        bestMs = ms;
      }
    }
    if (
      best !== null &&
      bestMs >= MATCH_SHARE * sum &&
      bestMs >= MATCH_SHARE * (byOld.get(best) ?? 0)
    ) {
      map.set(newLabel, best);
    }
  }
  return map;
}

/**
 * The speaker rows for the new labels, and the confirmed names that could not
 * be kept (sorted, no duplicates). A merge moves only when its target label
 * also has a match; else the row keeps its own name and loses the merge.
 */
export function carrySpeakerRows(
  oldRows: SpeakerRow[],
  newToOld: Map<string, string>,
): { rows: SpeakerRow[]; lost: string[] } {
  const oldToNew = new Map<string, string>();
  for (const [newLabel, oldLabel] of newToOld) oldToNew.set(oldLabel, newLabel);
  const rows: SpeakerRow[] = [];
  const kept = new Set<string>();
  const lost = new Set<string>();
  for (const row of oldRows) {
    const label = oldToNew.get(row.speaker_label);
    if (label === undefined) {
      if (row.display_name) lost.add(row.display_name);
      continue;
    }
    if (row.display_name) kept.add(row.display_name);
    rows.push({
      ...row,
      speaker_label: label,
      merged_into: row.merged_into
        ? (oldToNew.get(row.merged_into) ?? null)
        : null,
    });
  }
  // A name that another kept row still carries is not lost.
  return { rows, lost: [...lost].filter((n) => !kept.has(n)).sort() };
}
