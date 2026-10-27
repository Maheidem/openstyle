import type { LlmParamsLedger } from "@openstyle/validations";

// Base types of the LLM call record (specs/meeting-enhance-agentic.md 5.1,
// rule B). This is the only declaration of each type. The gateway and the
// nodes import them and declare none again. Nothing here knows a consumer:
// `CallRecord` has no scope field, because the recorder copies `scope` and
// `scope_id` from the run row.

/** The LLM steps. A later consumer widens the union. */
export type LlmStepId =
  | "correctChunk"
  | "identifySpeakers"
  | "summarize"
  | "suggestTags";

/** The LLM stages of a dictation (specs/dictation-pipeline.md 4.6). */
export type DictationStepId =
  | "dictationCleanup"
  | "dictationPolish"
  | "dictationTone";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export type UnifiedFinishReason =
  | "stop"
  | "length"
  | "content-filter"
  | "tool-calls"
  | "error"
  | "other";

/** null = unknown. */
export interface TokenUsage {
  input: number | null;
  output: number | null;
  reasoning: number | null;
  cached: number | null;
}

export type StructuredMode = LlmParamsLedger["structuredMode"];

export type GatewayErrorKind =
  | "length"
  | "content_filter"
  | "unexpected_tool_calls"
  | "abnormal_stop"
  | "reasoning_leak"
  | "schema"
  | "model_mismatch"
  | "cancelled"
  | "provider_timeout"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "provider_auth"
  | "provider_invalid_request"
  | "model_unavailable"
  | "deadline_exceeded";

/** One call, built after it ends. Each field maps to a column of `llm_calls`. */
export interface CallRecord {
  /** `run_id`. */
  runId: string;
  /** `step_key`. */
  unitKey: string;
  /** `node`. */
  node: LlmStepId | DictationStepId;
  /** `retry_reason`: the retry kind on the second call, else null. */
  retryReason: string | null;
  provider: string | null;
  modelRequested: string | null;
  modelServed: string | null;
  /** `messages_json` is `[{ role: "system", content: instructions }, ...messages]`. */
  instructions: string;
  messages: readonly ChatTurn[];
  /** `schema_name`, `schema_version`, `schema_json`. */
  schema: { name: string; version: number; json: unknown };
  /** `params_json`. */
  params: LlmParamsLedger;
  rawText: string | null;
  parsed: unknown | null;
  reasoningChars: number | null;
  finishUnified: UnifiedFinishReason | null;
  finishRaw: string | null;
  usage: TokenUsage;
  queuedMs: number | null;
  latencyMs: number | null;
  errorKind: GatewayErrorKind | null;
  errorDetail: string | null;
  /** Epoch ms. */
  startedAt: number;
  finishedAt: number;
}

/** `attempt` is not a field of `CallRecord`: `recordCall` computes it. */
export interface RecordedCall {
  id: number;
  attempt: number;
}

/** The recorder implements it. One phase: one row, after the call. */
export interface CallSink {
  /** Before each request: `llm_run_steps.attempts += 1`. */
  startAttempt(a: { runId: string; stepKey: string }): void;
  /** After the call ends, also for every error and cancel. null: the write failed. */
  recordCall(c: CallRecord): RecordedCall | null;
}
