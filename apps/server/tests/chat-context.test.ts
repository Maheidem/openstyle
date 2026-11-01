// The context window rules of the answer call (specs/meeting-chat-agent.md
// 2.8). Pure functions, no model. All text is fictional.
import { describe, expect, it } from "vitest";
import {
  assembleAnswerInput,
  compactHistory,
  type HistoryTurn,
  halveBudget,
  renderHistory,
  renderSource,
  trimToErrorNumbers,
} from "../src/lib/chat/context.js";
import type { Source } from "../src/lib/chat/types.js";

const D = Date.UTC(2026, 8, 15, 12);

function src(n: number, text = `Fact number ${n} about the harbor.`): Source {
  return {
    label: `S${n}`,
    kind: "transcript",
    meetingId: "m1",
    title: "Harbor Sync",
    startedAt: D,
    startMs: 61_000,
    endMs: null,
    itemId: null,
    text,
  };
}
const long = (n: number) => src(n, `word${n} `.repeat(120).trim());
const turn = (i: number): HistoryTurn => ({
  question: `Question ${i} about the pilot plan for the harbor`,
  answer: `Answer ${i} says the pilot starts on a Monday.`,
  cites: ["Harbor Sync, 2026-09-15"],
});

const base = {
  system: "Answer from the numbered sources. Cite labels.",
  question: "Who owns the rollback plan?",
  windowTokens: null,
  maxOutputTokens: 400,
  fixedTokens: 40,
};

describe("renderSource", () => {
  it("writes one line", () => {
    expect(renderSource(src(3))).toBe(
      "[S3] Harbor Sync, 2026-09-15 01:01: Fact number 3 about the harbor.",
    );
  });
  it("leaves out missing parts", () => {
    expect(
      renderSource({
        ...src(1, "a\n\nb"),
        title: null,
        startedAt: null,
        startMs: null,
      }),
    ).toBe("[S1] a b");
  });
});

describe("assembleAnswerInput", () => {
  it("keeps everything when it fits, in a fixed block order", () => {
    const r = assembleAnswerInput({
      ...base,
      history: [turn(1)],
      sources: [src(1), src(2)],
      budgetTokens: 6000,
    });
    expect(r.includedLabels).toEqual(["S1", "S2"]);
    expect(r.droppedLabels).toEqual([]);
    expect(r.historyTurnsDropped).toBe(0);
    const u = r.user;
    expect(u.indexOf("SOURCES:")).toBeLessThan(u.indexOf("HISTORY:"));
    expect(u.indexOf("HISTORY:")).toBeLessThan(u.indexOf("QUESTION:"));
    expect(u.endsWith(base.question)).toBe(true);
    expect(r.total).toBeLessThanOrEqual(6000);
  });

  it("drops sources whole, last-ranked first, and never cuts one", () => {
    const sources = [long(1), long(2), long(3), long(4)];
    const r = assembleAnswerInput({
      ...base,
      history: [],
      sources,
      budgetTokens: 700,
    });
    expect(r.includedLabels.length).toBeGreaterThan(0);
    expect(r.includedLabels.length).toBeLessThan(4);
    expect(r.includedLabels).toEqual(
      sources.slice(0, r.includedLabels.length).map((s) => s.label),
    );
    for (const l of r.includedLabels) {
      const s = sources.find((x) => x.label === l) as Source;
      expect(r.user).toContain(renderSource(s));
    }
    expect(r.droppedLabels).toEqual(
      sources.slice(r.includedLabels.length).map((s) => s.label),
    );
    expect(r.total).toBeLessThanOrEqual(700);
  });

  it("history never pushes a source out", () => {
    const sources = [long(1), long(2)];
    const without = assembleAnswerInput({
      ...base,
      history: [],
      sources,
      budgetTokens: 1000,
    });
    const history = Array.from({ length: 12 }, (_, i) => turn(i));
    const withHistory = assembleAnswerInput({
      ...base,
      history,
      sources,
      budgetTokens: 1000,
    });
    expect(withHistory.includedLabels).toEqual(without.includedLabels);
    expect(withHistory.total).toBeLessThanOrEqual(1000);
  });

  it("drops the oldest history turns first", () => {
    const history = Array.from({ length: 30 }, (_, i) => turn(i));
    const r = assembleAnswerInput({
      ...base,
      history,
      sources: [src(1)],
      budgetTokens: 6000,
    });
    expect(r.historyTurnsDropped).toBeGreaterThan(0);
    expect(r.parts.history).toBeLessThanOrEqual(600);
    expect(r.user).toContain("Question 29");
    expect(r.user).not.toContain("Question 0 about");
  });

  it("keeps the question whole even when no source fits", () => {
    const q = "Why ".repeat(200).trim();
    const r = assembleAnswerInput({
      ...base,
      question: q,
      history: [turn(1)],
      sources: [src(1)],
      budgetTokens: 100,
    });
    expect(r.user.endsWith(q)).toBe(true);
    expect(r.includedLabels).toEqual([]);
    expect(r.droppedLabels).toEqual(["S1"]);
  });

  it("caps the budget by the window", () => {
    const sources = [long(1), long(2), long(3), long(4)];
    const open = assembleAnswerInput({
      ...base,
      history: [],
      sources,
      budgetTokens: 6000,
    });
    const small = assembleAnswerInput({
      ...base,
      history: [],
      sources,
      budgetTokens: 6000,
      windowTokens: 800,
    });
    expect(open.droppedLabels).toEqual([]);
    expect(small.droppedLabels.length).toBeGreaterThan(0);
    expect(
      small.total + base.maxOutputTokens + base.fixedTokens,
    ).toBeLessThanOrEqual(800);
  });
});

describe("compactHistory", () => {
  const cite = { title: "Harbor Sync", started_at: D };
  it("keeps the first sentence of the answer, at most 200 chars", () => {
    const [t] = compactHistory([
      { role: "user", content: "When is the launch?", cites: [] },
      {
        role: "assistant",
        content: `The launch is on Monday [S1]. ${"More text. ".repeat(50)}`,
        cites: [cite, cite],
      },
    ]);
    expect(t?.answer).toBe("The launch is on Monday .");
    expect(t?.cites).toEqual(["Harbor Sync, 2026-09-15"]);
    const [u] = compactHistory([
      { role: "user", content: "q", cites: [] },
      { role: "assistant", content: "x".repeat(500), cites: [] },
    ]);
    expect(u?.answer.length).toBeLessThanOrEqual(200);
  });
  it("a question with two answers (a widen turn) keeps the last answer", () => {
    const turns = compactHistory([
      { role: "user", content: "What is the budget?", cites: [] },
      {
        role: "assistant",
        content: "",
        blocks: [
          {
            kind: "not_found",
            scope: { kind: "meeting", id: "m1" },
            reason: "no_sources",
            nearest: [],
          },
        ],
        cites: [],
      },
      { role: "assistant", content: "The budget is 40 thousand.", cites: [] },
      { role: "user", content: "And who approved it?", cites: [] },
      { role: "assistant", content: "Ana did.", cites: [] },
    ]);
    expect(turns.map((t) => [t.question, t.answer])).toEqual([
      ["What is the budget?", "The budget is 40 thousand."],
      ["And who approved it?", "Ana did."],
    ]);
  });
  it("describes a block-only answer", () => {
    const [t] = compactHistory([
      { role: "user", content: "List the open items", cites: [] },
      {
        role: "assistant",
        content: "",
        blocks: [{ kind: "list", list: "action_items", total: 3, items: [] }],
        cites: [],
      },
    ]);
    expect(t?.answer).toBe("listed 3 action items");
  });
  it("leaves out a question with no answer", () => {
    expect(compactHistory([{ role: "user", content: "q", cites: [] }])).toEqual(
      [],
    );
  });
});

describe("renderHistory", () => {
  it("writes Q and A lines with the sources", () => {
    expect(renderHistory([turn(1)])).toBe(
      "Q: Question 1 about the pilot plan for the harbor\nA: Answer 1 says the pilot starts on a Monday. (from: Harbor Sync, 2026-09-15)",
    );
  });
});

describe("retry helpers", () => {
  it("halves the budget", () => expect(halveBudget(6000)).toBe(3000));
  it("trims by the numbers of the error", () => {
    const next = trimToErrorNumbers({
      budgetTokens: 6000,
      maxOutputTokens: 400,
      promptTokens: 33_000,
      contextTokens: 32_768,
    });
    expect(next).toBeLessThan(6000);
    expect(next).toBeGreaterThan(0);
  });
  it("halves when the numbers are missing", () => {
    expect(
      trimToErrorNumbers({
        budgetTokens: 6000,
        maxOutputTokens: 400,
        promptTokens: null,
        contextTokens: null,
      }),
    ).toBe(3000);
  });
});
