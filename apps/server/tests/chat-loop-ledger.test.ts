// The item ledger of the Ask tool loop (D22, spec 11.10.3.1). The database has
// the real schema (version 56). The writer model is a fake. All text is fictional.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import type { ChatLlm } from "../src/lib/chat/llm.js";
import {
  backfillLedger,
  ledgerCovers,
  pendingLedgerMeetings,
  readLedger,
} from "../src/lib/chat/loop/ledger.js";
import { getDb } from "../src/lib/db.js";
import { insertSegment, resetMeetingTables } from "./helpers/meetings-db.js";

type Item = {
  id: string;
  kind: "action" | "decision" | "question";
  text: string;
  status: "raised" | "open" | "done" | "dropped" | "changed";
  owner: string | null;
  reason: string | null;
  blocked_by: string | null;
  line: number | null;
};

/** A writer that returns the scripted items of the meeting, found by title in the prompt. */
function writer(script: Record<string, Item[]>) {
  const prompts: string[] = [];
  const llm = {
    provider: "fake",
    modelId: "fake-writer",
    isLocal: false,
    contextWindow: null,
    runId: "r",
    async structured(i: {
      schema: { zod: z.ZodType<unknown> };
      messages: { content: string }[];
    }) {
      const user = i.messages.map((m) => m.content).join("\n");
      prompts.push(user);
      const title = /MEETING "([^"]+)"/.exec(user)?.[1] ?? "";
      return {
        object: i.schema.zod.parse({ items: script[title] ?? [] }),
        finishReason: "stop",
        usage: {} as never,
        latencyMs: 1,
      };
    },
    calls: () => 0,
    finish() {},
  } as unknown as ChatLlm;
  return { llm, prompts };
}

function addMeeting(id: string, title: string, day: number, lines: string[]) {
  const at = Date.UTC(2026, 8, day, 10);
  const db = getDb();
  db.prepare(
    `INSERT INTO meetings (id, title, status, started_at, duration_ms, created_at, folder_id)
     VALUES (?, ?, 'summarized', ?, 600000, ?, NULL)`,
  ).run(id, title, at, at);
  db.prepare(
    "INSERT INTO meeting_summaries (meeting_id, markdown, summary_json, created_at) VALUES (?, NULL, ?, ?)",
  ).run(
    id,
    JSON.stringify({
      overview: `${title} overview.`,
      keyPoints: [],
      decisions: [],
      actionItems: [{ task: "Sign the vendor contract", owner: "Ana" }],
      openQuestions: [],
    }),
    at,
  );
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

beforeAll(() => {
  getDb();
});

beforeEach(() => {
  resetMeetingTables();
  const db = getDb();
  db.exec(
    "DELETE FROM ledger_marks; DELETE FROM ledger_items; DELETE FROM ledger_meetings;",
  );
  addMeeting("m1", "Kickoff", 1, [
    "Ana will sign the vendor contract this week.",
    "The pilot waits for legal.",
  ]);
  addMeeting("m2", "Follow up", 8, [
    "Ana signed the vendor contract on Monday.",
  ]);
});

describe("ledger", () => {
  it("writes marks oldest first, links an item by the open list, and copies the quote from the named line", async () => {
    const db = getDb();
    expect(pendingLedgerMeetings(db)).toEqual(["m1", "m2"]);
    const { llm, prompts } = writer({
      Kickoff: [
        {
          id: "new",
          kind: "action",
          text: "Sign the vendor contract",
          status: "raised",
          owner: "Ana",
          reason: null,
          blocked_by: null,
          line: 1,
        },
      ],
      "Follow up": [
        {
          id: "L1",
          kind: "action",
          text: "Sign the vendor contract",
          status: "done",
          owner: "Ana",
          reason: null,
          blocked_by: null,
          line: 1,
        },
        {
          id: "new",
          kind: "question",
          text: "Who pays?",
          status: "raised",
          owner: null,
          reason: null,
          blocked_by: "finance",
          line: 99,
        },
      ],
    });
    const st = await backfillLedger(db, async () => llm);
    expect(st).toMatchObject({ meetings: 2, items: 2, marks: 3, failed: 0 });
    // The second pass saw the open item of the first.
    expect(prompts[1]).toContain("L1 [action] Sign the vendor contract");
    expect(pendingLedgerMeetings(db)).toEqual([]);
    expect(ledgerCovers(db, ["m2"])).toBe(true);
    const done = readLedger(db, ["m1", "m2"], {
      status: "done",
      kind: null,
      owner: null,
      meetingIds: null,
      dateFrom: null,
      limit: 10,
    });
    expect(done.total).toBe(1);
    const item = done.items[0];
    expect(item?.marks.map((k) => k.status)).toEqual(["raised", "done"]);
    // Code copied the quote of line 1 of each meeting.
    expect(item?.marks[0]?.quote).toBe(
      "Ana will sign the vendor contract this week.",
    );
    expect(item?.marks.every((k) => k.quoteOk)).toBe(true);
    // A line that does not exist gives a mark with no quote.
    const open = readLedger(db, ["m1", "m2"], {
      status: "open",
      kind: null,
      owner: null,
      meetingIds: null,
      dateFrom: null,
      limit: 10,
    });
    expect(open.items[0]?.marks[0]).toMatchObject({
      quote: "",
      quoteOk: false,
    });
  });

  it("the scope limits the marks, and a failed pass leaves the meeting unread", async () => {
    const db = getDb();
    const bad = {
      provider: "fake",
      modelId: "x",
      isLocal: false,
      runId: "r",
      contextWindow: null,
      async structured() {
        throw Object.assign(new Error("boom"), { kind: "server" });
      },
      calls: () => 0,
      finish() {},
    } as unknown as ChatLlm;
    const st = await backfillLedger(db, async () => bad);
    expect(st.failed).toBe(1);
    expect(pendingLedgerMeetings(db)).toEqual(["m1", "m2"]);
    expect(ledgerCovers(db, ["m1"])).toBe(false);
  });

  it("the meeting delete removes its marks", async () => {
    const db = getDb();
    const { llm } = writer({
      Kickoff: [
        {
          id: "new",
          kind: "decision",
          text: "Use the vendor",
          status: "raised",
          owner: null,
          reason: null,
          blocked_by: null,
          line: 2,
        },
      ],
    });
    await backfillLedger(db, async () => llm);
    db.prepare("DELETE FROM meetings WHERE id = 'm1'").run();
    expect(
      (
        db.prepare("SELECT COUNT(*) AS n FROM ledger_marks").get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
    expect(
      (
        db.prepare("SELECT COUNT(*) AS n FROM ledger_items").get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
  });
});
