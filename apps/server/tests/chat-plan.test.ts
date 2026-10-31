// The plan table, the slot schema and the planned calls (specs/
// meeting-chat-agent.md 2.3 stage 2). No model. All text is fictional.
import { describe, expect, it } from "vitest";
import type { Choices } from "../src/lib/chat/choices.js";
import {
  asksForCount,
  defaultSlots,
  planFor,
  plannedCalls,
  slotSystem,
  slotZod,
} from "../src/lib/chat/plan.js";
import type { TurnScope } from "../src/lib/chat/types.js";

const TODAY = Date.UTC(2026, 9, 26);
const CH: Choices = {
  people: [{ id: "ana lima", name: "Ana Lima" }],
  items: [{ label: "A1", id: "key1", text: "Write the rollback plan" }],
  meetings: [
    { label: "M1", id: "m1", text: "Harbor Sync (2026-09-15)" },
    { label: "M2", id: "m2", text: "Pier Review (2026-09-22)" },
  ],
  folders: [{ id: "f1", name: "Atlas" }],
  scopeMeetingIds: new Set(["m1", "m2"]),
};
const ALL: TurnScope = { kind: "all", id: null };
const FOLDER: TurnScope = { kind: "folder", id: "f1" };
const MEETING: TurnScope = { kind: "meeting", id: "m1" };
const calls = (
  intent: Parameters<typeof plannedCalls>[0],
  scope: TurnScope,
  q: string,
  slots = defaultSlots(q),
  round = 1,
) => plannedCalls(intent, scope, slots, CH, q, TODAY, round);

describe("planFor", () => {
  it("follows the table", () => {
    expect(planFor("lookup", "meeting")).toEqual([
      "search_chunks",
      "get_meeting_summary",
    ]);
    expect(planFor("lookup", "folder")).toEqual(["search_chunks"]);
    expect(planFor("who_said", "all")).toEqual([
      "search_chunks",
      "get_transcript_window",
    ]);
    expect(planFor("status", "folder")).toEqual(["folder_status"]);
    expect(planFor("status", "meeting")).toEqual(["get_meeting_summary"]);
    expect(planFor("status", "all")).toEqual([
      "list_meetings",
      "list_action_items",
    ]);
    expect(planFor("review", "folder")).toEqual([
      "list_decisions_questions",
      "list_action_items",
    ]);
    expect(planFor("other", "all")).toEqual(planFor("lookup", "all"));
  });
  it("write gives the four propose tools; no plan shows more than 8 tools", () => {
    expect(planFor("write", "all")).toHaveLength(4);
    for (const i of [
      "lookup",
      "who_said",
      "aggregate",
      "temporal",
      "review",
      "status",
      "write",
      "other",
    ] as const)
      for (const s of ["meeting", "folder", "all"] as const)
        expect(planFor(i, s).length).toBeLessThanOrEqual(8);
  });
});

describe("asksForCount", () => {
  it.each([
    "How many meetings did we have?",
    "What is the number of open items?",
    "Quantas reuniões tivemos?",
    "Quantos itens estão abertos?",
    "¿Cuántos temas hay?",
    "Wie viele Meetings gab es?",
    "Combien de réunions ?",
    "Quanti incontri abbiamo avuto?",
  ])("true: %s", (q) => expect(asksForCount(q)).toBe(true));
  it.each([
    "List the open items",
    "Who owns the plan?",
    "Liste as decisões",
  ])("false: %s", (q) => expect(asksForCount(q)).toBe(false));
});

describe("plannedCalls", () => {
  it("lookup: one search with the dates of the question", () => {
    const q = "What was decided about the pilot on September 15?";
    const [c] = calls("lookup", ALL, q);
    expect(c?.tool).toBe("search_chunks");
    expect(c?.args).toMatchObject({
      query: q,
      date_from: "2026-09-15",
      date_to: "2026-09-15",
    });
  });

  it("uses the query slot, and the question when the slot is too long", () => {
    const q = "and who owns it?";
    expect(
      calls("lookup", ALL, q, {
        ...defaultSlots(q),
        query: "rollback plan owner",
      })[0]?.args,
    ).toMatchObject({ query: "rollback plan owner" });
    expect(
      calls("lookup", ALL, q, { ...defaultSlots(q), query: "x".repeat(300) })[0]
        ?.args,
    ).toMatchObject({ query: q });
  });

  it("scope meeting limits the search to that meeting", () => {
    expect(calls("lookup", MEETING, "pilot?")[0]?.args).toMatchObject({
      meeting_ids: ["m1"],
    });
  });

  it("round 2 raises k and drops the dates; round 3 cuts the query", () => {
    const q =
      "What did the committee decide about the storage cluster budget on September 15?";
    const r1 = calls("lookup", ALL, q)[0]?.args as Record<string, unknown>;
    const r2 = calls("lookup", ALL, q, undefined, 2)[0]?.args as Record<
      string,
      unknown
    >;
    const r3 = calls("lookup", ALL, q, undefined, 3)[0]?.args as Record<
      string,
      unknown
    >;
    expect(r1.k).toBeUndefined();
    expect(r1.date_from).toBe("2026-09-15");
    expect(r2.k).toBe(20);
    expect(r2.date_from).toBeUndefined();
    expect(r2.query).toBe(r1.query);
    expect(r3.k).toBe(20);
    expect((r3.query as string).split(" ")).toHaveLength(3);
    expect(r3.query).toBe("committee storage September");
  });

  it("aggregate: open action items of a person, or a meeting count", () => {
    const a = calls("aggregate", ALL, "List the open items of Ana", {
      ...defaultSlots("x"),
      person: "ana lima",
    });
    expect(a).toEqual([
      {
        tool: "list_action_items",
        args: { status: "open", person_id: "ana lima" },
      },
    ]);
    const unknown = calls("aggregate", ALL, "List items", {
      ...defaultSlots("x"),
      person: "nobody",
    });
    expect(unknown[0]?.args).toEqual({ status: "open" });
    const done = calls("aggregate", ALL, "How many tasks are done?");
    expect(done[0]?.args).toMatchObject({ status: "done" });
    expect(
      calls("aggregate", ALL, "How many meetings did we have last week?")[0]
        ?.tool,
    ).toBe("list_meetings");
    expect(
      calls("aggregate", MEETING, "How many tasks?")[0]?.args,
    ).toMatchObject({ meeting_id: "m1" });
  });

  it("temporal: list meetings when a date exists, else search", () => {
    expect(
      calls(
        "temporal",
        FOLDER,
        "Which meetings did we have on September 22?",
      )[0],
    ).toMatchObject({
      tool: "list_meetings",
      args: { date_from: "2026-09-22" },
    });
    expect(calls("temporal", ALL, "When is the cutover?")[0]?.tool).toBe(
      "search_chunks",
    );
  });

  it("review: kind from the slot, else from the words", () => {
    expect(
      calls("review", FOLDER, "Show all decisions", {
        ...defaultSlots("x"),
        kind: "open_question",
      })[0]?.args,
    ).toMatchObject({ kind: "open_question" });
    expect(
      calls("review", FOLDER, "Show the open questions")[0]?.args,
    ).toMatchObject({ kind: "open_question" });
    expect(
      calls("review", FOLDER, "Show all decisions")[0]?.args,
    ).toMatchObject({ kind: "decision" });
  });

  it("status per scope", () => {
    expect(calls("status", MEETING, "status?")).toEqual([
      { tool: "get_meeting_summary", args: { meeting_id: "m1" } },
    ]);
    expect(calls("status", FOLDER, "status?")).toEqual([
      { tool: "folder_status", args: {} },
    ]);
    expect(calls("status", ALL, "status?").map((c) => c.tool)).toEqual([
      "list_meetings",
      "list_action_items",
    ]);
  });

  it("write: ids from labels; a missing slot gives no call", () => {
    const s = {
      ...defaultSlots("x"),
      change: "action_item" as const,
      item: "A1",
    };
    expect(calls("write", ALL, "Mark the rollback plan as done", s)).toEqual([
      {
        tool: "propose_action_item_change",
        args: { item_id: "key1", done: true },
      },
    ]);
    expect(
      calls("write", ALL, "Reopen the rollback plan", s)[0]?.args,
    ).toMatchObject({ done: false });
    expect(calls("write", ALL, "x", { ...s, item: "none" })).toEqual([]);
    expect(calls("write", ALL, "x", { ...s, item: "A9" })).toEqual([]);
    expect(
      calls("write", ALL, "Move Harbor Sync to Atlas", {
        ...defaultSlots("x"),
        change: "move",
        meeting: "M1",
        folder: "f1",
      }),
    ).toEqual([
      { tool: "propose_move", args: { meeting_id: "m1", folder_id: "f1" } },
    ]);
    expect(
      calls("write", ALL, "Tag it", {
        ...defaultSlots("x"),
        change: "retag",
        meeting: "M2",
        tag: "pilot",
      }),
    ).toEqual([
      { tool: "propose_retag", args: { meeting_ids: ["m2"], tag: "pilot" } },
    ]);
    expect(
      calls("write", ALL, "Merge Ana", {
        ...defaultSlots("x"),
        change: "merge_people",
        person: "ana lima",
      }),
    ).toEqual([
      { tool: "propose_merge_people", args: { person_ids: ["ana lima"] } },
    ]);
    expect(calls("write", ALL, "x", s, 2)).toEqual([]);
  });
});

describe("slots", () => {
  it("has no date fields and closed choices", () => {
    const z = slotZod("aggregate", CH);
    expect(z?.safeParse({ person: "ana lima" }).success).toBe(true);
    expect(z?.safeParse({ person: "nobody" }).success).toBe(false);
    expect(
      z?.safeParse({ person: "none", date_from: "2026-01-01" }).success,
    ).toBe(false);
    expect(slotZod("status", CH)).toBeNull();

    const w = slotZod("write", CH);
    expect(
      w?.safeParse({
        change: "move",
        item: "none",
        meeting: "M2",
        folder: "f1",
        person: "none",
        tag: null,
      }).success,
    ).toBe(true);
    expect(
      w?.safeParse({
        change: "move",
        item: "A9",
        meeting: "M2",
        folder: "f1",
        person: "none",
        tag: null,
      }).success,
    ).toBe(false);
  });

  it("the prompt names no date field and lists the choices", () => {
    const p = slotSystem("write", CH, "2026-10-26");
    expect(p).not.toMatch(/date_from|date_to/);
    expect(p).toContain('A1="Write the rollback plan"');
    expect(p).toContain("M2=Pier Review (2026-09-22)");
    // lookup, who_said and temporal have no model field: the query is made by code.
    expect(slotZod("lookup", CH)).toBeNull();
    expect(slotZod("temporal", CH)).toBeNull();
  });

  it("defaultSlots uses the question as the query", () => {
    expect(defaultSlots("who owns it?").query).toBe("who owns it?");
  });
});
