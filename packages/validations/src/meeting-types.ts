import type { CalendarEvent } from "./meeting-calendar.js";

// Response types for the meetings API. The server builds these shapes, the
// Electron main process passes them on, and the renderer reads them. This
// file has no runtime code. Use `import type` to read it.

/** The phase of a running meeting job (server job registry). */
export type MeetingJobPhase =
  | "diarizing"
  | "transcribing"
  | "preparing"
  | "reading"
  | "speakers"
  | "summarizing"
  | "combining"
  | "saving"
  | "tags";

/** One row of `GET /api/meetings`. */
export interface MeetingListItem {
  id: string;
  folder_id: string | null;
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
  /** The meeting's tag names, sorted (issue #231). */
  tags: string[];
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
    /** The phase of the job. A workflow run (Enhance, Summarize) sets it
     * with `step`, `steps` and `detail` (specs/meeting-enhance-agentic.md
     * 3.4.4). Its `done`/`total` then count work steps, not LLM calls. */
    phase?: MeetingJobPhase;
    /** The 1-based chunk or summary part in work, or null. */
    step?: number | null;
    /** The count of chunks or summary parts, or null. */
    steps?: number | null;
    /** The start of the chunk text in work, or null. */
    detail?: string | null;
  } | null;
  segment_counts: { total: number; failed: number };
  /** `systemSamples / micSamples` from `sync.json` when it is outside
   * 0.95..1.05 (issue #170) and the server cannot repair it, else null. The
   * two tracks should have the same length. With a value, the system audio
   * can play at the wrong speed and the transcript can be wrong. */
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

// Speaker-name verification (specs/meeting-enhance-agentic.md 4.4, 4.2).
// `verdict_json` of a speaker link in the LLM call record holds a
// `SpeakerVerdict`. This is the only declaration of these five types.

export type VerdictStatus = "kept" | "dropped";

export type DropReason =
  | "unknown_label"
  | "unknown_segment"
  | "no_quote"
  | "quote_too_long"
  | "quote_not_in_segment"
  | "empty_name"
  | "label_echo"
  | "name_not_in_quote"
  | "not_self_introduction"
  | "conflict_lost"
  | "duplicate_same_name";

export type EvidenceType = "self_introduction" | "addressed_as" | "role_detail";

/** Why a correction of an Enhance chunk was not applied. */
export type CorrectionDropReason =
  | "unknown_id"
  | "duplicate_id"
  | "empty_text"
  | "unchanged"
  | "format_only"
  | "deletes_words"
  | "too_different"
  | "meaning_flip"
  | "inflection_only"
  | "lowercases_name";

export interface SpeakerVerdict {
  unitKey: string;
  llmCallId: number | null;
  /** Copied from the proposal. One verdict per proposal, so (llmCallId, seq) is unique. */
  seq: number;
  label: string;
  proposedKind: "name" | "role";
  proposedName: string;
  segmentId: string;
  quote: string;
  /** Set by code. Null when dropped before the derivation. */
  evidenceType: EvidenceType | null;
  status: VerdictStatus;
  reason: DropReason | null;
  /** One line, at most 200 characters. */
  detail: string | null;
  /** After the spelling fix. Null when dropped. */
  finalName: string | null;
  /** Name before the spelling fix. */
  respelledFrom: string | null;
  /** conflict_lost: the call of the winner. */
  winnerCallId: number | null;
}

/**
 * The 202 body of `POST /api/meetings/:id/enhance`, `POST /:id/summarize` and
 * `POST /:id/runs/:runId/resume` (specs/meeting-enhance-agentic.md 3.4.2).
 * `id` is the meeting id. `runId` is the run that was started or resumed.
 */
export interface StartRunResponse {
  ok: true;
  id: string;
  runId: string;
}

/**
 * Why a resume is refused, one value for each guard of 3.4.7 in guard order.
 * Guards 4 and 6 also set the run to `failed`.
 */
export type ResumeConflictReason =
  | "meeting_status"
  | "job_running"
  | "not_interrupted"
  | "graph_changed"
  | "no_checkpoint"
  | "transcript_changed";

/** The 409 body of the resume route. `error` is one English line. */
export interface ResumeConflict {
  error: string;
  reason: ResumeConflictReason;
}
