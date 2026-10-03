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
}

/** One `meetings` row by id, or undefined when no row has that id. */
export function getMeetingRow(id: string): MeetingRow | undefined {
  return getDb().prepare("SELECT * FROM meetings WHERE id = ?").get(id) as
    | MeetingRow
    | undefined;
}
