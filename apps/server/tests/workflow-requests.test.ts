// Request counts through `callUnit` and the real gateway (specs/meeting-enhance-agentic.md
// 10.5.1, column "Req"; goal G5). The real gateway, gate and ledger run over a
// scripted `MockLanguageModelV4`. `callUnit` is the one retry layer: one retry
// for each call, with the `gatewayRetryOn` rule. The AI SDK runs with
// `maxRetries` 0 and no node has a `RetryPolicy`.
import { APICallError, RetryError } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { callUnit } from "../src/lib/llm/call-unit.js";
import { callStructured } from "../src/lib/llm/gateway.js";
import {
  CancelledError,
  DeadlineExceededError,
  GatewayError,
  ModelUnavailableError,
} from "../src/lib/llm/gateway-errors.js";
import { __resetLlmLanesForTests } from "../src/lib/llm/lane.js";
import {
  __clearModeCacheForTests,
  type CallProfile,
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
import {
  makeFakeRecorder,
  makeTestRunContext,
} from "./helpers/workflow-harness.js";

const MODEL = "Qwen3.8-27B";
const VALID = '{"corrections":[]}';

function makeProfile(over: Partial<CallProfile> = {}): CallProfile {
  return {
    taskId: "meetingEnhance",
    provider: "server",
    modelId: `srv_requests/${MODEL}`,
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

function apiError(
  statusCode: number | undefined,
  extra: { headers?: Record<string, string>; body?: string } = {},
): APICallError {
  return new APICallError({
    message: `HTTP ${statusCode ?? "network"}`,
    url: "http://127.0.0.1:1/v1/chat/completions",
    requestBodyValues: { messages: [{ content: "SECRET PROMPT TEXT" }] },
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(extra.headers ? { responseHeaders: extra.headers } : {}),
    ...(extra.body !== undefined ? { responseBody: extra.body } : {}),
    isRetryable:
      statusCode === undefined ||
      statusCode === 408 ||
      statusCode === 409 ||
      statusCode === 429 ||
      statusCode >= 500,
  });
}

/** One `callUnit` over a scripted model. Returns the number of requests. */
async function run(script: ScriptStep[], profile: CallProfile = makeProfile()) {
  const fake = scriptedModel(MODEL, script);
  const recorder = makeFakeRecorder();
  const ctx = makeTestRunContext();
  const sleep = vi.fn(async (_ms: number, _signal: AbortSignal) => {});
  let error: unknown = null;
  let value: unknown = null;
  try {
    value = await callUnit(
      {
        step: "correctChunk",
        runId: ctx.runId,
        unitKey: "chunk:0",
        chunkIndex: 0,
        schema: CORRECT_CHUNK_STEP_SCHEMA,
        instructions: "Fix recognizer errors. Return the corrections.",
        messages: [{ role: "user", content: "[s1] Me: we shiped on friday" }],
        profile,
        maxOutputTokens: 400,
        signal: ctx.signal,
      },
      ctx,
      {
        recorder,
        callStructured,
        createModel: seamFor(fake.model),
        sleep,
      },
    );
  } catch (e) {
    error = e;
  }
  return { requests: fake.calls.length, error, value, sleep, ctx, recorder };
}

beforeEach(() => {
  __resetLlmLanesForTests();
  __clearModeCacheForTests();
});

describe("A rows: the answer decides the retry", () => {
  it("A1: a valid answer is 1 request", async () => {
    const r = await run([okReply(VALID)]);
    expect(r.requests).toBe(1);
    expect(r.error).toBeNull();
  });

  it.each([
    ["A2 zod-invalid JSON", okReply('{"corrections":[{"id":"s1","text":42}]}')],
    ["A3 stray quote (#163)", okReply('{"corrections":["}')],
  ])("%s: 2 requests, the retry carries the validator message", async (_n, step) => {
    const r = await run([step]);
    expect(r.requests).toBe(2);
    expect(r.error).toBeInstanceOf(GatewayError);
    expect((r.error as GatewayError).kind).toBe("schema");
    // Each recorded call is a row; the second says why it is a retry.
    expect(r.recorder.calls.map((c) => c.retryReason)).toEqual([
      null,
      "schema",
    ]);
  });

  it("A2b: a schema error on the first call and a valid second answer succeeds", async () => {
    const r = await run([okReply('{"corrections":["}'), okReply(VALID)]);
    expect(r.requests).toBe(2);
    expect(r.error).toBeNull();
  });

  it.each([
    ["A6 content-filter", reply("content-filter", "content_filter", "")],
    [
      "A7 refusal field",
      okReply(VALID, {
        responseBody: {
          choices: [{ message: { content: VALID, refusal: "I cannot help." } }],
        },
      }),
    ],
    ["A8 tool-calls", reply("tool-calls", "tool_calls", "")],
  ])("%s: 1 request", async (_n, step) => {
    expect((await run([step])).requests).toBe(1);
  });

  it.each([
    ["A9 error", reply("error", "whatever", VALID)],
    ["A10 other", reply("other", "whatever", VALID)],
  ])("%s: 2 requests with a 1 s wait", async (_n, step) => {
    const r = await run([step]);
    expect(r.requests).toBe(2);
    expect(r.sleep).toHaveBeenCalledTimes(1);
    const wait = r.sleep.mock.calls[0] as unknown as [number];
    expect(wait[0]).toBeGreaterThanOrEqual(1000);
    expect(wait[0]).toBeLessThan(1500);
  });

  it.each([
    ["A11 unknown raw", reply("stop", "network_error", VALID)],
    ["A12 missing raw", reply("stop", undefined, VALID)],
  ])("%s: 1 request (5.2.1: no retry for unknown_raw and missing_raw)", async (_n, step) => {
    const r = await run([step]);
    expect(r.requests).toBe(1);
    expect((r.error as GatewayError).kind).toBe("abnormal_stop");
  });

  it("A13: end_turn passes under the Anthropic key; pause_turn and a wrong key fail with 1 request", async () => {
    const anthropic = makeProfile({
      provider: "anthropic",
      modelId: "anthropic/claude-sonnet-4-6",
      structured: "json_schema",
    });
    expect(
      (await run([reply("stop", "end_turn", VALID)], anthropic)).requests,
    ).toBe(1);
    const pause = await run([reply("stop", "pause_turn", VALID)], anthropic);
    expect(pause.requests).toBe(1);
    expect(pause.error).toBeInstanceOf(GatewayError);
    const wrongKey = await run([reply("stop", "end_turn", VALID)]);
    expect(wrongKey.requests).toBe(1);
    expect(wrongKey.error).toBeInstanceOf(GatewayError);
  });

  it("A14: a think tag with reasoning off is 1 request and run-wide", async () => {
    const r = await run([okReply(`<think>hmm</think>${VALID}`)]);
    expect(r.requests).toBe(1);
    expect((r.error as GatewayError).runWide).toBe(true);
  });

  it("A15: empty text with reasoning is 1 request at the call layer (the node reruns with reasoning off)", async () => {
    const bounded = makeProfile({
      reasoning: {
        ...makeProfile().reasoning,
        mode: "bounded",
        budgetTokens: 512,
      },
    });
    const r = await run(
      [okReply("", { reasoningText: "long thought", reasoningTokens: 600 })],
      bounded,
    );
    expect(r.requests).toBe(1);
    expect((r.error as GatewayError).kind).toBe("reasoning_leak");
  });

  it("A16: a different served model is 1 request", async () => {
    const r = await run([okReply(VALID, { servedModel: "Other-Model-9B" })]);
    expect(r.requests).toBe(1);
    expect((r.error as GatewayError).kind).toBe("model_mismatch");
  });

  it("A17 and A18: no served model passes; missing usage is stored as NULL", async () => {
    const r = await run([okReply(VALID, { servedModel: null, noUsage: true })]);
    expect(r.requests).toBe(1);
    expect(r.error).toBeNull();
    expect(r.recorder.calls[0]?.modelServed).toBeNull();
    expect(r.recorder.calls[0]?.usage).toEqual({
      input: null,
      output: null,
      reasoning: null,
      cached: null,
    });
  });
});

describe("HE rows: the transport error decides the retry", () => {
  it("HE1: 429 with Retry-After 3 waits 3000 ms and sends 2 requests", async () => {
    const r = await run([apiError(429, { headers: { "retry-after": "3" } })]);
    expect(r.requests).toBe(2);
    expect(r.sleep.mock.calls[0]?.[0]).toBe(3000);
  });

  it("HE2: retry-after-ms beats retry-after", async () => {
    const r = await run([
      apiError(429, {
        headers: { "retry-after-ms": "1500", "retry-after": "9" },
      }),
    ]);
    expect(r.requests).toBe(2);
    expect(r.sleep.mock.calls[0]?.[0]).toBe(1500);
  });

  it("HE3: an HTTP date gives the distance, at most 60 s", async () => {
    const date = new Date(Date.now() + 5000).toUTCString();
    const r = await run([apiError(429, { headers: { "retry-after": date } })]);
    expect(r.requests).toBe(2);
    const wait = r.sleep.mock.calls[0]?.[0] as number;
    expect(wait).toBeGreaterThan(3000);
    expect(wait).toBeLessThanOrEqual(5000);
  });

  it("HE4: Retry-After 90 gives no advice: 1 request", async () => {
    const r = await run([apiError(429, { headers: { "retry-after": "90" } })]);
    expect(r.requests).toBe(1);
  });

  it("HE5: 429 with no header waits 1 s plus jitter: 2 requests", async () => {
    const r = await run([apiError(429)]);
    expect(r.requests).toBe(2);
    const wait = r.sleep.mock.calls[0]?.[0] as number;
    expect(wait).toBeGreaterThanOrEqual(1000);
    expect(wait).toBeLessThan(1500);
  });

  it.each([
    500,
    502,
    503,
    504,
    409,
    undefined,
  ])("HE6: HTTP %s is provider_unavailable: 2 requests", async (status) => {
    const r = await run([apiError(status)]);
    expect(r.requests).toBe(2);
    expect((r.error as GatewayError).kind).toBe("provider_unavailable");
  });

  it("HE7: HTTP 408 retries on a cloud provider only", async () => {
    const cloud = await run(
      [apiError(408)],
      makeProfile({ provider: "openai", modelId: "openai/gpt-4o-mini" }),
    );
    expect(cloud.requests).toBe(2);
    const server = await run([apiError(408)]);
    expect(server.requests).toBe(1);
    expect((server.error as GatewayError).kind).toBe("provider_timeout");
  });

  it.each([401, 403])("HE8: HTTP %i is 1 request", async (status) => {
    const r = await run([apiError(status)]);
    expect(r.requests).toBe(1);
    expect((r.error as GatewayError).kind).toBe("provider_auth");
  });

  it("HE9: a 400 that names response_format retries once in a lower mode and succeeds", async () => {
    const r = await run([
      apiError(400, { body: '{"error":"response_format is not supported"}' }),
      okReply(VALID),
    ]);
    expect(r.requests).toBe(2);
    expect(r.error).toBeNull();
    expect(r.recorder.calls.at(-1)?.params.structuredMode).toBe("prompt_only");
    expect(r.sleep.mock.calls[0]?.[0]).toBe(0);
  });

  it.each([
    [400, "bad temperature"],
    [404, "no such route"],
    [422, "unprocessable"],
  ])("HE10: HTTP %i without a schema hint is 1 request", async (status, body) => {
    const r = await run([apiError(status, { body })]);
    expect(r.requests).toBe(1);
    expect((r.error as GatewayError).kind).toBe("provider_invalid_request");
  });

  it("HE12: a persistent 503 is exactly 2 requests for one call, never 6", async () => {
    const r = await run([apiError(503)]);
    expect(r.requests).toBe(2);
    expect(r.error).toBeInstanceOf(GatewayError);
    expect((r.error as GatewayError).retry).toBeNull();
  });

  it("HE13: abort while queued is 0 requests, in flight is 1, stopped() at the lease is 0", async () => {
    // Queued.
    const queued = scriptedModel(MODEL, [okReply(VALID)]);
    const ctx1 = makeTestRunContext();
    ctx1.cancel();
    await expect(
      callUnit(
        {
          step: "correctChunk",
          runId: ctx1.runId,
          unitKey: "chunk:0",
          chunkIndex: 0,
          schema: CORRECT_CHUNK_STEP_SCHEMA,
          instructions: "x",
          messages: [{ role: "user", content: "y" }],
          profile: makeProfile(),
          maxOutputTokens: 400,
          signal: ctx1.signal,
        },
        ctx1,
        {
          recorder: makeFakeRecorder(),
          callStructured,
          createModel: seamFor(queued.model),
          sleep: vi.fn(),
        },
      ),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(queued.calls).toHaveLength(0);

    // In flight.
    const flying = scriptedModel(MODEL, [HANG]);
    const ctx2 = makeTestRunContext();
    const p = callUnit(
      {
        step: "correctChunk",
        runId: ctx2.runId,
        unitKey: "chunk:0",
        chunkIndex: 0,
        schema: CORRECT_CHUNK_STEP_SCHEMA,
        instructions: "x",
        messages: [{ role: "user", content: "y" }],
        profile: makeProfile(),
        maxOutputTokens: 400,
        signal: ctx2.signal,
      },
      ctx2,
      {
        recorder: makeFakeRecorder(),
        callStructured,
        createModel: seamFor(flying.model),
        sleep: vi.fn(),
      },
    );
    const settled = p.catch((e) => e);
    await vi.waitFor(() => expect(flying.calls).toHaveLength(1));
    ctx2.cancel();
    expect(await settled).toBeInstanceOf(CancelledError);
    expect(flying.calls).toHaveLength(1);

    // stopped() true when the lease opens.
    const stopped = scriptedModel(MODEL, [okReply(VALID)]);
    const ctx3 = makeTestRunContext();
    ctx3.stop("provider_auth");
    await expect(
      callUnit(
        {
          step: "correctChunk",
          runId: ctx3.runId,
          unitKey: "chunk:0",
          chunkIndex: 0,
          schema: CORRECT_CHUNK_STEP_SCHEMA,
          instructions: "x",
          messages: [{ role: "user", content: "y" }],
          profile: makeProfile(),
          maxOutputTokens: 400,
          signal: ctx3.signal,
        },
        ctx3,
        {
          recorder: makeFakeRecorder(),
          callStructured,
          createModel: seamFor(stopped.model),
          sleep: vi.fn(),
        },
      ),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(stopped.calls).toHaveLength(0);
  });

  it("HE14: a RetryError is read through its last error (503 has advice, so the call layer retries once)", async () => {
    const inner = apiError(503);
    const retry = new RetryError({
      message: "Failed after 3 attempts",
      reason: "maxRetriesExceeded",
      errors: [inner, inner, inner],
    });
    const r = await run([retry]);
    expect((r.error as GatewayError).kind).toBe("provider_unavailable");
    expect(r.requests).toBe(2);
  });

  it("HE15: no model set up, no key, unsupported provider, server removed: 0 requests", async () => {
    const cases = [
      "Unsupported provider: nope",
      "No API key configured for provider: openai",
      "This server is not in your list any more. Add it again under Models, then pick a model.",
      "No AI model is set up yet. Pick one in Settings > Models.",
    ];
    for (const message of cases) {
      const fake = scriptedModel(MODEL, [okReply(VALID)]);
      const ctx = makeTestRunContext();
      let error: unknown = null;
      try {
        await callUnit(
          {
            step: "correctChunk",
            runId: ctx.runId,
            unitKey: "chunk:0",
            chunkIndex: 0,
            schema: CORRECT_CHUNK_STEP_SCHEMA,
            instructions: "x",
            messages: [{ role: "user", content: "y" }],
            profile: makeProfile(),
            maxOutputTokens: 400,
            signal: ctx.signal,
          },
          ctx,
          {
            recorder: makeFakeRecorder(),
            callStructured,
            createModel: async () => {
              throw new Error(message);
            },
            sleep: vi.fn(),
          },
        );
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ModelUnavailableError);
      expect(fake.calls).toHaveLength(0);
    }
  });

  it("HE16: a TimeoutError from the caller signal is DeadlineExceeded; another reason is Cancelled", async () => {
    const flying = scriptedModel(MODEL, [HANG]);
    const ctx = makeTestRunContext();
    const controller = new AbortController();
    const p = callUnit(
      {
        step: "correctChunk",
        runId: ctx.runId,
        unitKey: "chunk:0",
        chunkIndex: 0,
        schema: CORRECT_CHUNK_STEP_SCHEMA,
        instructions: "x",
        messages: [{ role: "user", content: "y" }],
        profile: makeProfile(),
        maxOutputTokens: 400,
        signal: controller.signal,
      },
      ctx,
      {
        recorder: makeFakeRecorder(),
        callStructured,
        createModel: seamFor(flying.model),
        sleep: vi.fn(),
      },
    );
    const settled = p.catch((e) => e);
    await vi.waitFor(() => expect(flying.calls).toHaveLength(1));
    controller.abort(new DOMException("deadline", "TimeoutError"));
    expect(await settled).toBeInstanceOf(DeadlineExceededError);
    expect(flying.calls).toHaveLength(1);

    const other = scriptedModel(MODEL, [okReply(VALID)]);
    const c2 = new AbortController();
    c2.abort(new Error("user"));
    await expect(
      callUnit(
        {
          step: "correctChunk",
          runId: ctx.runId,
          unitKey: "chunk:1",
          chunkIndex: 1,
          schema: CORRECT_CHUNK_STEP_SCHEMA,
          instructions: "x",
          messages: [{ role: "user", content: "y" }],
          profile: makeProfile(),
          maxOutputTokens: 400,
          signal: c2.signal,
        },
        ctx,
        {
          recorder: makeFakeRecorder(),
          callStructured,
          createModel: seamFor(other.model),
          sleep: vi.fn(),
        },
      ),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(other.calls).toHaveLength(0);
  });
});

describe("callUnit reuse and the retry wait", () => {
  it("a finished call of the same unit key is reused: 0 requests, 0 new rows", async () => {
    const fake = scriptedModel(MODEL, [okReply(VALID)]);
    const recorder = makeFakeRecorder();
    const ctx = makeTestRunContext();
    const input = {
      step: "correctChunk" as const,
      runId: ctx.runId,
      unitKey: "chunk:0",
      chunkIndex: 0,
      schema: CORRECT_CHUNK_STEP_SCHEMA,
      instructions: "x",
      messages: [{ role: "user" as const, content: "y" }],
      profile: makeProfile(),
      maxOutputTokens: 400,
      signal: ctx.signal,
    };
    const deps = {
      recorder,
      callStructured,
      createModel: seamFor(fake.model),
      sleep: vi.fn(async (_ms: number, _signal: AbortSignal) => {}),
    };
    const first = await callUnit(input, ctx, deps);
    expect(fake.calls).toHaveLength(1);
    const again = await callUnit(input, ctx, deps);
    expect(fake.calls).toHaveLength(1);
    expect(recorder.calls).toHaveLength(1);
    expect(again.object).toEqual(first.object);
    expect(again.callId).toBe(first.callId);
  });

  it("an abort during the retry wait ends the call with CancelledError and sends no second request", async () => {
    const fake = scriptedModel(MODEL, [apiError(503)]);
    const ctx = makeTestRunContext();
    const sleep = vi.fn(async () => {
      throw new Error("aborted");
    });
    await expect(
      callUnit(
        {
          step: "correctChunk",
          runId: ctx.runId,
          unitKey: "chunk:0",
          chunkIndex: 0,
          schema: CORRECT_CHUNK_STEP_SCHEMA,
          instructions: "x",
          messages: [{ role: "user", content: "y" }],
          profile: makeProfile(),
          maxOutputTokens: 400,
          signal: ctx.signal,
        },
        ctx,
        {
          recorder: makeFakeRecorder(),
          callStructured,
          createModel: seamFor(fake.model),
          sleep,
        },
      ),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(fake.calls).toHaveLength(1);
  });
});
