import type { LlmParamsLedger } from "@openstyle/validations";
import type {
  GatewayErrorKind,
  LlmStepId,
  StructuredMode,
  TokenUsage,
  UnifiedFinishReason,
} from "./call-record.js";

// Typed errors of the LLM gateway (specs/meeting-enhance-agentic.md 5.2).
// Code, UI and inspector read `kind`, never the message. A message holds fixed
// text with codes and numbers. It never holds prompt or answer text (5.8).

export type RetryChange = "none" | "add_validator_message" | "downgrade_mode";

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
  step: LlmStepId;
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
  constructor(
    init: Init & { where: "output" | "input"; maxOutputTokens: number },
  ) {
    super(init);
    this.where = init.where;
    this.maxOutputTokens = init.maxOutputTokens;
  }
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
  | "server_removed";

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
  step: LlmStepId;
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

/**
 * Turn a model setup error into the typed error. The four throw sites keep
 * their plain `Error` (`task-profiles.ts`, `providers.ts`, `registry.ts`); the
 * reason comes from their message. An error that matches none of the four
 * messages is a bug, not a setup fault: it is returned unchanged.
 */
export function modelUnavailableFrom(err: unknown, facts: CallFacts): unknown {
  if (err instanceof ModelUnavailableError) return err;
  const text = err instanceof Error ? err.message : String(err);
  let reason: ModelUnavailableReason;
  if (/Unsupported provider/i.test(text)) reason = "unsupported_provider";
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
