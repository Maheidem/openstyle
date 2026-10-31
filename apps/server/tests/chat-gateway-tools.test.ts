// The native tool turn of the gateway (specs/meeting-chat-agent.md 2.6, P0
// report section 9). A scripted model answers with tool calls. The real
// gateway, gate and ledger run.
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { CallRecord, CallSink } from "../src/lib/llm/call-record.js";
import {
  type CallToolTurnInput,
  callStructured,
  callToolTurn,
  type GatewayTool,
} from "../src/lib/llm/gateway.js";
import {
  AbnormalStopError,
  CancelledError,
  LengthError,
  ProviderError,
  UnexpectedToolCallsError,
} from "../src/lib/llm/gateway-errors.js";
import { __resetLlmLanesForTests } from "../src/lib/llm/lane.js";
import {
  __clearModeCacheForTests,
  type CallProfile,
} from "../src/lib/llm/model-profiles.js";

const MODEL = "Gemma-4-E2B";

const TOOLS: GatewayTool[] = [
  {
    type: "function",
    function: {
      name: "list_items",
      description: "List items.",
      parameters: {
        type: "object",
        properties: { kind: { type: "string", enum: ["action_items"] } },
        required: ["kind"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "count_items",
      description: "Count items.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

function makeProfile(over: Partial<CallProfile> = {}): CallProfile {
  return {
    taskId: "meetingChat",
    provider: "server",
    modelId: `srv_chat/${MODEL}`,
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

type Part =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string };

interface Step {
  unified: "stop" | "length" | "tool-calls" | "other";
  raw: string | undefined;
  content: Part[];
}

const call = (name: string, input: string, id = "c1"): Part => ({
  type: "tool-call",
  toolCallId: id,
  toolName: name,
  input,
});

function model(steps: Step[] | Error) {
  let n = 0;
  return new MockLanguageModelV4({
    provider: "fake.chat",
    modelId: MODEL,
    doGenerate: async () => {
      if (steps instanceof Error) throw steps;
      const s = steps[Math.min(n, steps.length - 1)] as Step;
      n += 1;
      return {
        content: s.content,
        finishReason: { unified: s.unified, raw: s.raw },
        usage: {
          inputTokens: { total: 90, noCache: 90, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 12, text: 12, reasoning: 0 },
        },
        warnings: [],
        response: { modelId: MODEL },
      };
    },
  });
}

function setup(
  steps: Step[] | Error,
  over: Partial<CallToolTurnInput> = {},
  profile = makeProfile(),
) {
  const m = model(steps);
  const records: CallRecord[] = [];
  const attempts: unknown[] = [];
  const sink: CallSink = {
    startAttempt: (a) => {
      attempts.push(a);
    },
    recordCall: (c) => {
      records.push(c);
      return { id: records.length, attempt: records.length };
    },
  };
  const input: CallToolTurnInput = {
    step: "chatRoute",
    runId: "run-1",
    unitKey: "route",
    instructions: "Pick a tool.",
    messages: [{ role: "user", content: "How many action items?" }],
    tools: TOOLS,
    profile,
    maxOutputTokens: 100,
    signal: new AbortController().signal,
    sink,
    createModel: async () => m,
    ...over,
  };
  return { m, records, attempts, input };
}

beforeEach(() => {
  __resetLlmLanesForTests();
  __clearModeCacheForTests();
});

describe("callToolTurn", () => {
  it("returns the call on a tool-calls finish and records it", async () => {
    const { input, records, attempts, m } = setup([
      {
        unified: "tool-calls",
        raw: "tool_calls",
        content: [call("list_items", '{"kind":"action_items"}')],
      },
    ]);
    const r = await callToolTurn(input);
    expect(r.kind).toBe("call");
    if (r.kind !== "call") return;
    expect(r.name).toBe("list_items");
    expect(r.args).toEqual({ kind: "action_items" });
    expect(r.rawFinishReason).toBe("tool_calls");
    expect(r.callId).toBe(1);
    expect(r.usage.input).toBe(90);
    expect(attempts).toEqual([{ runId: "run-1", stepKey: "route" }]);
    const row = records[0] as CallRecord;
    expect(row.node).toBe("chatRoute");
    expect(row.finishUnified).toBe("tool-calls");
    expect(row.finishRaw).toBe("tool_calls");
    expect(row.errorKind).toBeNull();
    expect(row.parsed).toMatchObject({
      kind: "call",
      name: "list_items",
      callNames: ["list_items"],
    });
    // The request carried the tools and toolChoice auto.
    const sent = m.doGenerateCalls[0];
    expect(sent?.tools?.map((t) => t.name)).toEqual([
      "list_items",
      "count_items",
    ]);
    expect(sent?.toolChoice).toEqual({ type: "auto" });
    expect(m.doGenerateCalls).toHaveLength(1);
  });

  it("returns the first call and records every name when the model makes several", async () => {
    const { input, records } = setup([
      {
        unified: "tool-calls",
        raw: "tool_calls",
        content: [
          call("count_items", "{}", "c1"),
          call("list_items", '{"kind":"action_items"}', "c2"),
        ],
      },
    ]);
    const r = await callToolTurn(input);
    expect(r.kind).toBe("call");
    if (r.kind === "call") expect(r.name).toBe("count_items");
    expect(r.callNames).toEqual(["count_items", "list_items"]);
    expect(records[0]?.parsed).toMatchObject({
      callNames: ["count_items", "list_items"],
    });
  });

  it("treats an empty argument string as an empty object", async () => {
    const { input } = setup([
      {
        unified: "tool-calls",
        raw: "tool_calls",
        content: [call("count_items", "")],
      },
    ]);
    const r = await callToolTurn(input);
    expect(r).toMatchObject({ kind: "call", name: "count_items", args: {} });
  });

  it("returns none with the text when the model makes no call", async () => {
    const { input } = setup([
      {
        unified: "stop",
        raw: "stop",
        content: [{ type: "text", text: "I do not know." }],
      },
    ]);
    const r = await callToolTurn(input);
    expect(r).toMatchObject({ kind: "none", text: "I do not know." });
    expect(r.note).toBeNull();
    expect(r.callNames).toEqual([]);
  });

  it("returns none with a note for arguments that are not JSON", async () => {
    const { input, records } = setup([
      {
        unified: "tool-calls",
        raw: "tool_calls",
        content: [call("list_items", '{"kind": ')],
      },
    ]);
    const r = await callToolTurn(input);
    expect(r.kind).toBe("none");
    expect(r.note).toContain("not a JSON object");
    expect(records[0]?.errorKind).toBeNull();
  });

  it("returns none with a note for arguments that are not an object", async () => {
    const { input } = setup([
      {
        unified: "tool-calls",
        raw: "tool_calls",
        content: [call("list_items", "[1,2]")],
      },
    ]);
    const r = await callToolTurn(input);
    expect(r.kind).toBe("none");
    expect(r.note).toContain("not a JSON object");
  });

  it("returns none with a note for a tool that is not in the list", async () => {
    const { input } = setup([
      {
        unified: "tool-calls",
        raw: "tool_calls",
        content: [call("delete_everything", "{}")],
      },
    ]);
    const r = await callToolTurn(input);
    expect(r.kind).toBe("none");
    expect(r.note).toContain("unknown tool");
  });

  it("accepts the raw finish value of each provider family", async () => {
    for (const [provider, raw] of [
      ["anthropic", "tool_use"],
      ["google", "STOP"],
      ["openai", "tool_calls"],
    ] as const) {
      const { input } = setup(
        [
          {
            unified: "tool-calls",
            raw,
            content: [call("count_items", "{}")],
          },
        ],
        {},
        makeProfile({ provider, modelId: MODEL }),
      );
      const r = await callToolTurn(input);
      expect(r.kind, provider).toBe("call");
    }
  });

  it("throws abnormal_stop for a raw value the provider does not use", async () => {
    const { input, records } = setup([
      {
        unified: "tool-calls",
        raw: "weird",
        content: [call("count_items", "{}")],
      },
    ]);
    await expect(callToolTurn(input)).rejects.toBeInstanceOf(AbnormalStopError);
    expect(records[0]?.errorKind).toBe("abnormal_stop");
  });

  it("throws LengthError on a length finish", async () => {
    const { input } = setup([
      { unified: "length", raw: "length", content: [] },
    ]);
    await expect(callToolTurn(input)).rejects.toBeInstanceOf(LengthError);
  });

  it("maps an HTTP 503 to a retryable ProviderError and writes a record", async () => {
    const { APICallError } = await import("ai");
    const err = new APICallError({
      message: "down",
      url: "http://127.0.0.1:1/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 503,
      isRetryable: true,
    });
    const { input, records } = setup(err);
    const e = await callToolTurn(input).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect((e as ProviderError).reason).toBe("unavailable");
    expect((e as ProviderError).retry?.change).toBe("none");
    expect(records[0]?.errorKind).toBe("provider_unavailable");
  });

  it("throws CancelledError when the signal is already aborted", async () => {
    const c = new AbortController();
    c.abort();
    const { input } = setup([{ unified: "stop", raw: "stop", content: [] }], {
      signal: c.signal,
    });
    await expect(callToolTurn(input)).rejects.toBeInstanceOf(CancelledError);
  });

  it("writes the retry kind to the record", async () => {
    const { input, records } = setup(
      [
        {
          unified: "tool-calls",
          raw: "tool_calls",
          content: [call("count_items", "{}")],
        },
      ],
      { retry: { kind: "provider_unavailable" } },
    );
    await callToolTurn(input);
    expect(records[0]?.retryReason).toBe("provider_unavailable");
  });

  it("callStructured still throws on a tool-calls finish (it sends no tools)", async () => {
    const m = model([
      {
        unified: "tool-calls",
        raw: "tool_calls",
        content: [call("count_items", "{}")],
      },
    ]);
    const { input } = setup([]);
    await expect(
      callStructured({
        step: "chatAnswer",
        runId: "run-1",
        unitKey: "answer",
        chunkIndex: null,
        schema: { name: "x", version: 1, zod: z.object({ a: z.string() }) },
        instructions: "Answer.",
        messages: [{ role: "user", content: "hi" }],
        profile: input.profile,
        maxOutputTokens: 100,
        signal: input.signal,
        sink: input.sink,
        createModel: async () => m,
      }),
    ).rejects.toBeInstanceOf(UnexpectedToolCallsError);
    expect(m.doGenerateCalls[0]?.tools ?? []).toHaveLength(0);
  });
});
