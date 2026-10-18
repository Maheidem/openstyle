// Scripted-model matrix of the LLM gateway (specs/meeting-enhance-agentic.md
// 10.5.1, rows A1 to A18 and HE1 to HE16). The real gateway, gate, ledger and
// model profiles run over a scripted `MockLanguageModelV4`, which enters
// through the `createModel` seam. One gateway call is one request:
// `maxRetries` is 0 and the gateway has no retry loop.
import { APICallError, RetryError } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CallRecord,
  CallSink,
  GatewayErrorKind,
} from "../src/lib/llm/call-record.js";
import {
  type CallStructuredInput,
  callStructured,
  modelMatches,
} from "../src/lib/llm/gateway.js";
import {
  AbnormalStopError,
  CancelledError,
  ContentFilterError,
  DeadlineExceededError,
  type GatewayError,
  LengthError,
  ModelMismatchError,
  ModelUnavailableError,
  ProviderError,
  ReasoningLeakError,
  SchemaError,
  UnexpectedToolCallsError,
} from "../src/lib/llm/gateway-errors.js";
import { __resetLlmLanesForTests } from "../src/lib/llm/lane.js";
import {
  __clearModeCacheForTests,
  type CallProfile,
  resolveCallProfile,
} from "../src/lib/llm/model-profiles.js";
import { CORRECT_CHUNK_STEP_SCHEMA } from "../src/lib/meetings/workflow/schemas.js";
import {
  HANG,
  okReply,
  reply,
  type ScriptStep,
  scriptedModel,
  seamFor,
} from "./helpers/fake-model.js";

const MODEL = "Qwen3.8-27B";
const VALID = '{"corrections":[]}';

function makeProfile(over: Partial<CallProfile> = {}): CallProfile {
  return {
    taskId: "meetingEnhance",
    provider: "server",
    modelId: `srv_matrix/${MODEL}`,
    contextWindow: null,
    maxOutputTokens: null,
    structured: "json_schema_strict",
    reasoning: {
      mode: "off",
      budgetTokens: 0,
      countsInMaxOutput: true,
      maxBudgetTokens: null,
      boundedLevel: null,
      control: "template_kwargs",
      force: false,
      offValue: null,
    },
    warnings: [],
    ...over,
  };
}

function makeSink() {
  const records: CallRecord[] = [];
  const attempts: { runId: string; stepKey: string }[] = [];
  const sink: CallSink = {
    startAttempt: (a) => {
      attempts.push(a);
    },
    recordCall: (c) => {
      records.push(c);
      return {
        id: records.length,
        attempt: records.filter(
          (r) => r.runId === c.runId && r.unitKey === c.unitKey,
        ).length,
      };
    },
  };
  return { sink, records, attempts };
}

function setup(script: ScriptStep[], profile: CallProfile = makeProfile()) {
  const fake = scriptedModel(MODEL, script);
  const rec = makeSink();
  const controller = new AbortController();
  const input: CallStructuredInput<{
    corrections: { id: string; text: string }[];
  }> = {
    step: "correctChunk",
    runId: "run-1",
    unitKey: "chunk:0",
    chunkIndex: 0,
    schema: CORRECT_CHUNK_STEP_SCHEMA,
    instructions: "Fix recognizer errors. Return the corrections.",
    messages: [{ role: "user", content: "[s1] Me: we shiped on friday" }],
    profile,
    maxOutputTokens: 400,
    signal: controller.signal,
    sink: rec.sink,
    createModel: seamFor(fake.model),
  };
  return { fake, rec, controller, input };
}

async function fails(p: Promise<unknown>): Promise<GatewayError> {
  try {
    await p;
  } catch (e) {
    return e as GatewayError;
  }
  throw new Error("expected the call to throw");
}

function apiError(
  statusCode: number | undefined,
  extra: {
    headers?: Record<string, string>;
    body?: string;
    isRetryable?: boolean;
    message?: string;
  } = {},
): APICallError {
  return new APICallError({
    message: extra.message ?? `HTTP ${statusCode ?? "network"}`,
    url: "http://127.0.0.1:1/v1/chat/completions",
    requestBodyValues: { messages: [{ content: "SECRET PROMPT TEXT" }] },
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(extra.headers ? { responseHeaders: extra.headers } : {}),
    ...(extra.body !== undefined ? { responseBody: extra.body } : {}),
    isRetryable:
      extra.isRetryable ??
      (statusCode === undefined ||
        statusCode === 408 ||
        statusCode === 409 ||
        statusCode === 429 ||
        statusCode >= 500),
  });
}

beforeEach(() => {
  __resetLlmLanesForTests();
  __clearModeCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("A1 to A3, valid and invalid answers", () => {
  it("A1: stop with valid JSON returns the object and records both reasons", async () => {
    const { input, rec, fake } = setup([okReply(VALID)]);
    const result = await callStructured(input);
    expect(result.object).toEqual({ corrections: [] });
    expect(result.finishReason).toBe("stop");
    expect(result.rawFinishReason).toBe("stop");
    expect(result.modelRequested).toBe(MODEL);
    expect(result.modelServed).toBe(MODEL);
    expect(result.structuredMode).toBe("json_schema_strict");
    expect(result.callId).toBe(1);
    expect(result.attempt).toBe(1);
    expect(fake.calls).toHaveLength(1);
    expect(rec.attempts).toEqual([{ runId: "run-1", stepKey: "chunk:0" }]);
    const row = rec.records[0] as CallRecord;
    expect(row.finishUnified).toBe("stop");
    expect(row.finishRaw).toBe("stop");
    expect(row.errorKind).toBeNull();
    expect(row.parsed).toEqual({ corrections: [] });
    expect(row.rawText).toBe(VALID);
    expect(row.schema.name).toBe("correct_chunk");
    expect(row.messages).toEqual(input.messages);
    expect(row.instructions).toBe(input.instructions);
  });

  it("A2: stop with zod-invalid JSON is a SchemaError; the retry adds the validator message only", async () => {
    const bad = '{"corrections":[{"id":"s1","text":42}]}';
    const first = setup([okReply(bad)]);
    const err = await fails(callStructured(first.input));
    expect(err).toBeInstanceOf(SchemaError);
    const schemaErr = err as SchemaError;
    expect(schemaErr.stage).toBe("schema");
    expect(schemaErr.retry?.change).toBe("add_validator_message");
    expect(schemaErr.validatorMessage).toContain("corrections.0.text");
    expect(schemaErr.validatorMessage).not.toContain("42");
    expect(first.rec.records[0]?.errorKind).toBe("schema");

    // The second call carries the message and a model value is not echoed.
    const second = setup([okReply(bad)]);
    const err2 = await fails(
      callStructured({
        ...second.input,
        retry: {
          kind: "schema",
          change: "add_validator_message",
          validatorMessage: schemaErr.validatorMessage,
        },
      }),
    );
    const sent = second.rec.records[0] as CallRecord;
    expect(sent.retryReason).toBe("schema");
    expect(sent.messages).toHaveLength(2);
    expect(sent.messages[1]?.role).toBe("user");
    expect(sent.messages[1]?.content).toContain(
      "Your last reply was not valid.",
    );
    expect(sent.messages[1]?.content).not.toContain(bad);
    expect((err2 as SchemaError).retry).toBeNull();
  });

  it("A3: stop with a stray quote is a SchemaError at the json stage", async () => {
    const { input } = setup([okReply('{"corrections":["}')]);
    const err = await fails(callStructured(input));
    expect(err).toBeInstanceOf(SchemaError);
    expect((err as SchemaError).stage).toBe("json");
  });
});

describe("A4 to A8, finish reasons", () => {
  it("A4: length with cut JSON is a LengthError", async () => {
    const { input, rec } = setup([
      reply("length", "length", '{"corrections":['),
    ]);
    const err = await fails(callStructured(input));
    expect(err).toBeInstanceOf(LengthError);
    expect((err as LengthError).where).toBe("output");
    expect((err as LengthError).maxOutputTokens).toBe(400);
    expect(err.retry).toBeNull();
    const row = rec.records[0] as CallRecord;
    expect(row.errorKind).toBe("length");
    expect(row.finishRaw).toBe("length");
    expect(row.rawText).toBe('{"corrections":[');
    expect(row.parsed).toBeNull();
    expect(err.facts.callId).toBe(1);
    expect(err.facts.rawFinishReason).toBe("length");
  });

  it("A5: length with complete valid JSON is a LengthError (v7 would parse it)", async () => {
    const { input, rec } = setup([reply("length", "length", VALID)]);
    const err = await fails(callStructured(input));
    expect(err).toBeInstanceOf(LengthError);
    // The object of a rejected answer is kept as parsed_json (D4).
    expect(rec.records[0]?.parsed).toEqual({ corrections: [] });
  });

  it("A6: content-filter is a ContentFilterError", async () => {
    const { input } = setup([reply("content-filter", "content_filter", "")]);
    const err = await fails(callStructured(input));
    expect(err).toBeInstanceOf(ContentFilterError);
    expect((err as ContentFilterError).via).toBe("finish_reason");
    expect(err.retry).toBeNull();
  });

  it("A7: stop with valid JSON and a refusal field is a ContentFilterError", async () => {
    const { input } = setup([
      okReply(VALID, {
        responseBody: {
          choices: [{ message: { content: VALID, refusal: "I cannot help." } }],
        },
      }),
    ]);
    const err = await fails(callStructured(input));
    expect(err).toBeInstanceOf(ContentFilterError);
    expect((err as ContentFilterError).via).toBe("refusal");
  });

  it("A8: tool-calls is an UnexpectedToolCallsError", async () => {
    const { input } = setup([reply("tool-calls", "tool_calls", "")]);
    const err = await fails(callStructured(input));
    expect(err).toBeInstanceOf(UnexpectedToolCallsError);
    expect(err.retry).toBeNull();
  });

  it.each([
    ["A9", "error"],
    ["A10", "other"],
  ] as const)("%s: unified %s is an AbnormalStopError with the same-input retry advice", async (_id, unified) => {
    const { input } = setup([reply(unified, "whatever", VALID)]);
    const err = await fails(callStructured(input));
    expect(err).toBeInstanceOf(AbnormalStopError);
    expect((err as AbnormalStopError).cause).toBe(unified);
    expect(err.retry?.change).toBe("none");
    expect(err.retry?.waitMs).toBeGreaterThanOrEqual(1000);
    expect(err.retry?.waitMs).toBeLessThan(1500);
    expect(err.runWide).toBe(false);
  });

  it("A11: stop with an unknown raw reason fails closed and is run-wide", async () => {
    const { input } = setup([reply("stop", "network_error", VALID)]);
    const err = await fails(callStructured(input));
    expect(err).toBeInstanceOf(AbnormalStopError);
    expect((err as AbnormalStopError).cause).toBe("unknown_raw");
    expect(err.retry).toBeNull();
    expect(err.runWide).toBe(true);
  });

  it("A12: stop with no raw reason is missing_raw", async () => {
    const { input } = setup([reply("stop", undefined, VALID)]);
    const err = await fails(callStructured(input));
    expect((err as AbnormalStopError).cause).toBe("missing_raw");
    expect(err.runWide).toBe(true);
  });

  it("A13: the stop alias depends on the provider and mode", async () => {
    const anthropic = makeProfile({
      provider: "anthropic",
      modelId: "anthropic/claude-sonnet-4-6",
      structured: "json_schema",
    });
    const ok = setup([reply("stop", "end_turn", VALID)], anthropic);
    await expect(callStructured(ok.input)).resolves.toMatchObject({
      rawFinishReason: "end_turn",
    });
    const pause = setup([reply("stop", "pause_turn", VALID)], anthropic);
    const err = await fails(callStructured(pause.input));
    expect((err as AbnormalStopError).cause).toBe("unknown_raw");
    // end_turn under the openai_chat key fails.
    const wrongKey = setup([reply("stop", "end_turn", VALID)]);
    const err2 = await fails(callStructured(wrongKey.input));
    expect((err2 as AbnormalStopError).cause).toBe("unknown_raw");
    // The forced json tool answers with tool_use.
    const tool = makeProfile({
      provider: "anthropic",
      modelId: "anthropic/claude-3-haiku-20240307",
      structured: "json_tool",
    });
    const t = setup([reply("stop", "tool_use", VALID)], tool);
    await expect(callStructured(t.input)).resolves.toMatchObject({
      structuredMode: "json_tool",
    });
  });
});

describe("A14 to A18, leak, model and usage", () => {
  it("A14: a think tag in the text is a ReasoningLeakError; run-wide with reasoning off", async () => {
    const { input } = setup([okReply(`<think>hmm</think>${VALID}`)]);
    const err = await fails(callStructured(input));
    expect(err).toBeInstanceOf(ReasoningLeakError);
    expect((err as ReasoningLeakError).leak).toBe("think_tag");
    expect(err.retry).toBeNull();
    expect(err.runWide).toBe(true);
  });

  it("A15: empty text with reasoning is a leak; not run-wide with reasoning on", async () => {
    const bounded = makeProfile({
      reasoning: {
        ...makeProfile().reasoning,
        mode: "bounded",
        budgetTokens: 512,
      },
    });
    const { input } = setup(
      [okReply("", { reasoningText: "long thought", reasoningTokens: 600 })],
      bounded,
    );
    const err = await fails(callStructured(input));
    expect(err).toBeInstanceOf(ReasoningLeakError);
    expect((err as ReasoningLeakError).leak).toBe(
      "empty_content_with_reasoning",
    );
    expect(err.runWide).toBe(false);
  });

  it("A15b: empty text with reasoning_content in the raw body is a leak", async () => {
    const { input } = setup([
      okReply("", {
        responseBody: {
          choices: [
            { message: { content: "", reasoning_content: "thinking" } },
          ],
        },
      }),
    ]);
    const err = await fails(callStructured(input));
    expect((err as ReasoningLeakError).leak).toBe(
      "empty_content_with_reasoning",
    );
  });

  it("A16: a different served model is a ModelMismatchError and run-wide", async () => {
    const { input } = setup([
      okReply(VALID, { servedModel: "Other-Model-9B" }),
    ]);
    const err = await fails(callStructured(input));
    expect(err).toBeInstanceOf(ModelMismatchError);
    expect((err as ModelMismatchError).requested).toBe(MODEL);
    expect((err as ModelMismatchError).served).toBe("Other-Model-9B");
    expect(err.runWide).toBe(true);
    expect(err.retry).toBeNull();
  });

  it("A17: no served model passes with a warning and a null served_model", async () => {
    const { input, rec } = setup([okReply(VALID, { servedModel: null })]);
    const result = await callStructured(input);
    expect(result.modelServed).toBeNull();
    expect(rec.records[0]?.modelServed).toBeNull();
    expect(result.paramsLedger.warnings).toContain("served model not reported");
  });

  it("A16b: modelMatches accepts a date suffix and a -latest alias, nothing else", () => {
    expect(modelMatches("gpt-4o-mini", "gpt-4o-mini-2024-07-18")).toBe(true);
    expect(
      modelMatches("claude-sonnet-4-5", "claude-sonnet-4-5-20250929"),
    ).toBe(true);
    expect(modelMatches("mistral-small-latest", "mistral-small-20260301")).toBe(
      true,
    );
    expect(modelMatches("Qwen3.8-27B", "qwen3.8-27b")).toBe(true);
    expect(modelMatches("gpt-4o", "gpt-4o-mini")).toBe(false);
    expect(modelMatches("gpt-4o-mini", "gpt-4o")).toBe(false);
  });

  it("A18: reasoning and cached tokens are stored; missing usage is NULL, not 0", async () => {
    const full = setup([
      okReply(VALID, { reasoningTokens: 600, cachedTokens: 40 }),
    ]);
    const r = await callStructured(full.input);
    expect(r.usage).toEqual({
      input: 120,
      output: 30,
      reasoning: 600,
      cached: 40,
    });
    expect(full.rec.records[0]?.usage).toEqual(r.usage);
    const none = setup([okReply(VALID, { noUsage: true })]);
    const r2 = await callStructured(none.input);
    expect(r2.usage).toEqual({
      input: null,
      output: null,
      reasoning: null,
      cached: null,
    });
  });
});

describe("HE1 to HE12, errors from the transport", () => {
  it("HE1: 429 with Retry-After 3 advises a wait of 3000 ms", async () => {
    const { input, fake } = setup([
      apiError(429, { headers: { "retry-after": "3" } }),
    ]);
    const err = await fails(callStructured(input));
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe("provider_rate_limited");
    expect(err.retry).toEqual({ change: "none", waitMs: 3000 });
    expect(fake.calls).toHaveLength(1);
  });

  it("HE2: retry-after-ms beats retry-after", async () => {
    const { input } = setup([
      apiError(429, {
        headers: { "retry-after-ms": "1500", "retry-after": "9" },
      }),
    ]);
    const err = await fails(callStructured(input));
    expect(err.retry?.waitMs).toBe(1500);
  });

  it("HE3: an HTTP date gives the distance, at most 60 s", async () => {
    const date = new Date(Date.now() + 5000).toUTCString();
    const { input } = setup([
      apiError(429, { headers: { "retry-after": date } }),
    ]);
    const err = await fails(callStructured(input));
    expect(err.retry?.waitMs).toBeGreaterThan(3000);
    expect(err.retry?.waitMs).toBeLessThanOrEqual(5000);
  });

  it("HE4 and HE5: Retry-After 90 gives no advice; no header gives 1 s plus jitter", async () => {
    const long = setup([apiError(429, { headers: { "retry-after": "90" } })]);
    expect((await fails(callStructured(long.input))).retry).toBeNull();
    const none = setup([apiError(429)]);
    const err = await fails(callStructured(none.input));
    expect(err.retry?.waitMs).toBeGreaterThanOrEqual(1000);
    expect(err.retry?.waitMs).toBeLessThan(1500);
  });

  it.each([
    500, 502, 503, 504, 409,
  ])("HE6: HTTP %i is provider_unavailable with advice", async (status) => {
    const { input } = setup([apiError(status)]);
    const err = await fails(callStructured(input));
    expect(err.kind).toBe("provider_unavailable");
    expect((err as ProviderError).statusCode).toBe(status);
    expect(err.retry?.change).toBe("none");
  });

  it("HE6b: a network error before any response is provider_unavailable", async () => {
    const { input } = setup([
      apiError(undefined, { message: "Cannot connect" }),
    ]);
    const err = await fails(callStructured(input));
    expect(err.kind).toBe("provider_unavailable");
    expect((err as ProviderError).statusCode).toBeNull();
    expect(err.retry).not.toBeNull();
  });

  it("HE7: HTTP 408 retries on a cloud provider only", async () => {
    const cloud = setup(
      [apiError(408)],
      makeProfile({ provider: "openai", modelId: "openai/gpt-4o-mini" }),
    );
    const e1 = await fails(callStructured(cloud.input));
    expect(e1.kind).toBe("provider_timeout");
    expect(e1.retry).not.toBeNull();
    const local = setup([apiError(408)]);
    const e2 = await fails(callStructured(local.input));
    expect(e2.kind).toBe("provider_timeout");
    expect(e2.retry).toBeNull();
  });

  it("HE7b: the call timeout is provider_timeout and the server gets no retry", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() =>
      AbortSignal.abort(new DOMException("timeout", "TimeoutError")),
    );
    const server = setup([HANG]);
    const e1 = await fails(callStructured(server.input));
    expect(e1.kind).toBe("provider_timeout");
    expect(e1.retry).toBeNull();
    const cloud = setup(
      [HANG],
      makeProfile({ provider: "openai", modelId: "openai/gpt-4o-mini" }),
    );
    const e2 = await fails(callStructured(cloud.input));
    expect(e2.kind).toBe("provider_timeout");
    expect(e2.retry).not.toBeNull();
    expect(cloud.rec.records).toHaveLength(1);
    expect(cloud.rec.records[0]?.errorKind).toBe("provider_timeout");
  });

  it.each([
    401, 403,
  ])("HE8: HTTP %i is provider_auth, run-wide, no retry", async (status) => {
    const { input } = setup([apiError(status)]);
    const err = await fails(callStructured(input));
    expect(err.kind).toBe("provider_auth");
    expect(err.retry).toBeNull();
    expect(err.runWide).toBe(true);
  });

  it("HE9: a 400 that names response_format advises a lower mode; the next call uses it", async () => {
    const first = setup([
      apiError(400, { body: '{"error":"response_format is not supported"}' }),
    ]);
    const err = await fails(callStructured(first.input));
    expect(err.kind).toBe("provider_invalid_request");
    expect(err.retry).toEqual({ change: "downgrade_mode", waitMs: 0 });
    expect(err.runWide).toBe(false);
    const next = setup([okReply(VALID)]);
    const result = await callStructured({
      ...next.input,
      retry: { kind: "provider_invalid_request", change: "downgrade_mode" },
    });
    expect(result.structuredMode).toBe("prompt_only");
    // The lower mode sends the schema in the instructions.
    expect(next.rec.records[0]?.instructions).toContain(
      "matches this JSON Schema",
    );
    expect(next.rec.records[0]?.params.structuredMode).toBe("prompt_only");
    // A new process relearns: the cache is empty again.
    __clearModeCacheForTests();
    const fresh = setup([okReply(VALID)]);
    expect((await callStructured(fresh.input)).structuredMode).toBe(
      "json_schema_strict",
    );
  });

  it.each([
    [400, "bad temperature"],
    [404, "no such route"],
    [422, "unprocessable"],
  ])("HE10: HTTP %i without a schema hint has no advice and is run-wide", async (status, body) => {
    const { input } = setup([apiError(status, { body })]);
    const err = await fails(callStructured(input));
    expect(err.kind).toBe("provider_invalid_request");
    expect(err.retry).toBeNull();
    expect(err.runWide).toBe(true);
  });

  it.each([
    [413, ""],
    [400, "prefill_memory_exceeded: prompt too large"],
    [400, "context_length_exceeded"],
    [400, "This model's maximum context length is 8192 tokens"],
  ])("HE11: HTTP %i %s is a LengthError at the input", async (status, body) => {
    const { input } = setup([apiError(status, { body })]);
    const err = await fails(callStructured(input));
    expect(err).toBeInstanceOf(LengthError);
    expect((err as LengthError).where).toBe("input");
    expect(err.retry).toBeNull();
  });

  it("HE12: a persistent 503 is one request per gateway call and no advice on the second", async () => {
    const first = setup([apiError(503)]);
    const e1 = await fails(callStructured(first.input));
    expect(e1.retry).not.toBeNull();
    expect(first.fake.calls).toHaveLength(1);
    const second = setup([apiError(503)]);
    const e2 = await fails(
      callStructured({
        ...second.input,
        retry: { kind: "provider_unavailable", change: "none" },
      }),
    );
    expect(e2.retry).toBeNull();
    expect(second.fake.calls).toHaveLength(1);
  });

  it("HE12b: no error text carries the prompt", async () => {
    const { input, rec } = setup([apiError(503)]);
    const err = await fails(callStructured(input));
    expect(err.message).not.toContain("SECRET PROMPT TEXT");
    expect((err as ProviderError).detail).not.toContain("SECRET PROMPT TEXT");
    expect(rec.records[0]?.errorDetail).not.toContain("SECRET PROMPT TEXT");
  });
});

describe("HE13 to HE16, cancel, deadline, setup", () => {
  it("HE13: abort while queued sends nothing and writes no record", async () => {
    const { input, controller, fake, rec } = setup([okReply(VALID)]);
    controller.abort();
    const err = await fails(callStructured(input));
    expect(err).toBeInstanceOf(CancelledError);
    expect((err as CancelledError).phase).toBe("queued");
    expect(fake.calls).toHaveLength(0);
    expect(rec.records).toHaveLength(0);
    expect(rec.attempts).toHaveLength(0);
  });

  it("HE13b: abort in flight is CancelledError in_flight and the call is recorded", async () => {
    const { input, controller, fake, rec } = setup([HANG]);
    const p = fails(callStructured(input));
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    controller.abort();
    const err = await p;
    expect(err).toBeInstanceOf(CancelledError);
    expect((err as CancelledError).phase).toBe("in_flight");
    expect(rec.records).toHaveLength(1);
    expect(rec.records[0]?.errorKind).toBe("cancelled");
  });

  it("HE13c: stopped() true when the lease opens is CancelledError queued with no request", async () => {
    const { input, fake, rec } = setup([okReply(VALID)]);
    const err = await fails(callStructured({ ...input, stopped: () => true }));
    expect(err).toBeInstanceOf(CancelledError);
    expect((err as CancelledError).phase).toBe("queued");
    expect(fake.calls).toHaveLength(0);
    expect(rec.attempts).toHaveLength(0);
    expect(rec.records).toHaveLength(0);
  });

  it("HE14: a RetryError is read through its last error", async () => {
    const inner = apiError(503);
    const retry = new RetryError({
      message: "Failed after 3 attempts",
      reason: "maxRetriesExceeded",
      errors: [inner, inner, inner],
    });
    const { input } = setup([retry]);
    const err = await fails(callStructured(input));
    expect(err.kind).toBe("provider_unavailable");
    expect((err as ProviderError).statusCode).toBe(503);
  });

  it("HE15: a model setup fault is ModelUnavailableError and sends nothing", async () => {
    const cases: [string, string][] = [
      ["Unsupported provider: nope", "unsupported_provider"],
      ["No API key configured for provider: openai", "no_api_key"],
      [
        "This server is not in your list any more. Add it again under Models, then pick a model.",
        "server_removed",
      ],
      ["No AI model is set up yet. Pick one in Settings > Models.", "no_model"],
    ];
    for (const [message, reason] of cases) {
      const { input, rec } = setup([okReply(VALID)]);
      const err = await fails(
        callStructured({
          ...input,
          createModel: async () => {
            throw new Error(message);
          },
        }),
      );
      expect(err).toBeInstanceOf(ModelUnavailableError);
      expect((err as ModelUnavailableError).reason).toBe(reason);
      expect((err as ModelUnavailableError).detail).toBe(message);
      expect(err.message).toContain("Settings > Models");
      expect(err.runWide).toBe(true);
      expect(rec.records).toHaveLength(0);
    }
  });

  it("HE15b: the real model builder fails for an unsupported provider and a missing key", async () => {
    const { input } = setup([okReply(VALID)]);
    const { createModel: _drop, ...bare } = input;
    const e1 = await fails(
      callStructured({
        ...bare,
        profile: makeProfile({ provider: "nope", modelId: "nope/x" }),
      }),
    );
    expect((e1 as ModelUnavailableError).reason).toBe("unsupported_provider");
    const e2 = await fails(
      callStructured({
        ...bare,
        profile: makeProfile({
          provider: "openai",
          modelId: "openai/gpt-4o-mini",
        }),
      }),
    );
    expect((e2 as ModelUnavailableError).reason).toBe("no_api_key");
  });

  it("HE15c: resolveCallProfile with no model set up is ModelUnavailableError no_model", async () => {
    const err = await fails(
      resolveCallProfile({
        taskId: "meetingEnhance",
        step: "correctChunk",
        maxReasoningTokens: 0,
      }),
    );
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect((err as ModelUnavailableError).reason).toBe("no_model");
  });

  it("HE16: a caller signal that aborts with TimeoutError is DeadlineExceededError; another reason is Cancelled", async () => {
    // In flight: 1 request.
    const a = setup([HANG]);
    const p = fails(callStructured(a.input));
    await vi.waitFor(() => expect(a.fake.calls).toHaveLength(1));
    a.controller.abort(new DOMException("deadline", "TimeoutError"));
    const e1 = await p;
    expect(e1).toBeInstanceOf(DeadlineExceededError);
    expect(a.rec.records[0]?.errorKind).toBe("deadline_exceeded");
    // Queued: 0 requests.
    const b = setup([okReply(VALID)]);
    b.controller.abort(new DOMException("deadline", "TimeoutError"));
    const e2 = await fails(callStructured(b.input));
    expect(e2).toBeInstanceOf(DeadlineExceededError);
    expect(b.fake.calls).toHaveLength(0);
    // Another reason.
    const c = setup([okReply(VALID)]);
    c.controller.abort(new Error("user"));
    expect(await fails(callStructured(c.input))).toBeInstanceOf(CancelledError);
  });
});

describe("the error kinds cover the 15 kinds of 5.2", () => {
  it("every GatewayErrorKind has a class that produces it", () => {
    // A Record keyed by the union fails the type check when a kind is added.
    const classes: Record<GatewayErrorKind, string> = {
      length: "LengthError",
      content_filter: "ContentFilterError",
      unexpected_tool_calls: "UnexpectedToolCallsError",
      abnormal_stop: "AbnormalStopError",
      reasoning_leak: "ReasoningLeakError",
      schema: "SchemaError",
      model_mismatch: "ModelMismatchError",
      cancelled: "CancelledError",
      provider_timeout: "ProviderError",
      provider_rate_limited: "ProviderError",
      provider_unavailable: "ProviderError",
      provider_auth: "ProviderError",
      provider_invalid_request: "ProviderError",
      model_unavailable: "ModelUnavailableError",
      deadline_exceeded: "DeadlineExceededError",
    };
    expect(Object.keys(classes)).toHaveLength(15);
  });
});
