import type { CalendarEvent } from "@openstyle/validations";

// ---------------------------------------------------------------------------
// Pure helpers of the import dialog "Which meeting is this?" (issue #445).
// ---------------------------------------------------------------------------

/** The shortest text that counts as a "contains" match. */
const MIN_CONTAINS_CHARS = 3;

/**
 * Normalize a title for the match: lowercase, punctuation to spaces, one
 * space between words. For a file name, also drop the extension and a
 * trailing browser copy suffix such as " (1)".
 */
export function normalizeTitle(text: string, isFileName = false): string {
  let s = text;
  if (isFileName) {
    s = s.replace(/\.[^./\\]+$/, "").replace(/\s*\(\d+\)\s*$/, "");
  }
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * True when the event title matches the file name: equal after
 * normalization, or one contains the other (the shorter side needs at
 * least 3 characters, so a short name does not match every event).
 */
export function titleMatchesFile(
  eventTitle: string,
  fileName: string,
): boolean {
  const a = normalizeTitle(eventTitle);
  const b = normalizeTitle(fileName, true);
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= MIN_CONTAINS_CHARS && long.includes(short);
}

export interface RankedEvent {
  event: CalendarEvent;
  matches: boolean;
}

/** Events that match the file name first, then by start time. */
export function rankEvents(
  events: CalendarEvent[],
  fileName: string,
): RankedEvent[] {
  return events
    .map((event) => ({
      event,
      matches: titleMatchesFile(event.title, fileName),
    }))
    .sort(
      (x, y) =>
        Number(y.matches) - Number(x.matches) || x.event.start - y.event.start,
    );
}

/** Start and end (epoch ms) of the local day that holds `at`, moved `offset` days. */
export function localDayWindow(
  at: number,
  offset = 0,
): { from: number; to: number } {
  const d = new Date(at);
  const y = d.getFullYear();
  const m = d.getMonth();
  const day = d.getDate() + offset;
  return {
    from: new Date(y, m, day).getTime(),
    to: new Date(y, m, day + 1).getTime(),
  };
}

/** A stable key for one event (a recurring event repeats its id). */
export function eventKey(event: CalendarEvent): string {
  return `${event.id}@${event.start}`;
}
