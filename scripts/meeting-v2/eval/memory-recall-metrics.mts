// The ranking metrics of memory-recall.mts, apart so that a test can import
// them without starting the run.

/** Meetings in the top list that count for recall. */
export const TOP = 10;

/** Recall@TOP, reciprocal rank and base rate of one ranked list of meetings. */
export function rankMetrics(
  ranked: readonly string[],
  relevant: ReadonlySet<string>,
  candidates: number,
): { recall: number; rr: number; baseRate: number; listed: number } {
  const top = ranked.slice(0, TOP);
  const found = top.filter((m) => relevant.has(m)).length;
  const first = ranked.findIndex((m) => relevant.has(m));
  return {
    recall: relevant.size > 0 ? found / relevant.size : 0,
    rr: first >= 0 ? 1 / (first + 1) : 0,
    baseRate: candidates > 0 ? relevant.size / candidates : 0,
    listed: ranked.length,
  };
}

/** Distinct meetings in order of first appearance. */
export function rankMeetings(hits: readonly { meetingId: string }[]): string[] {
  return [...new Set(hits.map((h) => h.meetingId))];
}
