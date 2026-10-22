import type { SpeakerVerdict } from "./meeting-types.js";

// Types for the LLM call record: the six `llm_*` tables, the recorder and the
// read API (specs/meeting-enhance-agentic.md sections 7 and 8). This file has
// no runtime code. Use `import type` to read it.

/** A new consumer adds its word here in its own PR. "test": platform tests. */
export type LlmScope = "meeting" | "test";

/** An "enhance" run also holds the chained summarize steps. */
export type LlmRunKind = "enhance" | "summarize";

export type LlmRunStatus =
  | "running"
  | "succeeded"
  | "partial"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "unknown";

/** "partial": some halves of the step ended ok, others failed. */
export type LlmStepStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "partial"
  | "failed"
  | "skipped"
  | "cancelled"
  | "interrupted"
  | "unknown";

/** The meeting targets. A link is generic by (target_type, target_id). */
export type LlmTargetType = "segment" | "speaker" | "summary";

/** `llm_calls.messages_json`. */
export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** `llm_calls.params_json`. Unknown keys stay readable. */
export interface LlmParamsLedger {
  /** Request fields: temperature, max_tokens, response_format. */
  topLevel: Record<string, unknown>;
  /** Fields the gateway added: chat_template_kwargs, top_k. */
  extraBody: Record<string, unknown>;
  /** Asked for, not sent. */
  dropped: { name: string; value?: unknown; reason: string }[];
  source: { mode: "auto" | "preset" | "custom"; presetId?: string };
  /** Where the gateway read the body. */
  capturedFrom: "wire" | "sdk_request";
  /** One line each, no prompt text. */
  warnings: string[];
  structuredMode:
    | "json_schema_strict"
    | "json_schema"
    | "json_tool"
    | "json_object"
    | "prompt_only";
}

export interface LlmStepInfo {
  key: string;
  node: string;
  status: LlmStepStatus;
  /** Start order of the step in the run, from 1. */
  seq: number;
  /** Calls started. */
  attempts: number;
  /** Call rows that exist. Less than `attempts` means a gap. */
  recordedCalls: number;
  errorKind: string | null;
  errorDetail: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface LlmRunInfo {
  id: string;
  scope: LlmScope;
  scopeId: string;
  kind: LlmRunKind;
  /** The original trigger. A resume never changes it. */
  startedBy: "auto" | "button";
  /** Above 0 means the run was resumed. */
  resumeCount: number;
  status: LlmRunStatus;
  graphVersion: number;
  startedAt: number;
  finishedAt: number | null;
  errorKind: string | null;
  errorDetail: string | null;
  callCount: number;
  failedCallCount: number;
  /** LLM-node steps of this run, all statuses. */
  llmStepCount: number;
  /** LLM-node steps with status `failed` or `partial`. */
  failedStepCount: number;
  correctedCount: number | null;
  /** Corrections that the checks dropped (no `unchanged` echoes). Null before graph version 3. */
  droppedCount: number | null;
  suggestionCount: number | null;
  /**
   * Project memory of the run (issue #234): the chunks that `prepare` found
   * in the other meetings of the folder. Ids only, no text. Null when the run
   * used none (unfiled meeting, search off, no hit, or an older run).
   */
  retrieval: LlmRetrievalInfo | null;
  lostRecords: number;
  /** Sums. Unknown counts as 0. */
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  steps: LlmStepInfo[];
}

export interface LlmRetrievalInfo {
  /** The embedding model of the index. */
  modelId: string;
  meetingIds: string[];
  chunkIds: number[];
}

export interface LlmRunListResponse {
  runs: LlmRunInfo[];
}

export interface LlmLinkInfo {
  id: number;
  callId: number;
  targetType: LlmTargetType;
  targetId: string;
  outcome: "applied" | "dropped" | "unknown";
  reason: string | null;
  appliedText: string | null;
  verdict: SpeakerVerdict | null;
  /** Speaker links: the clustering changed since the run. */
  staleLabels: boolean;
}

export interface LlmCallSummary {
  id: number;
  runId: string;
  stepKey: string;
  node: string;
  attempt: number;
  retryReason: string | null;
  provider: string | null;
  requestedModel: string | null;
  servedModel: string | null;
  finishUnified: string | null;
  finishRaw: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cachedTokens: number | null;
  queuedMs: number | null;
  latencyMs: number | null;
  errorKind: string | null;
  errorDetail: string | null;
  startedAt: number;
  finishedAt: number;
  links: LlmLinkInfo[];
}

export interface LlmCallFull extends LlmCallSummary {
  messages: LlmMessage[];
  schema: { name: string; version: number; json: unknown };
  /** Null when `params_json` does not parse. */
  params: LlmParamsLedger | null;
  rawText: string | null;
  parsed: unknown | null;
  reasoningChars: number | null;
  /** All calls of the step. */
  attempts: {
    callId: number;
    attempt: number;
    finishUnified: string | null;
    errorKind: string | null;
    latencyMs: number | null;
  }[];
}

export type LlmCallsResponse =
  | { detail: "summary"; calls: LlmCallSummary[] }
  | { detail: "full"; calls: LlmCallFull[] };
