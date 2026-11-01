// P1.1 changes of the turn pipeline (issue #402): the cheap route, the retry
// of an empty answer, the cross-language step and the count of mentions.
// The database has the real schema. `retrieve` and the model are fakes.
// All text is fictional.

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
  history: ChatMessage[] = [],
) =>
  runChatTurn({
    db: getDb(),
    scope: { kind: "all" },
    question,
    history,
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

  it("a plain follow-up makes no native call, and the search holds the earlier turn", async () => {
    retrieveMock.mockResolvedValue(ok([hit(1, "m1", 0.95)]));
    const { llm, log } = fakeLlm({
      native: NO_CALL,
      structured: {
        chatAnswer: [answer("The security review is on December 4.", ["S1"])],
      },
    });
    const history = [
      { role: "user", content: "Who runs the security review?", cites: [] },
      { role: "assistant", content: "Ana runs it.", blocks: [], cites: [] },
    ] as unknown as ChatMessage[];
    const r = await run("And when is that?", llm, {}, history);
    expect(r.blocks[0]?.kind).toBe("text");
    expect(log.map((l) => l.step)).toEqual(["chatAnswer"]);
    const q = (r.toolCalls[0]?.args as { query: string }).query;
    expect(q).toContain("Who runs the security review?");
    expect(q).toContain("Ana runs it.");
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

describe("scope A and the wider offer (P2)", () => {
  const nf = (r: { blocks: { kind: string }[] }) =>
    r.blocks[0] as unknown as {
      kind: string;
      scope: ChatScope;
      wider?: unknown;
    };

  it("a not_found block at a meeting offers its folder, and the trace holds the scope", async () => {
    getDb()
      .prepare(
        "INSERT OR REPLACE INTO meeting_folders (id, name, created_at, updated_at) VALUES ('f1', 'Project Atlas', 1, 1)",
      )
      .run();
    getDb()
      .prepare("UPDATE meetings SET folder_id = 'f1' WHERE id = 'm1'")
      .run();
    retrieveMock.mockResolvedValue(ok([]));
    const { llm } = fakeLlm({
      native: NO_CALL,
      structured: { chatAnswer: [{ sentences: [] }] },
    });
    const r = await runChatTurn({
      db: getDb(),
      scope: { kind: "meeting", id: "m1" },
      question: "What is the budget for the kiosk?",
      history: [],
      settings: SETTINGS,
      llm,
      signal: new AbortController().signal,
      now: TODAY,
    });
    expect(nf(r)).toMatchObject({
      kind: "not_found",
      scope: { kind: "meeting", id: "m1" },
      wider: { kind: "folder", id: "f1", name: "Project Atlas" },
    });
    expect(r.trace.scope).toEqual({ kind: "meeting", id: "m1" });
  });

  it("scope A runs, offers nothing wider, and the trace says all", async () => {
    retrieveMock.mockResolvedValue(ok([]));
    const { llm } = fakeLlm({
      native: NO_CALL,
      structured: { chatAnswer: [{ sentences: [] }] },
    });
    const r = await runChatTurn({
      db: getDb(),
      scope: { kind: "all" },
      question: "What is the budget for the kiosk?",
      history: [],
      settings: SETTINGS,
      llm,
      signal: new AbortController().signal,
      now: TODAY,
    });
    expect(nf(r)).toMatchObject({ kind: "not_found", scope: { kind: "all" } });
    expect(nf(r).wider ?? null).toBeNull();
    expect(r.trace.scope).toEqual({ kind: "all" });
  });

  it("the setting Search wider off gives no offer", async () => {
    getDb()
      .prepare("UPDATE meetings SET folder_id = NULL WHERE id = 'm1'")
      .run();
    retrieveMock.mockResolvedValue(ok([]));
    const { llm } = fakeLlm({
      native: NO_CALL,
      structured: { chatAnswer: [{ sentences: [] }] },
    });
    const r = await runChatTurn({
      db: getDb(),
      scope: { kind: "meeting", id: "m1" },
      question: "What is the budget for the kiosk?",
      history: [],
      settings: { ...SETTINGS, searchWider: false },
      llm,
      signal: new AbortController().signal,
      now: TODAY,
    });
    expect(nf(r).wider ?? null).toBeNull();
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

describe("decisions and next steps read the summary (P1.2)", () => {
  const runMeeting = (question: string, llm: ChatLlm) =>
    runChatTurn({
      db: getDb(),
      scope: { kind: "meeting", id: "m1" },
      question,
      history: [],
      settings: SETTINGS,
      llm,
      signal: new AbortController().signal,
      now: TODAY,
    });
  const addSummary = () =>
    getDb()
      .prepare(
        "INSERT INTO meeting_summaries (meeting_id, markdown, summary_json, created_at) VALUES ('m1', NULL, ?, 1)",
      )
      .run(
        JSON.stringify({
          overview: "The team met for the security review.",
          keyPoints: [],
          decisions: ["Hold the security review on December 4."],
          actionItems: [{ task: "Send the quote", owner: "Ana", due: null }],
          openQuestions: [],
        }),
      );

  it("What has been decided? calls the summary and cites the decision", async () => {
    addSummary();
    retrieveMock.mockResolvedValue(ok([hit(1, "m1", 0.2)]));
    const { llm, log } = fakeLlm({
      native: NO_CALL,
      structured: {
        chatAnswer: [
          answer("The team will hold the security review on December 4.", [
            "S3",
          ]),
        ],
      },
    });
    const r = await runMeeting("What has been decided?", llm);
    // No native call and no router call: code made the summary call.
    expect(log.map((l) => l.step)).toEqual(["chatAnswer"]);
    expect(r.toolCalls[0]?.tool).toBe("get_meeting_summary");
    expect(r.trace.steps.some((s) => s.name === "rules:decisions")).toBe(true);
    expect(r.blocks[0]?.kind).toBe("text");
    // A weak score of the extra search does not end the turn as not found.
    expect(r.content).toContain("December 4");
  });

  it("What are the next steps? uses the action items of the summary", async () => {
    addSummary();
    retrieveMock.mockResolvedValue(ok([]));
    const { llm } = fakeLlm({
      native: NO_CALL,
      structured: { chatAnswer: [answer("Ana sends the quote.", ["S3"])] },
    });
    const r = await runMeeting("What are the next steps?", llm);
    expect(r.toolCalls[0]?.tool).toBe("get_meeting_summary");
    expect(r.trace.steps.some((s) => s.name === "rules:steps")).toBe(true);
  });

  it("a meeting with no summary falls back to the search", async () => {
    retrieveMock.mockResolvedValue(ok([hit(1, "m1", 0.95)]));
    const { llm } = fakeLlm({
      native: NO_CALL,
      structured: {
        chatAnswer: [answer("The security review is on December 4.", ["S1"])],
      },
    });
    const r = await runMeeting("What has been decided?", llm);
    expect(r.toolCalls.map((c) => c.tool)).toContain("search_chunks");
    expect(r.blocks[0]?.kind).toBe("text");
  });

  it("a decision about a topic stays a search", async () => {
    addSummary();
    retrieveMock.mockResolvedValue(ok([hit(1, "m1", 0.95)]));
    const { llm } = fakeLlm({
      native: NO_CALL,
      structured: {
        chatAnswer: [answer("The security review is on December 4.", ["S1"])],
      },
    });
    const r = await runMeeting(
      "What did we decide about the security review?",
      llm,
    );
    expect(r.toolCalls[0]?.tool).toBe("search_chunks");
  });
});
