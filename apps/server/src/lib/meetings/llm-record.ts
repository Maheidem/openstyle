import type { LlmScope } from "@openstyle/validations";
import type { LlmStepId } from "../llm/call-record.js";
import type { NewLink } from "../llm/recorder.js";

// The meeting side of the generic LLM call record (specs/meeting-enhance-
// agentic.md 7.14). The platform tables know a scope and a target type. This
// file says what those words mean for a meeting.

/** Scope of a run that works on a meeting. */
export function meetingScope(meetingId: string): {
  scope: LlmScope;
  scopeId: string;
} {
  return { scope: "meeting", scopeId: meetingId };
}

/** The LLM nodes of a meeting run. The code nodes `prepare`, `verify` and `save` are not LLM nodes. */
export const MEETING_LLM_NODES: readonly LlmStepId[] = [
  "correctChunk",
  "identifySpeakers",
  "summarize",
];

/**
 * The link target of a summary: the meeting id. The row is checked later
 * against the current `meeting_summaries` row, so `appliedText` holds its
 * `created_at` as text.
 */
export function summaryLinkTarget(
  meetingId: string,
  summaryCreatedAt: number,
): Pick<NewLink, "targetType" | "targetId" | "seq" | "appliedText"> {
  return {
    targetType: "summary",
    targetId: meetingId,
    seq: 0,
    appliedText: String(summaryCreatedAt),
  };
}
