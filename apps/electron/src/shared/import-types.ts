// Import result types shared by the main process and the preload bridge.
// This file has no runtime code. Use `import type` to read it.

/** Result of an import-audio upload (`POST /api/transcribe/file`). */
export type ImportAudioResult =
  | {
      ok: true;
      raw: string;
      cleaned: string;
      model: string;
      audioDurationMs?: number;
      durationMs?: number;
    }
  | {
      ok: false;
      status?: number;
      error: string;
      detail?: string;
      code?: string;
      reason?: string;
    };

/**
 * A freshly imported meeting in the exact `GET /api/meetings/:id` response
 * shape (row + `job`/`segment_counts`/`summary`, constructed by the route).
 */
export type ImportedMeeting = {
  id: string;
  title: string | null;
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number | null;
  status: string;
  language: string | null;
  error: string | null;
  created_at: number | null;
  stt_provider: string | null;
  stt_model: string | null;
  audio_dir: string | null;
  context: string | null;
  job: { done: number; total: number; failed: number } | null;
  /** Last background-job failure for this meeting (GET /:id shape). Always
   * null on a fresh import — nothing has run yet. */
  job_error: string | null;
  segment_counts: { total: number; failed: number };
  summary: {
    markdown: string | null;
    llm_provider: string | null;
    llm_model: string | null;
    cost_usd: number | null;
    created_at: number | null;
  } | null;
};

export type MeetingImportResult =
  | { ok: true; meeting: ImportedMeeting }
  | {
      ok: false;
      status?: number;
      error: string;
      detail?: string;
      code?: string;
    };
