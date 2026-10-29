import { SETTINGS_KEYS } from "@openstyle/validations";
import { readSetting } from "../db.js";
import { extractContextTerms } from "./context-terms.js";
import { type MeetingRow, parseAttendees } from "./store.js";

/**
 * The meeting terms of the ASR bias prompt, in this order:
 * 1. The owner name (setting `owner_name`), when it has 2 or more letters.
 * 2. The full names of the calendar attendees (see {@link attendeeBiasNames}).
 * 3. The terms of the free-text context (PR #39, `extractContextTerms`).
 *
 * Duplicates are removed without regard to case; the first one stays. The
 * caller merges the list with the global vocabulary (`mergeContextVocabTerms`),
 * which keeps these terms first, so they win the 900-char prompt budget.
 *
 * Measured on 14 meetings with silver gold (2026-10-28, arm "B3"): span recall
 * went from 74.4% to 82.0%, and person names from 55.7% to 78.2%.
 */
export function buildMeetingBiasTerms(
  row: Pick<MeetingRow, "calendar_attendees" | "context">,
  ownerName: string | null | undefined,
): string[] {
  const owner = ownerName?.trim() ?? "";
  const head = letterCount(owner) >= 2 ? [owner] : [];
  const terms = [
    ...head,
    ...attendeeBiasNames(row),
    ...extractContextTerms(row.context ?? ""),
  ];
  const seen = new Set<string>();
  return terms.filter((term) => {
    const key = term.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** {@link buildMeetingBiasTerms} with the stored owner name. */
export function meetingBiasTerms(
  row: Pick<MeetingRow, "calendar_attendees" | "context"> | undefined,
): string[] {
  if (!row) return [];
  return buildMeetingBiasTerms(row, readSetting(SETTINGS_KEYS.ownerName));
}

/**
 * The most attendee names in the bias. About 15 chars each, so 20 names use
 * about 300 of the 900-char prompt budget. A large invite then cannot push
 * the context terms and the vocabulary out of the prompt.
 */
export const MAX_ATTENDEE_BIAS_NAMES = 20;

/**
 * The attendee names of the bias, in calendar order (the organizer first).
 * Each attendee gives its display name. An attendee with no display name
 * (the name is empty or is an email address) gives the name from its email
 * ({@link nameFromEmail}), or nothing. A name with fewer than 2 letters is
 * skipped. The calendar helper already skips rooms, resources and the user.
 */
function attendeeBiasNames(row: Pick<MeetingRow, "calendar_attendees">) {
  return parseAttendees(row)
    .map((a) => {
      const name = a.name.trim();
      if (name !== "" && !name.includes("@")) return name;
      return nameFromEmail(a.email.trim() || name) ?? "";
    })
    .filter((name) => letterCount(name) >= 2)
    .slice(0, MAX_ATTENDEE_BIAS_NAMES);
}

/**
 * "First Last" from an email of the form first.last@domain. Both parts must
 * be letters only, with 2 or more letters each. Each part gets title case.
 * Any other email gives null.
 */
export function nameFromEmail(email: string): string | null {
  const at = email.indexOf("@");
  if (at <= 0) return null;
  const m = /^(\p{L}{2,})\.(\p{L}{2,})$/u.exec(email.slice(0, at));
  if (!m) return null;
  const title = (s: string) =>
    s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  return `${title(m[1] as string)} ${title(m[2] as string)}`;
}

function letterCount(s: string): number {
  return s.match(/\p{L}/gu)?.length ?? 0;
}
