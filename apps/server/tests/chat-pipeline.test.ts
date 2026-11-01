// P1.1 changes of the turn pipeline (issue #402): the cheap route, the retry
// of an empty answer, the cross-language step and the count of mentions.
// The database has the real schema. `retrieve` and the model are fakes.
// All text is fictional.
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
  nativeTools: true,
  enabled: true,
};

interface Script {
  native: NativeCallResult;
  /** Structured results by step, in order of calls. */
  structured: Record<string, unknown[]>;
}

/** A scripted model. It records the calls it got. */
function fakeLlm(script: Script) {
  const log: { step: string; system: string; user: string }[] = [];
  const used: Record<string, number> = {};
  let calls = 0;
  const llm: ChatLlm = {
    provider: "fake",
    modelId: "fake-model",
    isLocal: true,
    contextWindow: null,
    runId: "run",
    async nativeCall() {
      calls++;
      log.push({ step: "native", system: "", user: "" });
      return script.native;
    },
    async structured<T>(i: {
      step: string;
      schema: { zod: z.ZodType<T> };
      system: string;
      messages: { content: string }[];
    }) {
      calls++;
      const key = i.step;
      const n = used[key] ?? 0;
      used[key] = n + 1;
      log.push({
        step: key,
        system: i.system,
        user: i.messages.map((m) => m.content).join("\n"),
      });
      const list = script.structured[key] ?? [];
      const object = list[Math.min(n, list.length - 1)] as T;
      return {
        object: i.schema.zod.parse(object),
        finishReason: "stop",
        usage: {} as never,
        latencyMs: 1,
      };
    },
    calls: () => calls,
    finish() {},
  } as unknown as ChatLlm;
  return { llm, log };
}

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

function addChunk(
  id: number,
  meetingId: string,
  segs: string[],
  start: number,
) {
  getDb()
    .prepare(
      `INSERT INTO meeting_chunks (id, meeting_id, ordinal, segment_ids, char_start, char_end, start_ms, end_ms, token_estimate, text_hash, model_id, created_at)
       VALUES (?, ?, ?, ?, 0, NULL, ?, ?, 100, 'h', 'x', 1)`,
    )
    .run(id, meetingId, id, JSON.stringify(segs), start, start + 30_000);
}

const hit = (
  chunkId: number,
  meetingId: string,
  rerank: number,
): RetrievalHit =>
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

const ok = (hits: RetrievalHit[]) => ({
  status: "ok" as const,
  modelId: "x",
  hits,
});

const run = (
  question: string,
  llm: ChatLlm,
  over: Partial<ChatSettings> = {},
) =>
  runChatTurn({
    db: getDb(),
    scope: { kind: "all", id: null },
    question,
    history: [],
    settings: { ...SETTINGS, ...over },
    llm,
    signal: new AbortController().signal,
    now: TODAY,
  });

const NO_CALL: NativeCallResult = { kind: "none", text: "" };
const answer = (text: string, cites: string[]) => ({
  sentences: [{ text, cites }],
});

beforeAll(() => {
  getDb();
});

beforeEach(() => {
  resetMeetingTables();
  getDb().exec("DELETE FROM meeting_chunks");
  retrieveMock.mockReset();
  addMeeting("m1", "Alpha sync", 1, [
    "The security review is on December 4.",
    "Kestrel Hosting sent the quote.",
  ]);
  addMeeting("m2", "Beta sync", 8, ["We talked about Kestrel Hosting again."]);
  addMeeting("m3", "Gamma sync", 15, ["Nothing about vendors here."]);
  addChunk(1, "m1", ["m1-s0", "m1-s1"], 0);
  addChunk(2, "m2", ["m2-s0"], 0);
});

describe("cheap route", () => {
  it("a plain question with no native call makes no router and no slot call", async () => {
    retrieveMock.mockResolvedValue(ok([hit(1, "m1", 0.95)]));
    const { llm, log } = fakeLlm({
      native: NO_CALL,
      structured: {
        chatAnswer: [answer("The security review is on December 4.", ["S1"])],
      },
    });
    const r = await run("When is the security review?", llm);
    expect(r.blocks[0]?.kind).toBe("text");
    expect(log.map((l) => l.step)).toEqual(["native", "chatAnswer"]);
    expect(r.trace.router).toBe("default");
  });

  it("a list question still uses the structured router", async () => {
    retrieveMock.mockResolvedValue(ok([hit(1, "m1", 0.95)]));
    const { llm, log } = fakeLlm({
      native: NO_CALL,
      structured: {
        chatRoute: [{ intent: "aggregate" }],
        chatSlots: [{ person: "none" }],
        chatAnswer: [answer("x", ["S1"])],
      },
    });
    await run("List all open action items.", llm);
    expect(log.some((l) => l.step === "chatRoute")).toBe(true);
  });
});

describe("empty answer", () => {
  it("an empty answer stays not found, even with a strong top hit (a retry made false answers)", async () => {
    retrieveMock.mockResolvedValue(ok([hit(1, "m1", 0.95)]));
    const { llm, log } = fakeLlm({
      native: NO_CALL,
      structured: { chatAnswer: [{ sentences: [] }] },
    });
    const r = await run("When is the security review?", llm);
    expect(r.blocks[0]).toMatchObject({
      kind: "not_found",
      reason: "no_sources",
    });
    expect(log.filter((l) => l.step === "chatAnswer")).toHaveLength(1);
  });
});

describe("cross-language step", () => {
  it("a weak first search gets one rewrite and the better search wins", async () => {
    retrieveMock
      .mockResolvedValueOnce(ok([hit(2, "m2", 0.2)]))
      .mockResolvedValueOnce(ok([hit(1, "m1", 0.95)]));
    const { llm, log } = fakeLlm({
      native: NO_CALL,
      structured: {
        chatSlots: [{ query: "security review date" }],
        chatAnswer: [answer("The security review is on December 4.", ["S1"])],
      },
    });
    const r = await run("Quando é a revisão de segurança?", llm);
    expect(r.blocks[0]?.kind).toBe("text");
    expect(retrieveMock).toHaveBeenCalledTimes(2);
    expect(r.toolCalls.map((c) => c.tool)).toEqual([
      "search_chunks",
      "search_chunks",
    ]);
    // The weak source (meeting m2) left the answer sources.
    expect(r.cites.map((c) => c.meeting_id)).toEqual(["m1"]);
    expect(log.filter((l) => l.step === "chatSlots")).toHaveLength(1);
  });

  it("a second search that only just passes the floor does not replace the first", async () => {
    retrieveMock
      .mockResolvedValueOnce(ok([hit(2, "m2", 0.2)]))
      .mockResolvedValueOnce(ok([hit(1, "m1", 0.56)]));
    const { llm } = fakeLlm({
      native: NO_CALL,
      structured: { chatSlots: [{ query: "loose words" }] },
    });
    const r = await run("Quanto custa o teste de intrusão?", llm);
    expect(r.blocks[0]).toMatchObject({
      kind: "not_found",
      reason: "no_sources",
    });
  });

  it("two weak searches end as not found", async () => {
    retrieveMock.mockResolvedValue(ok([hit(2, "m2", 0.2)]));
    const { llm } = fakeLlm({
      native: NO_CALL,
      structured: { chatSlots: [{ query: "something else" }] },
    });
    const r = await run("Quando é a revisão de segurança?", llm);
    expect(r.blocks[0]).toMatchObject({
      kind: "not_found",
      reason: "no_sources",
    });
  });

  it("a strong first search makes no rewrite call", async () => {
    retrieveMock.mockResolvedValue(ok([hit(1, "m1", 0.95)]));
    const { llm, log } = fakeLlm({
      native: NO_CALL,
      structured: {
        chatAnswer: [answer("The security review is on December 4.", ["S1"])],
      },
    });
    await run("When is the security review?", llm);
    expect(log.some((l) => l.step === "chatSlots")).toBe(false);
  });
});

describe("count of mentions", () => {
  it("counts the meetings whose transcript names the phrase, from the database", async () => {
    const { llm, log } = fakeLlm({
      native: {
        kind: "call",
        name: "search_chunks",
        args: { query: "Kestrel" },
      },
      structured: {},
    });
    const r = await run("In how many meetings was Kestrel Hosting named?", llm);
    expect(r.blocks).toEqual([{ kind: "count", n: 2, what: "meetings" }]);
    expect(r.cites.map((c) => c.meeting_id).sort()).toEqual(["m1", "m2"]);
    expect(r.toolCalls[0]).toMatchObject({ tool: "count_mentions", rows: 2 });
    // No answer call: the number comes from the tool, never from the model.
    expect(log.some((l) => l.step === "chatAnswer")).toBe(false);
    expect(retrieveMock).not.toHaveBeenCalled();
  });

  it("a name that no meeting holds counts zero", async () => {
    const { llm } = fakeLlm({ native: NO_CALL, structured: {} });
    const r = await run("In how many meetings was Zephyr Studios named?", llm);
    expect(r.blocks).toEqual([{ kind: "count", n: 0, what: "meetings" }]);
  });
});

describe("cited line for a question in another language", () => {
  it("the reranker picks the segment when no query word is in the text", async () => {
    // Six segments; the fact is in the last one. A PT question shares no word with them.
    addMeeting("m4", "Delta sync", 20, [
      "Filler talk number zero about the weather.",
      "Filler talk number one about the old dock.",
      "Filler talk number two about the ferry times.",
      "Filler talk number three about nothing at all.",
      "Filler talk number four about the coffee.",
      "The security review is on December 4.",
    ]);
    addChunk(
      4,
      "m4",
      ["m4-s0", "m4-s1", "m4-s2", "m4-s3", "m4-s4", "m4-s5"],
      0,
    );
    retrieveMock.mockResolvedValue(ok([hit(4, "m4", 0.95)]));
    const { llm } = fakeLlm({
      native: NO_CALL,
      structured: {
        chatAnswer: [
          answer("A revisão de segurança é em 4 de dezembro.", ["S1"]),
        ],
      },
    });
    const r = await run("Quando é a revisão de segurança?", llm);
    expect(r.blocks[0]?.kind).toBe("text");
    // The cite opens the meeting at the segment of the fact (start 50 s).
    expect(r.cites[0]?.start_ms).toBe(50_000);
  });
});
