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
   * "not yet resolved" — the language chip renders "Auto". */
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
  job: {
    done: number;
    total: number;
    failed: number;
    /** Which job holds the slot (server `activeJobKinds`). "summarize" is the
     * async Summarize job (specs/meeting-llm-queue.md §5.6) — the meeting's
     * `status` stays `transcribed` while it runs, so this is the only signal
     * the UI has that a summarize is in flight. */
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
   * meeting, or null. Deliberately not `error` — that column is the
   * transcript-integrity banner (§6 constraint 3). */
  job_error: string | null;
  segment_counts: { total: number; failed: number };
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
