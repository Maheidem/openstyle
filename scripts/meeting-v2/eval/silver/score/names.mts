// Pure helpers of the silver arm scorers (score_arms.mts, extract_unsup.mts):
// the attendee-name rule of the ASR bias and word-run counts. No I/O.
// nameFromEmail is the app rule (bias-terms.ts). The scorer keeps its own
// name filter (2+ characters, no cap), the rule that the arm results used.
import { nameFromEmail } from "../../../../../apps/server/src/lib/meetings/bias-terms.ts";

export { nameFromEmail };

/** The attendee names of the bias rule (display name, else first.last email). */
export function attendeeNames(json: string | null): string[] {
  if (!json) return [];
  return (JSON.parse(json) as { name?: string; email?: string }[])
    .map((a) => {
      const n = (a.name ?? "").trim();
      return n && !n.includes("@")
        ? n
        : (nameFromEmail((a.email ?? "").trim() || n) ?? "");
    })
    .filter((n) => n.length >= 2);
}

/** The name tokens (3 or more letters) of the attendee names, no duplicates. */
export function attendeeTokens(json: string | null): string[] {
  const out = new Set<string>();
  for (const full of attendeeNames(json))
    for (const t of full.split(/\s+/)) if (/^\p{L}{3,}$/u.test(t)) out.add(t);
  return [...out];
}

/** The number of times the word run `want` occurs in `hay`. */
export function countRun(hay: string[], want: string[]): number {
  let n = 0;
  for (let i = 0; i + want.length <= hay.length; i++)
    if (want.every((w, k) => hay[i + k] === w)) n++;
  return n;
}

/** True when the word run `want` occurs in `hay`. */
export function hasRun(hay: string[], want: string[]): boolean {
  return countRun(hay, want) > 0;
}
