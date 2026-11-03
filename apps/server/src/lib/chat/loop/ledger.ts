// The item ledger of the Ask tool loop (specs/meeting-chat-agent.md 11.10.3.1,
// D22). Two tables hold the items and their marks (see `schema.ts`, version
// 56). A writer pass reads one meeting at a time, oldest first. The writer is
// the model that the user selected (owner decision N10), and the ledger is
// only on for a cloud model (`loopProfile`). Code owns the dates, the ids and
// the quote: the writer names a transcript line, and code copies the line.
// Marks are append only.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createAppLogger, errorMessage } from "@openstyle/utils";
import { z } from "zod";
import { getDb } from "../../db.js";
import { isLocalProvider } from "../../llm/registry.js";
import { resolveTaskModel } from "../../llm/task-profiles.js";
import { actionItemKey, parseSummary } from "../../meetings/folder-overview.js";
import { normalizeText } from "../cites.js";
import { type ChatLlm, createChatLlm } from "../llm.js";
import { readChatSettings } from "../settings.js";
import { speakerResolver } from "../tools.js";
import { loopProfile } from "./profile.js";

const log = createAppLogger("chat-ledger");

export const ITEM_KINDS = ["action", "decision", "question"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
const STATUSES = ["raised", "open", "done", "dropped", "changed"] as const;
export type MarkStatus = (typeof STATUSES)[number];

const QUOTE_MAX = 240;

const WRITER_SCHEMA = {
  name: "ledger_writer",
  version: 2,
  zod: z.object({
    items: z
      .array(
        z.object({
          id: z.string().max(12),
          kind: z.enum(ITEM_KINDS),
          text: z.string().max(240),
          status: z.enum(STATUSES),
          owner: z.string().max(60).nullable(),
          reason: z.string().max(240).nullable(),
          blocked_by: z.string().max(120).nullable(),
          line: z.number().int().nullable(),
        }),
      )
      .max(24),
  }),
};

const WRITER_SYSTEM = `You keep a ledger of the action items, decisions and open questions of one project, meeting by meeting.
Read the MEETING (its summary and its numbered transcript lines). List every action item, decision and open question that this meeting talks about.
For each item give:
- "id": the id of the same item from the OPEN ITEMS list when this meeting talks about that item. Else "new".
- "kind": "action", "decision" or "question".
- "text": a short wording of the item.
- "status": "raised" (first time), "open" (still open), "done", "dropped" or "changed" (the plan or the decision changed). An action marked "(done by the user)" in the summary is "done".
- "owner": the person who owns it, or null.
- "reason": why the item is open or why it changed, or null.
- "blocked_by": who or what holds it, or null.
- "line": the number of the transcript line that shows the item, or null.
Use the same item id when a later meeting talks about the same thing. Do not make a new item for the same thing.
List only what the meeting says. Never use knowledge from outside the meeting.`;

interface MeetingRow {
  id: string;
  title: string | null;
  at: number;
  folder_id: string | null;
  summary_json: string | null;
}

interface SegRow {
  start_ms: number | null;
  speaker_label: string | null;
  source: string;
  t: string | null;
}

export interface LedgerStats {
  meetings: number;
  items: number;
  marks: number;
  quoteOk: number;
  failed: number;
  ms: number;
}

const DATE = "COALESCE(m.started_at, m.created_at)";

/** Open items of the folder before `before`, for the writer to link to. */
function openItemsOf(
  db: DatabaseSync,
  folder: string | null,
  before: number,
): { id: string; kind: string; text: string; status: string }[] {
  const rows = db
    .prepare(
      `SELECT i.id, i.kind, i.text,
              (SELECT status FROM ledger_marks k WHERE k.item_id = i.id AND k.meeting_date < ?
                ORDER BY k.meeting_date DESC, k.written_at DESC LIMIT 1) AS status
         FROM ledger_items i
        WHERE COALESCE(i.folder_id, '') = COALESCE(?, '')
        ORDER BY i.created_at, i.id`,
    )
    .all(before, folder) as {
    id: string;
    kind: string;
    text: string;
    status: string | null;
  }[];
  return rows
    .filter(
      (r) => r.status !== null && r.status !== "done" && r.status !== "dropped",
    )
    .map((r) => ({ ...r, status: r.status as string }));
}

/** The meetings with a summary that the writer has not read, oldest first. */
export function pendingLedgerMeetings(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        `SELECT m.id FROM meetings m
           JOIN meeting_summaries s ON s.meeting_id = m.id
          WHERE NOT EXISTS (SELECT 1 FROM ledger_meetings l WHERE l.meeting_id = m.id)
          ORDER BY ${DATE}, m.id`,
      )
      .all() as { id: string }[]
  ).map((r) => r.id);
}

/**
 * The writer pass for one meeting. One model call. Throws when the call fails;
 * the meeting stays unread, so the backfill tries it again later.
 */
export async function writeLedgerForMeeting(
  db: DatabaseSync,
  llm: ChatLlm,
  meetingId: string,
  stats?: LedgerStats,
): Promise<void> {
  const m = db
    .prepare(
      `SELECT m.id, m.title, ${DATE} AS at, m.folder_id, s.summary_json
         FROM meetings m LEFT JOIN meeting_summaries s ON s.meeting_id = m.id
        WHERE m.id = ?`,
    )
    .get(meetingId) as unknown as MeetingRow | undefined;
  if (!m) return;
  const segs = db
    .prepare(
      `SELECT start_ms, speaker_label, source, COALESCE(NULLIF(enhanced_text, ''), text) AS t
         FROM meeting_segments WHERE meeting_id = ? AND status = 'ok'
        ORDER BY start_ms, idx, id`,
    )
    .all(m.id) as unknown as SegRow[];
  const nameOf = speakerResolver(db, m.id);
  const lines = segs.flatMap((s) => {
    const t = s.t?.replace(/\s+/g, " ").trim();
    if (!t) return [];
    const who = s.speaker_label
      ? nameOf(s.speaker_label)
      : s.source === "mic"
        ? "Me"
        : "Them";
    return [{ startMs: s.start_ms ?? 0, text: t, who }];
  });
  const summary = parseSummary(m.summary_json);
  const doneKeys = new Set(
    (
      db
        .prepare(
          m.folder_id
            ? "SELECT item_key FROM folder_action_item_state WHERE done = 1 AND folder_id = ?"
            : "SELECT item_key FROM folder_action_item_state WHERE done = 1 AND folder_id IS NULL",
        )
        .all(...(m.folder_id ? [m.folder_id] : [])) as { item_key: string }[]
    ).map((r) => r.item_key),
  );
  const summaryText = summary
    ? [
        `Overview: ${summary.overview}`,
        summary.keyPoints.length
          ? `Key points: ${summary.keyPoints.join("; ")}`
          : "",
        summary.decisions.length
          ? `Decisions: ${summary.decisions.join("; ")}`
          : "",
        summary.actionItems.length
          ? `Action items: ${summary.actionItems
              .map(
                (a) =>
                  `${a.task}${a.owner ? ` (${a.owner})` : ""}${doneKeys.has(actionItemKey(m.id, a.task)) ? " (done by the user)" : ""}`,
              )
              .join("; ")}`
          : "",
        summary.openQuestions.length
          ? `Open questions: ${summary.openQuestions.join("; ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "(no summary)";
  const open = openItemsOf(db, m.folder_id, m.at);
  const openText =
    open.length === 0
      ? "(none)"
      : open
          .map((o, i) => `L${i + 1} [${o.kind}] ${o.text} (now ${o.status})`)
          .join("\n");
  const user = `OPEN ITEMS of this project:\n${openText}\n\nMEETING "${m.title ?? "Untitled"}" (${new Date(m.at).toISOString().slice(0, 10)})\nSUMMARY:\n${summaryText}\n\nTRANSCRIPT:\n${lines.map((l, i) => `${i + 1}. ${l.who}: ${l.text}`).join("\n")}`;
  const r = await llm.structured({
    step: "chatDig",
    unitKey: `ledger/${m.id}`,
    schema: WRITER_SCHEMA,
    system: WRITER_SYSTEM,
    messages: [{ role: "user", content: user }],
    maxOutputTokens: 2500,
  });
  const now = Date.now();
  let marks = 0;
  const write = db.prepare(
    `INSERT INTO ledger_marks (id, item_id, meeting_id, meeting_date, status, owner, reason, blocked_by,
       quote, quote_start_ms, quote_ok, writer_model, written_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.exec("BEGIN");
  try {
    for (const it of r.object.items) {
      // The id is a label of the OPEN ITEMS list of this folder, else a new item.
      const n = /^L(\d+)$/.exec(it.id.trim());
      let itemId = n ? open[Number(n[1]) - 1]?.id : undefined;
      if (!itemId) {
        itemId = randomUUID();
        db.prepare(
          "INSERT INTO ledger_items (id, folder_id, kind, text, first_meeting_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(itemId, m.folder_id, it.kind, it.text, m.id, m.at);
        if (stats) stats.items++;
      }
      // Code copies the quote from the line that the writer names.
      const line = it.line !== null ? lines[it.line - 1] : undefined;
      const quote = line ? line.text.slice(0, QUOTE_MAX) : "";
      const ok = line !== undefined && normalizeText(quote).length >= 8;
      write.run(
        randomUUID(),
        itemId,
        m.id,
        m.at,
        it.status,
        it.owner,
        it.reason,
        it.blocked_by,
        quote,
        ok ? (line?.startMs ?? null) : null,
        ok ? 1 : 0,
        llm.modelId,
        now,
      );
      marks++;
      if (stats) {
        stats.marks++;
        if (ok) stats.quoteOk++;
      }
    }
    db.prepare(
      "INSERT OR REPLACE INTO ledger_meetings (meeting_id, writer_model, marks, written_at) VALUES (?, ?, ?, ?)",
    ).run(m.id, llm.modelId, marks, now);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * The backfill: the writer pass for every meeting that no pass has read,
 * oldest first. It stops at the first failure and the next call resumes. The
 * eval calls it before the questions and awaits it.
 */
export async function backfillLedger(
  db: DatabaseSync,
  makeLlm: (threadId: string) => Promise<ChatLlm>,
  opts: {
    log?: (s: string) => void;
    isStopped?: () => boolean;
    /** Called after each meeting, with the LLM of that pass. */
    onPass?: (llm: ChatLlm) => void;
  } = {},
): Promise<LedgerStats> {
  const started = Date.now();
  const ids = pendingLedgerMeetings(db);
  const st: LedgerStats = {
    meetings: ids.length,
    items: 0,
    marks: 0,
    quoteOk: 0,
    failed: 0,
    ms: 0,
  };
  for (const id of ids) {
    if (opts.isStopped?.()) break;
    const llm = await makeLlm(`ledger-${id}`);
    try {
      await writeLedgerForMeeting(db, llm, id, st);
      llm.finish("succeeded");
    } catch (e) {
      st.failed++;
      llm.finish("failed", {
        errorKind: (e as { kind?: string }).kind,
        errorDetail: errorMessage(e),
      });
      opts.log?.(`ledger ${id}: failed (${errorMessage(e).slice(0, 80)})`);
      opts.onPass?.(llm);
      break;
    }
    opts.onPass?.(llm);
  }
  st.ms = Date.now() - started;
  return st;
}

let running: Promise<void> | null = null;

/**
 * Starts the backfill in the background when the Ask engine is the loop and
 * the selected chat model is a cloud model. One run at a time. It never
 * throws, so a caller (a saved summary, a turn) can fire and forget.
 */
export function kickLedgerBackfill(): void {
  if (running) return;
  running = (async () => {
    try {
      const s = readChatSettings();
      if (!s.enabled || s.engine !== "loop") return;
      const db = getDb();
      if (pendingLedgerMeetings(db).length === 0) return;
      const target = await resolveTaskModel("meetingChat");
      const profile = loopProfile({
        modelId: target.modelId,
        isLocal: isLocalProvider(target.provider),
      });
      if (!profile.ledger) return;
      const st = await backfillLedger(
        db,
        (threadId) =>
          createChatLlm(db, {
            threadId,
            signal: AbortSignal.timeout(600_000),
          }),
        { log: (m) => log.warn(m) },
      );
      log.info(
        `ledger backfill: ${st.meetings} meetings, ${st.marks} marks, ${st.failed} failed`,
      );
    } catch (e) {
      log.warn(`ledger backfill stopped: ${errorMessage(e)}`);
    }
  })().finally(() => {
    running = null;
  });
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export interface ListQuery {
  status: "open" | "done" | "all";
  kind: ItemKind | null;
  owner: string | null;
  meetingIds: string[] | null;
  dateFrom: number | null;
  limit: number;
}

export interface LedgerMarkView {
  meetingId: string;
  date: number;
  status: MarkStatus;
  owner: string | null;
  reason: string | null;
  blockedBy: string | null;
  quote: string;
  quoteOk: boolean;
}

export interface LedgerItemView {
  id: string;
  kind: ItemKind;
  text: string;
  nowStatus: MarkStatus;
  firstDate: number;
  firstMeetingId: string;
  /** In date order. */
  marks: LedgerMarkView[];
}

/** True when the ledger holds a pass for at least one meeting of the scope. */
export function ledgerCovers(
  db: DatabaseSync,
  allowed: readonly string[],
): boolean {
  if (allowed.length === 0) return false;
  const stmt = db.prepare(
    "SELECT 1 FROM ledger_meetings WHERE meeting_id = ? LIMIT 1",
  );
  return allowed.some((id) => stmt.get(id) !== undefined);
}

/** Items of the ledger inside `allowed` meetings (the scope), the newest mark first. */
export function readLedger(
  db: DatabaseSync,
  allowed: readonly string[],
  q: ListQuery,
): { total: number; items: LedgerItemView[] } {
  const ok = new Set(allowed);
  const wantMeetings = q.meetingIds ? new Set(q.meetingIds) : null;
  const items = db
    .prepare(
      "SELECT id, kind, text, first_meeting_id, created_at FROM ledger_items ORDER BY created_at, id",
    )
    .all() as {
    id: string;
    kind: ItemKind;
    text: string;
    first_meeting_id: string;
    created_at: number;
  }[];
  const markStmt = db.prepare(
    "SELECT meeting_id, meeting_date, status, owner, reason, blocked_by, quote, quote_ok FROM ledger_marks WHERE item_id = ? ORDER BY meeting_date, written_at, id",
  );
  const want = q.owner ? normalizeText(q.owner) : null;
  const out: LedgerItemView[] = [];
  for (const it of items) {
    if (q.kind && it.kind !== q.kind) continue;
    const marks = (
      markStmt.all(it.id) as {
        meeting_id: string;
        meeting_date: number;
        status: MarkStatus;
        owner: string | null;
        reason: string | null;
        blocked_by: string | null;
        quote: string;
        quote_ok: number;
      }[]
    )
      .filter((k) => ok.has(k.meeting_id))
      .map((k) => ({
        meetingId: k.meeting_id,
        date: k.meeting_date,
        status: k.status,
        owner: k.owner,
        reason: k.reason,
        blockedBy: k.blocked_by,
        quote: k.quote,
        quoteOk: k.quote_ok === 1,
      }));
    const first = marks[0];
    const last = marks[marks.length - 1];
    if (!first || !last) continue;
    if (wantMeetings && !marks.some((k) => wantMeetings.has(k.meetingId)))
      continue;
    const from = q.dateFrom;
    if (from !== null && !marks.some((k) => k.date >= from)) continue;
    if (
      want &&
      !marks.some((k) => k.owner && normalizeText(k.owner).includes(want))
    )
      continue;
    const closed = last.status === "done" || last.status === "dropped";
    if (q.status === "open" && closed) continue;
    if (q.status === "done" && !closed) continue;
    out.push({
      id: it.id,
      kind: it.kind,
      text: it.text,
      nowStatus: last.status,
      firstDate: first.date,
      firstMeetingId: first.meetingId,
      marks,
    });
  }
  out.sort(
    (a, b) =>
      (b.marks.at(-1)?.date ?? 0) - (a.marks.at(-1)?.date ?? 0) ||
      a.id.localeCompare(b.id),
  );
  return { total: out.length, items: out.slice(0, q.limit) };
}
