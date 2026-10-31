// The closed choices and the native tool calls (specs/meeting-chat-agent.md
// 2.3 and 3.1). Real SQLite test database, no model. All text is fictional.
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildChoices,
  type Choices,
  nativeToolDefs,
  validateNativeCall,
  visibleToolNames,
} from "../src/lib/chat/choices.js";
import { getDb } from "../src/lib/db.js";
import { actionItemKey } from "../src/lib/meetings/folder-overview.js";
import { insertSpeaker, resetMeetingTables } from "./helpers/meetings-db.js";

const TODAY = Date.UTC(2026, 9, 26);
const H = 3_600_000;

function seed() {
  const db = getDb();
  resetMeetingTables();
  db.exec("DELETE FROM folder_action_item_state");
  db.prepare(
    "INSERT INTO meeting_folders (id, name, description, created_at, updated_at) VALUES ('f1','Atlas',NULL,1,1), ('f2','Archive',NULL,1,1)",
  ).run();
  const add = (
    id: string,
    title: string,
    day: number[],
    folder: string | null,
    items: string[],
  ) => {
    const t = Date.UTC(
      day[0] as number,
      (day[1] as number) - 1,
      day[2] as number,
      12,
    );
    db.prepare(
      `INSERT INTO meetings (id, title, status, started_at, duration_ms, created_at, folder_id)
       VALUES (?, ?, 'summarized', ?, 60000, ?, ?)`,
    ).run(id, title, t, t, folder);
    db.prepare(
      "INSERT INTO meeting_summaries (meeting_id, markdown, summary_json, created_at) VALUES (?, NULL, ?, 1)",
    ).run(
      id,
      JSON.stringify({
        overview: "",
        keyPoints: [],
        decisions: [],
        openQuestions: [],
        actionItems: items.map((task) => ({ task, owner: null, due: null })),
      }),
    );
  };
  add("m1", "Harbor Sync", [2026, 9, 15], "f1", [
    "Write the rollback plan",
    "Order the storage cluster",
  ]);
  add("m2", "Pier Review", [2026, 9, 22], "f1", ["Send the pilot report"]);
  add("m3", "Budget Talk", [2026, 8, 3], null, ["Update the budget sheet"]);
  insertSpeaker("m1", "S1", { displayName: "Ana Lima" });
  insertSpeaker("m2", "S1", { displayName: "Ana Lima" });
  insertSpeaker("m2", "S2", { displayName: "Bruno Costa" });
  insertSpeaker("m3", "S1", { displayName: "Carla Dias" });
  // One item is done.
  db.prepare(
    "INSERT INTO folder_action_item_state (folder_id, item_key, done, updated_at) VALUES ('f1', ?, 1, 1)",
  ).run(actionItemKey("m2", "Send the pilot report"));
  void H;
}

beforeEach(seed);

const ALL = { kind: "all", id: null } as const;
const choicesFor = (
  q: string,
  scope: { kind: "meeting" | "folder" | "all"; id: string | null } = ALL,
  prior: string[] = [],
) => buildChoices(getDb(), scope, q, prior, TODAY);

describe("buildChoices", () => {
  it("ranks people by word overlap with the question", () => {
    const c = choicesFor("What did Bruno say?");
    expect(c.people[0]?.name).toBe("Bruno Costa");
    expect(c.people.map((p) => p.name).sort()).toEqual([
      "Ana Lima",
      "Bruno Costa",
      "Carla Dias",
    ]);
  });

  it("lists open items only, ranked, with the item key as id", () => {
    const c = choicesFor("close the rollback plan");
    expect(c.items.map((i) => i.label)).toEqual(["A1", "A2", "A3"]);
    expect(c.items[0]?.text).toBe("Write the rollback plan");
    expect(c.items[0]?.id).toBe(actionItemKey("m1", "Write the rollback plan"));
    expect(c.items.some((i) => i.text === "Send the pilot report")).toBe(false);
  });

  it("an unfiled meeting has open items in scope all", () => {
    expect(choicesFor("budget sheet").items[0]?.text).toBe(
      "Update the budget sheet",
    );
  });

  it("ranks meetings by title and by date words", () => {
    const byTitle = choicesFor("notes of the pier review");
    expect(byTitle.meetings[0]).toEqual({
      label: "M1",
      id: "m2",
      text: "Pier Review (2026-09-22)",
    });
    const byDate = choicesFor("what happened on September 15?");
    expect(byDate.meetings[0]?.id).toBe("m1");
    const byPt = choicesFor("o que houve em 3 de agosto?");
    expect(byPt.meetings[0]?.id).toBe("m3");
  });

  it("uses earlier questions of the thread to rank", () => {
    const c = choicesFor("and who owns it?", ALL, ["the budget sheet"]);
    expect(c.items[0]?.text).toBe("Update the budget sheet");
  });

  it("respects the scope", () => {
    const m = choicesFor("x", { kind: "meeting", id: "m1" });
    expect([...m.scopeMeetingIds]).toEqual(["m1"]);
    expect(m.meetings.map((x) => x.id)).toEqual(["m1"]);
    expect(m.people.map((p) => p.name)).toEqual(["Ana Lima"]);
    const f = choicesFor("x", { kind: "folder", id: "f1" });
    expect([...f.scopeMeetingIds].sort()).toEqual(["m1", "m2"]);
  });

  it("lists the folders", () => {
    expect(choicesFor("move it to archive").folders[0]).toEqual({
      id: "f2",
      name: "Archive",
    });
  });

  it("caps the lists", () => {
    const db = getDb();
    for (let i = 0; i < 20; i++) {
      db.prepare(
        "INSERT INTO meetings (id, title, status, started_at, created_at) VALUES (?, ?, 'summarized', ?, ?)",
      ).run(`x${i}`, `Extra ${i}`, Date.UTC(2026, 0, 1 + i), 1);
      insertSpeaker(`x${i}`, "S1", { displayName: `Person Number${i}` });
    }
    const c = choicesFor("x");
    expect(c.meetings).toHaveLength(12);
    expect(c.people.length).toBeLessThanOrEqual(30);
    expect(c.meetings.at(-1)?.label).toBe("M12");
  });

  // Eval-style: the gold item or meeting is inside the closed lists.
  it.each([
    ["Mark the rollback plan as done", "items", "Write the rollback plan"],
    [
      "Close the task about the budget sheet",
      "items",
      "Update the budget sheet",
    ],
    [
      "Move the Budget Talk meeting to Archive",
      "meetings",
      "Budget Talk (2026-08-03)",
    ],
    ["Tag the meeting of September 22", "meetings", "Pier Review (2026-09-22)"],
  ] as const)("gold choice is listed: %s", (q, list, text) => {
    const c = choicesFor(q);
    const texts = (c[list] as { text: string }[]).map((x) => x.text);
    expect(texts).toContain(text);
    expect(texts.indexOf(text)).toBeLessThan(2);
  });
});

describe("nativeToolDefs", () => {
  it("builds OpenAI function tools with closed labels and no date field", () => {
    const c = choicesFor("x");
    const defs = nativeToolDefs(c, [
      "search_chunks",
      "get_meeting_summary",
      "list_action_items",
      "list_meetings",
    ]);
    expect(defs.map((d) => d.function.name)).toEqual([
      "search_chunks",
      "get_meeting_summary",
      "list_action_items",
      "list_meetings",
    ]);
    const summary = defs[1]?.function.parameters.properties.meeting as {
      enum: string[];
    };
    expect(summary.enum).toEqual(c.meetings.map((m) => m.label));
    for (const d of defs) {
      const p = JSON.stringify(d.function.parameters);
      expect(p).not.toContain("date_from");
      expect(p).not.toContain("date_to");
      expect(d.type).toBe("function");
    }
  });

  it("shows at most 8 tools", () => {
    const c = choicesFor("x");
    const defs = nativeToolDefs(c, visibleToolNames("folder", false));
    expect(defs.length).toBeLessThanOrEqual(8);
    expect(visibleToolNames("meeting", false)).not.toContain("list_people");
    expect(visibleToolNames("all", false)).not.toContain("folder_status");
    expect(visibleToolNames("all", true)).toHaveLength(4);
  });

  it("leaves out a tool whose closed list is empty", () => {
    const empty: Choices = {
      people: [],
      items: [],
      meetings: [],
      folders: [],
      scopeMeetingIds: new Set(),
    };
    const names = nativeToolDefs(empty, [
      "get_meeting_summary",
      "propose_action_item_change",
      "propose_merge_people",
      "list_meetings",
    ]).map((d) => d.function.name);
    expect(names).toEqual(["list_meetings"]);
  });
});

describe("validateNativeCall", () => {
  const env = (
    c: Choices,
    over: Partial<Parameters<typeof validateNativeCall>[1]> = {},
  ) => ({
    choices: c,
    scope: ALL,
    allowed: [
      "search_chunks",
      "get_meeting_summary",
      "list_action_items",
      "propose_move",
      "propose_action_item_change",
      "propose_retag",
      "propose_merge_people",
    ],
    question: "What did we decide about the pilot?",
    todayMs: TODAY,
    ...over,
  });

  it("maps a label to the meeting id and parses with the zod schema", () => {
    const c = choicesFor("pier review");
    const r = validateNativeCall(
      { name: "get_meeting_summary", args: { meeting: "M1" } },
      env(c),
    );
    expect(r).toEqual({
      ok: true,
      args: { tool: "get_meeting_summary", args: { meeting_id: "m2" } },
    });
  });

  it("rejects an unknown label and does not repair it", () => {
    const c = choicesFor("x");
    const r = validateNativeCall(
      { name: "get_meeting_summary", args: { meeting: "M99" } },
      env(c),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/^bad_label/);
  });

  it("rejects a raw meeting id that is not a label", () => {
    const c = choicesFor("x");
    expect(
      validateNativeCall(
        { name: "get_meeting_summary", args: { meeting: "m1" } },
        env(c),
      ).ok,
    ).toBe(false);
  });

  it("rejects a tool outside the plan and an unknown tool", () => {
    const c = choicesFor("x");
    const a = validateNativeCall({ name: "list_people", args: {} }, env(c));
    expect(a).toEqual({ ok: false, reason: "tool_not_allowed: list_people" });
    const b = validateNativeCall({ name: "drop_tables", args: {} }, env(c));
    expect(b).toEqual({ ok: false, reason: "unknown_tool: drop_tables" });
  });

  it("ignores a model date and uses the date of the question", () => {
    const c = choicesFor("x");
    const r = validateNativeCall(
      {
        name: "search_chunks",
        args: {
          query: "pilot",
          date_from: "1999-01-01",
          date_to: "1999-02-02",
        },
      },
      env(c, { question: "What was said on September 15?" }),
    );
    expect(r.ok && r.args.args).toMatchObject({
      query: "pilot",
      date_from: "2026-09-15",
      date_to: "2026-09-15",
    });
  });

  it("sets no date when the question has none", () => {
    const c = choicesFor("x");
    const r = validateNativeCall(
      {
        name: "search_chunks",
        args: { query: "pilot", date_from: "1999-01-01" },
      },
      env(c),
    );
    expect(r.ok && Object.keys(r.args.args as object)).toEqual(["query"]);
  });

  it("uses the question for an empty query and cuts a long one", () => {
    const c = choicesFor("x");
    const empty = validateNativeCall(
      { name: "search_chunks", args: { query: "  " } },
      env(c),
    );
    expect(empty.ok && (empty.args.args as { query: string }).query).toBe(
      "What did we decide about the pilot?",
    );
    const q = "word ".repeat(80).trim();
    const longQ = validateNativeCall(
      { name: "search_chunks", args: { query: q } },
      env(c, { question: q }),
    );
    expect(
      longQ.ok && (longQ.args.args as { query: string }).query.length,
    ).toBeLessThanOrEqual(200);
  });

  it("a meeting outside the scope is an error", () => {
    const c = choicesFor("x");
    const narrow: Choices = { ...c, scopeMeetingIds: new Set(["m1"]) };
    const r = validateNativeCall(
      { name: "get_meeting_summary", args: { meeting: "M1" } },
      env(narrow),
    );
    const label = narrow.meetings[0]?.id;
    expect(r.ok).toBe(label === "m1");
    const other = narrow.meetings.find((m) => m.id !== "m1");
    const idx = narrow.meetings.indexOf(other as never) + 1;
    const bad = validateNativeCall(
      { name: "get_meeting_summary", args: { meeting: `M${idx}` } },
      env(narrow),
    );
    expect(bad).toEqual({
      ok: false,
      reason: `out_of_scope: meeting ${other?.id}`,
    });
  });

  it("maps a person id and rejects an unknown person", () => {
    const c = choicesFor("bruno");
    const ok = validateNativeCall(
      {
        name: "list_action_items",
        args: { person: c.people[0]?.id, status: "open" },
      },
      env(c),
    );
    expect(ok.ok && ok.args.args).toMatchObject({
      person_id: c.people[0]?.id,
      status: "open",
    });
    expect(
      validateNativeCall(
        { name: "list_action_items", args: { person: "Nobody" } },
        env(c),
      ).ok,
    ).toBe(false);
    expect(
      validateNativeCall(
        { name: "list_action_items", args: { person: "none" } },
        env(c),
      ).ok,
    ).toBe(true);
  });

  it("builds write proposals from labels", () => {
    const c = choicesFor(
      "Mark the rollback plan as done and move Budget Talk to archive",
    );
    const item = validateNativeCall(
      { name: "propose_action_item_change", args: { item: "A1", done: true } },
      env(c),
    );
    expect(item.ok && item.args.args).toEqual({
      item_id: actionItemKey("m1", "Write the rollback plan"),
      done: true,
    });
    const mv = validateNativeCall(
      { name: "propose_move", args: { meeting: "M1", folder: "f2" } },
      env(c),
    );
    expect(mv.ok && mv.args.args).toMatchObject({ folder_id: "f2" });
    expect(
      validateNativeCall(
        { name: "propose_move", args: { meeting: "M1", folder: "f9" } },
        env(c),
      ).ok,
    ).toBe(false);
  });

  it("retag without a meeting uses the meetings in the date range of the question", () => {
    const c = choicesFor("x");
    const r = validateNativeCall(
      { name: "propose_retag", args: { tag: "pilot" } },
      env(c, { question: "Tag the meetings of September 22 as pilot" }),
    );
    expect(r.ok && r.args.args).toEqual({ meeting_ids: ["m2"], tag: "pilot" });
    const none = validateNativeCall(
      { name: "propose_retag", args: { tag: "pilot" } },
      env(c),
    );
    expect(none.ok).toBe(false);
  });
});
