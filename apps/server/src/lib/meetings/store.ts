import type { CalendarEvent } from "@openstyle/validations";
import { getDb } from "../db.js";

export interface MeetingRow {
  id: string;
  folder_id: string | null;
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
  /** 1 = the audio retention sweep skips this meeting (schema 47). */
  retention_exempt: number;
  /** JSON array of the confirmed speaker names that the last re-transcribe
   * could not keep (schema 48). NULL means none. */
  speaker_names_lost: string | null;
  /** "live" while the transcript comes from the live loop (schema 52). */
  transcript_source: string | null;
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
 * The row without the six calendar columns and the raw JSON of
 * `speaker_names_lost`. List and detail responses use it, so raw attendee
 * JSON (with emails) never leaves the server. The detail response adds the
 * `calendar` object and the parsed names instead.
 */
export function omitCalendarColumns(row: MeetingRow) {
  const {
    calendar_event_id: _id,
    calendar_title: _title,
    calendar_start: _start,
    calendar_end: _end,
    calendar_url: _url,
    calendar_attendees: _attendees,
    speaker_names_lost: _lost,
    ...rest
  } = row;
  return rest;
}

/** The names of `speaker_names_lost`. A bad or missing value gives []. */
export function parseLostNames(row: Pick<MeetingRow, "speaker_names_lost">) {
  if (!row.speaker_names_lost) return [];
  try {
    const parsed: unknown = JSON.parse(row.speaker_names_lost);
    return Array.isArray(parsed)
      ? parsed.filter((n): n is string => typeof n === "string")
      : [];
  } catch {
    return [];
  }
}

/** One `meetings` row by id, or undefined when no row has that id. */
export function getMeetingRow(id: string): MeetingRow | undefined {
  return getDb().prepare("SELECT * FROM meetings WHERE id = ?").get(id) as
    | MeetingRow
    | undefined;
}

/**
 * The status that the badge shows (PR #258). `meetings.status` is the
 * pipeline state, and its CHECK has no Enhance value. The badge says
 * `enhanced` when the transcript holds Enhance corrections and the summary
 * did not complete: none was saved (`transcribed`), or the saved one was
 * repaired from a cut answer (`summarized` with `summaryPartial`). Every
 * other case shows `status` as it is.
 */
export function displayStatusOf(
  status: string,
  enhanced: boolean,
  summaryPartial: boolean,
): string {
  if (!enhanced) return status;
  if (status === "transcribed") return "enhanced";
  if (status === "summarized" && summaryPartial) return "enhanced";
  return status;
}

/** `displayStatusOf` with the facts read from the database. */
export function meetingDisplayStatus(row: Pick<MeetingRow, "id" | "status">) {
  if (row.status !== "transcribed" && row.status !== "summarized") {
    return row.status;
  }
  const facts = getDb()
    .prepare(
      `SELECT
         EXISTS (SELECT 1 FROM meeting_segments
                 WHERE meeting_id = ? AND enhanced_text IS NOT NULL
                   AND enhanced_text <> '') AS enhanced,
         COALESCE((SELECT partial FROM meeting_summaries
                   WHERE meeting_id = ?), 0) AS partial`,
    )
    .get(row.id, row.id) as { enhanced: number; partial: number };
  return displayStatusOf(row.status, facts.enhanced === 1, facts.partial === 1);
}
