// The clarifying question and the map-reduce synthesis (spec 11.8, D20).
// The database has the real schema. The model is a fake. All text is fictional.

import type { ChatMessage } from "@openstyle/validations";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { detectClarify } from "../src/lib/chat/clarify.js";
import type { ChatLlm, NativeCallResult } from "../src/lib/chat/llm.js";
import { runChatTurn } from "../src/lib/chat/pipeline.js";
import type { ChatSettings } from "../src/lib/chat/settings.js";
import { getDb } from "../src/lib/db.js";
import { insertSpeaker, resetMeetingTables } from "./helpers/meetings-db.js";

vi.mock("../src/lib/search/retrieve.js", () => ({
  retrieve: vi.fn(async () => ({ status: "ok", modelId: "x", hits: [] })),
  hitText: vi.fn(() => "TEXT"),
}));
vi.mock("../src/lib/mlx-rerank/client.js", () => ({
  rerankPairs: vi.fn(async (_q: string, docs: readonly string[]) =>
    docs.map(() => 0.5),
  ),
}));

const TODAY = Date.UTC(2026, 9, 26, 12);
const SETTINGS: ChatSettings = {
  rounds: 2,
  sourceBudget: 2000,
  k: 8,
  deadlineMs: 60_000,
  searchWider: true,
  clarify: true,
  research: false,
  nativeTools: true,
  enabled: true,
};
const NO_CALL: NativeCallResult = { kind: "none", text: "" };

function fakeLlm(structured: (step: string, user: string) => unknown) {
  const log: { step: string; user: string; unitKey: string }[] = [];
  let calls = 0;
  const llm = {
    provider: "fake",
    modelId: "fake",
    isLocal: true,
    contextWindow: null,
    runId: "r",
    async nativeCall() {
      calls++;
      return NO_CALL;
    },
    async structured(i: {
      step: string;
      unitKey: string;
      schema: { zod: { parse: (x: unknown) => unknown } };
      messages: { content: string }[];
    }) {
      calls++;
      const user = i.messages.map((m) => m.content).join("\n");
      log.push({ step: i.step, user, unitKey: i.unitKey });
      return {
        object: i.schema.zod.parse(structured(i.unitKey, user)),
        finishReason: "stop",
        usage: {},
        latencyMs: 1,
      };
    },
    calls: () => calls,
    finish() {},
  } as unknown as ChatLlm;
  return { llm, log };
}

const folder = (id: string, name: string) =>
  getDb()
    .prepare(
      "INSERT INTO meeting_folders (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)",
    )
    .run(id, name);

function meeting(
  id: string,
  title: string,
  day: number,
  folderId: string | null,
  summary?: object,
) {
  const at = Date.UTC(2026, 8, 1) + day * 86_400_000;
  const db = getDb();
  db.prepare(
    `INSERT INTO meetings (id, title, status, started_at, duration_ms, created_at, folder_id)
     VALUES (?, ?, 'summarized', ?, 600000, ?, ?)`,
  ).run(id, title, at, at, folderId);
  if (summary) {
    db.prepare(
      "INSERT INTO meeting_summaries (meeting_id, markdown, summary_json, created_at) VALUES (?, NULL, ?, 1)",
    ).run(id, JSON.stringify(summary));
  }
}

const base = {
  db: () => getDb(),
  lastAssistantBlocks: [] as never[],
  hasEarlierQuestion: false,
};
const detect = (
  question: string,
  scope: { kind: "all" | "folder" | "meeting"; id: string | null } = {
    kind: "all",
    id: null,
  },
  over: Partial<Parameters<typeof detectClarify>[0]> = {},
) =>
  detectClarify({
    db: base.db(),
    scope,
    question,
    lastAssistantBlocks: base.lastAssistantBlocks,
    hasEarlierQuestion: base.hasEarlierQuestion,
    ...over,
  });

beforeAll(() => {
  getDb();
});

beforeEach(() => {
  resetMeetingTables();
  folder("f1", "Harbor Mobile");
  folder("f2", "Harbor Web");
  folder("f3", "Orchard Data");
  meeting("m1", "Harbor Mobile kickoff", 1, "f1");
  meeting("m2", "Harbor Web kickoff", 2, "f2");
  meeting("m3", "Orchard sync", 3, "f3");
  meeting("m4", "Ana Souza intro", 4, "f1");
  insertSpeaker("m1", "A", { displayName: "Ana Souza" });
  insertSpeaker("m2", "A", { displayName: "Ana Lima" });
  insertSpeaker("m3", "A", { displayName: "Bruno Reis" });
});

describe("detectClarify", () => {
  it("asks which folder when two folders share a word and none is named in full", () => {
    const b = detect("What is the status of Harbor?");
    expect(b?.why).toBe("scope");
    expect(b?.options.map((o) => o.label)).toEqual([
      "Harbor Mobile",
      "Harbor Web",
    ]);
    expect(b?.options[0]?.ask).toContain("Harbor Mobile");
  });

  it("does not ask when one folder is named in full or matches more words", () => {
    expect(detect("What is the status of Harbor Mobile?")).toBeNull();
    expect(detect("What is the status of Orchard?")).toBeNull();
  });

  it("asks which person for a first name that two people share", () => {
    const b = detect("What did Ana say about the budget?");
    expect(b?.why).toBe("person");
    expect(b?.options.map((o) => o.label).sort()).toEqual([
      "Ana Lima",
      "Ana Souza",
    ]);
    expect(b?.options[0]?.ask).toContain("Ana ");
    expect(detect("What did Ana Lima say about the budget?")).toBeNull();
  });

  it("asks for the intent of a question with no topic, only at Everything and with no history", () => {
    expect(detect("status?")?.why).toBe("intent");
    expect(detect("what about it?")?.options).toHaveLength(4);
    expect(detect("status?", { kind: "folder", id: "f1" })).toBeNull();
    expect(
      detect("status?", undefined, { hasEarlierQuestion: true }),
    ).toBeNull();
    expect(detect("What are the decisions?")).toBeNull();
    expect(detect("Who proposed the pilot?")).toBeNull();
  });

  it("never asks twice in a row", () => {
    const prev = detect("What is the status of Harbor?");
    expect(prev).not.toBeNull();
    expect(
      detect("What is the status of Harbor?", undefined, {
        lastAssistantBlocks: [prev] as never[],
      }),
    ).toBeNull();
  });
});

describe("clarify in the turn", () => {
  const run = (
    question: string,
    over: Partial<ChatSettings> = {},
    extra: { noClarify?: boolean; history?: ChatMessage[] } = {},
  ) => {
    const { llm, log } = fakeLlm(() => ({}));
    return runChatTurn({
      db: getDb(),
      scope: { kind: "all" },
      question,
      history: extra.history ?? [],
      settings: { ...SETTINGS, ...over },
      llm,
      signal: new AbortController().signal,
      now: TODAY,
      ...(extra.noClarify ? { noClarify: true } : {}),
    }).then((r) => ({ r, log, llm }));
  };

  it("returns a clarify block with no model call", async () => {
    const { r, log, llm } = await run("What is the status of Harbor?");
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0]?.kind).toBe("clarify");
    expect(log).toHaveLength(0);
    expect(llm.calls()).toBe(0);
    expect(r.trace.steps[0]?.name).toBe("clarify:scope");
  });

  it("the setting off and 'answer anyway' skip the question", async () => {
    const off = await run("What is the status of Harbor?", { clarify: false });
    expect(off.r.blocks[0]?.kind).not.toBe("clarify");
    const anyway = await run(
      "What is the status of Harbor?",
      {},
      { noClarify: true },
    );
    expect(anyway.r.blocks[0]?.kind).not.toBe("clarify");
  });
});

describe("map-reduce synthesis", () => {
  const FACTS = (i: number) => ({
    overview: `Step ${i} of the long program covered the Zephyr${i} milestone.`,
    keyPoints: [
      `Zephyr${i} budget is ${1000 + i} dollars and the owner is Person${i}.`,
      "A long filler sentence about the schedule, the staffing, the risks and the vendors. ".repeat(
        6,
      ),
    ],
    decisions: [`Decision ${i}: ship Zephyr${i} in week ${i}.`],
    actionItems: [],
    openQuestions: [],
  });

  it("shortens a folder digest that does not fit, keeps labels, and covers early and late meetings", async () => {
    folder("big", "Long Program");
    for (let i = 1; i <= 40; i++) {
      meeting(`b${i}`, `Program step ${i}`, 10 + i, "big", FACTS(i));
    }
    const { llm, log } = fakeLlm((unitKey, user) => {
      if (unitKey.startsWith("map/")) {
        const labels = [...user.matchAll(/\[(S\d+)\] Program step (\d+)/g)];
        return {
          notes: labels.map((m) => ({
            label: m[1],
            note: `Zephyr${m[2]} milestone, budget ${1000 + Number(m[2])} dollars.`,
          })),
        };
      }
      // The reduce call: cite the first and the last source shown.
      const shown = [...user.matchAll(/\[(S\d+)\] Program step (\d+)/g)];
      const first = shown[0];
      const last = shown.at(-1);
      return {
        lead: [
          {
            text: `The program ran from step ${first?.[2]} to step ${last?.[2]}.`,
            cites: [first?.[1], last?.[1]],
          },
        ],
        bullets: [
          {
            text: `Zephyr${first?.[2]} milestone, budget ${1000 + Number(first?.[2])} dollars.`,
            cites: [first?.[1]],
          },
          {
            text: `Zephyr${last?.[2]} milestone, budget ${1000 + Number(last?.[2])} dollars.`,
            cites: [last?.[1]],
          },
        ],
      };
    });
    const r = await runChatTurn({
      db: getDb(),
      scope: { kind: "folder", id: "big" },
      question: "Tell me the story of this folder",
      history: [],
      settings: SETTINGS,
      llm,
      signal: new AbortController().signal,
      now: TODAY,
    });
    const step = r.trace.steps.find((s) => s.name === "map_reduce");
    expect(step?.note).toContain("Reading 40 meetings");
    expect(
      log.filter((l) => l.unitKey.startsWith("map/")).length,
    ).toBeGreaterThan(0);
    // The reduce runs in date slices: the oldest and the newest meeting are
    // each in the sources of one reduce call.
    const reduces = log.filter((l) => !l.unitKey.startsWith("map/"));
    expect(reduces.length).toBeGreaterThanOrEqual(2);
    expect(reduces.some((l) => l.user.includes("Program step 1,"))).toBe(true);
    expect(reduces.some((l) => l.user.includes("Program step 40,"))).toBe(true);
    expect(r.blocks.some((b) => b.kind === "not_found")).toBe(false);
    // Every cite points to a real meeting of the folder.
    expect(r.cites.length).toBeGreaterThan(0);
    for (const c of r.cites) expect(c.meeting_id).toMatch(/^b\d+$/);
    // The cite chip shows the real summary text, not the shortened note.
    expect(r.cites.some((c) => c.text.includes("of the long program"))).toBe(
      true,
    );
  });

  it("a note that adds a number falls back to the code cut", async () => {
    folder("big", "Long Program");
    for (let i = 1; i <= 12; i++) {
      meeting(`b${i}`, `Program step ${i}`, 10 + i, "big", FACTS(i));
    }
    const { llm, log } = fakeLlm((unitKey, user) => {
      if (unitKey.startsWith("map/")) {
        const labels = [...user.matchAll(/\[(S\d+)\] Program step (\d+)/g)];
        return {
          notes: labels.map((m) => ({
            label: m[1],
            note: "Budget 987654321.",
          })),
        };
      }
      return {};
    });
    await runChatTurn({
      db: getDb(),
      scope: { kind: "folder", id: "big" },
      question: "Tell me the story of this folder",
      history: [],
      settings: SETTINGS,
      llm,
      signal: new AbortController().signal,
      now: TODAY,
    }).catch(() => undefined);
    const reduce = log.filter((l) => !l.unitKey.startsWith("map/")).at(-1);
    expect(reduce?.user ?? "").not.toContain("987654321");
  });
});
