// The model side of an Ask turn (lib/chat/llm.ts). The real gate, gateway and
// recorder run over a scripted model. Fictional data only.
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ChatGateError, createChatLlm } from "../src/lib/chat/llm.js";
import { getDb } from "../src/lib/db.js";
import type { GatewayTool } from "../src/lib/llm/gateway.js";
import { __resetLlmLanesForTests } from "../src/lib/llm/lane.js";
import { __clearModeCacheForTests } from "../src/lib/llm/model-profiles.js";
import { seedTestModel, TEST_MODEL } from "./helpers/workflow-harness.js";

vi.mock("../src/lib/model-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/model-registry.js")>()),
  fetchModelsFromRegistry: vi.fn().mockResolvedValue({}),
}));

const db = () => getDb();

type Part =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string };
type Step =
  | { unified: "stop" | "tool-calls"; raw: string; content: Part[] }
  | Error;

function model(steps: Step[]) {
  let n = 0;
  return new MockLanguageModelV4({
    provider: "fake.chat",
    modelId: TEST_MODEL,
    doGenerate: async () => {
      const s = steps[Math.min(n, steps.length - 1)] as Step;
      n += 1;
      if (s instanceof Error) throw s;
      return {
        content: s.content,
        finishReason: { unified: s.unified, raw: s.raw },
        usage: {
          inputTokens: { total: 50, noCache: 50, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 9, text: 9, reasoning: 0 },
        },
        warnings: [],
        response: { modelId: TEST_MODEL },
      };
    },
  });
}

const text = (t: string): Step => ({
  unified: "stop",
  raw: "stop",
  content: [{ type: "text", text: t }],
});
const toolCall = (name: string, input: string): Step => ({
  unified: "tool-calls",
  raw: "tool_calls",
  content: [{ type: "tool-call", toolCallId: "c1", toolName: name, input }],
});

const TOOLS: GatewayTool[] = [
  {
    type: "function",
    function: {
      name: "count_items",
      description: "Count items.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

const INTENT = {
  name: "chat_intent",
  version: 1,
  zod: z.object({ intent: z.enum(["lookup", "status"]) }),
};

function runRows() {
  return db().prepare("SELECT * FROM llm_runs WHERE scope = 'chat'").all() as {
    id: string;
    scope: string;
    scope_id: string;
    kind: string;
    started_by: string;
    status: string;
    error_kind: string | null;
    meeting_id: string | null;
  }[];
}

function callRows() {
  return db()
    .prepare("SELECT * FROM llm_calls WHERE scope = 'chat' ORDER BY id")
    .all() as {
    node: string;
    step_key: string;
    scope_id: string;
    attempt: number;
    retry_reason: string | null;
    finish_unified: string;
    error_kind: string | null;
  }[];
}

beforeEach(() => {
  db().exec("DELETE FROM llm_runs WHERE scope = 'chat'");
  db().exec("DELETE FROM model_configs WHERE type = 'llm'");
  db().exec("DELETE FROM own_servers");
  __resetLlmLanesForTests();
  __clearModeCacheForTests();
});

const signal = () => new AbortController().signal;

describe("the gate (spec 2.5a)", () => {
  it("throws no_model when no model is set", async () => {
    const err = await createChatLlm(db(), {
      threadId: "t1",
      signal: signal(),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatGateError);
    expect((err as ChatGateError).reason).toBe("no_model");
    expect(runRows()).toEqual([]);
  });

  it("throws provider_not_ready when a cloud provider has no key", async () => {
    db()
      .prepare(
        `INSERT INTO model_configs (provider, model_id, model_name, type, is_default)
         VALUES ('openai', 'gpt-5-mini', 'gpt-5-mini', 'llm', 1)`,
      )
      .run();
    const err = await createChatLlm(db(), {
      threadId: "t1",
      signal: signal(),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatGateError);
    expect((err as ChatGateError).reason).toBe("provider_not_ready");
  });

  it("throws provider_not_ready when the own server is gone", async () => {
    db()
      .prepare(
        `INSERT INTO model_configs (provider, model_id, model_name, type, is_default)
         VALUES ('server', 'srv_gone/Model', 'Model', 'llm', 1)`,
      )
      .run();
    const err = await createChatLlm(db(), {
      threadId: "t1",
      signal: signal(),
    }).catch((e: unknown) => e);
    expect((err as ChatGateError).reason).toBe("provider_not_ready");
  });

  it("throws provider_not_ready when the local model is not downloaded", async () => {
    db()
      .prepare(
        `INSERT INTO model_configs (provider, model_id, model_name, type, is_default)
         VALUES ('local-mlx-llm', 'local-mlx-llm/gemma-4-e2b-qat-4bit', 'Gemma', 'llm', 1)`,
      )
      .run();
    const prev = process.env.HUGGINGFACE_HUB_CACHE;
    process.env.HUGGINGFACE_HUB_CACHE = "/nonexistent-openstyle-test-cache";
    try {
      const err = await createChatLlm(db(), {
        threadId: "t1",
        signal: signal(),
      }).catch((e: unknown) => e);
      expect((err as ChatGateError).reason).toBe("provider_not_ready");
    } finally {
      if (prev === undefined) delete process.env.HUGGINGFACE_HUB_CACHE;
      else process.env.HUGGINGFACE_HUB_CACHE = prev;
    }
  });
});

describe("a turn with a scripted model", () => {
  beforeEach(() => {
    seedTestModel();
  });

  it("writes one run (scope chat) and one row for each call", async () => {
    const m = model([
      toolCall("count_items", "{}"),
      text('{"intent":"status"}'),
      text('{"intent":"lookup"}'),
    ]);
    const llm = await createChatLlm(db(), {
      threadId: "thread-1",
      signal: signal(),
      deps: { createModel: async () => m },
    });
    expect(llm.isLocal).toBe(true);
    expect(llm.provider).toBe("server");
    expect(llm.contextWindow).toBeNull();
    expect(llm.calls()).toBe(0);

    const native = await llm.nativeCall({
      system: "Pick a tool.",
      messages: [{ role: "user", content: "How many?" }],
      tools: TOOLS as never,
      maxOutputTokens: 80,
      unitKey: "route",
    });
    expect(native).toEqual({ kind: "call", name: "count_items", args: {} });

    const first = await llm.structured({
      step: "chatRoute",
      unitKey: "route-json",
      schema: INTENT,
      system: "Return the intent.",
      messages: [{ role: "user", content: "How many?" }],
      maxOutputTokens: 24,
    });
    expect(first.object).toEqual({ intent: "status" });
    expect(first.finishReason).toBe("stop");
    expect(first.usage.input).toBe(50);

    // The same unit key a second time (an answer retry) is a new call.
    const again = await llm.structured({
      step: "chatRoute",
      unitKey: "route-json",
      schema: INTENT,
      system: "Return the intent.",
      messages: [{ role: "user", content: "How many?" }],
      maxOutputTokens: 24,
    });
    expect(again.object).toEqual({ intent: "lookup" });
    expect(llm.calls()).toBe(3);
    expect(m.doGenerateCalls).toHaveLength(3);
    llm.finish("succeeded");
    llm.finish("failed", { errorKind: "late" });

    const runs = runRows();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: llm.runId,
      scope: "chat",
      scope_id: "thread-1",
      kind: "meetingChat",
      started_by: "chat",
      status: "succeeded",
      meeting_id: null,
    });
    const calls = callRows();
    expect(calls.map((c) => [c.node, c.step_key, c.scope_id])).toEqual([
      ["chatRoute", "route", "thread-1"],
      ["chatRoute", "route-json", "thread-1"],
      ["chatRoute", "route-json/2", "thread-1"],
    ]);
    const steps = db()
      .prepare(
        "SELECT step_key, status FROM llm_run_steps WHERE run_id = ? ORDER BY seq",
      )
      .all(llm.runId);
    expect(steps).toEqual([
      { step_key: "route", status: "succeeded" },
      { step_key: "route-json", status: "succeeded" },
      { step_key: "route-json/2", status: "succeeded" },
    ]);
  });

  it("returns none for a plain text answer of the native turn", async () => {
    const llm = await createChatLlm(db(), {
      threadId: "t",
      signal: signal(),
      deps: { createModel: async () => model([text("no tool needed")]) },
    });
    const r = await llm.nativeCall({
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      tools: TOOLS as never,
      maxOutputTokens: 50,
      unitKey: "route",
    });
    expect(r).toEqual({ kind: "none", text: "no tool needed" });
  });

  it("retries a native call once after a transport error", async () => {
    const down = new APICallError({
      message: "down",
      url: "http://127.0.0.1:1/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 503,
      isRetryable: true,
    });
    const sleep = vi.fn(async () => {});
    const m = model([down, toolCall("count_items", "{}")]);
    const llm = await createChatLlm(db(), {
      threadId: "t",
      signal: signal(),
      deps: { createModel: async () => m, sleep },
    });
    const r = await llm.nativeCall({
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      tools: TOOLS as never,
      maxOutputTokens: 50,
      unitKey: "route",
    });
    expect(r.kind).toBe("call");
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(llm.calls()).toBe(1);
    const rows = callRows();
    expect(rows.map((c) => [c.attempt, c.retry_reason, c.error_kind])).toEqual([
      [1, null, "provider_unavailable"],
      [2, "provider_unavailable", null],
    ]);
  });

  it("does not retry a second failure: the typed error is thrown and the step fails", async () => {
    const down = new APICallError({
      message: "down",
      url: "http://127.0.0.1:1/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 503,
      isRetryable: true,
    });
    const m = model([down, down, down]);
    const llm = await createChatLlm(db(), {
      threadId: "t",
      signal: signal(),
      deps: { createModel: async () => m, sleep: async () => {} },
    });
    await expect(
      llm.nativeCall({
        system: "s",
        messages: [{ role: "user", content: "hi" }],
        tools: TOOLS as never,
        maxOutputTokens: 50,
        unitKey: "route",
      }),
    ).rejects.toMatchObject({ kind: "provider_unavailable" });
    expect(m.doGenerateCalls).toHaveLength(2);
    llm.finish("failed", { errorKind: "provider_unavailable" });
    expect(runRows()[0]).toMatchObject({
      status: "failed",
      error_kind: "provider_unavailable",
    });
    const step = db()
      .prepare("SELECT status FROM llm_run_steps WHERE run_id = ?")
      .get(llm.runId);
    expect(step).toEqual({ status: "failed" });
  });

  it("a structured call stops on an aborted signal", async () => {
    const c = new AbortController();
    const llm = await createChatLlm(db(), {
      threadId: "t",
      signal: c.signal,
      deps: { createModel: async () => model([text('{"intent":"lookup"}')]) },
    });
    c.abort();
    await expect(
      llm.structured({
        step: "chatAnswer",
        unitKey: "answer",
        schema: INTENT,
        system: "s",
        messages: [{ role: "user", content: "hi" }],
        maxOutputTokens: 24,
      }),
    ).rejects.toMatchObject({ kind: "cancelled" });
    llm.finish("cancelled");
    expect(runRows()[0]?.status).toBe("cancelled");
  });
});
