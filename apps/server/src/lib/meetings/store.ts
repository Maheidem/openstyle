import type { CalendarEvent } from "@openstyle/validations";
import { getDb } from "../db.js";

export interface MeetingRow {
  id: string;
  title: string | null;
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number | null;
  status: string;
  audio_dir: string | null;
  stt_provider: string | null;
  stt_model: string | null;
  /** Resolved (or user-set) transcription language, Phase A2. NULL means
   * "not yet resolved" — falls back to per-chunk auto or triggers
   * resolution on the next transcribe run. */
  language: string | null;
  /** Free-text per-meeting context (specs/meeting-speaker-naming.md §3.4),
   * editable anytime. Feeds both the naming prompt (§5.2) and the summarize
   * prompt (§9.3). NULL means unset — the common case, and every meeting
   * created before this migration. */
  context: string | null;
  error: string | null;
  created_at: number | null;
  /** Linked calendar event (specs/calendar-eventkit.md). All NULL when the
   * meeting is not linked. `calendar_attendees` is a JSON array. */
  calendar_event_id: string | null;
  calendar_title: string | null;
  calendar_start: number | null;
  calendar_end: number | null;
  calendar_url: string | null;
  calendar_attendees: string | null;
}

/** Attendees of the linked event. A bad or missing JSON value gives []. */
export function parseAttendees(
  row: Pick<MeetingRow, "calendar_attendees">,
): CalendarEvent["attendees"] {
  if (!row.calendar_attendees) return [];
  try {
    const parsed: unknown = JSON.parse(row.calendar_attendees);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((a) => {
      if (!a || typeof a !== "object") return [];
      const { name, email, isOrganizer } = a as Record<string, unknown>;
      return [
        {
          name: typeof name === "string" ? name : "",
          email: typeof email === "string" ? email : "",
          isOrganizer: isOrganizer === true,
        },
      ];
    });
  } catch {
    return [];
  }
}

/** The linked event as the API shows it, or null when not linked. */
export function toCalendarEvent(row: MeetingRow): CalendarEvent | null {
  if (!row.calendar_event_id) return null;
  return {
    id: row.calendar_event_id,
    title: row.calendar_title ?? "",
    start: row.calendar_start ?? 0,
    end: row.calendar_end ?? 0,
    url: row.calendar_url,
    attendees: parseAttendees(row),
  };
}

/**
 * The row without the six calendar columns. List and detail responses use it,
 * so raw attendee JSON (with emails) never leaves the server. The detail
 * response adds the `calendar` object instead.
 */
export function omitCalendarColumns(row: MeetingRow) {
  const {
    calendar_event_id: _id,
    calendar_title: _title,
    calendar_start: _start,
    calendar_end: _end,
    calendar_url: _url,
    calendar_attendees: _attendees,
    ...rest
  } = row;
  return rest;
}

/** One `meetings` row by id, or undefined when no row has that id. */
export function getMeetingRow(id: string): MeetingRow | undefined {
  return getDb().prepare("SELECT * FROM meetings WHERE id = ?").get(id) as
    | MeetingRow
    | undefined;
}
