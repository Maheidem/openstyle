export interface TranscriptSegment {
  speaker: "Me" | "Them";
  startMs: number;
  endMs: number;
  text: string;
  /** Diarization label (spec §6) — raw numeral string, e.g. "2". Undefined
   * when undiarized (flag off, or this segment fell through to NULL). */
  speakerLabel?: string;
  /** `meeting_segments.id`, Phase C (specs/meeting-transcription-quality.md
   * §6.1) — unused by the UI directly, carried through for a stable list
   * key candidate. */
  id?: string;
  /** LLM-corrected text, Phase C. Undefined when never enhanced, or when
   * Enhance ran and left this segment unchanged. */
  enhancedText?: string;
  /** Confirmed display name for this segment's resolved speaker identity
   * (specs/meeting-speaker-naming.md §4), following any merge. Undefined
   * when unnamed — renderer falls back to "Them {{speakerLabel}}". */
  speakerName?: string;
}

/**
 * The 200 body of `POST /api/meetings/:id/enhance`, as the note card reads it
 * (specs/meeting-transcription-quality.md §6). `partial` is the honest middle
 * state — some chunks corrected, some failed and left as raw text. A wholly
 * failed pass is NOT here: that's a 502 with a `reason`, handled by the
 * `enhanceFailure` state.
 */
export interface EnhanceNote {
  correctedCount: number;
  partial?: boolean;
  chunksAttempted?: number;
  chunksFailed?: number;
}

export interface SpeakerRow {
  label: string;
  segmentCount: number;
  quote: string | null;
  displayName: string | null;
  suggestedName: string | null;
  suggestedEvidence: string | null;
  /** "role" marks `suggestedName` as a role/descriptor guess rather than a
   * confirmed-evidence name (specs/meeting-speaker-naming.md §5.2's
   * hardened contract) — always "name" for a pre-hardening row or when the
   * LLM omitted the field. */
  suggestedKind: "name" | "role";
  mergedInto: string | null;
}

export interface SpeakersResponse {
  speakers: SpeakerRow[];
  unlabeledCount: number;
  /** Max `meeting_speakers.confirmed_at` across this meeting's rows, or
   * null when there are none — powers the summary-tab staleness hint
   * (§9.2) without a second endpoint. Deliberately NOT `updated_at`: that
   * column is also bumped by Enhance's own suggestion writes, which are
   * evidence, never a user-confirmed change, and must never mark an
   * already-generated summary stale on their own (real-E2E fix). */
  latestSpeakerUpdate: number | null;
}

export interface DiarizationStatusResponse {
  enabled: boolean;
  status: "ready" | "not-ready" | "unavailable" | "error";
  error?: string;
}

export type RecorderStatus = "idle" | "recording" | "finalizing";
