// Wire tests of the LLM gateway (specs/meeting-enhance-agentic.md 10.5.2,
// W1 to W13, W2b, W15). The model is built by `createChatModel`, so the real
// provider code and the real fetch wrapper run. Only `globalThis.fetch` is
// stubbed. The `createModel` seam stays unset.
import { serverModelId } from "@openstyle/validations";
import { asSchema } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteSetting, getDb, writeSetting } from "../src/lib/db.js";
import type { CallRecord, CallSink } from "../src/lib/llm/call-record.js";
import {
  __clearLlamaCppCompletionForTests,
  type CallStructuredInput,
  callStructured,
  probeEndpoint,
} from "../src/lib/llm/gateway.js";
import {
  AbnormalStopError,
  CancelledError,
  ContentFilterError,
  type GatewayError,
  LengthError,
  ModelMismatchError,
  ProviderError,
  ReasoningLeakError,
  UnexpectedToolCallsError,
} from "../src/lib/llm/gateway-errors.js";
import { __resetLlmLanesForTests } from "../src/lib/llm/lane.js";
import {
  __clearModeCacheForTests,
  type CallProfile,
  resolveCallProfile,
  withReasoningOff,
} from "../src/lib/llm/model-profiles.js";
import {
  createSamplingFetch,
  mergeSamplingIntoBody,
} from "../src/lib/llm/registry.js";
import { resolveTaskCall } from "../src/lib/llm/task-profiles.js";
import {
  CORRECT_CHUNK_STEP_SCHEMA,
  type CorrectChunk,
} from "../src/lib/meetings/workflow/schemas.js";
import { getOwnServer, insertOwnServer } from "../src/lib/own-servers.js";
import { putTaskAssignments } from "./helpers/task-assignments.js";

const MODEL = "Test-Model-27B";
const VALID = '{"corrections":[]}';
const jsonHeaders = { "content-type": "application/json" };

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown> | null;
}

function chatReply(
  content: string,
  o: {
    finish?: string | null;
    model?: string | null;
    extraMessage?: Record<string, unknown>;
    reasoningTokens?: number;
    extraBody?: Record<string, unknown>;
  } = {},
): Response {
  return new Response(
    JSON.stringify({
      ...(o.extraBody ?? {}),
      id: "1",
      object: "chat.completion",
      created: 0,
      ...(o.model === null ? {} : { model: o.model ?? MODEL }),
      choices: [
        {
          index: 0,
          message: { role: "assistant", content, ...(o.extraMessage ?? {}) },
          finish_reason: o.finish === undefined ? "stop" : o.finish,
        },
      ],
      usage: {
        prompt_tokens: 40,
        completion_tokens: 9,
        total_tokens: 49,
        ...(o.reasoningTokens !== undefined
          ? {
              completion_tokens_details: {
                reasoning_tokens: o.reasoningTokens,
              },
            }
          : {}),
      },
    }),
    { status: 200, headers: jsonHeaders },
  );
}

function errorReply(
  status: number,
  body = "{}",
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: { ...jsonHeaders, ...headers },
  });
}

/** Stub fetch: each call takes the next reply. The last reply repeats. */
function stubFetch(replies: (() => Response | Promise<Response>)[]): Seen[] {
  const seen: Seen[] = [];
  let n = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const raw = init?.body;
    let body: Record<string, unknown> | null = null;
    if (typeof raw === "string") {
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
    }
    seen.push({
      url: String(input instanceof Request ? input.url : input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body,
    });
    // models.dev is down in these tests: a read of it is a network fault.
    if (seen[seen.length - 1]?.url.includes("models.dev")) {
      throw new TypeError("fetch failed");
    }
    const next = replies[Math.min(n, replies.length - 1)];
    n += 1;
    if (!next) throw new Error("no reply");
    return next();
  });
  return seen;
}

function makeSink() {
  const records: CallRecord[] = [];
  const sink: CallSink = {
    startAttempt: () => undefined,
    recordCall: (c) => {
      records.push(c);
      return { id: records.length, attempt: records.length };
    },
  };
  return { sink, records };
}

let serverId = "";
let modelId = "";

function seedDefaultLlm(provider: string, id: string): void {
  const db = getDb();
  db.exec("DELETE FROM model_configs WHERE type = 'llm'");
  db.prepare(
    `INSERT INTO model_configs (provider, model_id, model_name, type, is_default)
     VALUES (?, ?, ?, 'llm', 1)`,
  ).run(provider, id, id);
}

async function serverProfile(): Promise<CallProfile> {
  seedDefaultLlm("server", modelId);
  return resolveCallProfile({
    taskId: "meetingEnhance",
    step: "correctChunk",
    maxReasoningTokens: 0,
  });
}

async function makeInput(
  profile: CallProfile,
  over: Partial<CallStructuredInput<CorrectChunk>> = {},
) {
  const rec = makeSink();
  const controller = new AbortController();
  const input: CallStructuredInput<CorrectChunk> = {
    step: "correctChunk",
    runId: "run-wire",
    unitKey: "chunk:0",
    chunkIndex: 0,
    schema: CORRECT_CHUNK_STEP_SCHEMA,
    instructions: "Fix recognizer errors.",
    messages: [{ role: "user", content: "[s1] Me: we shiped on friday" }],
    profile,
    maxOutputTokens: 400,
    signal: controller.signal,
    sink: rec.sink,
    ...over,
  };
  return { input, ...rec, controller };
}

async function fails(p: Promise<unknown>): Promise<GatewayError> {
  try {
    await p;
  } catch (e) {
    return e as GatewayError;
  }
  throw new Error("expected the call to throw");
}

/** What the ledger must equal: the wire body without prompts and schema bodies. */
function expectedLedgerBody(body: Record<string, unknown>) {
  const copy = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  delete copy.messages;
  const rf = copy.response_format as
    | { json_schema?: { schema?: unknown } }
    | undefined;
  if (rf?.json_schema) delete rf.json_schema.schema;
  return copy;
}

beforeEach(() => {
  for (const name of [
    "ANTHROPIC_BASE_URL",
    "OPENAI_BASE_URL",
    "GROQ_BASE_URL",
    "MISTRAL_BASE_URL",
    "GOOGLE_GENERATIVE_AI_BASE_URL",
  ]) {
    vi.stubEnv(name, undefined);
  }
  deleteSetting("llm_task_assignments");
  deleteSetting("llm_parameter_presets");
  getDb().prepare("DELETE FROM api_keys").run();
  getDb().exec("DELETE FROM own_servers");
  serverId = insertOwnServer({
    baseUrl: "http://127.0.0.1:8123",
    apiKey: null,
    flavor: "omlx",
  }).id;
  modelId = serverModelId(serverId, MODEL);
  __resetLlmLanesForTests();
  __clearModeCacheForTests();
  __clearLlamaCppCompletionForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("W1, a normal server call", () => {
  it("sends the schema, reasoning off and the sampling; the ledger equals the body", async () => {
    const seen = stubFetch([() => chatReply(VALID)]);
    const profile = await serverProfile();
    // W14 (a): a server profile reads no models.dev entry and has no warning.
    expect(seen).toHaveLength(0);
    expect(profile.warnings).toEqual([]);
    expect(profile.contextWindow).toBeNull();
    expect(profile.structured).toBe("json_schema_strict");

    const { input, records } = await makeInput(profile);
    const result = await callStructured(input);
    expect(result.object).toEqual({ corrections: [] });
    expect(seen).toHaveLength(1);
    const body = seen[0]?.body as Record<string, unknown>;
    expect(seen[0]?.url).toBe("http://127.0.0.1:8123/v1/chat/completions");
    const rf = body.response_format as {
      type: string;
      json_schema: { name: string; strict: boolean; schema: unknown };
    };
    expect(rf.type).toBe("json_schema");
    expect(rf.json_schema.name).toBe("correct_chunk");
    expect(rf.json_schema.strict).toBe(true);
    expect(rf.json_schema.schema).toEqual(
      await asSchema(CORRECT_CHUNK_STEP_SCHEMA.zod).jsonSchema,
    );
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(400);
    expect(body.model).toBe(MODEL);

    // Ledger equals the body key by key (G8). Prompts and schema bodies are out.
    const ledger = result.paramsLedger;
    expect(ledger.capturedFrom).toBe("wire");
    expect({ ...ledger.topLevel, ...ledger.extraBody }).toEqual(
      expectedLedgerBody(body),
    );
    expect(ledger.extraBody).toEqual({
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(ledger.dropped).toEqual([]);
    expect(ledger.source).toEqual({ mode: "auto" });
    expect(ledger.structuredMode).toBe("json_schema_strict");
    // The record holds the same ledger and the schema JSON.
    expect(records[0]?.params).toEqual(ledger);
    expect(records[0]?.schema.json).toEqual(rf.json_schema.schema);
    expect(JSON.stringify(ledger)).not.toContain("we shiped");
  });
});

describe("W2 and W2b, the preset denylist", () => {
  const presetKeys = {
    response_format: { type: "json_object" },
    stop: ["}"],
    guided_json: { type: "object" },
    top_k: 20,
  };

  it("W2: response_format, stop and guided_json are dropped; the SDK schema stays", async () => {
    seedDefaultLlm("server", modelId);
    putTaskAssignments({
      meetingEnhance: { mode: "custom", params: presetKeys },
    });
    const seen = stubFetch([() => chatReply(VALID)]);
    const { input } = await makeInput(await serverProfile());
    const result = await callStructured(input);
    const body = seen[0]?.body as Record<string, unknown>;
    expect(body.stop).toBeUndefined();
    expect(body.guided_json).toBeUndefined();
    expect((body.response_format as { type: string }).type).toBe("json_schema");
    expect(body.top_k).toBe(20);
    const dropped = result.paramsLedger.dropped;
    expect(dropped.map((d) => d.name).sort()).toEqual([
      "guided_json",
      "response_format",
      "stop",
    ]);
    expect(dropped.every((d) => d.reason === "denylist")).toBe(true);
    expect(result.paramsLedger.source).toEqual({ mode: "custom" });
    expect(result.paramsLedger.extraBody.top_k).toBe(20);
  });

  it("W2b: dictation cleanup keeps stop; the two meeting tasks drop it", async () => {
    seedDefaultLlm("server", modelId);
    putTaskAssignments({
      cleanup: { mode: "custom", params: { stop: ["x"], temperature: 0.2 } },
      meetingEnhance: { mode: "custom", params: { stop: ["x"] } },
      meetingSummarize: { mode: "custom", params: { stop: ["x"] } },
    });
    const cleanup = await resolveTaskCall("cleanup", {
      autoMaxOutputTokens: 100,
    });
    expect(cleanup.samplingParams.stop).toEqual(["x"]);
    expect(cleanup.droppedKeys).toEqual([]);
    for (const task of ["meetingEnhance", "meetingSummarize"] as const) {
      const r = await resolveTaskCall(task, { autoMaxOutputTokens: 100 });
      expect(r.samplingParams.stop).toBeUndefined();
      expect(r.droppedKeys).toEqual([
        { name: "stop", value: ["x"], reason: "denylist" },
      ]);
    }
  });
});

describe("W3, wire finish reasons", () => {
  it.each([
    ["stop", null],
    ["length", LengthError],
    ["content_filter", ContentFilterError],
    ["tool_calls", UnexpectedToolCallsError],
    ["function_call", UnexpectedToolCallsError],
    ["something_new", AbnormalStopError],
  ] as const)("finish_reason %s", async (finish, errorClass) => {
    stubFetch([() => chatReply(VALID, { finish })]);
    const { input, records } = await makeInput(await serverProfile());
    if (errorClass === null) {
      const result = await callStructured(input);
      expect(result.rawFinishReason).toBe("stop");
    } else {
      const err = await fails(callStructured(input));
      expect(err).toBeInstanceOf(errorClass);
      expect(records[0]?.finishRaw).toBe(finish);
    }
  });
});

describe("W4 and W5, HTTP errors", () => {
  it("W4: 429 with Retry-After 3 and maxRetries 0 is one request", async () => {
    const seen = stubFetch([
      () => errorReply(429, '{"error":"slow down"}', { "retry-after": "3" }),
    ]);
    const { input } = await makeInput(await serverProfile());
    const err = await fails(callStructured(input));
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).statusCode).toBe(429);
    expect((err as ProviderError).retryAfterMs).toBe(3000);
    expect(err.retry).toEqual({ change: "none", waitMs: 3000 });
    expect(seen).toHaveLength(1);
  });

  it.each([
    [429, "{}", { "retry-after": "3" }, "provider_rate_limited", true],
    [
      429,
      "{}",
      { "retry-after-ms": "1500", "retry-after": "9" },
      "provider_rate_limited",
      true,
    ],
    [429, "{}", { "retry-after": "90" }, "provider_rate_limited", false],
    [500, "{}", {}, "provider_unavailable", true],
    [503, "{}", {}, "provider_unavailable", true],
    [409, "{}", {}, "provider_unavailable", true],
    [408, "{}", {}, "provider_timeout", false],
    [401, "{}", {}, "provider_auth", false],
    [403, "{}", {}, "provider_auth", false],
    [
      400,
      '{"error":"unsupported response_format"}',
      {},
      "provider_invalid_request",
      true,
    ],
    [400, '{"error":"bad value"}', {}, "provider_invalid_request", false],
    [404, "{}", {}, "provider_invalid_request", false],
    [422, "{}", {}, "provider_invalid_request", false],
  ] as const)("W5: HTTP %i %s %j gives %s", async (status, body, headers, kind, advice) => {
    const seen = stubFetch([() => errorReply(status, body, { ...headers })]);
    const { input } = await makeInput(await serverProfile());
    const err = await fails(callStructured(input));
    expect(err.kind).toBe(kind);
    expect((err.retry !== null) === advice).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it("W5b: a network failure before any response is provider_unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("fetch failed"),
    );
    const { input } = await makeInput(await serverProfile());
    const err = await fails(callStructured(input));
    expect(err.kind).toBe("provider_unavailable");
    expect(err.retry).not.toBeNull();
  });
});

describe("W6, the mode cache", () => {
  it("a 400 naming response_format drops the mode to prompt_only; the next call succeeds; a restart relearns", async () => {
    const seen = stubFetch([
      () => errorReply(400, '{"error":"response_format is not supported"}'),
      () => chatReply(VALID),
    ]);
    const profile = await serverProfile();
    const first = await makeInput(profile);
    const err = await fails(callStructured(first.input));
    expect(err.retry).toEqual({ change: "downgrade_mode", waitMs: 0 });

    const second = await makeInput(profile, {
      retry: { kind: "provider_invalid_request", change: "downgrade_mode" },
    });
    const result = await callStructured(second.input);
    expect(result.structuredMode).toBe("prompt_only");
    const body = seen[1]?.body as Record<string, unknown>;
    expect(body.response_format).toBeUndefined();
    expect(JSON.stringify(body.messages)).toContain("matches this JSON Schema");

    // Without the retry flag the cache still holds the lower mode.
    const third = await makeInput(profile);
    expect((await callStructured(third.input)).structuredMode).toBe(
      "prompt_only",
    );

    __clearModeCacheForTests();
    const fourth = await makeInput(profile);
    expect((await callStructured(fourth.input)).structuredMode).toBe(
      "json_schema_strict",
    );
    expect(
      (seen[3]?.body as Record<string, unknown>).response_format,
    ).toBeDefined();
  });
});

describe("W7, the served model", () => {
  it.each([
    ["equal", MODEL, true],
    ["case only", MODEL.toLowerCase(), true],
    ["date suffix", `${MODEL}-20260101`, true],
    ["missing", null, true],
    ["different", "Llama-3.1-8B", false],
  ] as const)("reply model: %s", async (_name, served, passes) => {
    stubFetch([() => chatReply(VALID, { model: served })]);
    const { input } = await makeInput(await serverProfile());
    if (passes) {
      const result = await callStructured(input);
      expect(result.modelServed).toBe(served);
      if (served === null) {
        expect(result.paramsLedger.warnings).toContain(
          "served model not reported",
        );
      }
    } else {
      expect(await fails(callStructured(input))).toBeInstanceOf(
        ModelMismatchError,
      );
    }
  });
});

describe("W8, reasoning in the answer", () => {
  it("reasoning_content with empty content is empty_content_with_reasoning", async () => {
    stubFetch([
      () =>
        chatReply("", {
          extraMessage: { reasoning_content: "Let me think..." },
        }),
    ]);
    const { input, records } = await makeInput(await serverProfile());
    const err = await fails(callStructured(input));
    expect(err).toBeInstanceOf(ReasoningLeakError);
    expect((err as ReasoningLeakError).leak).toBe(
      "empty_content_with_reasoning",
    );
    expect(records[0]?.reasoningChars).toBe("Let me think...".length);
  });

  it("a think tag in the content is think_tag", async () => {
    stubFetch([() => chatReply(`<think>x</think>${VALID}`)]);
    const { input } = await makeInput(await serverProfile());
    const err = await fails(callStructured(input));
    expect((err as ReasoningLeakError).leak).toBe("think_tag");
  });

  it("reasoning tokens are recorded; NULL when the server omits them", async () => {
    stubFetch([() => chatReply(VALID, { reasoningTokens: 7 })]);
    const a = await makeInput(await serverProfile());
    expect((await callStructured(a.input)).usage.reasoning).toBe(7);
    stubFetch([() => chatReply(VALID)]);
    const b = await makeInput(await serverProfile());
    expect((await callStructured(b.input)).usage.reasoning).toBeNull();
  });
});

describe("W8b, a thought block that uses the output limit", () => {
  const thought = { reasoning_content: "er</|channel> id seg-2..." };
  const llamaCpp = {
    system_fingerprint: "b11594-e0bcaccbe",
    timings: { prompt_n: 900, predicted_n: 400 },
  };

  it("length with only reasoning and reasoning off is a leak, not length", async () => {
    stubFetch([
      () => chatReply("", { finish: "length", extraMessage: thought }),
    ]);
    const { input, records } = await makeInput(await serverProfile());
    const err = await fails(callStructured(input));
    expect(err).toBeInstanceOf(ReasoningLeakError);
    expect((err as ReasoningLeakError).leak).toBe(
      "empty_content_with_reasoning",
    );
    expect(err.message).toBe(
      "The model used its output limit (400) on reasoning and wrote no answer.",
    );
    expect(err.runWide).toBe(true);
    // Not llama.cpp: nothing to change, so no retry.
    expect(err.retry).toBeNull();
    expect(records[0]?.errorKind).toBe("reasoning_leak");
  });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: jsonHeaders });
  const completion = (text: string) =>
    json({
      ...llamaCpp,
      id: "c1",
      object: "text_completion",
      created: 0,
      model: MODEL,
      choices: [{ index: 0, text, finish_reason: "stop" }],
      usage: { prompt_tokens: 900, completion_tokens: 12, total_tokens: 912 },
    });
  /** The fake server root of the seeded own server. Fetch is stubbed. */
  const root = () => getOwnServer(serverId)?.base_url ?? "";

  it("llama.cpp: the retry uses the template and /v1/completions, and the model keeps it", async () => {
    const seen = stubFetch([
      () =>
        chatReply("", {
          finish: "length",
          extraMessage: thought,
          extraBody: llamaCpp,
        }),
      () => json({ prompt: "<|turn>user\nhi<turn|>\n<|turn>model\n" }),
      () => completion(VALID),
      () => json({ prompt: "P2" }),
      () => completion(VALID),
    ]);
    const profile = await serverProfile();
    const first = await makeInput(profile);
    const err = await fails(callStructured(first.input));
    expect(err).toBeInstanceOf(ReasoningLeakError);
    expect(err.retry).toEqual({ change: "llamacpp_completion", waitMs: 0 });

    const retry = await makeInput(profile, {
      retry: { kind: "reasoning_leak", change: "llamacpp_completion" },
    });
    const result = await callStructured(retry.input);
    expect(result.object).toEqual({ corrections: [] });
    expect(seen[1]?.url).toBe(`${root()}/apply-template`);
    expect(seen[1]?.body?.chat_template_kwargs).toEqual({
      enable_thinking: false,
    });
    expect(seen[1]?.body?.messages).toEqual(seen[0]?.body?.messages);
    expect(seen[2]?.url).toBe(`${root()}/v1/completions`);
    const body = seen[2]?.body as Record<string, unknown>;
    expect(body.prompt).toBe("<|turn>user\nhi<turn|>\n<|turn>model\n");
    expect(body.json_schema).toEqual(
      (seen[0]?.body?.response_format as { json_schema: { schema: unknown } })
        .json_schema.schema,
    );
    expect(body.max_tokens).toBe(400);
    expect(body.messages).toBeUndefined();
    expect(body.response_format).toBeUndefined();
    expect(retry.records[0]?.finishUnified).toBe("stop");
    expect(retry.records[0]?.params.warnings).toContain(
      "llama.cpp: /v1/completions, JSON grammar from the first token",
    );

    // The next call of the same model and step takes the route on the first try.
    const next = await makeInput(profile);
    await callStructured(next.input);
    expect(seen[4]?.url).toBe(`${root()}/v1/completions`);

    // Another step of the same model keeps the chat route.
    stubFetch([() => chatReply(VALID, { extraBody: llamaCpp })]);
    const other = await makeInput(profile, { step: "summarize" });
    await callStructured(other.input);
    expect(other.records[0]?.params.warnings).not.toContain(
      "llama.cpp: /v1/completions, JSON grammar from the first token",
    );
  });

  it("llama-swap: a 404 on /apply-template falls back to /upstream/<model>/", async () => {
    const seen = stubFetch([
      () => json({ error: "not found" }, 404),
      () => json({ prompt: "P" }),
      () => completion(VALID),
    ]);
    const { input } = await makeInput(await serverProfile(), {
      retry: { kind: "reasoning_leak", change: "llamacpp_completion" },
    });
    await callStructured(input);
    expect(seen.map((s) => s.url)).toEqual([
      `${root()}/apply-template`,
      `${root()}/upstream/${MODEL}/apply-template`,
      `${root()}/v1/completions`,
    ]);
  });

  it("an output limit on the completion route is length, with no retry", async () => {
    stubFetch([
      () => json({ prompt: "P" }),
      () =>
        json({
          ...llamaCpp,
          model: MODEL,
          choices: [
            {
              index: 0,
              text: '{"corrections":[{"id"',
              finish_reason: "length",
            },
          ],
          usage: {
            prompt_tokens: 900,
            completion_tokens: 400,
            total_tokens: 1300,
          },
        }),
    ]);
    const { input } = await makeInput(await serverProfile(), {
      retry: { kind: "reasoning_leak", change: "llamacpp_completion" },
    });
    const err = await fails(callStructured(input));
    expect(err).toBeInstanceOf(LengthError);
    expect(err.retry).toBeNull();
  });
});

describe("W9, SDK warnings", () => {
  it("a setting the SDK ignores is dropped with reason sdk_unsupported", async () => {
    // OpenAI reasoning models ignore `temperature` and the SDK warns.
    getDb()
      .prepare("INSERT OR REPLACE INTO api_keys (provider, key) VALUES (?, ?)")
      .run("openai", "test-key");
    seedDefaultLlm("openai", "openai/gpt-5-mini");
    stubFetch([() => chatReply(VALID, { model: "gpt-5-mini" })]);
    const profile = await resolveCallProfile({
      taskId: "meetingEnhance",
      step: "correctChunk",
      maxReasoningTokens: 0,
    });
    const { input } = await makeInput(profile);
    const result = await callStructured(input);
    const names = result.paramsLedger.dropped.map((d) => [d.name, d.reason]);
    expect(names).toContainEqual(["temperature", "sdk_unsupported"]);
  });
});

describe("W10, timeout and cancel on a held socket", () => {
  function heldSocket(): () => Promise<Response> {
    return () => new Promise<Response>(() => undefined);
  }

  it("a fired call timeout is provider_timeout with no retry on the server", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() =>
      AbortSignal.abort(new DOMException("timeout", "TimeoutError")),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
          if (init?.signal?.aborted)
            reject(new DOMException("aborted", "AbortError"));
        }),
    );
    const { input, records } = await makeInput(await serverProfile());
    const err = await fails(callStructured(input));
    expect(err.kind).toBe("provider_timeout");
    expect(err.retry).toBeNull();
    expect(records[0]?.errorKind).toBe("provider_timeout");
  });

  it("a timed-out server call keeps chat_template_kwargs in extraBody", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() =>
      AbortSignal.abort(new DOMException("timeout", "TimeoutError")),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
          if (init?.signal?.aborted)
            reject(new DOMException("aborted", "AbortError"));
        }),
    );
    const { input, records } = await makeInput(await serverProfile());
    await fails(callStructured(input));
    const ledger = records[0]?.params;
    expect(ledger?.capturedFrom).toBe("wire");
    expect(ledger?.extraBody.chat_template_kwargs).toEqual({
      enable_thinking: false,
    });
    expect(ledger?.topLevel.chat_template_kwargs).toBeUndefined();
    expect(ledger?.topLevel.model).toBe(MODEL);
  });

  it("the user signal first is CancelledError in_flight", async () => {
    const seen = stubFetch([heldSocket()]);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          seen.push({
            url: "",
            method: "",
            headers: new Headers(),
            body: null,
          });
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const { input, controller } = await makeInput(await serverProfile());
    const p = fails(callStructured(input));
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    controller.abort();
    const err = await p;
    expect(err).toBeInstanceOf(CancelledError);
    expect((err as CancelledError).phase).toBe("in_flight");
  });
});

describe("W11, a body that is not a string", () => {
  it("the wrapper passes it on untouched", async () => {
    const seen: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      seen.push(init?.body);
      return new Response("{}");
    });
    const bytes = new Uint8Array([1, 2, 3]);
    const wrapped = createSamplingFetch(
      { temperature: 1 },
      { gatewayOverrides: { force: { set: { x: 1 } } } },
    );
    await wrapped("http://127.0.0.1:1/v1/x", { method: "POST", body: bytes });
    expect(seen[0]).toBe(bytes);
  });
});

describe("W12, every provider and mode puts its structured-output field on the wire", () => {
  interface Row {
    id: string;
    provider: string;
    model: string;
    mode: CallProfile["structured"];
    reply: () => Response;
    served?: string;
    expectBody: (body: Record<string, unknown>) => void;
  }

  const anthropicReply = (content: unknown[], stop: string) => () =>
    new Response(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content,
        stop_reason: stop,
        stop_sequence: null,
        usage: { input_tokens: 40, output_tokens: 9 },
      }),
      { status: 200, headers: jsonHeaders },
    );
  const googleReply = () =>
    new Response(
      JSON.stringify({
        candidates: [
          {
            content: { role: "model", parts: [{ text: VALID }] },
            finishReason: "STOP",
            index: 0,
          },
        ],
        usageMetadata: {
          promptTokenCount: 40,
          candidatesTokenCount: 9,
          totalTokenCount: 49,
        },
      }),
      { status: 200, headers: jsonHeaders },
    );
  const rfType = (b: Record<string, unknown>) =>
    (b.response_format as { type?: string } | undefined)?.type;

  const rows: Row[] = [
    {
      id: "openai strict",
      provider: "openai",
      model: "openai/gpt-4o-mini",
      mode: "json_schema_strict",
      reply: () => chatReply(VALID, { model: "gpt-4o-mini" }),
      expectBody: (b) => {
        expect(rfType(b)).toBe("json_schema");
        expect(
          (b.response_format as { json_schema: { strict: boolean } })
            .json_schema.strict,
        ).toBe(true);
      },
    },
    {
      id: "openai json_object",
      provider: "openai",
      model: "openai/gpt-4o-mini",
      mode: "json_object",
      reply: () => chatReply(VALID, { model: "gpt-4o-mini" }),
      expectBody: (b) => expect(rfType(b)).toBe("json_object"),
    },
    {
      id: "openai prompt_only",
      provider: "openai",
      model: "openai/gpt-4o-mini",
      mode: "prompt_only",
      reply: () => chatReply(VALID, { model: "gpt-4o-mini" }),
      expectBody: (b) => expect(b.response_format).toBeUndefined(),
    },
    {
      id: "groq strict",
      provider: "groq",
      model: "groq/qwen/qwen3.8-27b",
      mode: "json_schema_strict",
      reply: () => chatReply(VALID, { model: "qwen/qwen3.8-27b" }),
      expectBody: (b) => expect(rfType(b)).toBe("json_schema"),
    },
    {
      id: "groq json_object",
      provider: "groq",
      model: "groq/llama-3.3-70b-versatile",
      mode: "json_object",
      reply: () => chatReply(VALID, { model: "llama-3.3-70b-versatile" }),
      expectBody: (b) => expect(rfType(b)).toBe("json_object"),
    },
    {
      id: "anthropic output_config.format",
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4-6",
      mode: "json_schema",
      reply: anthropicReply([{ type: "text", text: VALID }], "end_turn"),
      expectBody: (b) => {
        const format = (b.output_config as { format?: { type?: string } })
          ?.format;
        expect(format?.type).toBe("json_schema");
      },
    },
    {
      id: "anthropic json tool",
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4-6",
      mode: "json_tool",
      reply: anthropicReply(
        [
          {
            type: "tool_use",
            id: "t1",
            name: "json",
            input: { corrections: [] },
          },
        ],
        "tool_use",
      ),
      expectBody: (b) => {
        const tools = b.tools as { name: string }[];
        expect(tools.map((t) => t.name)).toContain("json");
        expect(b.tool_choice).toBeDefined();
      },
    },
    {
      id: "google json_schema",
      provider: "google",
      model: "google/gemini-2.5-flash",
      mode: "json_schema",
      reply: googleReply,
      expectBody: (b) => {
        const g = b.generationConfig as Record<string, unknown>;
        expect(g.responseMimeType).toBe("application/json");
        expect(g.responseSchema ?? g.responseJsonSchema).toBeDefined();
      },
    },
    {
      id: "google json_object",
      provider: "google",
      model: "google/gemini-2.5-flash",
      mode: "json_object",
      reply: googleReply,
      expectBody: (b) => {
        const g = b.generationConfig as Record<string, unknown>;
        expect(g.responseMimeType).toBe("application/json");
        expect(g.responseSchema).toBeUndefined();
        expect(g.responseJsonSchema).toBeUndefined();
      },
    },
    {
      id: "mistral json_schema",
      provider: "mistral",
      model: "mistral/mistral-small-latest",
      mode: "json_schema",
      reply: () => chatReply(VALID, { model: "mistral-small-latest" }),
      expectBody: (b) => expect(rfType(b)).toBe("json_schema"),
    },
    {
      id: "mistral json_object",
      provider: "mistral",
      model: "mistral/mistral-small-latest",
      mode: "json_object",
      reply: () => chatReply(VALID, { model: "mistral-small-latest" }),
      expectBody: (b) => expect(rfType(b)).toBe("json_object"),
    },
    {
      id: "openrouter require_parameters",
      provider: "openrouter",
      model: "openrouter/meta-llama/llama-3.1-8b-instruct",
      mode: "json_schema_strict",
      reply: () =>
        chatReply(VALID, { model: "meta-llama/llama-3.1-8b-instruct" }),
      expectBody: (b) => {
        expect(rfType(b)).toBe("json_schema");
        expect(b.provider).toEqual({ require_parameters: true });
        expect(b.reasoning).toEqual({ effort: "none" });
      },
    },
    {
      id: "vercel strict",
      provider: "vercel",
      model: "vercel/anthropic/claude-haiku-4.5",
      mode: "json_schema_strict",
      reply: () => chatReply(VALID, { model: "anthropic/claude-haiku-4.5" }),
      expectBody: (b) => expect(rfType(b)).toBe("json_schema"),
    },
    {
      id: "server strict",
      provider: "server",
      model: "",
      mode: "json_schema_strict",
      reply: () => chatReply(VALID),
      expectBody: (b) => expect(rfType(b)).toBe("json_schema"),
    },
    {
      id: "server prompt_only",
      provider: "server",
      model: "",
      mode: "prompt_only",
      reply: () => chatReply(VALID),
      expectBody: (b) => expect(b.response_format).toBeUndefined(),
    },
  ];

  it.each(rows)("$id", async (row) => {
    const modelFor = row.provider === "server" ? modelId : row.model;
    if (row.provider !== "server") {
      getDb()
        .prepare(
          "INSERT OR REPLACE INTO api_keys (provider, key) VALUES (?, ?)",
        )
        .run(row.provider, `key-${row.provider}`);
    }
    seedDefaultLlm(row.provider, modelFor);
    const seen = stubFetch([row.reply]);
    const base = await resolveCallProfile({
      taskId: "meetingEnhance",
      step: "correctChunk",
      maxReasoningTokens: 0,
    });
    // Cloud profiles read models.dev; the stub answers it with a failure.
    const profile: CallProfile = { ...base, structured: row.mode };
    const { input, records } = await makeInput(profile);
    const result = await callStructured(input);
    expect(result.structuredMode).toBe(row.mode);
    const call = seen.find(
      (s) => s.body !== null && !s.url.includes("models.dev"),
    );
    expect(call).toBeDefined();
    row.expectBody(call?.body as Record<string, unknown>);
    // Snapshot of the body, so a change of any provider shape shows in review.
    expect({ url: call?.url, body: call?.body }).toMatchSnapshot();
    expect(records[0]?.params.structuredMode).toBe(row.mode);
  });
});

describe("W13, input overflow", () => {
  it.each([
    [413, ""],
    [400, '{"error":{"code":"prefill_memory_exceeded"}}'],
    [400, '{"error":{"code":"context_length_exceeded"}}'],
    [400, '{"error":{"message":"maximum context length is 8192"}}'],
  ])("HTTP %i %s is a LengthError at the input", async (status, body) => {
    stubFetch([() => errorReply(status, body)]);
    const { input } = await makeInput(await serverProfile());
    const err = await fails(callStructured(input));
    expect(err).toBeInstanceOf(LengthError);
    expect((err as LengthError).where).toBe("input");
  });
});

describe("W15, probeEndpoint", () => {
  function probeFetch(status: number | "reject") {
    const calls: { url: string; method: string; headers: Headers }[] = [];
    const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
      });
      if (status === "reject") throw new TypeError("fetch failed");
      return new Response("", { status });
    });
    return { fn: fn as unknown as typeof fetch, calls };
  }

  it("server: GET <base>/v1/models; any HTTP status is true", async () => {
    for (const status of [200, 401, 404, 503]) {
      const { fn, calls } = probeFetch(status);
      const ok = await probeEndpoint(
        { provider: "server", modelId },
        { fetch: fn },
      );
      expect(ok).toBe(true);
      expect(calls[0]?.method).toBe("GET");
      expect(calls[0]?.url).toBe("http://127.0.0.1:8123/v1/models");
    }
  });

  it("server: a rejected fetch and a timeout are false", async () => {
    const { fn } = probeFetch("reject");
    expect(
      await probeEndpoint({ provider: "server", modelId }, { fetch: fn }),
    ).toBe(false);
    const hang = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener("abort", () =>
            rej(new DOMException("t", "TimeoutError")),
          );
        }),
    ) as unknown as typeof fetch;
    expect(
      await probeEndpoint(
        { provider: "server", modelId },
        { fetch: hang, timeoutMs: 20 },
      ),
    ).toBe(false);
  });

  it.each([
    ["openai", "https://api.openai.com/v1"],
    ["anthropic", "https://api.anthropic.com/v1"],
    ["google", "https://generativelanguage.googleapis.com/v1beta"],
    ["mistral", "https://api.mistral.ai/v1"],
    ["groq", "https://api.groq.com/openai/v1"],
    ["openrouter", "https://openrouter.ai/api/v1"],
    ["vercel", "https://ai-gateway.vercel.sh/v1"],
  ])("cloud %s: HEAD on %s, no key sent", async (provider, base) => {
    getDb()
      .prepare("INSERT OR REPLACE INTO api_keys (provider, key) VALUES (?, ?)")
      .run(provider, "SECRET-KEY");
    for (const status of [200, 401, 404, 503]) {
      const { fn, calls } = probeFetch(status);
      expect(
        await probeEndpoint(
          { provider, modelId: `${provider}/m` },
          { fetch: fn },
        ),
      ).toBe(true);
      expect(calls[0]?.method).toBe("HEAD");
      expect(calls[0]?.url).toBe(base);
      expect(calls[0]?.headers.get("authorization")).toBeNull();
      expect(
        JSON.stringify([...(calls[0]?.headers.entries() ?? [])]),
      ).not.toContain("SECRET-KEY");
    }
    const { fn } = probeFetch("reject");
    expect(
      await probeEndpoint(
        { provider, modelId: `${provider}/m` },
        { fetch: fn },
      ),
    ).toBe(false);
  });

  it("a missing server entry, a missing key and an unknown provider are true with no request", async () => {
    const { fn, calls } = probeFetch(200);
    expect(
      await probeEndpoint(
        { provider: "server", modelId: serverModelId("srv_gone", MODEL) },
        { fetch: fn },
      ),
    ).toBe(true);
    expect(
      await probeEndpoint(
        { provider: "openai", modelId: "openai/x" },
        { fetch: fn },
      ),
    ).toBe(true);
    expect(
      await probeEndpoint(
        { provider: "someone", modelId: "someone/x" },
        { fetch: fn },
      ),
    ).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("5.5.2, precedence of the gateway keys over a preset", () => {
  function assign(params: Record<string, unknown>): void {
    seedDefaultLlm("server", modelId);
    putTaskAssignments({ meetingEnhance: { mode: "custom", params } });
  }

  async function boundedProfile(): Promise<CallProfile> {
    seedDefaultLlm("server", modelId);
    return resolveCallProfile({
      taskId: "meetingEnhance",
      step: "identifySpeakers",
      maxReasoningTokens: 1024,
      reasoningSteps: { identifySpeakers: "bounded" },
    });
  }

  it("a preset that turns thinking on wins over the off plan, with a ledger warning", async () => {
    assign({ chat_template_kwargs: { enable_thinking: true } });
    const seen = stubFetch([() => chatReply(VALID)]);
    const { input } = await makeInput(await serverProfile());
    const result = await callStructured(input);
    expect(
      (seen[0]?.body as Record<string, unknown>).chat_template_kwargs,
    ).toEqual({
      enable_thinking: true,
    });
    expect(result.paramsLedger.warnings).toContain("reasoning on by preset");
  });

  it("a bounded plan writes enable_thinking and thinking_budget", async () => {
    const seen = stubFetch([() => chatReply(VALID)]);
    const { input } = await makeInput(await boundedProfile());
    const result = await callStructured(input);
    const body = seen[0]?.body as Record<string, unknown>;
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(body.thinking_budget).toBe(1024);
    expect(result.paramsLedger.extraBody.thinking_budget).toBe(1024);
    expect(result.paramsLedger.warnings).toEqual([]);
  });

  it("a key the preset sets keeps the preset value; the ledger names it", async () => {
    assign({
      chat_template_kwargs: { enable_thinking: false },
      thinking_budget: 50,
    });
    const seen = stubFetch([() => chatReply(VALID)]);
    const { input } = await makeInput(await boundedProfile());
    const result = await callStructured(input);
    const body = seen[0]?.body as Record<string, unknown>;
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.thinking_budget).toBe(50);
    expect(result.paramsLedger.warnings).toEqual([
      "reasoning plan overridden by preset: enable_thinking",
      "reasoning plan overridden by preset: thinking_budget",
    ]);
  });

  it("force (the length route) beats the preset and removes the reasoning keys", async () => {
    assign({
      chat_template_kwargs: { enable_thinking: true, reasoning_effort: "high" },
      reasoning_effort: "high",
      thinking_budget: 99,
      top_k: 20,
    });
    const seen = stubFetch([() => chatReply(VALID)]);
    const { input } = await makeInput(withReasoningOff(await boundedProfile()));
    await callStructured(input);
    const body = seen[0]?.body as Record<string, unknown>;
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.thinking_budget).toBeUndefined();
    expect(body.top_k).toBe(20);
  });

  it("max_tokens stays a floor: a preset floor above the call value reaches the wire", () => {
    const body = JSON.stringify({ model: "m", max_tokens: 100 });
    expect(
      JSON.parse(mergeSamplingIntoBody(body, { max_tokens: 512 })).max_tokens,
    ).toBe(512);
    expect(
      JSON.parse(mergeSamplingIntoBody(body, { max_tokens: 50 })).max_tokens,
    ).toBe(100);
  });

  it("a preset max_tokens never lifts the body past the room left in the window", async () => {
    // The owner preset names the whole window (32768) on a 32768-token model.
    // The worker refuses prompt + max_tokens over the window, so every call
    // failed and the length route split down to single lines.
    assign({ max_tokens: 32768 });
    const seen = stubFetch([() => chatReply(VALID)]);
    const profile = { ...(await serverProfile()), contextWindow: 32768 };
    const { input } = await makeInput(profile);
    await callStructured(input);
    const body = seen[0]?.body as Record<string, unknown>;
    const max = body.max_tokens as number;
    expect(max).toBeGreaterThanOrEqual(400);
    // The prompt is about 60 tokens: the room is far below 32768.
    expect(max).toBeLessThan(32768 - 40);
  });

  it("the ceiling keeps a smaller preset floor and the call value", () => {
    const body = JSON.stringify({ model: "m", max_tokens: 400 });
    const merge = (preset: number, ceiling: number) =>
      JSON.parse(
        mergeSamplingIntoBody(
          body,
          { max_tokens: preset },
          { maxTokensCeiling: ceiling },
        ),
      ).max_tokens;
    expect(merge(1000, 5000)).toBe(1000);
    expect(merge(32768, 5000)).toBe(5000);
    // A ceiling under the call value never lowers it.
    expect(merge(32768, 100)).toBe(400);
  });
});

describe("W16, wire warnings reach the ledger", () => {
  it("Gemini 3 with reasoning off records that thinking cannot be turned off", async () => {
    getDb()
      .prepare("INSERT OR REPLACE INTO api_keys (provider, key) VALUES (?, ?)")
      .run("google", "key-google");
    seedDefaultLlm("google", "google/gemini-3-pro");
    stubFetch([
      () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: { role: "model", parts: [{ text: VALID }] },
                finishReason: "STOP",
                index: 0,
              },
            ],
            usageMetadata: {
              promptTokenCount: 40,
              candidatesTokenCount: 9,
              totalTokenCount: 49,
            },
          }),
          { status: 200, headers: jsonHeaders },
        ),
    ]);
    const base = await resolveCallProfile({
      taskId: "meetingEnhance",
      step: "correctChunk",
      maxReasoningTokens: 0,
    });
    const { input, records } = await makeInput({
      ...base,
      structured: "json_schema",
    });
    const result = await callStructured(input);
    expect(result.paramsLedger.warnings).toContain(
      "reasoning cannot be turned off: thinkingLevel low",
    );
    expect(records[0]?.params.warnings).toContain(
      "reasoning cannot be turned off: thinkingLevel low",
    );
  });
});
