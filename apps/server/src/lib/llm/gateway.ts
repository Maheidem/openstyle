import { THINK_TAG } from "@openstyle/stt";
import { createAppLogger } from "@openstyle/utils";
import type { LlmParamsLedger } from "@openstyle/validations";
import { parseServerModelId } from "@openstyle/validations";
import {
  APICallError,
  asSchema,
  generateText,
  type LanguageModel,
  type LanguageModelMiddleware,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  RetryError,
  wrapLanguageModel,
} from "ai";
import type { z } from "zod";
import { getApiKey } from "../api-keys.js";
import { getOwnServer } from "../own-servers.js";
import { createChatModel } from "../providers.js";
import type {
  CallRecord,
  CallSink,
  ChatTurn,
  GatewayErrorKind,
  LlmStepId,
  StructuredMode,
  TokenUsage,
  UnifiedFinishReason,
} from "./call-record.js";
import {
  AbnormalStopError,
  blankFacts,
  type CallFacts,
  CancelledError,
  ContentFilterError,
  DeadlineExceededError,
  failureDetail,
  type GatewayError,
  LengthError,
  MAX_RETRY_WAIT_MS,
  ModelMismatchError,
  modelUnavailableFrom,
  ProviderError,
  ReasoningLeakError,
  type RetryAdvice,
  type RetryChange,
  SchemaError,
  UnexpectedToolCallsError,
} from "./gateway-errors.js";
import { LlmLaneCancelledError, withLlmLane } from "./lane.js";
import {
  type CallProfile,
  effectiveMode,
  reasoningWire,
  rememberRejectedMode,
} from "./model-profiles.js";
import type { GatewayOverrides, LlmTaskContext } from "./registry.js";
import { isLocalProvider, isOwnServerProvider } from "./registry.js";
import { type ResolvedTaskCall, resolveTaskCall } from "./task-profiles.js";
import { getTracing, telemetryFor } from "./tracing.js";

// The LLM gateway (specs/meeting-enhance-agentic.md section 5). One entry
// point, `callStructured`. One call sends one request and never loops. The
// gateway builds no prompts, writes no domain data and imports no consumer.

const log = createAppLogger("llm-gateway");

/** A schema the gateway sends. `zod` goes to the SDK unchanged (4.0.3 rule 7). */
export interface StepSchema<T> {
  /** [A-Za-z0-9_]. The wire name. */
  name: string;
  /** Stored in the record, not sent. */
  version: number;
  zod: z.ZodType<T>;
}

export type CreateModel = typeof createChatModel;

export interface CallStructuredInput<T> {
  step: LlmStepId;
  runId: string;
  unitKey: string;
  chunkIndex: number | null;
  schema: StepSchema<T>;
  /** The system text. v7 rejects system-role messages. */
  instructions: string;
  messages: readonly ChatTurn[];
  profile: CallProfile;
  /** Capped at `profile.maxOutputTokens` here. */
  maxOutputTokens: number;
  signal: AbortSignal;
  sink: CallSink;
  onQueued?: (i: { waitedMs: number; ahead: number }) => void;
  stopped?: () => boolean;
  retry?: {
    kind: GatewayErrorKind;
    change: RetryChange;
    validatorMessage?: string;
  };
  /** Test seam: a scripted model. Production leaves it unset. */
  createModel?: CreateModel;
}

export interface CallStructuredResult<T> {
  object: T;
  finishReason: "stop";
  rawFinishReason: string;
  usage: TokenUsage;
  modelRequested: string;
  modelServed: string | null;
  latencyMs: number;
  queuedMs: number;
  attempt: number | null;
  paramsLedger: LlmParamsLedger;
  structuredMode: StructuredMode;
  callId: number | null;
}

// ---------------------------------------------------------------------------
// Gate helpers (5.3)
// ---------------------------------------------------------------------------

/** The raw stop value the gate accepts for one provider and mode (5.3.2). */
function acceptedRawStop(provider: string, mode: StructuredMode): string {
  switch (provider) {
    case "anthropic":
      return mode === "json_tool" ? "tool_use" : "end_turn";
    case "google":
      return "STOP";
    default:
      // openai, vercel, openrouter, server, groq, mistral
      return "stop";
  }
}

const VERSION_SUFFIX = /^(?:-\d{8}|-\d{4}-\d{2}-\d{2}|-v\d+(?:\.\d+)*)$/;

/**
 * True when the served model is the requested one (5.3.4): equal ignoring
 * case, or the requested id plus one date or version suffix. A `-latest`
 * request matches its base plus such a suffix.
 */
export function modelMatches(requested: string, served: string): boolean {
  const r = requested.trim().toLowerCase();
  const s = served.trim().toLowerCase();
  if (r === s) return true;
  if (s.startsWith(r) && VERSION_SUFFIX.test(s.slice(r.length))) return true;
  if (r.endsWith("-latest")) {
    const base = r.slice(0, -"-latest".length);
    if (s.startsWith(base) && VERSION_SUFFIX.test(s.slice(base.length))) {
      return true;
    }
  }
  return false;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstChoiceMessage(body: unknown): Record<string, unknown> | null {
  const choices = asObject(body)?.choices;
  if (!Array.isArray(choices)) return null;
  return asObject(asObject(choices[0])?.message);
}

function nonBlankString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** The OpenAI `refusal` field, when the answer is a refusal. */
function hasRefusal(body: unknown): boolean {
  return nonBlankString(firstChoiceMessage(body)?.refusal) !== null;
}

/** Reasoning text the raw body carries (`@ai-sdk/openai` `.chat` does not read it). */
function bodyReasoning(body: unknown): string | null {
  const message = firstChoiceMessage(body);
  return (
    nonBlankString(message?.reasoning_content) ??
    nonBlankString(message?.reasoning)
  );
}

/** Zod paths and messages only, no echoed values, at most 500 characters. */
function validatorMessage(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
    .join("; ")
    .slice(0, 500);
}

/** Remove one outer Markdown code fence and nothing else (5.3.5). */
function stripOneFence(text: string): string {
  const m = /^\s*```[a-zA-Z0-9]*\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text);
  return m?.[1] ?? text;
}

type ParseOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; stage: "json" | "schema"; message: string };

function parseAnswer<T>(
  text: string,
  schema: z.ZodType<T>,
  fence: boolean,
): ParseOutcome<T> {
  let json: unknown;
  try {
    json = JSON.parse(fence ? stripOneFence(text) : text);
  } catch {
    return {
      ok: false,
      stage: "json",
      message: "The answer is not valid JSON.",
    };
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    stage: "schema",
    message: validatorMessage(parsed.error.issues),
  };
}

// ---------------------------------------------------------------------------
// Capture middleware (5.1)
// ---------------------------------------------------------------------------

interface Capture {
  unified: UnifiedFinishReason;
  raw: string | undefined;
  modelId: string | undefined;
  responseBody: unknown;
  requestBody: unknown;
  warnings: { type: string; feature?: string; details?: string }[];
  text: string;
  reasoningChars: number;
  usage: TokenUsage;
  /** Call options the SDK handed to the model, for the ledger when no body exists. */
  callOptions: {
    temperature?: number;
    maxOutputTokens?: number;
    topP?: number;
  };
}

function usageOf(
  u: {
    inputTokens: { total?: number; cacheRead?: number };
    outputTokens: { total?: number; reasoning?: number };
  },
  responseBody: unknown,
): TokenUsage {
  const usage: TokenUsage = {
    input: u.inputTokens.total ?? null,
    output: u.outputTokens.total ?? null,
    reasoning: u.outputTokens.reasoning ?? null,
    cached: u.inputTokens.cacheRead ?? null,
  };
  // The OpenAI chat reader turns a missing detail into 0. Unknown is NULL (7.4).
  const raw = asObject(asObject(responseBody)?.usage);
  if (raw && "prompt_tokens" in raw) {
    const out = asObject(raw.completion_tokens_details);
    if (typeof out?.reasoning_tokens !== "number") usage.reasoning = null;
    const inp = asObject(raw.prompt_tokens_details);
    if (typeof inp?.cached_tokens !== "number") usage.cached = null;
  }
  return usage;
}

// ---------------------------------------------------------------------------
// Ledger (5.1)
// ---------------------------------------------------------------------------

const BODY_NOISE_KEYS = ["messages", "system", "contents"];
const SCHEMA_BODY_KEYS = new Set([
  "schema",
  "input_schema",
  "responseSchema",
  "responseJsonSchema",
]);

/** A deep copy without prompts and schema bodies. */
function stripBodies(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripBodies);
  const obj = asObject(value);
  if (!obj) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(obj)) {
    if (SCHEMA_BODY_KEYS.has(key)) continue;
    out[key] = stripBodies(v);
  }
  return out;
}

function requestFields(body: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(body)) {
    if (BODY_NOISE_KEYS.includes(key)) continue;
    copy[key] = stripBodies(v);
  }
  return copy;
}

interface LedgerInput {
  sdkBody: unknown;
  wireBody: unknown;
  capture: Capture | null;
  resolved: ResolvedTaskCall;
  profile: CallProfile;
  mode: StructuredMode;
  warnings: string[];
  noReasoningControl: boolean;
  maxOutputTokens: number;
}

/**
 * Keys the SDK puts in a chat request body itself. A failed call has no SDK
 * body, so this set splits the wire body the same way a successful call does.
 */
const KNOWN_SDK_BODY_KEYS = [
  "model",
  "messages",
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "response_format",
  "stream",
  "stream_options",
  "stop",
  "seed",
  "frequency_penalty",
  "presence_penalty",
  "reasoning_effort",
  "tools",
  "tool_choice",
  "user",
];

function buildLedger(i: LedgerInput): LlmParamsLedger {
  const sdk = asObject(i.sdkBody);
  const wire = asObject(i.wireBody);
  let topLevel: Record<string, unknown> = {};
  let extraBody: Record<string, unknown> = {};
  let capturedFrom: LlmParamsLedger["capturedFrom"] = "sdk_request";

  if (wire) {
    capturedFrom = "wire";
    const fields = requestFields(wire);
    const sdkKeys = new Set(sdk ? Object.keys(sdk) : KNOWN_SDK_BODY_KEYS);
    for (const [key, v] of Object.entries(fields)) {
      if (sdkKeys.has(key)) topLevel[key] = v;
      else extraBody[key] = v;
    }
  } else if (sdk) {
    topLevel = requestFields(sdk);
  } else {
    // A scripted model gives no body: the ledger holds the call options.
    const o = i.capture?.callOptions ?? {};
    topLevel = {
      model: i.profile.modelId,
      ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
      ...(o.topP !== undefined ? { top_p: o.topP } : {}),
      max_tokens: o.maxOutputTokens ?? i.maxOutputTokens,
    };
  }
  extraBody = (stripBodies(extraBody) as Record<string, unknown>) ?? {};

  const dropped: LlmParamsLedger["dropped"] = i.resolved.droppedKeys.map(
    (d) => ({ name: d.name, value: d.value, reason: d.reason }),
  );
  for (const w of i.capture?.warnings ?? []) {
    if (w.type === "unsupported") {
      dropped.push({
        name: w.feature ?? "unknown",
        reason: "sdk_unsupported",
      });
    }
  }
  if (i.noReasoningControl) {
    dropped.push({ name: "reasoning", reason: "no_reasoning_control" });
  }

  return {
    topLevel,
    extraBody,
    dropped,
    source: i.resolved.source,
    capturedFrom,
    warnings: [...i.warnings],
    structuredMode: i.mode,
  };
}

// ---------------------------------------------------------------------------
// Errors from the transport (5.2.1)
// ---------------------------------------------------------------------------

/** Wait advice with 1 s plus jitter. */
function backoffWaitMs(): number {
  return 1000 + Math.floor(Math.random() * 250);
}

function parseRetryAfter(
  headers: Record<string, string> | undefined,
): number | null {
  if (!headers) return null;
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const ms = lower["retry-after-ms"];
  if (ms !== undefined) {
    const n = Number.parseFloat(ms);
    if (!Number.isNaN(n) && n >= 0) return n;
  }
  const after = lower["retry-after"];
  if (after !== undefined) {
    const seconds = Number.parseFloat(after);
    if (!Number.isNaN(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(after);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  return null;
}

const INPUT_OVERFLOW =
  /prefill_memory_exceeded|context_length_exceeded|maximum context length/i;
const MODE_REJECTION = /response_format|json_schema|schema/i;

/** Unwrap a `RetryError` to its last error. Not expected at `maxRetries` 0. */
function unwrap(error: unknown): unknown {
  return RetryError.isInstance(error) ? (error.lastError ?? error) : error;
}

/** Everything the error mapper needs. */
interface ErrorContext {
  facts: CallFacts;
  profile: CallProfile;
  mode: StructuredMode;
  maxOutputTokens: number;
  /** A second call: a failure is final. */
  isRetry: boolean;
}

function mapApiError(error: APICallError, c: ErrorContext): GatewayError {
  const status = error.statusCode ?? null;
  const body = typeof error.responseBody === "string" ? error.responseBody : "";
  const detail = failureDetail(error);
  const common = { facts: c.facts };
  const provider = (
    reason: ProviderError["reason"],
    retry: RetryAdvice | null,
    runWide = false,
    retryAfterMs: number | null = null,
  ) =>
    new ProviderError({
      ...common,
      message: `Provider error: ${reason}${status === null ? "" : ` (HTTP ${status})`}`,
      reason,
      statusCode: status,
      retryAfterMs,
      detail,
      retry: c.isRetry ? null : retry,
      runWide,
    });

  if (
    status === 413 ||
    (status === 400 && INPUT_OVERFLOW.test(`${body} ${error.message}`))
  ) {
    return new LengthError({
      ...common,
      message: "The request was too long for the model.",
      where: "input",
      maxOutputTokens: c.maxOutputTokens,
      retry: null,
    });
  }
  if (status === 408) {
    return provider(
      "timeout",
      isLocalProvider(c.profile.provider)
        ? null
        : { change: "none", waitMs: backoffWaitMs() },
    );
  }
  if (status === 429) {
    const after = parseRetryAfter(error.responseHeaders);
    let advice: RetryAdvice | null;
    if (after === null) advice = { change: "none", waitMs: backoffWaitMs() };
    else if (after > MAX_RETRY_WAIT_MS) advice = null;
    else advice = { change: "none", waitMs: Math.ceil(after) };
    return provider("rate_limited", advice, false, after);
  }
  if (status === 401 || status === 403) {
    return provider("auth", null, true);
  }
  if (status === 400 || status === 404 || status === 422) {
    if (MODE_REJECTION.test(body) || MODE_REJECTION.test(error.message)) {
      const lower = rememberRejectedMode(c.profile, c.mode);
      if (lower) {
        return provider("invalid_request", {
          change: "downgrade_mode",
          waitMs: 0,
        });
      }
    }
    return provider("invalid_request", null, true);
  }
  if (status === null || status === 409 || status >= 500) {
    return provider("unavailable", { change: "none", waitMs: backoffWaitMs() });
  }
  // Any other status: the SDK flag decides (spec rule, 5.2.1).
  return error.isRetryable
    ? provider("unavailable", { change: "none", waitMs: backoffWaitMs() })
    : provider("invalid_request", null, true);
}

// ---------------------------------------------------------------------------
// callStructured
// ---------------------------------------------------------------------------

const DEGRADED_SUFFIX =
  "Return one JSON object that matches this JSON Schema. Return no other text.";

function mergeProviderOptions(
  ...parts: Record<string, Record<string, unknown>>[]
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const part of parts) {
    for (const [key, v] of Object.entries(part)) {
      out[key] = { ...(out[key] ?? {}), ...v };
    }
  }
  return out;
}

/** Provider options that choose the structured mode (5.4). */
function structuredOptions(
  provider: string,
  mode: StructuredMode,
): Record<string, Record<string, unknown>> {
  if (provider === "anthropic") {
    if (mode === "json_schema") {
      return { anthropic: { structuredOutputMode: "outputFormat" } };
    }
    if (mode === "json_tool") {
      return { anthropic: { structuredOutputMode: "jsonTool" } };
    }
    return {};
  }
  if (
    (provider === "groq" || provider === "google" || provider === "mistral") &&
    mode === "json_object"
  ) {
    return { [provider]: { structuredOutputs: false } };
  }
  return {};
}

function reasonOf(signal: AbortSignal): unknown {
  return signal.reason;
}

function isTimeoutReason(reason: unknown): boolean {
  return (
    typeof reason === "object" &&
    reason !== null &&
    (reason as { name?: unknown }).name === "TimeoutError"
  );
}

/**
 * Send one structured request and check the answer. Throws one typed
 * `GatewayError`. Every call that reached the wire writes one record, also
 * every error and cancel in flight (7.7); a sink failure never fails the call.
 */
export async function callStructured<T>(
  input: CallStructuredInput<T>,
): Promise<CallStructuredResult<T>> {
  const { profile } = input;
  const mode = effectiveMode(profile);
  const maxOutputTokens = Math.max(
    1,
    Math.min(
      input.maxOutputTokens,
      profile.maxOutputTokens ?? Number.POSITIVE_INFINITY,
    ),
  );
  const isRetry = input.retry !== undefined;
  const degraded = mode === "json_object" || mode === "prompt_only";

  const facts = blankFacts({
    step: input.step,
    unitKey: input.unitKey,
    modelRequested: profile.modelId,
    structuredMode: mode,
  });

  // Step 1: the retry change. A validator message becomes a user turn.
  const messages: ChatTurn[] = [...input.messages];
  if (
    input.retry?.change === "add_validator_message" &&
    input.retry.validatorMessage
  ) {
    messages.push({
      role: "user",
      content: `Your last reply was not valid. Problem: ${input.retry.validatorMessage}. Return the corrected JSON only.`,
    });
  }

  // Steps 2 and 3: resolve the call and build the model. A fault here means no
  // request was sent (ModelUnavailableError).
  let resolved: ResolvedTaskCall;
  let model: LanguageModel;
  const wireHolder: { seen: boolean; body: unknown } = {
    seen: false,
    body: null,
  };
  const warnings = [...profile.warnings];
  const wire = reasoningWire(profile);
  warnings.push(...wire.warnings);
  let jsonSchema: unknown;
  try {
    resolved = await resolveTaskCall(profile.taskId, {
      autoMaxOutputTokens: maxOutputTokens,
      pin: { provider: profile.provider, modelId: profile.modelId },
    });
    jsonSchema = await asSchema(input.schema.zod).jsonSchema;

    const presetSet = {
      topLevel: resolved.presetKeys.topLevel,
      chatTemplateKwargs: resolved.presetKeys.chatTemplateKwargs,
    };
    const overrides: GatewayOverrides = {
      ...wire.overrides,
      presetSet,
    };
    if (wire.overrides.bounded) {
      if (presetSet.chatTemplateKwargs.includes("enable_thinking")) {
        warnings.push("reasoning plan overridden by preset: enable_thinking");
      }
      if (presetSet.topLevel.includes("thinking_budget")) {
        warnings.push("reasoning plan overridden by preset: thinking_budget");
      }
    } else if (
      profile.reasoning.mode === "off" &&
      !profile.reasoning.force &&
      isLocalProvider(profile.provider) &&
      presetSet.chatTemplateKwargs.includes("enable_thinking") &&
      asObject(resolved.samplingParams.chat_template_kwargs)
        ?.enable_thinking === true
    ) {
      warnings.push("reasoning on by preset");
    }

    // OpenRouter must route to an endpoint that supports every parameter we
    // send, or the schema could be dropped silently (5.4).
    const bodyExtra: Record<string, unknown> | null =
      profile.provider === "openrouter"
        ? { provider: { require_parameters: true }, ...wire.bodyExtra }
        : Object.keys(wire.bodyExtra).length > 0
          ? wire.bodyExtra
          : null;

    const taskContext: LlmTaskContext = {
      task: profile.taskId,
      sampling: resolved.samplingParams,
      gatewayOverrides: overrides,
      ...(bodyExtra ? { bodyExtra } : {}),
      onRequestBody: (body) => {
        wireHolder.seen = true;
        wireHolder.body = body;
      },
    };
    const created = await (input.createModel ?? createChatModel)(
      resolved.provider,
      resolved.modelId,
      taskContext,
    );
    if (typeof created === "string") {
      throw new Error(`Unsupported provider: ${resolved.provider}`);
    }
    model = created;
  } catch (e) {
    throw modelUnavailableFrom(e, facts);
  }

  const laneStart = Date.now();
  const captured: { value: Capture | null } = { value: null };
  const middleware: LanguageModelMiddleware = {
    wrapGenerate: async ({ doGenerate, params }) => {
      const result = await doGenerate();
      let text = "";
      let reasoningChars = 0;
      for (const part of result.content) {
        if (part.type === "text") text += part.text;
        else if (part.type === "reasoning") reasoningChars += part.text.length;
      }
      const fromBody = bodyReasoning(result.response?.body);
      if (fromBody) reasoningChars += fromBody.length;
      captured.value = {
        unified: result.finishReason.unified,
        raw: result.finishReason.raw,
        modelId: result.response?.modelId,
        responseBody: result.response?.body,
        requestBody: result.request?.body,
        warnings: result.warnings as Capture["warnings"],
        text,
        reasoningChars,
        usage: usageOf(result.usage, result.response?.body),
        callOptions: {
          ...(params.temperature !== undefined
            ? { temperature: params.temperature }
            : {}),
          ...(params.topP !== undefined ? { topP: params.topP } : {}),
          ...(params.maxOutputTokens !== undefined
            ? { maxOutputTokens: params.maxOutputTokens }
            : {}),
        },
      };
      return result;
    },
  };
  const wrapped = wrapLanguageModel({ model, middleware });
  const modelRequested = model.modelId;
  facts.modelRequested = modelRequested;

  const instructions = degraded
    ? `${input.instructions}\n\n${DEGRADED_SUFFIX}\n${JSON.stringify(jsonSchema)}`
    : input.instructions;
  const output =
    mode === "prompt_only"
      ? Output.text()
      : mode === "json_object"
        ? Output.json()
        : Output.object({
            schema: input.schema.zod,
            name: input.schema.name,
          });
  const providerOptions = mergeProviderOptions(
    structuredOptions(profile.provider, mode),
    wire.providerOptions,
  );

  const finalize = async (
    outcome: { error: GatewayError | null; parsed: unknown },
    times: { startedAt: number; wireStart: number },
  ): Promise<{ id: number | null; attempt: number | null }> => {
    const finishedAt = Date.now();
    const c = captured.value;
    const ledger = buildLedger({
      sdkBody: c ? c.requestBody : null,
      wireBody: wireHolder.seen ? wireHolder.body : null,
      capture: c,
      resolved,
      profile,
      mode,
      warnings,
      noReasoningControl: wire.noControl,
      maxOutputTokens,
    });
    Object.assign(facts, { paramsLedger: ledger, structuredMode: mode });
    const record: CallRecord = {
      runId: input.runId,
      unitKey: input.unitKey,
      node: input.step,
      retryReason: input.retry?.kind ?? null,
      provider: profile.provider,
      modelRequested,
      modelServed: facts.modelServed,
      instructions,
      messages,
      schema: {
        name: input.schema.name,
        version: input.schema.version,
        json: jsonSchema,
      },
      params: ledger,
      rawText: c ? c.text : null,
      parsed: outcome.parsed ?? null,
      reasoningChars: c ? c.reasoningChars : null,
      finishUnified: c ? c.unified : null,
      finishRaw: c ? (c.raw ?? null) : null,
      usage: c
        ? c.usage
        : { input: null, output: null, reasoning: null, cached: null },
      queuedMs: times.wireStart - laneStart,
      latencyMs: finishedAt - times.wireStart,
      errorKind: outcome.error ? outcome.error.kind : null,
      errorDetail: outcome.error ? outcome.error.message.slice(0, 500) : null,
      startedAt: times.startedAt,
      finishedAt,
    };
    let recorded: { id: number; attempt: number } | null = null;
    try {
      recorded = input.sink.recordCall(record);
    } catch {
      log.warn(`call record write failed (${input.step} ${input.unitKey})`);
    }
    facts.callId = recorded?.id ?? null;
    facts.attempt = recorded?.attempt ?? null;
    facts.latencyMs = finishedAt - times.wireStart;
    return { id: facts.callId, attempt: facts.attempt };
  };

  const queued = (): GatewayError => {
    if (input.signal.aborted && isTimeoutReason(reasonOf(input.signal))) {
      return new DeadlineExceededError({
        facts,
        message: "The run deadline passed before the call started.",
      });
    }
    return new CancelledError({
      facts,
      message: "The call was cancelled before it started.",
      phase: "queued",
    });
  };

  try {
    return await withLlmLane(
      profile.provider,
      profile.modelId,
      {
        cls: "background",
        taskId: profile.taskId,
        signal: input.signal,
        ...(input.onQueued ? { onQueued: input.onQueued } : {}),
      },
      async () => {
        const queuedMs = Date.now() - laneStart;
        if (input.stopped?.()) throw queued();

        try {
          input.sink.startAttempt({
            runId: input.runId,
            stepKey: input.unitKey,
          });
        } catch {
          log.warn(
            `attempt start write failed (${input.step} ${input.unitKey})`,
          );
        }
        const startedAt = Date.now();
        const wireStart = startedAt;
        const timeoutSignal = AbortSignal.timeout(resolved.timeoutMs);
        const abortSignal = AbortSignal.any([input.signal, timeoutSignal]);

        let sdkResult: Awaited<ReturnType<typeof generateText>> | null = null;
        let sdkError: unknown = null;
        try {
          sdkResult = await generateText({
            model: wrapped,
            maxRetries: 0,
            telemetry: telemetryFor(getTracing(), input.step),
            abortSignal,
            instructions,
            messages: messages.map((m) => ({
              role: m.role,
              content: m.content,
            })),
            output,
            temperature: resolved.temperature,
            ...(resolved.topP !== undefined ? { topP: resolved.topP } : {}),
            maxOutputTokens,
            ...(Object.keys(providerOptions).length > 0
              ? { providerOptions: providerOptions as never }
              : {}),
          });
        } catch (e) {
          sdkError = unwrap(e);
        }

        const ctx: ErrorContext = {
          facts,
          profile,
          mode,
          maxOutputTokens,
          isRetry,
        };
        const c = captured.value;

        // Abort, deadline and timeout come first when no answer was captured.
        if (!c) {
          let error: GatewayError;
          if (input.signal.aborted) {
            error = isTimeoutReason(reasonOf(input.signal))
              ? new DeadlineExceededError({
                  facts,
                  message: "The run deadline passed during the call.",
                })
              : new CancelledError({
                  facts,
                  message: "The call was cancelled.",
                  phase: "in_flight",
                });
          } else if (timeoutSignal.aborted) {
            error = new ProviderError({
              facts,
              message: "Provider error: timeout",
              reason: "timeout",
              statusCode: null,
              retryAfterMs: null,
              detail: `TimeoutError: no answer in ${resolved.timeoutMs} ms`,
              retry:
                isRetry || isLocalProvider(profile.provider)
                  ? null
                  : { change: "none", waitMs: backoffWaitMs() },
            });
          } else if (APICallError.isInstance(sdkError)) {
            error = mapApiError(sdkError, ctx);
          } else {
            error = new ProviderError({
              facts,
              message: "Provider error: unavailable",
              reason: "unavailable",
              statusCode: null,
              retryAfterMs: null,
              detail: failureDetail(sdkError),
              retry: isRetry
                ? null
                : { change: "none", waitMs: backoffWaitMs() },
            });
          }
          await finalize({ error, parsed: null }, { startedAt, wireStart });
          throw error;
        }

        // The answer exists. Fill the facts, then run the gate in order.
        const served = nonBlankString(c.modelId);
        Object.assign(facts, {
          finishReason: c.unified,
          rawFinishReason: c.raw ?? null,
          usage: c.usage,
          modelServed: served,
        });

        const fail = async (
          e: GatewayError,
          parsed: unknown = null,
        ): Promise<GatewayError> => {
          await finalize({ error: e, parsed }, { startedAt, wireStart });
          return e;
        };

        // Keep the object of an answer the gate rejects (7, D4).
        const salvage = (): unknown => {
          const r = parseAnswer(c.text, input.schema.zod, degraded);
          return r.ok ? r.value : null;
        };

        // (1) unified finish reason
        if (c.unified === "length") {
          throw await fail(
            new LengthError({
              facts,
              message: `The answer was cut at the token limit (${maxOutputTokens}).`,
              where: "output",
              maxOutputTokens,
            }),
            salvage(),
          );
        }
        if (c.unified === "content-filter") {
          throw await fail(
            new ContentFilterError({
              facts,
              message: "The provider filtered the answer.",
              via: "finish_reason",
            }),
            salvage(),
          );
        }
        if (c.unified === "tool-calls") {
          throw await fail(
            new UnexpectedToolCallsError({
              facts,
              message:
                "The model asked for a tool call. The step sends no tools.",
            }),
            salvage(),
          );
        }
        if (c.unified === "error" || c.unified === "other") {
          throw await fail(
            new AbnormalStopError({
              facts,
              message: `The provider stopped with finish reason ${c.unified}.`,
              cause: c.unified,
              retry: isRetry
                ? null
                : { change: "none", waitMs: backoffWaitMs() },
            }),
            salvage(),
          );
        }
        if (hasRefusal(c.responseBody)) {
          throw await fail(
            new ContentFilterError({
              facts,
              message: "The model refused to answer.",
              via: "refusal",
            }),
            salvage(),
          );
        }
        // (2) raw finish reason
        if (c.raw === undefined || c.raw === null || c.raw === "") {
          throw await fail(
            new AbnormalStopError({
              facts,
              message: "The provider gave no raw finish reason.",
              cause: "missing_raw",
              runWide: true,
            }),
            salvage(),
          );
        }
        if (c.raw !== acceptedRawStop(profile.provider, mode)) {
          throw await fail(
            new AbnormalStopError({
              facts,
              message: `The raw finish reason "${c.raw.slice(0, 40)}" is not a known stop.`,
              cause: "unknown_raw",
              runWide: true,
            }),
            salvage(),
          );
        }
        // (3) reasoning leak
        const reasoningOff = profile.reasoning.mode === "off";
        const leak: "think_tag" | "empty_content_with_reasoning" | null =
          THINK_TAG.test(c.text)
            ? "think_tag"
            : c.text.trim() === "" &&
                (c.reasoningChars > 0 || (c.usage.reasoning ?? 0) > 0)
              ? "empty_content_with_reasoning"
              : null;
        if (leak) {
          throw await fail(
            new ReasoningLeakError({
              facts,
              message: `The answer holds reasoning text (${leak}).`,
              leak,
              runWide: reasoningOff,
            }),
          );
        }
        // (4) served model
        if (served === null) {
          warnings.push("served model not reported");
        } else if (!modelMatches(modelRequested, served)) {
          throw await fail(
            new ModelMismatchError({
              facts,
              message: `The served model differs from the requested one (${modelRequested} / ${served}).`,
              requested: modelRequested,
              served,
              runWide: true,
            }),
            salvage(),
          );
        }
        // (5) parse
        let object: T | undefined;
        let failure: { stage: "json" | "schema"; message: string } | null =
          null;
        if (degraded) {
          const r = parseAnswer(c.text, input.schema.zod, true);
          if (r.ok) object = r.value;
          else failure = r;
        } else if (sdkError !== null) {
          if (NoObjectGeneratedError.isInstance(sdkError)) {
            const r = parseAnswer(c.text, input.schema.zod, false);
            failure = r.ok
              ? { stage: "schema", message: "The SDK rejected the object." }
              : r;
          } else {
            throw await fail(
              new ProviderError({
                facts,
                message: "Provider error: unavailable",
                reason: "unavailable",
                statusCode: null,
                retryAfterMs: null,
                detail: failureDetail(sdkError),
                retry: isRetry
                  ? null
                  : { change: "none", waitMs: backoffWaitMs() },
              }),
            );
          }
        } else {
          try {
            object = (sdkResult as { output: T }).output;
          } catch (e) {
            if (!NoOutputGeneratedError.isInstance(e)) throw e;
            const r = parseAnswer(c.text, input.schema.zod, false);
            failure = r.ok
              ? { stage: "json", message: "The answer holds no object." }
              : r;
          }
        }
        if (failure || object === undefined) {
          const f = failure ?? {
            stage: "json" as const,
            message: "The answer holds no object.",
          };
          throw await fail(
            new SchemaError({
              facts,
              message: `The answer does not match the schema (${f.stage}).`,
              stage: f.stage,
              validatorMessage: f.message,
              retry: isRetry
                ? null
                : { change: "add_validator_message", waitMs: 0 },
            }),
          );
        }

        const recorded = await finalize(
          { error: null, parsed: object },
          { startedAt, wireStart },
        );
        return {
          object,
          finishReason: "stop",
          rawFinishReason: c.raw,
          usage: c.usage,
          modelRequested,
          modelServed: served,
          latencyMs: facts.latencyMs,
          queuedMs,
          attempt: recorded.attempt,
          paramsLedger: facts.paramsLedger,
          structuredMode: mode,
          callId: recorded.id,
        } satisfies CallStructuredResult<T>;
      },
    );
  } catch (e) {
    if (e instanceof LlmLaneCancelledError) throw queued();
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Boot probe (5.7)
// ---------------------------------------------------------------------------

/**
 * Base URLs of the cloud providers for the probe. Read in the v7 provider
 * packages on 2026-10-18: `@ai-sdk/openai` 4.0.96, `anthropic` 4.0.82,
 * `google` 4.0.99, `mistral` 4.0.66, `groq` 4.0.63. OpenRouter and Vercel
 * come from the registry.
 */
const PROBE_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  mistral: "https://api.mistral.ai/v1",
  groq: "https://api.groq.com/openai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  vercel: "https://ai-gateway.vercel.sh/v1",
};

export interface ProbeOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/**
 * One request, 3 s, no API key, no meeting data. Any HTTP status passes: an
 * answer proves the endpoint is reachable. A network error or a timeout gives
 * false. A missing server entry, a missing key or an unknown provider gives
 * true: the resumed run then fails with a typed `model_unavailable` at its
 * first call (5.7).
 */
export async function probeEndpoint(
  profile: Pick<CallProfile, "provider" | "modelId">,
  opts: ProbeOptions = {},
): Promise<boolean> {
  let url: string;
  let method: "GET" | "HEAD";
  if (isOwnServerProvider(profile.provider)) {
    const target = parseServerModelId(profile.modelId);
    const server = target ? getOwnServer(target.serverId) : null;
    if (!server) return true;
    url = `${server.base_url.replace(/\/v1\/?$/, "")}/v1/models`;
    method = "GET";
  } else {
    const base = PROBE_BASE_URLS[profile.provider];
    if (!base) return true;
    if (!getApiKey(profile.provider)) return true;
    url = base;
    method = "HEAD";
  }
  const doFetch = opts.fetch ?? globalThis.fetch;
  try {
    await doFetch(url, {
      method,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 3000),
    });
    return true;
  } catch {
    return false;
  }
}
