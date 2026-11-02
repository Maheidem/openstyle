// Ask research mode (specs/meeting-chat-agent.md 11.9): the trigger, the stop
// rules, the closed strategies, the repeat rule and the shape of the graph.
import type { ChatMessage } from "@openstyle/validations";
import { describe, expect, it } from "vitest";
import {
  argsKey,
  type Evidence,
  type Lead,
  listCalls,
  MAX_ITER,
  ResearchRun,
  type Step,
  stopRule,
} from "../src/lib/chat/research/research.js";
import {
  hasDiggingWord,
  researchTrigger,
} from "../src/lib/chat/research/trigger.js";
import type { Turn } from "../src/lib/chat/turn.js";
import { HARD_CAP_CALLS } from "../src/lib/chat/turn.js";

const msg = (over: Partial<ChatMessage>): ChatMessage => ({
  id: 1,
  thread_id: "t",
  role: "assistant",
  content: "",
  blocks: [],
  cites: [],
  trace: null,
  model_id: null,
  provider: null,
  ms: null,
  created_at: 0,
  ...over,
});

const trigger = (
  question: string,
  history: ChatMessage[] = [],
  enabled = true,
) => researchTrigger({ question, history, enabled });

describe("researchTrigger (11.9.9)", () => {
  it("sends a digging question to research, in several languages", () => {
    expect(trigger("What has blocked the Kestrel contract so far?")).toBe(true);
    expect(trigger("What are the open items in this project?")).toBe(true);
    expect(trigger("How did that decision evolve across the meetings?")).toBe(
      true,
    );
    expect(trigger("Is anything still unresolved about sign-in?")).toBe(true);
    expect(trigger("O que bloqueou a publicação do app?")).toBe(true);
    expect(trigger("Por que isso ainda não foi decidido?")).toBe(true);
    expect(trigger("Quem defendeu adiar o lançamento e por quê?")).toBe(true);
    expect(trigger("Warum wurde der Vertrag nicht unterschrieben?")).toBe(true);
    expect(trigger("Pourquoi le contrat est-il bloqué ?")).toBe(true);
  });

  it("keeps a single fact on the fast path", () => {
    expect(trigger("Who owns the Kestrel hosting contract?")).toBe(false);
    expect(trigger("When is the launch?")).toBe(false);
    expect(trigger("How much is the release budget now?")).toBe(false);
    expect(trigger("Quando está previsto o lançamento do app?")).toBe(false);
    expect(trigger("What is the Kestrel hosting contract?")).toBe(false);
  });

  it("is off when the setting is off", () => {
    expect(trigger("What blocked the contract?", [], false)).toBe(false);
  });

  it("keeps write, count and list-command questions out", () => {
    expect(trigger("Mark the open item as done")).toBe(false);
    expect(trigger("How many meetings mentioned the blocker?")).toBe(false);
    expect(trigger("List all open action items for Ana.")).toBe(false);
  });

  it("keeps a broad question on the synthesis path", () => {
    expect(trigger("Tell me the story of this project")).toBe(false);
  });

  it("sends a reason follow-up after a list answer to research", () => {
    const list = msg({
      blocks: [{ kind: "list", list: "action_items", total: 1, items: [] }],
    });
    expect(trigger("Why are these?", [list])).toBe(true);
  });

  it("finds digging words with folded accents", () => {
    expect(hasDiggingWord("Qual é o motivo?")).toBe(true);
    expect(hasDiggingWord("Quem é o responsável?")).toBe(false);
  });
});

const lead = (over: Partial<Lead> = {}): Lead => ({
  id: "L1",
  text: "x",
  status: "open",
  acts: 0,
  origin: "question",
  meetingId: null,
  list: false,
  ...over,
});

const step = (n: number): Step => ({
  tool: "search_chunks",
  argsKey: "k",
  rows: 1,
  topScore: 0.9,
  newLabels: Array.from({ length: n }, (_, i) => `S${i}`),
  leadId: "L1",
});

function fakeTurn(
  over: { calls?: number; elapsed?: number; deadlineMs?: number } = {},
) {
  const controller = new AbortController();
  return {
    t0: Date.now() - (over.elapsed ?? 0),
    stopReason: () => ((over.calls ?? 0) >= HARD_CAP_CALLS ? "call_cap" : null),
    input: {
      signal: controller.signal,
      llm: { calls: () => over.calls ?? 0 },
      settings: { deadlineMs: over.deadlineMs ?? 60_000 },
    },
  } as unknown as Turn;
}

describe("stopRule (11.9.6)", () => {
  const base = (t: Turn, extra: Partial<Parameters<typeof stopRule>[0]> = {}) =>
    stopRule({
      t,
      iteration: 1,
      maxIter: MAX_ITER.local,
      leads: [lead()],
      steps: [step(2)],
      evidenceCount: 2,
      ...extra,
    });

  it("goes on when no rule fires", () => {
    expect(base(fakeTurn())).toBeNull();
  });

  it("stops at the call cap with 3 calls kept for the answer", () => {
    expect(base(fakeTurn({ calls: HARD_CAP_CALLS - 3 }))).toBe("call_cap");
    expect(base(fakeTurn({ calls: HARD_CAP_CALLS - 4 }))).toBeNull();
  });

  it("stops when no lead is open", () => {
    expect(base(fakeTurn(), { leads: [lead({ status: "done" })] })).toBe(
      "no_leads",
    );
  });

  it("stops at MAX_ITER: 4 for a local model", () => {
    expect(base(fakeTurn(), { iteration: 4 })).toBe("max_iter");
    expect(base(fakeTurn(), { iteration: 3 })).toBeNull();
  });

  it("stops after the soft deadline: half of the turn deadline", () => {
    expect(base(fakeTurn({ elapsed: 31_000 }))).toBe("deadline");
    expect(base(fakeTurn({ elapsed: 29_000 }))).toBeNull();
  });

  it("stops when the last 2 observe steps added nothing new", () => {
    expect(base(fakeTurn(), { steps: [step(2), step(0), step(0)] })).toBe(
      "stalled",
    );
    expect(base(fakeTurn(), { steps: [step(0), step(2)] })).toBeNull();
  });
});

describe("no repeat", () => {
  it("never runs the same tool with the same arguments twice", () => {
    const run = new ResearchRun();
    const call = {
      tool: "search_chunks",
      args: { query: "Why  was it BLOCKED" },
    };
    expect(run.isRepeat(call)).toBe(false);
    run.remember(call);
    expect(
      run.isRepeat({
        tool: "search_chunks",
        args: { query: "why was it blocked" },
      }),
    ).toBe(true);
  });

  it("counts a query with word overlap of 0.8 or more as a repeat", () => {
    const run = new ResearchRun();
    run.remember({
      tool: "search_chunks",
      args: { query: "kestrel contract signing blocked reasons" },
    });
    expect(
      run.isRepeat({
        tool: "search_chunks",
        args: { query: "kestrel contract signing blocked" },
      }),
    ).toBe(true);
    expect(
      run.isRepeat({
        tool: "search_chunks",
        args: { query: "budget freeze approval" },
      }),
    ).toBe(false);
  });

  it("treats a search over other meetings as a new search", () => {
    const run = new ResearchRun();
    run.remember({ tool: "search_chunks", args: { query: "same words" } });
    expect(
      run.isRepeat({
        tool: "search_chunks",
        args: { query: "same words", meeting_ids: ["a"], k: 4 },
      }),
    ).toBe(false);
  });

  it("builds the key from the tool and sorted arguments", () => {
    expect(argsKey({ tool: "t", args: { b: 1, query: "X  y" } })).toBe(
      argsKey({ tool: "t", args: { query: "x y", b: 1 } }),
    );
  });
});

describe("closed strategies", () => {
  it("asks for the open questions alone when the question says questions", () => {
    expect(
      listCalls("Which questions are still open?").map((c) => c.tool),
    ).toEqual(["list_decisions_questions"]);
    expect(listCalls("What are the open items?").map((c) => c.tool)).toEqual([
      "list_action_items",
      "list_decisions_questions",
    ]);
  });
});

describe("evidence type", () => {
  it("is plain data", () => {
    const e: Evidence = {
      label: "S1",
      kind: "transcript",
      meetingId: "m",
      title: null,
      startedAt: null,
      startMs: null,
      endMs: null,
      itemId: null,
      text: "t",
      tool: "search_chunks",
      leadId: "L1",
      score: 0.9,
    };
    expect(JSON.parse(JSON.stringify(e))).toEqual(e);
  });
});
