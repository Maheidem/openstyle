// The write proposal builders (apps/server/src/lib/chat/proposals.ts).
// They return a proposal object and write nothing. All text is fictional.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { proposalFor } from "../src/lib/chat/proposals.js";
import type { TurnScope } from "../src/lib/chat/types.js";
import { getDb } from "../src/lib/db.js";
import {
  actionItemKey,
  setActionItemDone,
} from "../src/lib/meetings/folder-overview.js";
import { insertSpeaker, resetMeetingTables } from "./helpers/meetings-db.js";

const SCOPE_F1: TurnScope = { kind: "folder", id: "f1" };
const SCOPE_M1: TurnScope = { kind: "meeting", id: "m1" };
const SCOPE_ALL: TurnScope = { kind: "all", id: null };
const T0 = Date.UTC(2026, 8, 1);

function seedMeeting(id: string, folder: string | null, tasks: string[]) {
  const db = getDb();
  db.prepare(
    "INSERT INTO meetings (id, title, status, started_at, created_at, folder_id) VALUES (?, ?, 'summarized', ?, ?, ?)",
  ).run(id, id, T0, T0, folder);
  db.prepare(
    "INSERT INTO meeting_summaries (meeting_id, markdown, summary_json, created_at) VALUES (?, NULL, ?, 1)",
  ).run(
    id,
    JSON.stringify({
      overview: "",
      keyPoints: [],
      decisions: [],
      actionItems: tasks.map((task) => ({ task, owner: null, due: null })),
      openQuestions: [],
    }),
  );
}

beforeEach(() => {
  resetMeetingTables();
  const db = getDb();
  db.exec("DELETE FROM folder_action_item_state");
  for (const [id, name] of [
    ["f1", "Harbor Pricing"],
    ["f2", "Vendor Audit"],
  ]) {
    db.prepare(
      "INSERT INTO meeting_folders (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)",
    ).run(id, name);
  }
  seedMeeting("m1", "f1", ["Send the tide chart to the dock office"]);
  seedMeeting("m2", "f1", ["Order new mooring lines"]);
  seedMeeting("m3", "f2", ["Collect the vendor invoices"]);
  insertSpeaker("m1", "SPEAKER_00", { displayName: "Dana Whitfield" });
  insertSpeaker("m2", "SPEAKER_00", { displayName: "Dana Whitfield" });
  insertSpeaker("m3", "SPEAKER_00", { displayName: "Dana Reyes" });
  setActionItemDone(
    db,
    "f1",
    actionItemKey("m2", "Order new mooring lines"),
    true,
    5,
  );
});

/** Row count of every table, and a hash of the rows of every table. */
function snapshot() {
  const db = getDb();
  const tables = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((t) => t.name);
  const counts: Record<string, number> = {};
  const hash = createHash("sha256");
  for (const t of tables) {
    // Sorted as text: a virtual table may have no rowid.
    const rows = db
      .prepare(`SELECT * FROM "${t}"`)
      .all()
      .map((r) => JSON.stringify(r))
      .sort();
    counts[t] = rows.length;
    hash.update(t).update(JSON.stringify(rows));
  }
  return { counts, hash: hash.digest("hex") };
}

const chartKey = actionItemKey("m1", "Send the tide chart to the dock office");

describe("proposalFor", () => {
  it("action item: close and reopen", () => {
    expect(
      proposalFor(getDb(), SCOPE_F1, "propose_action_item_change", {
        item_id: chartKey,
        done: true,
      }),
    ).toEqual({
      kind: "action_item",
      ids: [chartKey],
      arg: true,
    });
    const mooring = actionItemKey("m2", "Order new mooring lines");
    expect(
      proposalFor(getDb(), SCOPE_F1, "propose_action_item_change", {
        item_id: mooring,
        done: false,
      }),
    ).toEqual({
      kind: "action_item",
      ids: [mooring],
      arg: false,
    });
  });

  it("action item: unknown id or id outside the scope gives null", () => {
    const db = getDb();
    expect(
      proposalFor(db, SCOPE_F1, "propose_action_item_change", {
        item_id: "0123456789abcdef",
        done: true,
      }),
    ).toBeNull();
    const foreign = actionItemKey("m3", "Collect the vendor invoices");
    expect(
      proposalFor(db, SCOPE_F1, "propose_action_item_change", {
        item_id: foreign,
        done: true,
      }),
    ).toBeNull();
    expect(
      proposalFor(db, SCOPE_ALL, "propose_action_item_change", {
        item_id: foreign,
        done: true,
      }),
    ).not.toBeNull();
    expect(
      proposalFor(db, SCOPE_M1, "propose_action_item_change", {
        item_id: actionItemKey("m2", "Order new mooring lines"),
        done: true,
      }),
    ).toBeNull();
  });

  it("retag: normalizes the tag, checks scope and the cap of 20", () => {
    const db = getDb();
    expect(
      proposalFor(db, SCOPE_F1, "propose_retag", {
        meeting_ids: ["m1", "m2", "m1"],
        tag: " Reviewed ",
      }),
    ).toEqual({
      kind: "retag",
      ids: ["m1", "m2"],
      arg: ["reviewed"],
    });
    expect(
      proposalFor(db, SCOPE_F1, "propose_retag", {
        meeting_ids: ["m1", "m3"],
        tag: "x",
      }),
    ).toBeNull();
    expect(
      proposalFor(db, SCOPE_ALL, "propose_retag", {
        meeting_ids: ["nope"],
        tag: "x",
      }),
    ).toBeNull();
    const many = Array.from({ length: 21 }, (_, i) => `m${i}`);
    expect(
      proposalFor(db, SCOPE_ALL, "propose_retag", {
        meeting_ids: many,
        tag: "x",
      }),
    ).toBeNull();
  });

  it("move: the meeting is in scope and the folder exists", () => {
    const db = getDb();
    expect(
      proposalFor(db, SCOPE_F1, "propose_move", {
        meeting_id: "m1",
        folder_id: "f2",
      }),
    ).toEqual({
      kind: "move",
      ids: ["m1"],
      arg: "f2",
    });
    expect(
      proposalFor(db, SCOPE_F1, "propose_move", {
        meeting_id: "m1",
        folder_id: "nope",
      }),
    ).toBeNull();
    expect(
      proposalFor(db, SCOPE_F1, "propose_move", {
        meeting_id: "m3",
        folder_id: "f1",
      }),
    ).toBeNull();
  });

  it("merge people: ids come from list_people of the scope", () => {
    const db = getDb();
    expect(
      proposalFor(db, SCOPE_F1, "propose_merge_people", {
        person_ids: ["dana whitfield"],
      }),
    ).toEqual({
      kind: "merge_people",
      ids: ["dana whitfield"],
      arg: null,
    });
    expect(
      proposalFor(db, SCOPE_F1, "propose_merge_people", {
        person_ids: ["dana reyes"],
      }),
    ).toBeNull();
    expect(
      proposalFor(db, SCOPE_ALL, "propose_merge_people", {
        person_ids: ["dana reyes", "dana whitfield"],
      }),
    ).not.toBeNull();
    expect(
      proposalFor(db, SCOPE_ALL, "propose_merge_people", {
        person_ids: ["Free Name"],
      }),
    ).toBeNull();
  });

  it("bad arguments and read tools give null", () => {
    const db = getDb();
    expect(
      proposalFor(db, SCOPE_F1, "propose_retag", { meeting_ids: [], tag: "x" }),
    ).toBeNull();
    expect(proposalFor(db, SCOPE_F1, "propose_move", {})).toBeNull();
    expect(
      proposalFor(db, SCOPE_F1, "propose_action_item_change", null),
    ).toBeNull();
    expect(proposalFor(db, SCOPE_F1, "list_meetings", {})).toBeNull();
    expect(proposalFor(db, SCOPE_F1, "drop_tables", {})).toBeNull();
  });

  it("writes nothing: every table row count and the hash of every table stay the same", () => {
    const db = getDb();
    const before = snapshot();
    expect(Object.keys(before.counts).length).toBeGreaterThan(20);
    expect(before.counts.meetings).toBe(3);
    const calls: [TurnScope, string, unknown][] = [
      [
        SCOPE_F1,
        "propose_action_item_change",
        { item_id: chartKey, done: true },
      ],
      [
        SCOPE_F1,
        "propose_action_item_change",
        { item_id: chartKey, done: false },
      ],
      [
        SCOPE_F1,
        "propose_retag",
        { meeting_ids: ["m1", "m2"], tag: "reviewed" },
      ],
      [SCOPE_F1, "propose_move", { meeting_id: "m1", folder_id: "f2" }],
      [
        SCOPE_ALL,
        "propose_merge_people",
        { person_ids: ["dana reyes", "dana whitfield"] },
      ],
      [SCOPE_F1, "propose_retag", { meeting_ids: ["m3"], tag: "reviewed" }], // rejected
      [SCOPE_F1, "propose_move", { meeting_id: "m1", folder_id: "nope" }], // rejected
    ];
    for (const [scope, tool, args] of calls) proposalFor(db, scope, tool, args);
    expect(snapshot()).toEqual(before);
    // The snapshot sees a write: it is not blind.
    db.prepare(
      "INSERT INTO tags (id, name, created_at) VALUES ('t9','probe',1)",
    ).run();
    expect(snapshot()).not.toEqual(before);
  });
});
