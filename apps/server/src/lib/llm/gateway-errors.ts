import type { LlmParamsLedger } from "@openstyle/validations";
import type {
  GatewayErrorKind,
  GatewayStepId,
  StructuredMode,
  TokenUsage,
  UnifiedFinishReason,
} from "./call-record.js";

// Typed errors of the LLM gateway (specs/meeting-enhance-agentic.md 5.2).
// Code, UI and inspector read `kind`, never the message. A message holds fixed
// text with codes and numbers. It never holds prompt or answer text (5.8).

export type RetryChange =
  | "none"
  | "add_validator_message"
  | "downgrade_mode"
  | "llamacpp_completion";

/** What `callUnit` may do after this error. `waitMs` is at most 60 000. */
export interface RetryAdvice {
  change: RetryChange;
  waitMs: number;
}

/** The longest wait the gateway advises. */
export const MAX_RETRY_WAIT_MS = 60_000;

/** Facts about the call that failed (or that succeeded, for the result). */
export interface CallFacts {
  callId: number | null;
  step: GatewayStepId;
  unitKey: string;
  attempt: number | null;
  finishReason: UnifiedFinishReason | null;
  rawFinishReason: string | null;
  usage: TokenUsage | null;
  modelRequested: string;
  modelServed: string | null;
  structuredMode: StructuredMode;
  paramsLedger: LlmParamsLedger;
  latencyMs: number;
}

export interface GatewayErrorInit {
  /** Fixed text with codes and numbers. No prompt or answer text. */
  message: string;
  facts: CallFacts;
  retry?: RetryAdvice | null;
  runWide?: boolean;
}

export abstract class GatewayError extends Error {
  abstract readonly kind: GatewayErrorKind;
  readonly facts: CallFacts;
  /** null: final, the graph must not retry. */
  readonly retry: RetryAdvice | null;
  /** The same cause hits every other unit of the run. */
  readonly runWide: boolean;

  constructor(init: GatewayErrorInit) {
    super(init.message);
    this.facts = init.facts;
    this.retry = init.retry ?? null;
    this.runWide = init.runWide ?? false;
  }
}

type Init = GatewayErrorInit;

export class LengthError extends GatewayError {
  readonly kind = "length";
  readonly where: "output" | "input";
  readonly maxOutputTokens: number;
  /**
   * The text of the cut answer, or null (input too long, no answer). It stays
   * in memory: never put it in a message, a log or a span (5.8). Summarize
   * repairs a cut summary from it (PR #258).
   */
  readonly cutText: string | null;
  constructor(
    init: Init & {
      where: "output" | "input";
      maxOutputTokens: number;
      cutText?: string | null;
    },
  ) {
    super(init);
    this.where = init.where;
    this.maxOutputTokens = init.maxOutputTokens;
    this.cutText = init.cutText ?? null;
  }
}

/**
 * The prompt and the answer budget do not fit the context window of the model
 * (specs/llm-runtime-tuning.md 9 item 5). The kind stays `length` (where
 * `input`), so every caller that splits on a long input handles it.
 *
 * `source`:
 * - `estimate`: the guard of the gateway stopped the call before it was sent
 *   (no request, no call record).
 * - `provider`: the model refused the request. For the local MLX worker the
 *   expected refusal is HTTP 400 with the body
 *   `{"error": {"type": "invalid_request_error", "code": "context_length_exceeded",
 *   "message": "...", "prompt_tokens": N, "max_tokens": M, "context_tokens": C}}`.
 *   The numbers are optional. OpenAI-compatible servers send the same code.
 *   A refusal means that the estimate was too low: the caller splits.
 */
export class ContextExceededError extends LengthError {
  readonly source: "estimate" | "provider";
  /** Estimated (source `estimate`) or counted by the provider. null: unknown. */
  readonly promptTokens: number | null;
  readonly contextTokens: number | null;
  constructor(
    init: Init & {
      maxOutputTokens: number;
      source: "estimate" | "provider";
      promptTokens: number | null;
      contextTokens: number | null;
    },
  ) {
    super({ ...init, where: "input" });
    this.source = init.source;
    this.promptTokens = init.promptTokens;
    this.contextTokens = init.contextTokens;
  }
}

/** Provider texts of a prompt that is too long for the model. */
export const INPUT_OVERFLOW =
  /prefill_memory_exceeded|context_length_exceeded|maximum context length/i;

/** The token numbers of a refusal body, when the provider sends them. */
export function overflowNumbers(body: string): {
  promptTokens: number | null;
  contextTokens: number | null;
} {
  const num = (key: string): number | null => {
    const m = new RegExp(`"${key}"\\s*:\\s*(\\d+)`).exec(body);
    return m?.[1] ? Number.parseInt(m[1], 10) : null;
  };
  return {
    promptTokens: num("prompt_tokens"),
    contextTokens: num("context_tokens"),
  };
}

/**
 * True when a raw provider error says that the prompt is too long: HTTP 413,
 * or HTTP 400 with one of the INPUT_OVERFLOW texts. For callers that do not
 * go through the gateway (dictation cleanup).
 */
export function isInputOverflow(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if (error instanceof ContextExceededError) return true;
  const e = error as {
    statusCode?: unknown;
    responseBody?: unknown;
    message?: unknown;
  };
  if (e.statusCode === 413) return true;
  if (e.statusCode !== 400) return false;
  const body = typeof e.responseBody === "string" ? e.responseBody : "";
  const message = typeof e.message === "string" ? e.message : "";
  return INPUT_OVERFLOW.test(`${body} ${message}`);
}

export class ContentFilterError extends GatewayError {
  readonly kind = "content_filter";
  readonly via: "finish_reason" | "refusal";
  constructor(init: Init & { via: "finish_reason" | "refusal" }) {
    super(init);
    this.via = init.via;
  }
}

export class UnexpectedToolCallsError extends GatewayError {
  readonly kind = "unexpected_tool_calls";
}

export class AbnormalStopError extends GatewayError {
  readonly kind = "abnormal_stop";
  declare readonly cause: "error" | "other" | "unknown_raw" | "missing_raw";
  constructor(
    init: Init & { cause: "error" | "other" | "unknown_raw" | "missing_raw" },
  ) {
    super(init);
    this.cause = init.cause;
  }
}

export class ReasoningLeakError extends GatewayError {
  readonly kind = "reasoning_leak";
  readonly leak: "think_tag" | "empty_content_with_reasoning";
  constructor(
    init: Init & { leak: "think_tag" | "empty_content_with_reasoning" },
  ) {
    super(init);
    this.leak = init.leak;
  }
}

export class SchemaError extends GatewayError {
  readonly kind = "schema";
  readonly stage: "json" | "schema";
  /** Zod paths and messages only, at most 500 characters, no echoed values. */
  readonly validatorMessage: string;
  constructor(
    init: Init & { stage: "json" | "schema"; validatorMessage: string },
  ) {
    super(init);
    this.stage = init.stage;
    this.validatorMessage = init.validatorMessage;
  }
}

export class ModelMismatchError extends GatewayError {
  readonly kind = "model_mismatch";
  readonly requested: string;
  readonly served: string;
  constructor(init: Init & { requested: string; served: string }) {
    super(init);
    this.requested = init.requested;
    this.served = init.served;
  }
}

export class CancelledError extends GatewayError {
  readonly kind = "cancelled";
  readonly phase: "queued" | "in_flight";
  constructor(init: Init & { phase: "queued" | "in_flight" }) {
    super(init);
    this.phase = init.phase;
  }
}

export class DeadlineExceededError extends GatewayError {
  readonly kind = "deadline_exceeded";
}

export type ModelUnavailableReason =
  | "no_model"
  | "unsupported_provider"
  | "no_api_key"
  | "server_removed"
  /** The local model pool has no room next to the models in use. */
  | "not_enough_memory"
  /** The local MLX worker exited before it was ready (for example an old
   *  worker that refuses a new argument). Final: no wait, no retry. */
  | "engine_start_failed";

/**
 * The on-device engine (the MLX worker) cannot start now, because its update
 * is not installed yet (`MlxRuntimeUpdatePendingError`). It is not a model
 * setup fault: the caller can wait and start the run again when the engine
 * is ready.
 */
export class EngineNotReadyError extends GatewayError {
  readonly kind = "engine_not_ready";
  /** The original message of the start error. */
  readonly detail: string;
  constructor(init: Init & { detail: string }) {
    super(init);
    this.detail = init.detail;
  }
}

export class ModelUnavailableError extends GatewayError {
  readonly kind = "model_unavailable";
  readonly reason: ModelUnavailableReason;
  /** The original message of the setup error. */
  readonly detail: string;
  constructor(init: Init & { reason: ModelUnavailableReason; detail: string }) {
    super(init);
    this.reason = init.reason;
    this.detail = init.detail;
  }
}

export type ProviderReason =
  | "timeout"
  | "rate_limited"
  | "unavailable"
  | "auth"
  | "invalid_request";

export class ProviderError extends GatewayError {
  readonly kind: GatewayErrorKind;
  readonly reason: ProviderReason;
  readonly statusCode: number | null;
  readonly retryAfterMs: number | null;
  /** The provider message, cut to 200 characters: error name, colon, message. */
  readonly detail: string;
  constructor(
    init: Init & {
      reason: ProviderReason;
      statusCode: number | null;
      retryAfterMs: number | null;
      detail: string;
    },
  ) {
    super(init);
    this.reason = init.reason;
    this.kind = `provider_${init.reason}` as GatewayErrorKind;
    this.statusCode = init.statusCode;
    this.retryAfterMs = init.retryAfterMs;
    this.detail = init.detail;
  }
}

/** Cut a provider error to one line of 200 characters, as `failureDetail` does. */
export function failureDetail(err: unknown): string {
  const name = err instanceof Error ? err.name : "Error";
  const message = err instanceof Error ? err.message : String(err);
  return `${name}: ${message}`.replace(/\s+/g, " ").slice(0, 200);
}

/** A ledger with no body, for an error that happens before any request. */
export function emptyLedger(structuredMode: StructuredMode): LlmParamsLedger {
  return {
    topLevel: {},
    extraBody: {},
    dropped: [],
    source: { mode: "auto" },
    capturedFrom: "sdk_request",
    warnings: [],
    structuredMode,
  };
}

/** Facts for an error that happens before any request was sent. */
export function blankFacts(a: {
  step: GatewayStepId;
  unitKey: string;
  modelRequested: string;
  structuredMode?: StructuredMode;
}): CallFacts {
  const structuredMode = a.structuredMode ?? "json_schema_strict";
  return {
    callId: null,
    step: a.step,
    unitKey: a.unitKey,
    attempt: null,
    finishReason: null,
    rawFinishReason: null,
    usage: null,
    modelRequested: a.modelRequested,
    modelServed: null,
    structuredMode,
    paramsLedger: emptyLedger(structuredMode),
    latencyMs: 0,
  };
}

/** The `code` of a typed start error of the local MLX worker, or null. */
function startErrorCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/**
 * Turn a model setup error into the typed error. The four throw sites keep
 * their plain `Error` (`task-profiles.ts`, `providers.ts`, `registry.ts`); the
 * reason comes from their message. Two typed start errors of the local MLX
 * LLM map by their `code`: a pending runtime update
 * (`MlxRuntimeUpdatePendingError`) is `EngineNotReadyError`, a full model
 * pool (`MlxLlmPoolNoRoomError`) is `not_enough_memory`, and a worker that
 * exits before ready (`MlxWorkerStartError`) is `engine_start_failed`. An error that
 * matches none of these is a bug, not a setup fault: it is returned unchanged.
 */
export function modelUnavailableFrom(err: unknown, facts: CallFacts): unknown {
  if (err instanceof ModelUnavailableError) return err;
  if (err instanceof EngineNotReadyError) return err;
  const text = err instanceof Error ? err.message : String(err);
  const code = startErrorCode(err);
  if (code === "runtime-update-pending") {
    return new EngineNotReadyError({
      message: "The on-device engine is not ready (update pending).",
      facts,
      detail: text.slice(0, 200),
      runWide: true,
    });
  }
  let reason: ModelUnavailableReason;
  if (code === "llm-pool-no-room") reason = "not_enough_memory";
  else if (code === "worker-start-failed") reason = "engine_start_failed";
  else if (/Unsupported provider/i.test(text)) reason = "unsupported_provider";
  else if (/No API key/i.test(text)) reason = "no_api_key";
  else if (/not in your list/i.test(text)) reason = "server_removed";
  else if (/No AI model is set up/i.test(text)) reason = "no_model";
  else return err;
  return new ModelUnavailableError({
    message: `No usable AI model (${reason}). Check Settings > Models.`,
    facts,
    reason,
    detail: text.slice(0, 200),
    runWide: true,
  });
}
