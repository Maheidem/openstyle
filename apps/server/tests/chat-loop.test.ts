// The Ask tool loop (D22, spec 11.10): the engine switch, the model profile,
// the forced first call, the cite check by id and the "180k" rule. The database
// has the real schema. `retrieve` and the model are fakes. All text is fictional.

import type { ChatMessage, ChatScope } from "@openstyle/validations";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { ChatLlm, NativeCallResult } from "../src/lib/chat/llm.js";
import { runChatTurn } from "../src/lib/chat/pipeline.js";
import type { ChatSettings } from "../src/lib/chat/settings.js";
import { getDb } from "../src/lib/db.js";
import type { RetrievalHit } from "../src/lib/search/retrieve.js";
import { insertSegment, resetMeetingTables } from "./helpers/meetings-db.js";

vi.mock("../src/lib/search/retrieve.js", () => ({
  retrieve: vi.fn(),
  hitText: vi.fn(() => "SUMMARY TEXT"),
}));
vi.mock("../src/lib/mlx-rerank/client.js", () => ({
  // A stand-in reranker: a segment about the security review scores high.
  rerankPairs: vi.fn(async (_q: string, docs: readonly string[]) =>
    docs.map((d) => (/security review/i.test(d) ? 0.9 : 0.1)),
  ),
}));
const { retrieve } = await import("../src/lib/search/retrieve.js");
const retrieveMock = vi.mocked(retrieve);

const TODAY = Date.UTC(2026, 9, 26, 12);
const SETTINGS: ChatSettings = {
  rounds: 2,
  sourceBudget: 4000,
  k: 8,
  deadlineMs: 60_000,
  searchWider: true,
  clarify: true,
  research: false,
  engine: "loop",
  nativeTools: true,
  enabled: true,
};

import { expandThousands } from "../src/lib/chat/cites.js";
import { loopProfile } from "../src/lib/chat/loop/profile.js";

interface Calls {
  tools: string[][];
  forced: (string | undefined)[];
  answerUser: string[];
  answerSystem: string[];
}

/** A scripted model: step 1 calls `first`, the next step stops. */
function loopLlm(
  name: string,
  args: Record<string, unknown>,
  answer: unknown,
  opts: { isLocal?: boolean; modelId?: string } = {},
) {
  const seen: Calls = {
    tools: [],
    forced: [],
    answerUser: [],
    answerSystem: [],
  };
  let step = 0;
  let n = 0;
  const llm = {
    provider: "fake",
    modelId: opts.modelId ?? "fake-model",
    isLocal: opts.isLocal ?? true,
    contextWindow: null,
    runId: "run",
    async nativeCall(i: {
      tools: { function: { name: string } }[];
      toolChoice?: string;
    }) {
      n++;
      seen.tools.push(i.tools.map((t) => t.function.name));
      seen.forced.push(i.toolChoice);
      if (step++ > 0) return { kind: "none", text: "done", calls: [] };
      return {
        kind: "call",
        name,
        args,
        text: "",
        calls: [{ id: "c1", name, args }],
      };
    },
    async structured(i: {
      schema: { zod: z.ZodType<unknown> };
      system: string;
      messages: { content: string }[];
    }) {
      n++;
      seen.answerSystem.push(i.system);
      seen.answerUser.push(i.messages.map((m) => m.content).join("\n"));
      return {
        object: i.schema.zod.parse(answer),
        finishReason: "stop",
        usage: {} as never,
        latencyMs: 1,
      };
    },
    calls: () => n,
    finish() {},
  } as unknown as ChatLlm;
  return { llm, seen };
}

const run = (
  question: string,
  llm: ChatLlm,
  over: Partial<ChatSettings> = {},
) =>
  runChatTurn({
    db: getDb(),
    scope: { kind: "all" },
    question,
    history: [],
    settings: { ...SETTINGS, ...over },
    llm,
    signal: new AbortController().signal,
    now: TODAY,
  });

const hit = (chunkId: number, meetingId: string, rerank: number) =>
  ({
    chunkId,
    meetingId,
    score: rerank,
    rerankScore: rerank,
    ordinal: chunkId,
    kind: "transcript",
    startMs: 0,
    endMs: 30_000,
  }) as RetrievalHit;

function addMeeting(id: string, title: string, day: number, lines: string[]) {
  const at = Date.UTC(2026, 8, day, 10);
  getDb()
    .prepare(
      `INSERT INTO meetings (id, title, status, started_at, duration_ms, created_at, folder_id)
       VALUES (?, ?, 'summarized', ?, 600000, ?, NULL)`,
    )
    .run(id, title, at, at);
  for (const [i, text] of lines.entries()) {
    insertSegment({
      id: `${id}-s${i}`,
      meetingId: id,
      idx: i,
      startMs: i * 10_000,
      endMs: i * 10_000 + 9_000,
      text,
    });
  }
}

beforeAll(() => {
  getDb();
});

beforeEach(() => {
  resetMeetingTables();
  getDb().exec("DELETE FROM meeting_chunks");
  retrieveMock.mockReset();
  addMeeting("m1", "Alpha sync", 1, [
    "The security review is on December 4.",
    "The budget is 180k for the first year.",
  ]);
  addMeeting("m2", "Beta sync", 8, ["We talked about Kestrel Hosting again."]);
  getDb()
    .prepare(
      `INSERT INTO meeting_chunks (id, meeting_id, ordinal, segment_ids, char_start, char_end, start_ms, end_ms, token_estimate, text_hash, model_id, created_at)
       VALUES (1, 'm1', 1, ?, 0, NULL, 0, 30000, 100, 'h', 'x', 1)`,
    )
    .run(JSON.stringify(["m1-s0", "m1-s1"]));
});

describe("model profile", () => {
  it("picks the first call by model class, and the ledger only for a cloud model", () => {
    const p = (modelId: string, isLocal: boolean) =>
      loopProfile({ modelId, isLocal });
    expect(p("local-mlx-llm/gemma-4-e4b-qat-4bit", true)).toMatchObject({
      first: "search",
      stepCap: 5,
      ledger: false,
    });
    expect(p("local-mlx-llm/gemma-4-e2b-qat-4bit", true)).toMatchObject({
      first: "list_meetings",
      stepCap: 3,
      ledger: false,
    });
    expect(p("server/x/qwen3.8-flash", true)).toMatchObject({
      first: "list_meetings",
      ledger: false,
    });
    expect(p("claude-opus-5-5", false)).toMatchObject({
      first: "auto",
      stepCap: 10,
      ledger: true,
    });
    expect(p("server/x/Qwen3.8-27B", true)).toMatchObject({
      cls: "local-large",
      first: "search",
      stepCap: 10,
    });
    expect(p("some-unknown-local", true).first).toBe("search");
    expect(p("some-unknown-cloud", false).first).toBe("auto");
  });
});

describe("expandThousands", () => {
  it("turns 180k into 180000 and leaves words alone", () => {
    expect(expandThousands("The budget is 180k.")).toBe(
      "The budget is 180000.",
    );
    expect(expandThousands("1.5 k and 2,5k")).toBe("1500 and 2500");
    expect(expandThousands("a kilo, 5km, k8s")).toBe("a kilo, 5km, k8s");
  });
});

describe("loop engine", () => {
  it("forces the first call of a small model, answers with a cite, and takes 180k as 180000", async () => {
    retrieveMock.mockResolvedValue({
      status: "ok",
      modelId: "x",
      hits: [hit(1, "m1", 0.95)],
    });
    const { llm, seen } = loopLlm(
      "search",
      { query: "first year budget" },
      {
        lead: [{ text: "The first-year budget is 180000.", cites: ["S1"] }],
        bullets: [],
      },
      { modelId: "local-mlx-llm/gemma-4-e4b-qat-4bit" },
    );
    const r = await run("What is the first-year budget?", llm);
    expect(r.blocks[0]?.kind).toBe("text");
    expect(r.cites.map((c) => c.label)).toEqual(["S1"]);
    // Step 1: one active tool and a forced choice. Step 2: all four tools.
    expect(seen.tools[0]).toEqual(["search"]);
    expect(seen.forced[0]).toBe("required");
    expect(seen.tools[1]).toEqual([
      "list_meetings",
      "search",
      "read",
      "list_items",
    ]);
    expect(r.trace.steps.some((s) => s.name?.startsWith("loop:"))).toBe(true);
  });

  it("returns not_found when the loop finds nothing", async () => {
    retrieveMock.mockResolvedValue({ status: "ok", modelId: "x", hits: [] });
    const { llm } = loopLlm(
      "search",
      { query: "moon base" },
      {
        lead: [],
        bullets: [],
      },
    );
    const r = await run("What about the moon base?", llm);
    expect(r.blocks[0]).toMatchObject({ kind: "not_found" });
  });

  it("a search with only weak hits tells the answer step, which may still answer", async () => {
    retrieveMock.mockResolvedValue({
      status: "ok",
      modelId: "x",
      hits: [hit(1, "m1", 0.2)],
    });
    const { llm, seen } = loopLlm(
      "search",
      { query: "first year budget" },
      {
        lead: [{ text: "The first-year budget is 180000.", cites: ["S1"] }],
        bullets: [],
      },
    );
    const r = await run("What is the first-year budget?", llm);
    expect(r.blocks[0]?.kind).toBe("text");
    expect(seen.answerSystem[0]).toContain("only weak matches");
  });

  it("list_meetings lists every meeting with no cap", async () => {
    const { llm, seen } = loopLlm(
      "list_meetings",
      {},
      {
        lead: [{ text: "The first meeting is Alpha sync.", cites: ["S1"] }],
        bullets: [],
      },
      { modelId: "local-mlx-llm/gemma-4-e2b-qat-4bit" },
    );
    const r = await run("Which meeting came first?", llm);
    expect(r.blocks[0]?.kind).toBe("text");
    expect(seen.tools[0]).toEqual(["list_meetings"]);
    expect(seen.answerUser[0]).toContain("Alpha sync");
    expect(seen.answerUser[0]).toContain("Beta sync");
  });

  it("the pipeline engine does not enter the loop", async () => {
    retrieveMock.mockResolvedValue({
      status: "ok",
      modelId: "x",
      hits: [hit(1, "m1", 0.95)],
    });
    const { llm, seen } = loopLlm(
      "search",
      { query: "x" },
      {
        sentences: [],
        lead: [],
        bullets: [],
      },
    );
    await run("When is the security review?", llm, { engine: "pipeline" });
    expect(seen.tools.some((t) => t.includes("list_items"))).toBe(false);
  });
});
