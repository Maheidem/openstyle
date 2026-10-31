// The read tools of the meeting chat agent (apps/server/src/lib/chat/tools.ts).
// The tests run over a tmp SQLite database that has the real schema. All
// meeting text is fictional. `retrieve` is a stub: no model, no worker.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listPeopleInScope,
  runTool,
  ToolRejected,
} from "../src/lib/chat/tools.js";
import {
  SourceMap,
  type ToolContext,
  type TurnScope,
} from "../src/lib/chat/types.js";
import { getDb } from "../src/lib/db.js";
import {
  actionItemKey,
  setActionItemDone,
} from "../src/lib/meetings/folder-overview.js";
import type { RetrievalHit } from "../src/lib/search/retrieve.js";
import {
  insertSegment,
  insertSpeaker,
  resetMeetingTables,
} from "./helpers/meetings-db.js";

vi.mock("../src/lib/search/retrieve.js", () => ({
  retrieve: vi.fn(),
  hitText: vi.fn(() => "SUMMARY TEXT"),
}));
const { retrieve, hitText } = await import("../src/lib/search/retrieve.js");
const retrieveMock = vi.mocked(retrieve);
const hitTextMock = vi.mocked(hitText);

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1, 10); // 2026-09-01 10:00 UTC
const TODAY = Date.UTC(2026, 9, 26, 12);

const SCOPE_M1: TurnScope = { kind: "meeting", id: "m1" };
const SCOPE_F1: TurnScope = { kind: "folder", id: "f1" };
const SCOPE_ALL: TurnScope = { kind: "all", id: null };

const ctxOf = (
  scope: TurnScope,
  over: Partial<ToolContext> = {},
): ToolContext => ({
  db: getDb(),
  scope,
  sources: new SourceMap(),
  todayMs: TODAY,
  k: 8,
  rerank: false,
  ...over,
});

interface SummarySeed {
  overview?: string;
  keyPoints?: string[];
  decisions?: string[];
  actionItems?: { task: string; owner: string | null; due: string | null }[];
  openQuestions?: string[];
}

function addFolder(id: string, name: string) {
  getDb()
    .prepare(
      "INSERT INTO meeting_folders (id, name, description, created_at, updated_at) VALUES (?, ?, 'Tide alerts for boat owners', 1, 1)",
    )
    .run(id, name);
}

function addMeeting(o: {
  id: string;
  folder: string | null;
  day: number;
  title?: string;
  summary?: SummarySeed;
  markdown?: string;
}) {
  const db = getDb();
  db.prepare(
    `INSERT INTO meetings (id, title, status, started_at, duration_ms, created_at, folder_id)
     VALUES (?, ?, 'summarized', ?, 600000, ?, ?)`,
  ).run(o.id, o.title ?? o.id, T0 + o.day * DAY, T0 + o.day * DAY, o.folder);
  if (o.summary || o.markdown) {
    db.prepare(
      "INSERT INTO meeting_summaries (meeting_id, markdown, summary_json, created_at) VALUES (?, ?, ?, ?)",
    ).run(
      o.id,
      o.markdown ?? null,
      o.summary
        ? JSON.stringify({
            overview: "",
            keyPoints: [],
            decisions: [],
            actionItems: [],
            openQuestions: [],
            ...o.summary,
          })
        : null,
      1,
    );
  }
}

const task = (
  t: string,
  owner: string | null = null,
  due: string | null = null,
) => ({
  task: t,
  owner,
  due,
});

beforeAll(() => {
  getDb(); // build the schema
});

beforeEach(() => {
  resetMeetingTables();
  const db = getDb();
  db.exec("DELETE FROM folder_action_item_state");
  db.exec("DELETE FROM folder_standing");
  db.exec("DELETE FROM meeting_chunks");
  retrieveMock.mockReset();
  hitTextMock.mockClear();

  addFolder("f1", "Harbor Pricing");
  addFolder("f2", "Vendor Audit");
  addMeeting({
    id: "m1",
    folder: "f1",
    day: 0,
    title: "Harbor kickoff",
    summary: {
      overview: "The team plans the new tide alert price list.",
      keyPoints: ["Price list in two tiers", "Launch in spring"],
      decisions: ["Use two price tiers"],
      actionItems: [
        task(
          "Send the tide chart to the dock office",
          "Dana Whitfield",
          "Friday",
        ),
        task("Order new mooring lines", "Lee Okafor", null),
      ],
      openQuestions: ["Who pays for the buoy upkeep?"],
    },
  });
  addMeeting({
    id: "m2",
    folder: "f1",
    day: 7,
    title: "Harbor weekly",
    summary: {
      overview: "Follow up on the price list.",
      decisions: ["Keep the winter discount"],
      actionItems: [
        task("Send the tide chart to the dock office", null, null),
        task("Draft the harbor notice", "Dana", null),
      ],
    },
  });
  addMeeting({
    id: "m3",
    folder: "f1",
    day: 34,
    title: "Harbor review",
    summary: { overview: "Review of the notice." },
  });
  addMeeting({
    id: "m4",
    folder: "f2",
    day: 3,
    title: "Audit start",
    summary: {
      actionItems: [task("Collect the vendor invoices", "Dana Reyes", null)],
    },
  });
  addMeeting({
    id: "u1",
    folder: null,
    day: 5,
    title: "Hallway chat",
    summary: { actionItems: [task("Buy a new kettle", "Lee Okafor", null)] },
  });
  addMeeting({
    id: "old",
    folder: "f1",
    day: 1,
    title: "Old notes",
    markdown: "# Old notes\nThe board met about the dock repair budget.",
  });

  insertSpeaker("m1", "SPEAKER_00", { displayName: "Dana Whitfield" });
  insertSpeaker("m1", "SPEAKER_01", { displayName: "Lee Okafor" });
  insertSpeaker("m2", "SPEAKER_00", { displayName: "Dana Whitfield" });
  insertSpeaker("m4", "SPEAKER_00", { displayName: "Dana Reyes" });
});

const rejected = (p: Promise<unknown>) =>
  expect(p).rejects.toBeInstanceOf(ToolRejected);

describe("runTool: validation and scope", () => {
  it("rejects an unknown tool and bad arguments", async () => {
    await rejected(runTool(ctxOf(SCOPE_ALL), "drop_tables", {}));
    await rejected(runTool(ctxOf(SCOPE_ALL), "search_chunks", { query: "" }));
    await rejected(
      runTool(ctxOf(SCOPE_ALL), "list_meetings", { date_from: "yesterday" }),
    );
    await rejected(
      runTool(ctxOf(SCOPE_ALL), "list_meetings", { date_from: "2026-02-30" }),
    );
    await rejected(
      runTool(ctxOf(SCOPE_ALL), "list_meetings", {
        date_from: "2026-10-05",
        date_to: "2026-10-01",
      }),
    );
  });

  // [tool, args builder from a meeting id]
  const withId: [string, (id: string) => unknown][] = [
    ["search_chunks", (id) => ({ query: "tide", meeting_ids: [id] })],
    ["get_meeting_summary", (id) => ({ meeting_id: id })],
    ["list_action_items", (id) => ({ meeting_id: id })],
    [
      "list_decisions_questions",
      (id) => ({ kind: "decision", meeting_id: id }),
    ],
    [
      "get_transcript_window",
      (id) => ({ meeting_id: id, from_ms: 0, to_ms: 1000 }),
    ],
  ];

  it.each(
    withId,
  )("%s rejects a meeting outside the meeting scope", async (tool, args) => {
    await rejected(runTool(ctxOf(SCOPE_M1), tool, args("m2")));
    await rejected(runTool(ctxOf(SCOPE_M1), tool, args("u1")));
    await rejected(runTool(ctxOf(SCOPE_M1), tool, args("nope")));
  });

  it.each(
    withId,
  )("%s rejects a meeting outside the folder scope", async (tool, args) => {
    await rejected(runTool(ctxOf(SCOPE_F1), tool, args("m4"))); // other folder
    await rejected(runTool(ctxOf(SCOPE_F1), tool, args("u1"))); // unfiled: scope A only
    await rejected(runTool(ctxOf(SCOPE_F1), tool, args("nope")));
  });

  it("scope all accepts an unfiled meeting", async () => {
    retrieveMock.mockResolvedValue({ status: "ok", modelId: "x", hits: [] });
    const r = await runTool(ctxOf(SCOPE_ALL), "get_meeting_summary", {
      meeting_id: "u1",
    });
    expect(r.rows).toBeGreaterThan(0);
    await expect(
      runTool(ctxOf(SCOPE_ALL), "search_chunks", {
        query: "tide",
        meeting_ids: ["u1"],
      }),
    ).resolves.toMatchObject({ rows: 0 });
  });
});

describe("list_action_items", () => {
  it("lists a folder, groups the same task and reads done marks", async () => {
    const key = actionItemKey("m1", "Send the tide chart to the dock office");
    setActionItemDone(getDb(), "f1", key, true, 5);
    const ctx = ctxOf(SCOPE_F1);
    const all = await runTool(ctx, "list_action_items", {});
    // 3 groups: the chart (m1+m2), the mooring lines, the notice. Old notes have no object.
    expect(all.rows).toBe(3);
    const block = all.blocks[0];
    expect(block).toMatchObject({
      kind: "list",
      list: "action_items",
      total: 3,
    });
    if (block?.kind !== "list") throw new Error("not a list");
    const chart = block.items.find((i) =>
      i.text.startsWith("Send the tide chart"),
    );
    expect(chart).toMatchObject({
      done: true,
      owner: "Dana Whitfield",
      due: "Friday",
      item_id: key,
    });
    expect(chart?.label).toMatch(/^S\d+$/);

    const open = await runTool(ctxOf(SCOPE_F1), "list_action_items", {
      status: "open",
    });
    expect(open.rows).toBe(2);
    const done = await runTool(ctxOf(SCOPE_F1), "list_action_items", {
      status: "done",
    });
    expect(done.rows).toBe(1);
    // One item source per row; the id is set; the text has the state.
    const src = ctx.sources.all().find((x) => x.itemId === key);
    expect(src).toMatchObject({ kind: "item", meetingId: "m1" });
    expect(src?.text).toContain("done");
  });

  it("filters by meeting and by date", async () => {
    const one = await runTool(ctxOf(SCOPE_F1), "list_action_items", {
      meeting_id: "m2",
    });
    expect(one.rows).toBe(2);
    const sept = await runTool(ctxOf(SCOPE_F1), "list_action_items", {
      date_from: "2026-09-08",
      date_to: "2026-09-08",
    });
    expect(sept.rows).toBe(2);
    const none = await runTool(ctxOf(SCOPE_F1), "list_action_items", {
      date_from: "2026-12-01",
      date_to: "2026-12-31",
    });
    expect(none.rows).toBe(0);
    expect(none.blocks).toEqual([]);
  });

  it("person match rule: first name fits when it is the only one in the scope", async () => {
    const r = await runTool(ctxOf(SCOPE_F1), "list_action_items", {
      person_id: "dana whitfield",
    });
    // "Dana Whitfield" owns the chart. The owner text "Dana" (the notice) fits her.
    expect(r.rows).toBe(2);
    const lee = await runTool(ctxOf(SCOPE_F1), "list_action_items", {
      person_id: "Lee Okafor",
    });
    expect(lee.rows).toBe(1);
  });

  it("person match rule: two people with one first name do not match the first name", async () => {
    // In scope all, "Dana Whitfield" and "Dana Reyes" are speakers. "Dana" fits neither.
    const w = await runTool(ctxOf(SCOPE_ALL), "list_action_items", {
      person_id: "dana whitfield",
    });
    expect(w.rows).toBe(1); // the chart only, not the notice owned by "Dana"
    const own = await runTool(ctxOf(SCOPE_ALL), "list_action_items", {
      person_id: "dana",
    });
    expect(own.rows).toBe(1);
    const reyes = await runTool(ctxOf(SCOPE_ALL), "list_action_items", {
      person_id: "dana reyes",
    });
    expect(reyes.rows).toBe(1);
  });

  it("caps the sources at 30 and the block at 50", async () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      task(
        `Unique chore number ${i} about ${["dock", "sail", "rope", "net"][i % 4]} ${i * 7919}`,
      ),
    );
    addMeeting({
      id: "big",
      folder: "f2",
      day: 20,
      summary: { actionItems: many },
    });
    const ctx = ctxOf({ kind: "folder", id: "f2" });
    const r = await runTool(ctx, "list_action_items", {});
    expect(r.rows).toBeGreaterThanOrEqual(60);
    expect(r.labels).toHaveLength(30);
    const b = r.blocks[0];
    if (b?.kind !== "list") throw new Error("not a list");
    expect(b.items).toHaveLength(50);
    expect(b.total).toBe(r.rows);
    expect(b.items.filter((i) => i.label !== null)).toHaveLength(30);
  });
});

describe("list_decisions_questions", () => {
  it("lists decisions and open questions of a folder", async () => {
    const d = await runTool(ctxOf(SCOPE_F1), "list_decisions_questions", {
      kind: "decision",
    });
    expect(d.rows).toBe(2);
    expect(d.blocks[0]).toMatchObject({
      kind: "list",
      list: "decisions",
      total: 2,
    });
    const q = await runTool(ctxOf(SCOPE_F1), "list_decisions_questions", {
      kind: "open_question",
    });
    expect(q.rows).toBe(1);
    expect(q.blocks[0]).toMatchObject({ list: "open_questions" });
  });
  it("respects limit and date range", async () => {
    const lim = await runTool(ctxOf(SCOPE_F1), "list_decisions_questions", {
      kind: "decision",
      limit: 1,
    });
    const b = lim.blocks[0];
    if (b?.kind !== "list") throw new Error("not a list");
    expect(b.items).toHaveLength(1);
    expect(b.total).toBe(2);
    const sept = await runTool(ctxOf(SCOPE_F1), "list_decisions_questions", {
      kind: "decision",
      date_from: "2026-09-01",
      date_to: "2026-09-01",
    });
    expect(sept.rows).toBe(1);
  });
});

describe("get_meeting_summary", () => {
  it("adds one source per line with item ids and done state", async () => {
    const key = actionItemKey("m1", "Order new mooring lines");
    setActionItemDone(getDb(), "f1", key, true, 5);
    const ctx = ctxOf(SCOPE_M1);
    const r = await runTool(ctx, "get_meeting_summary", { meeting_id: "m1" });
    expect(r.blocks).toEqual([]);
    const all = ctx.sources.all();
    expect(all.map((s) => s.text)).toEqual(
      expect.arrayContaining([
        "Overview: The team plans the new tide alert price list.",
        "Decision: Use two price tiers",
        "Open question: Who pays for the buoy upkeep?",
      ]),
    );
    const mooring = all.find((s) =>
      s.text.startsWith("Action item: Order new mooring"),
    );
    expect(mooring).toMatchObject({ kind: "item", itemId: key });
    expect(mooring?.text).toContain("done");
    const chart = all.find((s) => s.text.includes("tide chart"));
    expect(chart?.text).toContain("open");
    expect(chart?.itemId).toBe(
      actionItemKey("m1", "Send the tide chart to the dock office"),
    );
    expect(r.rows).toBe(all.length);
  });

  it("unfiled meeting: action items are open", async () => {
    const ctx = ctxOf(SCOPE_ALL);
    await runTool(ctx, "get_meeting_summary", { meeting_id: "u1" });
    expect(
      ctx.sources.all().find((s) => s.text.includes("kettle"))?.text,
    ).toContain("open");
  });

  it("NULL summary_json: the markdown is one source", async () => {
    const ctx = ctxOf(SCOPE_F1);
    const r = await runTool(ctx, "get_meeting_summary", { meeting_id: "old" });
    expect(r.rows).toBe(1);
    expect(ctx.sources.all()[0]).toMatchObject({
      kind: "summary",
      itemId: null,
    });
    expect(ctx.sources.all()[0]?.text).toContain("dock repair budget");
  });

  it("no summary at all: rows 0", async () => {
    getDb()
      .prepare(
        "INSERT INTO meetings (id, title, status, started_at, created_at, folder_id) VALUES ('bare','Bare','transcribed',?,?,'f1')",
      )
      .run(T0, T0);
    const r = await runTool(ctxOf(SCOPE_F1), "get_meeting_summary", {
      meeting_id: "bare",
    });
    expect(r.rows).toBe(0);
  });
});

describe("get_transcript_window", () => {
  beforeEach(() => {
    insertSegment({
      id: "w1",
      meetingId: "m1",
      idx: 0,
      startMs: 1000,
      endMs: 4000,
      source: "mic",
      text: "Let us start with prices.",
    });
    insertSegment({
      id: "w2",
      meetingId: "m1",
      idx: 1,
      startMs: 4500,
      endMs: 9000,
      source: "system",
      text: "I will send the tide chart.",
      speakerLabel: "SPEAKER_00",
    });
    insertSegment({
      id: "w3",
      meetingId: "m1",
      idx: 2,
      startMs: 9500,
      endMs: 12000,
      source: "system",
      text: "Fine by me.",
      speakerLabel: "SPEAKER_01",
    });
    insertSegment({
      id: "w4",
      meetingId: "m1",
      idx: 3,
      startMs: 13000,
      endMs: 15000,
      source: "system",
      text: "Unlabeled voice.",
    });
    insertSegment({
      id: "w5",
      meetingId: "m1",
      idx: 4,
      startMs: 400_000,
      endMs: 405_000,
      source: "system",
      text: "Far away line.",
      speakerLabel: "SPEAKER_00",
    });
    getDb()
      .prepare(
        "UPDATE meeting_segments SET enhanced_text = 'I will send the tide chart today.' WHERE id = 'w2'",
      )
      .run();
  });

  it("returns lines with speaker names and one window source", async () => {
    const ctx = ctxOf(SCOPE_M1);
    const r = await runTool(ctx, "get_transcript_window", {
      meeting_id: "m1",
      from_ms: 0,
      to_ms: 20_000,
    });
    expect(r.rows).toBe(4);
    const src = ctx.sources.all();
    expect(src).toHaveLength(1);
    expect(src[0]).toMatchObject({
      kind: "window",
      startMs: 1000,
      endMs: 15000,
    });
    const lines = src[0]?.text.split("\n");
    expect(lines).toEqual([
      "[0:01] Me: Let us start with prices.",
      "[0:04] Dana Whitfield: I will send the tide chart today.", // enhanced text wins
      "[0:09] Lee Okafor: Fine by me.",
      "[0:13] Them: Unlabeled voice.",
    ]);
  });

  it("clamps the span to 180000 ms", async () => {
    const r = await runTool(ctxOf(SCOPE_M1), "get_transcript_window", {
      meeting_id: "m1",
      from_ms: 0,
      to_ms: 600_000,
    });
    expect(r.rows).toBe(4); // w5 starts at 400000: outside 0..180000
    const r2 = await runTool(ctxOf(SCOPE_M1), "get_transcript_window", {
      meeting_id: "m1",
      from_ms: 399_000,
      to_ms: 9_999_999,
    });
    expect(r2.rows).toBe(1);
  });

  it("rejects a window that ends before it starts; filters by speaker", async () => {
    await rejected(
      runTool(ctxOf(SCOPE_M1), "get_transcript_window", {
        meeting_id: "m1",
        from_ms: 5000,
        to_ms: 1000,
      }),
    );
    const r = await runTool(ctxOf(SCOPE_M1), "get_transcript_window", {
      meeting_id: "m1",
      from_ms: 0,
      to_ms: 20_000,
      speaker: "lee",
    });
    expect(r.rows).toBe(1);
  });

  it("follows merged speakers and cuts the text at a line boundary", async () => {
    getDb()
      .prepare(
        "UPDATE meeting_speakers SET merged_into = 'SPEAKER_01' WHERE meeting_id='m1' AND speaker_label='SPEAKER_00'",
      )
      .run();
    const ctx = ctxOf(SCOPE_M1);
    await runTool(ctx, "get_transcript_window", {
      meeting_id: "m1",
      from_ms: 4000,
      to_ms: 6000,
    });
    expect(ctx.sources.all()[0]?.text).toContain("Lee Okafor: I will send");
    // Long lines: the window text stays under 1500 characters and keeps whole lines.
    for (let i = 0; i < 30; i++) {
      insertSegment({
        id: `L${i}`,
        meetingId: "m1",
        idx: 100 + i,
        startMs: 100_000 + i * 1000,
        endMs: 100_900 + i * 1000,
        text: `Line ${i} ${"word ".repeat(30)}`,
      });
    }
    const ctx2 = ctxOf(SCOPE_M1);
    await runTool(ctx2, "get_transcript_window", {
      meeting_id: "m1",
      from_ms: 100_000,
      to_ms: 130_000,
    });
    const text = ctx2.sources.all()[0]?.text ?? "";
    expect(text.length).toBeLessThanOrEqual(1500);
    expect(
      text
        .split("\n")
        .every((l) =>
          /^\[\d+:\d{2}\] Them: Line \d+ (word ?)+$/.test(l.trimEnd()),
        ),
    ).toBe(true);
  });
});

describe("list_people and listPeopleInScope", () => {
  it("returns speakers and owners with meeting counts", () => {
    const f1 = listPeopleInScope(getDb(), SCOPE_F1);
    expect(f1).toEqual([
      { id: "dana whitfield", name: "Dana Whitfield", meetings: 2 }, // m1, m2 ("Dana" owner joins)
      { id: "lee okafor", name: "Lee Okafor", meetings: 1 },
    ]);
    const all = listPeopleInScope(getDb(), SCOPE_ALL).map((p) => p.id);
    expect(all).toEqual(
      expect.arrayContaining([
        "dana whitfield",
        "dana reyes",
        "lee okafor",
        "dana",
      ]),
    );
  });
  it("folds accents and case", () => {
    insertSpeaker("m3", "SPEAKER_00", { displayName: "  JOSÉ   Álvarez " });
    const p = listPeopleInScope(getDb(), SCOPE_F1).find(
      (x) => x.id === "jose alvarez",
    );
    expect(p).toMatchObject({ name: "JOSÉ Álvarez", meetings: 1 });
  });
  it("ignores merged speakers; the tool adds no source", async () => {
    insertSpeaker("m3", "SPEAKER_01", {
      displayName: "Ghost Person",
      mergedInto: "SPEAKER_00",
    });
    expect(
      listPeopleInScope(getDb(), SCOPE_F1).some((p) => p.id === "ghost person"),
    ).toBe(false);
    const ctx = ctxOf(SCOPE_F1);
    const r = await runTool(ctx, "list_people", { query: "lee" });
    expect(r).toMatchObject({ rows: 1, labels: [], blocks: [] });
    expect(ctx.sources.size).toBe(0);
  });
});

describe("folder_status", () => {
  it("folder scope: saved bullets, counts, one folder source and a status block", async () => {
    getDb()
      .prepare(
        "INSERT INTO folder_standing (folder_id, input_hash, bullets_json, generated_at) VALUES ('f1','old-hash',?,9)",
      )
      .run(
        JSON.stringify([
          "The price list has two tiers.",
          "The notice is still a draft.",
        ]),
      );
    const ctx = ctxOf(SCOPE_F1);
    const r = await runTool(ctx, "folder_status", {});
    expect(r.rows).toBe(1);
    expect(r.blocks[0]).toMatchObject({
      kind: "status",
      bullets: [
        "The price list has two tiers.",
        "The notice is still a draft.",
      ],
      open_actions: 3,
      open_questions: 1,
    });
    const src = ctx.sources.all()[0];
    expect(src).toMatchObject({ kind: "folder", title: "Harbor Pricing" });
    expect(src?.text).toContain("may be out of date"); // the hash differs: stale
    expect(src?.text).toContain("Open action items: 3");
  });
  it("meeting scope uses the folder of the meeting; unfiled and all give rows 0", async () => {
    expect((await runTool(ctxOf(SCOPE_M1), "folder_status", {})).rows).toBe(1);
    expect(
      (await runTool(ctxOf({ kind: "meeting", id: "u1" }), "folder_status", {}))
        .rows,
    ).toBe(0);
    expect((await runTool(ctxOf(SCOPE_ALL), "folder_status", {})).rows).toBe(0);
    expect(
      (
        await runTool(
          ctxOf({ kind: "folder", id: "nope" }),
          "folder_status",
          {},
        )
      ).rows,
    ).toBe(0);
  });
});

describe("list_meetings", () => {
  it("newest first, full count in rows, limit on sources", async () => {
    const ctx = ctxOf(SCOPE_F1);
    const r = await runTool(ctx, "list_meetings", { limit: 2 });
    expect(r.rows).toBe(4); // m1, m2, m3, old
    expect(r.labels).toHaveLength(2);
    expect(ctx.sources.all().map((s) => s.meetingId)).toEqual(["m3", "m2"]);
    expect(ctx.sources.all()[1]?.text).toBe(
      "Harbor weekly (2026-09-08) Follow up on the price list.",
    );
  });
  it("filters by date range and tag", async () => {
    const sept = await runTool(ctxOf(SCOPE_ALL), "list_meetings", {
      date_from: "2026-09-01",
      date_to: "2026-09-30",
    });
    expect(sept.rows).toBe(6 - 1); // all but m3 (Oct 5)
    const db = getDb();
    db.prepare(
      "INSERT INTO tags (id, name, created_at) VALUES ('t1','reviewed',1)",
    ).run();
    db.prepare(
      "INSERT INTO meeting_tags (meeting_id, tag_id, source, created_at) VALUES ('m2','t1','user',1)",
    ).run();
    const tagged = await runTool(ctxOf(SCOPE_ALL), "list_meetings", {
      tag: "Reviewed",
    });
    expect(tagged.rows).toBe(1);
  });
});

describe("search_chunks", () => {
  const hit = (
    chunkId: number,
    meetingId: string,
    kind: RetrievalHit["kind"],
    score: number,
    startMs: number | null = 0,
    endMs: number | null = 60_000,
  ): RetrievalHit => ({
    chunkId,
    meetingId,
    score,
    ordinal: chunkId,
    kind,
    startMs,
    endMs,
  });

  function addChunk(
    chunkId: number,
    meetingId: string,
    segmentIds: string[],
    startMs: number,
  ) {
    getDb()
      .prepare(
        `INSERT INTO meeting_chunks (id, meeting_id, ordinal, segment_ids, char_start, char_end, start_ms, end_ms, token_estimate, text_hash, model_id, created_at)
         VALUES (?, ?, ?, ?, 0, NULL, ?, ?, 100, 'h', 'x', 1)`,
      )
      .run(
        chunkId,
        meetingId,
        chunkId,
        JSON.stringify(segmentIds),
        startMs,
        startMs + 60_000,
      );
  }

  beforeEach(() => {
    // One long chunk of 6 segments in m1. The query words sit in the 5th one.
    for (let i = 0; i < 6; i++) {
      const text =
        i === 4
          ? "We must fix the buoy upkeep budget before the winter storms arrive at the harbor."
          : `Filler talk number ${i} about nothing in particular, only the weather and the old dock and the ferry times today.`;
      insertSegment({
        id: `c${i}`,
        meetingId: "m1",
        idx: 10 + i,
        startMs: 10_000 + i * 10_000,
        endMs: 19_000 + i * 10_000,
        text,
      });
    }
    addChunk(101, "m1", ["c0", "c1", "c2", "c3", "c4", "c5"], 10_000);
    addChunk(102, "m1", ["c0"], 10_000);
    addChunk(103, "m1", ["c1"], 20_000);
    addChunk(104, "m1", ["c2"], 30_000);
    addChunk(105, "m2", ["c3"], 40_000);
  });

  const ok = (hits: RetrievalHit[]) =>
    retrieveMock.mockResolvedValue({ status: "ok", modelId: "x", hits });

  it("groups by meeting: best hit plus up to 2 more transcript chunks; best_ms is the best segment", async () => {
    ok([
      hit(101, "m1", "transcript", 0.9, 10_000),
      hit(900, "m1", "summary", 0.8, null, null),
      hit(102, "m1", "transcript", 0.7, 10_000),
      hit(103, "m1", "transcript", 0.6, 20_000),
      hit(104, "m1", "transcript", 0.5, 30_000),
      hit(105, "m2", "transcript", 0.4, 40_000),
    ]);
    const ctx = ctxOf(SCOPE_F1);
    const r = await runTool(ctx, "search_chunks", {
      query: "buoy upkeep budget",
    });
    expect(r.degraded).toBeNull();
    const src = ctx.sources.all();
    // m1: best (101) + 2 more transcript chunks (102, 103); the summary hit is not "extra", 104 is over the cap.
    expect(src.filter((s) => s.meetingId === "m1")).toHaveLength(3);
    expect(src.filter((s) => s.meetingId === "m2")).toHaveLength(1);
    expect(r.rows).toBe(4);
    const best = src[0];
    expect(best).toMatchObject({
      kind: "transcript",
      meetingId: "m1",
      startMs: 50_000,
      endMs: 60_000,
      title: "Harbor kickoff",
    });
    expect(best?.text.length).toBeLessThanOrEqual(640);
    expect(best?.text).toContain("buoy upkeep budget"); // the cited line is inside the text
    expect(best?.text).toContain(
      "We must fix the buoy upkeep budget before the winter storms arrive",
    );
  });

  it("a chunk with no query word starts at its first segment", async () => {
    ok([hit(102, "m1", "transcript", 0.7, 10_000)]);
    const ctx = ctxOf(SCOPE_F1);
    await runTool(ctx, "search_chunks", { query: "zebra quarterly" });
    expect(ctx.sources.all()[0]?.startMs).toBe(10_000);
  });

  it("a summary hit becomes a summary source; kinds filter works", async () => {
    ok([
      hit(900, "m1", "summary", 0.9, null, null),
      hit(102, "m1", "transcript", 0.8, 10_000),
    ]);
    const ctx = ctxOf(SCOPE_F1);
    await runTool(ctx, "search_chunks", { query: "tide", kinds: ["summary"] });
    expect(ctx.sources.all()).toHaveLength(1);
    expect(ctx.sources.all()[0]).toMatchObject({
      kind: "summary",
      startMs: null,
      text: "SUMMARY TEXT",
    });
  });

  it("meta hits show only when nothing else is found", async () => {
    ok([hit(800, "m1", "meta", 0.9, null, null)]);
    const a = ctxOf(SCOPE_F1);
    const r = await runTool(a, "search_chunks", { query: "kickoff" });
    expect(r.rows).toBe(1);
    expect(a.sources.all()[0]?.kind).toBe("summary");
    ok([
      hit(800, "m1", "meta", 0.9, null, null),
      hit(102, "m1", "transcript", 0.5, 10_000),
    ]);
    const b = ctxOf(SCOPE_F1);
    await runTool(b, "search_chunks", { query: "kickoff" });
    expect(b.sources.all().map((s) => s.kind)).toEqual(["transcript"]);
  });

  it("passes scope, date range, mode and rerank to retrieve", async () => {
    ok([]);
    await runTool(ctxOf(SCOPE_M1, { rerank: true, k: 5 }), "search_chunks", {
      query: "tide",
      date_from: "2026-09-01",
      date_to: "2026-09-30",
    });
    const call = retrieveMock.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      query: { kind: "text", text: "tide" },
      scope: { kind: "meeting", meetingId: "m1" },
      dateRange: { fromMs: Date.UTC(2026, 8, 1), toMs: Date.UTC(2026, 9, 1) },
      k: 5,
      mode: "hybrid",
      rerank: { candidates: 30 },
    });
    await runTool(ctxOf(SCOPE_F1), "search_chunks", { query: "tide", k: 12 });
    const second = retrieveMock.mock.calls[1]?.[0];
    expect(second).toMatchObject({
      scope: { kind: "folder", folderId: "f1" },
      k: 12,
    });
    expect(second).not.toHaveProperty("rerank");
    expect(second).not.toHaveProperty("dateRange");
    await runTool(ctxOf(SCOPE_ALL), "search_chunks", { query: "tide" });
    expect(retrieveMock.mock.calls[2]?.[0]).toMatchObject({
      scope: { kind: "all" },
    });
  });

  it("meeting_ids: one id goes into the scope; more ids filter after the call", async () => {
    ok([
      hit(102, "m1", "transcript", 0.9, 10_000),
      hit(105, "m2", "transcript", 0.8, 40_000),
      hit(103, "m3", "transcript", 0.7, 20_000),
    ]);
    const one = ctxOf(SCOPE_F1);
    await runTool(one, "search_chunks", { query: "tide", meeting_ids: ["m2"] });
    expect(retrieveMock.mock.calls[0]?.[0].scope).toEqual({
      kind: "meeting",
      meetingId: "m2",
    });
    const two = ctxOf(SCOPE_F1);
    await runTool(two, "search_chunks", {
      query: "tide",
      meeting_ids: ["m1", "m2"],
      k: 4,
    });
    expect(retrieveMock.mock.calls[1]?.[0].k).toBe(12);
    expect(
      two.sources
        .all()
        .map((s) => s.meetingId)
        .sort(),
    ).toEqual(["m1", "m2"]);
  });

  it("degraded: search off, search error, a thrown error; no throw, rows 0", async () => {
    retrieveMock.mockResolvedValue({ status: "off", reason: "no_model" });
    expect(
      await runTool(ctxOf(SCOPE_F1), "search_chunks", { query: "tide" }),
    ).toMatchObject({ rows: 0, degraded: "search_off", labels: [] });
    retrieveMock.mockResolvedValue({
      status: "error",
      kind: "worker_unavailable",
    });
    expect(
      await runTool(ctxOf(SCOPE_F1), "search_chunks", { query: "tide" }),
    ).toMatchObject({ rows: 0, degraded: "search_error" });
    retrieveMock.mockRejectedValue(new Error("boom"));
    expect(
      await runTool(ctxOf(SCOPE_F1), "search_chunks", { query: "tide" }),
    ).toMatchObject({ rows: 0, degraded: "search_error" });
    // The structured tools still run when the search is off (spec 2.5a).
    expect(
      (await runTool(ctxOf(SCOPE_F1), "list_action_items", {})).degraded,
    ).toBeNull();
  });

  it("no hits: rows 0, not degraded", async () => {
    ok([]);
    expect(
      await runTool(ctxOf(SCOPE_F1), "search_chunks", { query: "tide" }),
    ).toMatchObject({ rows: 0, degraded: null });
  });
});
