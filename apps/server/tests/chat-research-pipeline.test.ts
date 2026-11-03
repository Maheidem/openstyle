// Ask research mode through the real graph (specs/meeting-chat-agent.md 11.9):
// the loop, the closed strategies, the stop rules, the trail and the
// checkpoints. The database has the real schema. `retrieve`, the reranker and
// the model are fakes. All text is fictional.

import type { ChatMessage } from "@openstyle/validations";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { ChatLlm } from "../src/lib/chat/llm.js";
import { runChatTurn } from "../src/lib/chat/pipeline.js";
import type { ChatSettings } from "../src/lib/chat/settings.js";
import { getDb } from "../src/lib/db.js";
import { createLlmRecorder } from "../src/lib/llm/recorder.js";
import type { RetrievalHit } from "../src/lib/search/retrieve.js";
import { insertSegment, resetMeetingTables } from "./helpers/meetings-db.js";

vi.mock("../src/lib/search/retrieve.js", () => ({
  retrieve: vi.fn(),
  hitText: vi.fn(() => "SUMMARY TEXT"),
}));
vi.mock("../src/lib/mlx-rerank/client.js", () => ({
  rerankPairs: vi.fn(async (_q: string, docs: readonly string[]) =>
    docs.map(() => 0.9),
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
  research: true,
  nativeTools: true,
  enabled: true,
};

type Script = Record<string, unknown[]>;

/** A scripted model. It records the calls it got and can fail the answer. */
function fakeLlm(
  script: Script,
  over: { runId?: string; failAnswer?: boolean } = {},
) {
  const log: { step: string; user: string }[] = [];
  const used: Record<string, number> = {};
  let calls = 0;
  const llm = {
    provider: "fake",
    modelId: "fake-model",
    isLocal: true,
    contextWindow: null,
    runId: over.runId ?? "run",
    async nativeCall() {
      calls++;
      log.push({ step: "native", user: "" });
      return { kind: "none", text: "" };
    },
    async structured<T>(i: {
      step: string;
      schema: { zod: z.ZodType<T> };
      messages: { content: string }[];
    }) {
      calls++;
      const n = used[i.step] ?? 0;
      used[i.step] = n + 1;
      log.push({
        step: i.step,
        user: i.messages.map((m) => m.content).join("\n"),
      });
      if (over.failAnswer && i.step === "chatAnswer") {
        throw new Error("the model server is gone");
      }
      const list = script[i.step] ?? [];
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

function addChunk(id: number, meetingId: string, segs: string[]) {
  getDb()
    .prepare(
      `INSERT INTO meeting_chunks (id, meeting_id, ordinal, segment_ids, char_start, char_end, start_ms, end_ms, token_estimate, text_hash, model_id, created_at)
       VALUES (?, ?, ?, ?, 0, NULL, 0, 30000, 100, 'h', 'x', 1)`,
    )
    .run(id, meetingId, id, JSON.stringify(segs));
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

const REASONS = {
  lead: [{ text: "The security review is on December 4.", cites: ["S1"] }],
  bullets: [
    { text: "We talked about Kestrel Hosting again.", cites: ["S2"] },
    { text: "Kestrel Hosting sent the quote.", cites: ["S1"] },
  ],
};

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
  addChunk(1, "m1", ["m1-s0", "m1-s1"]);
  addChunk(2, "m2", ["m2-s0"]);
});

describe("the research loop", () => {
  it("reads other meetings when reflect asks, then answers with cites from both", async () => {
    retrieveMock
      .mockResolvedValueOnce(ok([hit(1, "m1", 0.95)]))
      .mockResolvedValueOnce(ok([hit(2, "m2", 0.9)]));
    const { llm, log } = fakeLlm({
      chatReflect: [
        { next: "other_meetings", query: "" },
        { next: "stop", query: "" },
      ],
      chatAnswer: [REASONS],
    });
    const r = await run("Is the Kestrel contract still unresolved?", llm);
    expect(r.blocks[0]?.kind).toBe("text");
    expect(new Set(r.cites.map((c) => c.meeting_id))).toEqual(
      new Set(["m1", "m2"]),
    );
    // No route call: code seeds the lead and builds every tool call.
    expect(log.map((l) => l.step)).toEqual([
      "chatReflect",
      "chatReflect",
      "chatAnswer",
    ]);
    expect(r.trace.research).toMatchObject({
      iterations: 2,
      max_iter: 4,
      meetings: 2,
      searches: 2,
      done: "enough",
      open_leads: [],
    });
    // The second search is the cross-meeting step: only meetings not read yet.
    const second = r.toolCalls[1]?.args as {
      meeting_ids?: string[];
      k?: number;
    };
    expect(second.meeting_ids).toEqual(["m2", "m3"]);
    expect(second.k).toBe(4);
    // The research steps are in the trace.
    expect(
      r.trace.steps.filter((s) => s.stage === "research").map((s) => s.name),
    ).toEqual([
      "search",
      "reflect:other_meetings",
      "other_meetings",
      "reflect:stop",
    ]);
  });

  it("never repeats a search: a repeated query closes the lead", async () => {
    retrieveMock.mockResolvedValue(ok([hit(1, "m1", 0.95)]));
    const { llm } = fakeLlm({
      chatReflect: [{ next: "rephrase", query: "Kestrel contract unresolved" }],
      chatAnswer: [REASONS],
    });
    const r = await run("Is the Kestrel contract still unresolved?", llm);
    const queries = r.toolCalls
      .filter((c) => c.tool === "search_chunks")
      .map((c) => JSON.stringify(c.args));
    expect(new Set(queries).size).toBe(queries.length);
  });

  it("stops after 2 loop turns with nothing new and says what it did not find", async () => {
    retrieveMock.mockResolvedValue(ok([]));
    const { llm } = fakeLlm({
      chatReflect: [{ next: "other_meetings", query: "" }],
      chatAnswer: [REASONS],
    });
    const r = await run("Is the Kestrel contract still unresolved?", llm);
    expect(r.blocks[0]).toMatchObject({ kind: "not_found" });
    expect(r.trace.research).toMatchObject({
      done: "stalled",
      meetings: 0,
      open_leads: ["Is the Kestrel contract still unresolved?"],
    });
  });

  it("drops a weak search from the evidence (under the not-found floor)", async () => {
    retrieveMock.mockResolvedValue(ok([hit(1, "m1", 0.2)]));
    const { llm } = fakeLlm({
      chatReflect: [{ next: "stop", query: "" }],
      chatAnswer: [REASONS],
    });
    const r = await run("Is the Kestrel contract still unresolved?", llm);
    expect(r.blocks[0]).toMatchObject({ kind: "not_found" });
    expect(r.trace.research?.meetings).toBe(0);
  });

  it("one lead gets at most 3 act steps", async () => {
    let n = 0;
    retrieveMock.mockImplementation(async () => {
      n += 1;
      return ok([hit(1 + (n % 2), n % 2 ? "m2" : "m1", 0.9)]);
    });
    const { llm } = fakeLlm({
      chatReflect: [
        { next: "rephrase", query: "kestrel" },
        { next: "rephrase", query: "hosting quote" },
        { next: "rephrase", query: "security review date" },
      ],
      chatAnswer: [REASONS],
    });
    const r = await run("Is the Kestrel contract still unresolved?", llm);
    expect(r.trace.research?.searches).toBeLessThanOrEqual(3);
  });
});

describe("the fast path stays fast", () => {
  it("a single fact makes no reflect call and has no research trace", async () => {
    retrieveMock.mockResolvedValue(ok([hit(1, "m1", 0.95)]));
    const { llm, log } = fakeLlm({
      chatAnswer: [
        {
          sentences: [
            { text: "The security review is on December 4.", cites: ["S1"] },
          ],
        },
      ],
    });
    const r = await run("When is the security review?", llm);
    expect(r.trace.research).toBeUndefined();
    expect(log.some((l) => l.step === "chatReflect")).toBe(false);
  });

  it("the setting off keeps a digging question on the old path", async () => {
    retrieveMock.mockResolvedValue(ok([hit(1, "m1", 0.95)]));
    const { llm, log } = fakeLlm({
      chatAnswer: [
        {
          sentences: [
            { text: "The security review is on December 4.", cites: ["S1"] },
          ],
        },
      ],
    });
    const r = await run("Why was the security review moved?", llm, {
      research: false,
    });
    expect(r.trace.research).toBeUndefined();
    expect(log.some((l) => l.step === "chatReflect")).toBe(false);
  });
});

describe("leads from the last list answer", () => {
  const listAnswer = {
    id: 2,
    thread_id: "t",
    role: "assistant",
    content: "",
    blocks: [
      {
        kind: "list",
        list: "action_items",
        total: 2,
        items: ["Send the quote", "Book the security review"].map((text) => ({
          text,
          meeting_id: "m1",
          meeting_title: "Alpha sync",
          item_id: null,
          done: false,
          owner: null,
          due: null,
          label: null,
        })),
      },
    ],
    cites: [],
    trace: null,
    model_id: null,
    provider: null,
    ms: null,
    created_at: 0,
  } as unknown as ChatMessage;

  it("one worker for each item; a reason with a supported quote is shown, an item with none says so (11.9.16)", async () => {
    retrieveMock.mockResolvedValue(ok([hit(1, "m1", 0.95)]));
    const { llm, log } = fakeLlm({
      chatDig: [
        // item 1: a reason that the chunk of m1 holds
        {
          reasons: [
            {
              reason: "The vendor sent the quote and legal has not signed.",
              source: "S1",
              quote: "Kestrel Hosting sent the quote.",
            },
          ],
        },
        // item 2: the model invents a quote that no source holds
        {
          reasons: [
            {
              reason: "Budget freeze until 2027.",
              source: "S4",
              quote: "budget freeze until 2027 for everyone",
            },
          ],
        },
      ],
    });
    const history = [
      {
        id: 1,
        role: "user",
        content: "What are the open items?",
        cites: [],
        blocks: [],
      },
      listAnswer,
    ] as unknown as ChatMessage[];
    const r = await run("Why are these still open?", llm, {}, history);
    // No answer call: the bullets are composed by code from the records.
    expect(log.map((l) => l.step)).toEqual(["chatDig", "chatDig"]);
    const texts = r.blocks.flatMap((b) => (b.kind === "text" ? [b.text] : []));
    expect(texts).toHaveLength(2);
    // The two workers run at the same time: which item gets which script entry is not fixed.
    expect(
      texts.filter((x) => x.includes("legal has not signed")),
    ).toHaveLength(1);
    expect(texts.filter((x) => x.includes("no reason found"))).toHaveLength(1);
    expect(texts.some((x) => x.startsWith("Send the quote:"))).toBe(true);
    expect(texts.some((x) => x.startsWith("Book the security review:"))).toBe(
      true,
    );
    expect(texts.join(" ")).not.toContain("2027");
    // Every bullet has a cite that exists.
    for (const b of r.blocks) {
      if (b.kind === "text") {
        expect(b.cites.length).toBeGreaterThan(0);
        for (const l of b.cites) {
          expect(r.cites.some((c) => c.label === l)).toBe(true);
        }
      }
    }
    expect(r.trace.research).toMatchObject({ done: "enough" });
  });
});

describe("the model asks to dig (11.9.17)", () => {
  it("dig_deeper in the native call switches to research: scout, one worker for each meeting, then the answer", async () => {
    retrieveMock.mockResolvedValue(ok([hit(1, "m1", 0.95)]));
    const { llm, log } = fakeLlm({
      chatDig: [
        {
          who: "",
          what: "Kestrel Hosting sent the quote.",
          why: "",
          source: "S1",
          quote: "Kestrel Hosting sent the quote.",
        },
      ],
      chatAnswer: [
        {
          lead: [{ text: "Kestrel Hosting sent the quote.", cites: ["S1"] }],
          bullets: [
            { text: "Kestrel Hosting sent the quote again.", cites: ["S1"] },
            { text: "The security review is on December 4.", cites: ["S1"] },
          ],
        },
      ],
    });
    // A plain question with no digging word: the model picks the research tool.
    (llm as unknown as { nativeCall: () => Promise<unknown> }).nativeCall =
      async () => ({ kind: "call", name: "dig_deeper", args: {} });
    const r = await run("What happened with the Kestrel hosting quote?", llm);
    expect(r.blocks[0]?.kind).toBe("text");
    const steps = log.map((l) => l.step);
    // One worker for each meeting of the small scope (3 meetings), then one answer.
    expect(steps.filter((x) => x === "chatDig")).toHaveLength(3);
    expect(steps.at(-1)).toBe("chatAnswer");
    const names = r.trace.steps.map((s) => `${s.stage}:${s.name}`);
    expect(names).toContain("route:native:dig_deeper");
    expect(names).toContain("research:worker:meeting:record");
    expect(r.trace.research).toMatchObject({ done: "enough" });
  });

  it("without research mode the tool is not offered and a dig call is ignored", async () => {
    retrieveMock.mockResolvedValue(ok([hit(1, "m1", 0.95)]));
    const { llm, log } = fakeLlm({
      chatAnswer: [
        {
          found: true,
          sentences: [
            { text: "Kestrel Hosting sent the quote.", cites: ["S1"] },
          ],
        },
      ],
    });
    let offered: string[] = [];
    (
      llm as unknown as {
        nativeCall: (i: {
          tools: { function: { name: string } }[];
        }) => Promise<unknown>;
      }
    ).nativeCall = async (i) => {
      offered = i.tools.map((t) => t.function.name);
      return { kind: "none", text: "" };
    };
    await run("What happened with the Kestrel hosting quote?", llm, {
      research: false,
    });
    expect(offered).not.toContain("dig_deeper");
    expect(log.some((l) => l.step === "chatDig")).toBe(false);
  });
});

describe("checkpoints (11.9.8)", () => {
  const countRows = (runId: string): number =>
    (
      getDb()
        .prepare(
          "SELECT COUNT(*) AS n FROM llm_checkpoints WHERE thread_id = ?",
        )
        .get(runId) as { n: number }
    ).n;

  function startRun(runId: string): void {
    getDb()
      .prepare(
        "INSERT OR IGNORE INTO chat_threads (id, meeting_id, folder_id, title, created_at, updated_at) VALUES ('t-ckpt', NULL, NULL, NULL, 1, 1)",
      )
      .run();
    const started = createLlmRecorder(getDb()).startRun({
      id: runId,
      scope: "chat",
      scopeId: "t-ckpt",
      kind: "meetingChat",
      startedBy: "chat",
      graphVersion: 1,
      startedAt: 1,
    });
    expect(started).toBe("ok");
  }

  it("deletes the checkpoints of a finished turn", async () => {
    startRun("run-ok");
    retrieveMock.mockResolvedValue(ok([hit(1, "m1", 0.95)]));
    const { llm } = fakeLlm(
      {
        chatReflect: [{ next: "stop", query: "" }],
        chatAnswer: [REASONS],
      },
      { runId: "run-ok" },
    );
    const r = await run("Is the Kestrel contract still unresolved?", llm);
    expect(r.blocks[0]?.kind).toBe("text");
    expect(countRows("run-ok")).toBe(0);
  });

  it("keeps the checkpoints of a failed turn", async () => {
    startRun("run-bad");
    retrieveMock.mockResolvedValue(ok([hit(1, "m1", 0.95)]));
    const { llm } = fakeLlm(
      { chatReflect: [{ next: "stop", query: "" }] },
      { runId: "run-bad", failAnswer: true },
    );
    await expect(
      run("Is the Kestrel contract still unresolved?", llm),
    ).rejects.toThrow("the model server is gone");
    expect(countRows("run-bad")).toBeGreaterThan(0);
  });
});
