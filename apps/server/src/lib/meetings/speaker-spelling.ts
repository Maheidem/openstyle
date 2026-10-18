/**
 * Spelling step for speaker-name suggestions (specs/calendar-eventkit.md).
 *
 * The LLM suggests a name from the transcript. This pure step then compares
 * that name with the names of the linked calendar event's attendees. It can
 * only fix the spelling of a suggestion that already exists. It never adds a
 * name, and it never changes the evidence or the kind. The LLM prompt does
 * not hold the attendee list.
 */

const MAX_NAME_CHARS = 80;
/** A first name must have at least this many letters for a one-letter typo fix. */
export const MIN_FUZZY_FIRST_NAME = 4;

/** An attendee sets their own display name, so treat it as untrusted text. */
function cleanName(name: string): string {
  return name
    .replace(/[\p{Cc}\p{Cf}"'`<>{}[\]\\]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_CHARS);
}

/** Edit distance, capped: returns 2 for any distance above 1. */
export function distanceAtMostOne(a: string, b: string): 0 | 1 | 2 {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 1) return 2;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) ? 1 : 2;
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  return long.slice(i + 1) === short.slice(i) ? 1 : 2;
}

interface Candidate {
  full: string;
  first: string;
  rest: string;
}

function split(name: string): { first: string; rest: string } {
  const [first = "", ...others] = name.toLowerCase().split(" ");
  return { first, rest: others.join(" ") };
}

/**
 * Returns the attendee's full name when exactly one attendee matches the
 * suggested name, else the suggested name unchanged.
 *
 * A match needs the first name to be equal (ignoring case) or one letter off
 * (first names of 4 letters or more only). When the suggestion has more than
 * a first name, the rest must be equal too. When two attendees match at the
 * same level, nothing changes. An exact match beats a one-letter match.
 */
export function fixNameSpelling(
  suggested: string,
  attendeeNames: string[],
): string {
  const wanted = cleanName(suggested);
  if (!wanted) return suggested;
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const raw of attendeeNames) {
    const full = cleanName(raw);
    const key = full.toLowerCase();
    if (!full || seen.has(key)) continue;
    seen.add(key);
    candidates.push({ full, ...split(full) });
  }
  const want = split(wanted);
  const exact: Candidate[] = [];
  const near: Candidate[] = [];
  for (const c of candidates) {
    if (want.rest && want.rest !== c.rest) continue;
    const d = distanceAtMostOne(want.first, c.first);
    if (d === 0) exact.push(c);
    else if (
      d === 1 &&
      want.first.length >= MIN_FUZZY_FIRST_NAME &&
      c.first.length >= MIN_FUZZY_FIRST_NAME
    )
      near.push(c);
  }
  const pool = exact.length > 0 ? exact : near;
  return pool.length === 1 && pool[0] ? pool[0].full : suggested;
}
