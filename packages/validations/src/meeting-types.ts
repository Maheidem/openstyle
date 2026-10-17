import type { CalendarEvent } from "./meeting-calendar.js";

// Response types for the meetings API. The server builds these shapes, the
// Electron main process passes them on, and the renderer reads them. This
// file has no runtime code. Use `import type` to read it.

/** One row of `GET /api/meetings`. */
export interface MeetingListItem {
  id: string;
  title: string | null;
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number | null;
  status: string;
  /** Resolved (or user-set) transcription language, Phase A2. NULL means
   * "not yet resolved". The language chip shows "Auto". */
  language: string | null;
  error: string | null;
  created_at: number | null;
}

/**
 * The body of `GET /api/meetings/:id`. `POST /api/meetings/import` returns the
 * same shape, so the renderer needs no second fetch.
 */
export interface MeetingDetail extends MeetingListItem {
  stt_provider: string | null;
  stt_model: string | null;
  audio_dir: string | null;
  /** Free-text per-meeting context (specs/meeting-speaker-naming.md §3.4),
   * editable anytime. Feeds both the naming prompt and the summarize
   * prompt. NULL means unset. */
  context: string | null;
  /** The linked calendar event, or null (specs/calendar-eventkit.md). */
  calendar: CalendarEvent | null;
  job: {
    done: number;
    total: number;
    failed: number;
    /** Which job holds the slot (server `activeJobKinds`). "summarize" is the
     * async Summarize job (specs/meeting-llm-queue.md §5.6). The `status` of
     * the meeting stays `transcribed` while the job runs. This field is the
     * only signal that tells the UI that a summarize is in progress. */
    kind?:
      | "transcribe"
      | "retry-failed"
      | "diarize"
      | "summarize"
      | "enhance"
      | null;
    /** Set while one of the job's LLM calls waits for its lane (§5.5). */
    queued?: { ahead: number; sinceMs: number } | null;
  } | null;
  /** Canonical failure text of the last background job (Summarize) for this
   * meeting, or null. This is not the `error` column. That column is the
   * transcript-integrity banner (§6 constraint 3). */
  job_error: string | null;
  segment_counts: { total: number; failed: number };
  /** `systemSamples / micSamples` from `sync.json` when it is outside
   * 0.95..1.05 (issue #170) and the server cannot repair it, else null. A
   * value means that one track ran at the wrong speed, so the transcript can
   * be wrong. */
  track_ratio_warning: number | null;
  /** Issue #170: the system track has a known sample-rate mismatch. It was
   * recorded at `toRate` Hz but read as `fromRate` Hz. `repaired` is true
   * when the server has resampled `system.wav` (the original stays as
   * `system.original.wav`), false when the next transcription repairs it.
   * Null when there is no such mismatch. */
  track_repair: { fromRate: number; toRate: number; repaired: boolean } | null;
  summary: {
    markdown: string | null;
    llm_provider: string | null;
    llm_model: string | null;
    cost_usd: number | null;
    created_at: number | null;
  } | null;
}

/** What the main process returns for a meeting-import upload. */
export type MeetingImportResult =
  | { ok: true; meeting: MeetingDetail }
  | {
      ok: false;
      status?: number;
      error: string;
      detail?: string;
      code?: string;
    };
