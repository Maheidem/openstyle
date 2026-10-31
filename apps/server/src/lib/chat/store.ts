import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type ChatBlock,
  type ChatCite,
  type ChatMessage,
  type ChatScope,
  type ChatThread,
  type ChatTrace,
  chatBlockSchema,
  chatCiteSchema,
  chatTraceSchema,
} from "@openstyle/validations";
import { z } from "zod";

// Access to chat_threads and chat_messages (specs/meeting-chat-agent.md 4.2).
// A thread belongs to one meeting or one folder. A deleted meeting or folder
// removes its threads, and a deleted thread removes its messages (cascade).

/** Characters of the thread title, taken from the first question. */
const CHAT_TITLE_MAX_CHARS = 60;
/** Messages that the prompt history reads, at most. The pipeline compacts them. */
const CHAT_HISTORY_MAX_MESSAGES = 20;

const blocksSchema = z.array(chatBlockSchema);
const citesSchema = z.array(chatCiteSchema);

interface ThreadRow {
  id: string;
  meeting_id: string | null;
  folder_id: string | null;
  title: string | null;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: number;
  thread_id: string;
  role: string;
  content: string;
  blocks_json: string | null;
  cites_json: string | null;
  trace_json: string | null;
  model_id: string | null;
  provider: string | null;
  ms: number | null;
  created_at: number;
}

function toThread(r: ThreadRow): ChatThread {
  return {
    id: r.id,
    meeting_id: r.meeting_id,
    folder_id: r.folder_id,
    title: r.title,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/** True when the meeting or the folder of the scope exists. */
function scopeExists(db: DatabaseSync, scope: ChatScope): boolean {
  const table = scope.kind === "meeting" ? "meetings" : "meeting_folders";
  return (
    db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(scope.id) !==
    undefined
  );
}

/** A new empty thread, or null when the meeting or folder does not exist. */
export function createThread(
  db: DatabaseSync,
  scope: ChatScope,
  now = Date.now(),
): ChatThread | null {
  if (!scopeExists(db, scope)) return null;
  const id = randomUUID();
  db.prepare(
    `INSERT INTO chat_threads (id, meeting_id, folder_id, title, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?)`,
  ).run(
    id,
    scope.kind === "meeting" ? scope.id : null,
    scope.kind === "folder" ? scope.id : null,
    now,
    now,
  );
  return getThread(db, id);
}

/** The threads of one meeting or folder, newest activity first. */
export function listThreads(db: DatabaseSync, scope: ChatScope): ChatThread[] {
  const column = scope.kind === "meeting" ? "meeting_id" : "folder_id";
  const rows = db
    .prepare(
      `SELECT id, meeting_id, folder_id, title, created_at, updated_at
         FROM chat_threads WHERE ${column} = ?
        ORDER BY updated_at DESC, created_at DESC, id DESC`,
    )
    .all(scope.id) as unknown as ThreadRow[];
  return rows.map(toThread);
}

export function getThread(db: DatabaseSync, id: string): ChatThread | null {
  const row = db
    .prepare(
      `SELECT id, meeting_id, folder_id, title, created_at, updated_at
         FROM chat_threads WHERE id = ?`,
    )
    .get(id) as ThreadRow | undefined;
  return row ? toThread(row) : null;
}

/** The scope of a thread. */
export function threadScope(thread: ChatThread): ChatScope | null {
  if (thread.meeting_id) return { kind: "meeting", id: thread.meeting_id };
  if (thread.folder_id) return { kind: "folder", id: thread.folder_id };
  return null;
}

export interface NewChatMessage {
  role: "user" | "assistant";
  content: string;
  blocks?: ChatBlock[];
  cites?: ChatCite[];
  trace?: ChatTrace | null;
  runId?: string | null;
  modelId?: string | null;
  provider?: string | null;
  ms?: number | null;
}

/** One line of at most `CHAT_TITLE_MAX_CHARS` characters. */
function titleOf(question: string): string {
  const line = question.replace(/\s+/g, " ").trim();
  return line.length <= CHAT_TITLE_MAX_CHARS
    ? line
    : `${line.slice(0, CHAT_TITLE_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * Save one message. It also sets `updated_at` of the thread, and the title of
 * the thread from the first question. Returns the stored message.
 */
export function appendMessage(
  db: DatabaseSync,
  threadId: string,
  msg: NewChatMessage,
  now = Date.now(),
): ChatMessage {
  // Check the JSON columns before the insert: a message that the reader would
  // skip is never written.
  const blocks = blocksSchema.parse(msg.blocks ?? []);
  const cites = citesSchema.parse(msg.cites ?? []);
  const trace = msg.trace ? chatTraceSchema.parse(msg.trace) : null;
  const result = db
    .prepare(
      `INSERT INTO chat_messages
         (thread_id, role, content, blocks_json, cites_json, trace_json,
          run_id, model_id, provider, ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      threadId,
      msg.role,
      msg.content,
      JSON.stringify(blocks),
      JSON.stringify(cites),
      trace ? JSON.stringify(trace) : null,
      msg.runId ?? null,
      msg.modelId ?? null,
      msg.provider ?? null,
      msg.ms ?? null,
      now,
    );
  db.prepare("UPDATE chat_threads SET updated_at = ? WHERE id = ?").run(
    now,
    threadId,
  );
  if (msg.role === "user") {
    db.prepare(
      "UPDATE chat_threads SET title = ? WHERE id = ? AND title IS NULL",
    ).run(titleOf(msg.content), threadId);
  }
  const stored = readMessage(
    db
      .prepare("SELECT * FROM chat_messages WHERE id = ?")
      .get(Number(result.lastInsertRowid)) as unknown as MessageRow,
  );
  if (!stored) throw new Error("The chat message was not saved");
  return stored;
}

function parseJsonColumn<T>(
  text: string | null,
  schema: z.ZodType<T>,
): T | null {
  if (text === null) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** A row as a message, or null when a column does not parse (a bad row). */
function readMessage(r: MessageRow): ChatMessage | null {
  if (r.role !== "user" && r.role !== "assistant") return null;
  const blocks =
    r.blocks_json === null ? [] : parseJsonColumn(r.blocks_json, blocksSchema);
  const cites =
    r.cites_json === null ? [] : parseJsonColumn(r.cites_json, citesSchema);
  if (blocks === null || cites === null) return null;
  let trace: ChatTrace | null = null;
  if (r.trace_json !== null) {
    trace = parseJsonColumn(r.trace_json, chatTraceSchema);
    if (trace === null) return null;
  }
  return {
    id: r.id,
    thread_id: r.thread_id,
    role: r.role,
    content: r.content,
    blocks,
    cites,
    trace,
    model_id: r.model_id,
    provider: r.provider,
    ms: r.ms,
    created_at: r.created_at,
  };
}

/** All messages of a thread, oldest first. A bad row is skipped. */
export function listMessages(
  db: DatabaseSync,
  threadId: string,
): ChatMessage[] {
  const rows = db
    .prepare("SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY id")
    .all(threadId) as unknown as MessageRow[];
  const out: ChatMessage[] = [];
  for (const row of rows) {
    const m = readMessage(row);
    if (m) out.push(m);
  }
  return out;
}

/**
 * The stored messages before `beforeId` (the question that is being asked
 * now), oldest first, at most `CHAT_HISTORY_MAX_MESSAGES`. An assistant
 * message always follows its question in a thread; a lone user message
 * (a turn that failed) stays in, and the pipeline reads it as an open turn.
 */
export function loadHistoryForPrompt(
  db: DatabaseSync,
  threadId: string,
  beforeId: number,
): ChatMessage[] {
  return listMessages(db, threadId)
    .filter((m) => m.id < beforeId)
    .slice(-CHAT_HISTORY_MAX_MESSAGES);
}
