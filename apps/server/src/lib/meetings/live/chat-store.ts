/**
 * Saved chat of a meeting (issue #375). The live chat writes each question and
 * answer here, so the chat survives a page change and the user can read it
 * after Stop. The table is `meeting_chat_messages` (schema 52); the rows go
 * away with the meeting.
 */
import type { DatabaseSync } from "node:sqlite";
import { withTransaction } from "../../db.js";

export interface ChatCite {
  label: string;
  kind: "live" | "past" | "folder";
  meetingId?: string;
  title?: string | null;
  timeMs?: number | null;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  cites: ChatCite[];
  ms: number | null;
  createdAt: number;
}

interface Row {
  id: number;
  role: "user" | "assistant";
  content: string;
  cites_json: string | null;
  ms: number | null;
  created_at: number;
}

function parseCites(json: string | null): ChatCite[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as ChatCite[]) : [];
  } catch {
    return [];
  }
}

/** All messages of a meeting, oldest first. */
export function listChatMessages(
  db: DatabaseSync,
  meetingId: string,
): ChatMessage[] {
  const rows = db
    .prepare(
      `SELECT id, role, content, cites_json, ms, created_at
         FROM meeting_chat_messages WHERE meeting_id = ? ORDER BY id`,
    )
    .all(meetingId) as unknown as Row[];
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    content: r.content,
    cites: parseCites(r.cites_json),
    ms: r.ms,
    createdAt: r.created_at,
  }));
}

/** The last `count` messages as model history, oldest first. */
export function recentChatHistory(
  db: DatabaseSync,
  meetingId: string,
  count: number,
): { role: "user" | "assistant"; content: string }[] {
  const rows = db
    .prepare(
      `SELECT role, content FROM meeting_chat_messages
        WHERE meeting_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(meetingId, count) as unknown as {
    role: "user" | "assistant";
    content: string;
  }[];
  return rows.reverse();
}

/** Save one answered question. Both rows or none. */
export function appendChatPair(
  db: DatabaseSync,
  meetingId: string,
  pair: { question: string; answer: string; cites: ChatCite[]; ms: number },
): void {
  const insert = db.prepare(
    `INSERT INTO meeting_chat_messages
       (meeting_id, role, content, cites_json, ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const now = Date.now();
  withTransaction(db, () => {
    insert.run(meetingId, "user", pair.question, null, null, now);
    insert.run(
      meetingId,
      "assistant",
      pair.answer,
      JSON.stringify(pair.cites),
      pair.ms,
      now + 1,
    );
  });
}
