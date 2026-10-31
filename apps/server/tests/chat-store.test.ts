// Threads and messages of the Ask tab (specs/meeting-chat-agent.md 4.2).
// Fictional meeting data only.
import type { ChatCite, ChatTrace } from "@openstyle/validations";
import { beforeEach, describe, expect, it } from "vitest";
import {
  appendMessage,
  createThread,
  getThread,
  listMessages,
  listThreads,
  loadHistoryForPrompt,
  threadScope,
} from "../src/lib/chat/store.js";
import { getDb } from "../src/lib/db.js";
import { resetMeetingTables } from "./helpers/meetings-db.js";

const db = () => getDb();

function addMeeting(id: string, folder: string | null = null): void {
  db()
    .prepare(
      `INSERT INTO meetings (id, title, status, started_at, created_at, folder_id)
       VALUES (?, ?, 'summarized', 1000, 1000, ?)`,
    )
    .run(id, `Meeting ${id}`, folder);
}

function addFolder(id: string): void {
  db()
    .prepare(
      "INSERT INTO meeting_folders (id, name, description, created_at, updated_at) VALUES (?, ?, NULL, 1, 1)",
    )
    .run(id, `Folder ${id}`);
}

const CITE: ChatCite = {
  label: "S1",
  kind: "summary",
  meeting_id: "m1",
  title: "Meeting m1",
  started_at: 1000,
  start_ms: null,
  item_id: null,
  text: "The team picked the harbor theme.",
};

const TRACE: ChatTrace = {
  intent: "lookup",
  router: "structured",
  steps: [],
  calls: 3,
  sources_dropped: [],
  history_turns_dropped: 0,
  source_tokens: 120,
};

beforeEach(() => {
  db().exec("DELETE FROM chat_threads");
  resetMeetingTables();
});

describe("threads", () => {
  it("creates a thread for a meeting and for a folder", () => {
    addMeeting("m1");
    addFolder("f1");
    const a = createThread(db(), { kind: "meeting", id: "m1" });
    const b = createThread(db(), { kind: "folder", id: "f1" });
    expect(a?.meeting_id).toBe("m1");
    expect(a?.folder_id).toBeNull();
    expect(b?.folder_id).toBe("f1");
    expect(b?.meeting_id).toBeNull();
    expect(a?.title).toBeNull();
    expect(threadScope(a as NonNullable<typeof a>)).toEqual({
      kind: "meeting",
      id: "m1",
    });
    expect(threadScope(b as NonNullable<typeof b>)).toEqual({
      kind: "folder",
      id: "f1",
    });
  });

  it("returns null for a meeting or folder that does not exist", () => {
    expect(createThread(db(), { kind: "meeting", id: "nope" })).toBeNull();
    expect(createThread(db(), { kind: "folder", id: "nope" })).toBeNull();
  });

  it("lists the threads of a scope, newest activity first", () => {
    addMeeting("m1");
    addMeeting("m2");
    const t1 = createThread(db(), { kind: "meeting", id: "m1" }, 100);
    const t2 = createThread(db(), { kind: "meeting", id: "m1" }, 200);
    createThread(db(), { kind: "meeting", id: "m2" }, 300);
    expect(
      listThreads(db(), { kind: "meeting", id: "m1" }).map((t) => t.id),
    ).toEqual([t2?.id, t1?.id]);
    // A message bumps the thread to the top.
    appendMessage(db(), t1?.id as string, { role: "user", content: "hi" }, 500);
    expect(
      listThreads(db(), { kind: "meeting", id: "m1" }).map((t) => t.id),
    ).toEqual([t1?.id, t2?.id]);
    expect(getThread(db(), t1?.id as string)?.updated_at).toBe(500);
  });

  it("getThread returns null for an unknown id", () => {
    expect(getThread(db(), "missing")).toBeNull();
  });

  it("deletes the threads and messages with the meeting", () => {
    addMeeting("m1");
    const t = createThread(db(), { kind: "meeting", id: "m1" });
    appendMessage(db(), t?.id as string, { role: "user", content: "hi" });
    db().prepare("DELETE FROM meetings WHERE id = ?").run("m1");
    expect(getThread(db(), t?.id as string)).toBeNull();
    const n = db().prepare("SELECT count(*) AS n FROM chat_messages").get() as {
      n: number;
    };
    expect(n.n).toBe(0);
  });

  it("deletes the threads with the folder", () => {
    addFolder("f1");
    const t = createThread(db(), { kind: "folder", id: "f1" });
    db().prepare("DELETE FROM meeting_folders WHERE id = ?").run("f1");
    expect(getThread(db(), t?.id as string)).toBeNull();
  });
});

describe("messages", () => {
  function thread(): string {
    addMeeting("m1");
    return createThread(db(), { kind: "meeting", id: "m1" })?.id as string;
  }

  it("stores and reads a question and an answer with all columns", () => {
    const id = thread();
    const q = appendMessage(db(), id, { role: "user", content: "What?" }, 10);
    const a = appendMessage(
      db(),
      id,
      {
        role: "assistant",
        content: "The harbor theme [S1].",
        blocks: [
          { kind: "text", text: "The harbor theme [S1].", cites: ["S1"] },
        ],
        cites: [CITE],
        trace: TRACE,
        runId: "run-1",
        modelId: "gemma",
        provider: "local-mlx-llm",
        ms: 812,
      },
      20,
    );
    expect(q.role).toBe("user");
    expect(q.blocks).toEqual([]);
    expect(a.cites).toEqual([CITE]);
    expect(a.trace).toEqual(TRACE);
    expect(a.model_id).toBe("gemma");
    expect(a.ms).toBe(812);
    expect(listMessages(db(), id)).toEqual([q, a]);
  });

  it("sets the title from the first question, 60 characters, once", () => {
    const id = thread();
    const long = `${"Which decisions did the team take about the harbor launch? ".repeat(3)}`;
    appendMessage(db(), id, { role: "user", content: long });
    const title = getThread(db(), id)?.title as string;
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.startsWith("Which decisions did the team take")).toBe(true);
    appendMessage(db(), id, { role: "user", content: "Second question" });
    expect(getThread(db(), id)?.title).toBe(title);
  });

  it("refuses a message whose blocks do not match the schema, and writes nothing", () => {
    const id = thread();
    expect(() =>
      appendMessage(db(), id, {
        role: "assistant",
        content: "x",
        blocks: [{ kind: "nope" } as never],
      }),
    ).toThrow();
    expect(listMessages(db(), id)).toEqual([]);
  });

  it("an assistant message does not set the title", () => {
    const id = thread();
    appendMessage(db(), id, { role: "assistant", content: "x" });
    expect(getThread(db(), id)?.title).toBeNull();
  });

  it("skips a bad row and does not throw", () => {
    const id = thread();
    appendMessage(db(), id, { role: "user", content: "good" });
    const insert = db().prepare(
      `INSERT INTO chat_messages (thread_id, role, content, blocks_json, cites_json, trace_json, created_at)
       VALUES (?, 'assistant', 'bad', ?, ?, ?, 1)`,
    );
    insert.run(id, "{not json", "[]", null);
    insert.run(id, '[{"kind":"unknown"}]', "[]", null);
    insert.run(id, "[]", "[]", '{"intent":1}');
    appendMessage(db(), id, { role: "assistant", content: "also good" });
    expect(listMessages(db(), id).map((m) => m.content)).toEqual([
      "good",
      "also good",
    ]);
  });

  it("reads a row with null JSON columns as empty", () => {
    const id = thread();
    db()
      .prepare(
        "INSERT INTO chat_messages (thread_id, role, content, created_at) VALUES (?, 'user', 'q', 1)",
      )
      .run(id);
    const [m] = listMessages(db(), id);
    expect(m?.blocks).toEqual([]);
    expect(m?.cites).toEqual([]);
    expect(m?.trace).toBeNull();
  });

  it("loads the history before a message, at most 20 messages", () => {
    const id = thread();
    for (let i = 0; i < 30; i++) {
      appendMessage(db(), id, {
        role: i % 2 === 0 ? "user" : "assistant",
        content: `m${i}`,
      });
    }
    const current = appendMessage(db(), id, { role: "user", content: "now" });
    const history = loadHistoryForPrompt(db(), id, current.id);
    expect(history).toHaveLength(20);
    expect(history[0]?.content).toBe("m10");
    expect(history.at(-1)?.content).toBe("m29");
    expect(history.some((m) => m.id >= current.id)).toBe(false);
  });
});
