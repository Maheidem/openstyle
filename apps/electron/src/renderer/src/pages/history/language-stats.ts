// Pure helpers of the "By language" stats section (issue #443).

/** One row of GET /api/history/stats `by_language`. null: Unknown. */
export interface LanguageStatRow {
  language: string | null;
  dictations: number;
  words: number;
  audio_ms: number;
}

/**
 * Whole-percent shares of `values` that sum to 100 (largest remainder).
 * All zero gives all zero.
 */
export function roundShares(values: number[]): number[] {
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return values.map(() => 0);
  const exact = values.map((v) => (v / total) * 100);
  const floors = exact.map(Math.floor);
  let left = 100 - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((e, i) => ({ i, rest: e - Math.floor(e) }))
    .sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    left -= 1;
  }
  return floors;
}

/** The share label: "<1%" for a share above 0 that rounds to 0. */
export function formatShare(rounded: number, value: number): string {
  if (rounded === 0 && value > 0) return "<1%";
  return `${rounded}%`;
}

/** Words per minute, or null when the row has no audio (shown as "—"). */
export function languageWpm(row: LanguageStatRow): number | null {
  if (row.language === null || row.audio_ms <= 0) return null;
  return Math.round(row.words / (row.audio_ms / 60000));
}
