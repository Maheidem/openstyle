// Live mode fixes (issue #375): the saved chat and the live transcript that
// Stop keeps. Fictional text only.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  appendChatPair,
  listChatMessages,
  recentChatHistory,
} from "../src/lib/meetings/live/chat-store.js";
import { saveLiveTranscript } from "../src/lib/meetings/live/finish.js";
import type { LiveLine } from "../src/lib/meetings/live/store.js";
import { initSchema } from "../src/lib/schema.js";
import { createVersionedDb } from "./helpers/schema-db.js";

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  initSchema(db);
  return db;
}

function addMeeting(db: DatabaseSync, id: string, status = "recorded"): void {
  db.prepare(
    "INSERT INTO meetings (id, status, started_at, created_at) VALUES (?, ?, 0, 0)",
  ).run(id, status);
}

const line = (
  source: "mic" | "system",
  startMs: number,
  text: string,
): LiveLine => ({ source, startMs, endMs: startMs + 1000, text, final: true });

describe("schema 52", () => {
  it("adds the chat table and the transcript source on a new database", () => {
    const db = freshDb();
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables).toContain("meeting_chat_messages");
    const columns = (
      db.prepare("PRAGMA table_info(meetings)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(columns).toContain("transcript_source");
  });

  it("migrates a version 51 database and keeps its meetings", () => {
    const db = createVersionedDb(
      51,
      `CREATE TABLE meetings (
         id TEXT PRIMARY KEY, title TEXT, started_at INTEGER, ended_at INTEGER,
         duration_ms INTEGER, status TEXT NOT NULL, audio_dir TEXT,
         stt_provider TEXT, stt_model TEXT, error TEXT, created_at INTEGER
       );
       INSERT INTO meetings (id, status) VALUES ('old', 'transcribed');`,
    );
    initSchema(db);
    expect(
      db
        .prepare("SELECT transcript_source FROM meetings WHERE id = 'old'")
        .get(),
    ).toEqual({ transcript_source: null });
    expect(
      db.prepare("SELECT COUNT(*) AS c FROM meeting_chat_messages").get(),
    ).toEqual({ c: 0 });
  });
});

describe("saved chat", () => {
  it("keeps the questions and answers in order, with the cites", () => {
    const db = freshDb();
    addMeeting(db, "m1", "recording");
    appendChatPair(db, "m1", {
      question: "Who owns the beta?",
      answer: "Dana owns it.",
      cites: [{ label: "L1", kind: "live", timeMs: 5000 }],
      ms: 240,
    });
    appendChatPair(db, "m1", {
      question: "When?",
      answer: "On the 14th.",
      cites: [],
      ms: 200,
    });
    const messages = listChatMessages(db, "m1");
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "Who owns the beta?"],
      ["assistant", "Dana owns it."],
      ["user", "When?"],
      ["assistant", "On the 14th."],
    ]);
    expect(messages[1].cites).toEqual([
      { label: "L1", kind: "live", timeMs: 5000 },
    ]);
    expect(messages[1].ms).toBe(240);
  });

  it("gives the last messages as model history, oldest first", () => {
    const db = freshDb();
    addMeeting(db, "m1", "recording");
    for (const n of [1, 2, 3]) {
      appendChatPair(db, "m1", {
        question: `q${n}`,
        answer: `a${n}`,
        cites: [],
        ms: 1,
      });
    }
    expect(recentChatHistory(db, "m1", 4)).toEqual([
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "q3" },
      { role: "assistant", content: "a3" },
    ]);
  });

  it("goes away with the meeting", () => {
    const db = freshDb();
    addMeeting(db, "m1", "recording");
    appendChatPair(db, "m1", { question: "q", answer: "a", cites: [], ms: 1 });
    db.prepare("DELETE FROM meetings WHERE id = 'm1'").run();
    expect(listChatMessages(db, "m1")).toEqual([]);
  });
});

describe("saveLiveTranscript", () => {
  const stt = { provider: "local-mlx", modelId: "qwen3-1.7b-8bit" };

  it("writes the lines as segments and marks the meeting as live", () => {
    const db = freshDb();
    addMeeting(db, "m1");
    const saved = saveLiveTranscript(
      db,
      "m1",
      [
        line("system", 6000, "Second line."),
        line("mic", 0, "First line."),
        line("mic", 9000, "Third line."),
      ],
      stt,
    );
    expect(saved).toBe(3);
    const rows = db
      .prepare(
        "SELECT id, source, idx, text, status FROM meeting_segments WHERE meeting_id = 'm1' ORDER BY start_ms",
      )
      .all();
    expect(rows).toEqual([
      {
        id: "m1:mic:0",
        source: "mic",
        idx: 0,
        text: "First line.",
        status: "ok",
      },
      {
        id: "m1:system:0",
        source: "system",
        idx: 0,
        text: "Second line.",
        status: "ok",
      },
      {
        id: "m1:mic:1",
        source: "mic",
        idx: 1,
        text: "Third line.",
        status: "ok",
      },
    ]);
    expect(
      db
        .prepare(
          "SELECT status, transcript_source, stt_provider, stt_model FROM meetings WHERE id = 'm1'",
        )
        .get(),
    ).toEqual({
      status: "transcribed",
      transcript_source: "live",
      stt_provider: "local-mlx",
      stt_model: "qwen3-1.7b-8bit",
    });
  });

  it("writes nothing for no lines, a failed stop or a meeting with segments", () => {
    const db = freshDb();
    addMeeting(db, "empty");
    expect(saveLiveTranscript(db, "empty", [], stt)).toBe(0);
    expect(saveLiveTranscript(db, "empty", [line("mic", 0, "   ")], stt)).toBe(
      0,
    );
    addMeeting(db, "failed", "failed");
    expect(
      saveLiveTranscript(db, "failed", [line("mic", 0, "Text.")], stt),
    ).toBe(0);
    addMeeting(db, "done");
    expect(saveLiveTranscript(db, "done", [line("mic", 0, "Text.")], stt)).toBe(
      1,
    );
    expect(saveLiveTranscript(db, "done", [line("mic", 0, "More.")], stt)).toBe(
      0,
    );
    expect(
      db.prepare("SELECT status FROM meetings WHERE id = 'empty'").get(),
    ).toEqual({ status: "recorded" });
  });
});
