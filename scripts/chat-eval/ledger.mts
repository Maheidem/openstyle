/**
 * The item ledger of the D22 spike (spec 11.10.3.1), phase 2. Eval only.
 *
 * Two tables in the scratch DB: `ledger_items` and `ledger_marks`. A writer
 * pass reads one meeting at a time (oldest first). The writer is the SAME
 * model as the one under test (owner decision N10). Code owns the dates, the
 * ids and the quote check (the quote must be in the transcript).
 */

import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { normalizeText } from "../../apps/server/src/lib/chat/cites.ts";
import type { ChatLlm } from "../../apps/server/src/lib/chat/llm.ts";
import { speakerResolver } from "../../apps/server/src/lib/chat/tools.ts";
import { parseSummary } from "../../apps/server/src/lib/meetings/folder-overview.ts";
import { usageOfRun } from "./cost.mts";

// zod comes from the server package, as in dig-oracle.mts.
const ZOD_PACKAGE = "zod";
const { z } = createRequire(
  new URL("../../apps/server/package.json", import.meta.url),
)(ZOD_PACKAGE) as { z: any };

export const KINDS = ["action", "decision", "question"] as const;
export type ItemKind = (typeof KINDS)[number];
const STATUSES = ["raised", "open", "done", "dropped", "changed"] as const;
export type MarkStatus = (typeof STATUSES)[number];

export const DDL = `
CREATE TABLE IF NOT EXISTS ledger_items (
  id TEXT PRIMARY KEY,
  folder_id TEXT,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  first_meeting_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger_marks (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  meeting_date INTEGER NOT NULL,
  status TEXT NOT NULL,
  owner TEXT,
  reason TEXT,
  blocked_by TEXT,
  quote TEXT NOT NULL,
  quote_start_ms INTEGER,
  quote_ok INTEGER NOT NULL,
  writer_model TEXT NOT NULL,
  written_at INTEGER NOT NULL
);`;

const WRITER_SCHEMA = {
  name: "ledger_writer",
  version: 1,
  zod: z.object({
    items: z
      .array(
        z.object({
          id: z.string().max(12),
          kind: z.enum(KINDS),
          text: z.string().max(240),
          status: z.enum(STATUSES),
          owner: z.string().max(60).nullable(),
          reason: z.string().max(240).nullable(),
          blocked_by: z.string().max(120).nullable(),
          quote: z.string().max(240),
        }),
      )
      .max(24),
  }),
};

const WRITER_SYSTEM = `You keep a ledger of the action items, decisions and open questions of one project, meeting by meeting.
Read the MEETING (its summary and its transcript). List every action item, decision and open question that this meeting talks about.
For each item give:
- "id": the id of the same item from the OPEN ITEMS list when this meeting talks about that item. Else "new".
- "kind": "action", "decision" or "question".
- "text": a short wording of the item.
- "status": "raised" (first time), "open" (still open), "done", "dropped" or "changed" (the plan or the decision changed).
- "owner": the person who owns it, or null.
- "reason": why the item is open or why it changed, or null.
- "blocked_by": who or what holds it, or null.
- "quote": words copied EXACTLY from the transcript lines (without the speaker name) that show the item. Maximum 200 characters.
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
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  tokensCacheWrite: number;
  tokensReasoning: number;
}

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

/**
 * The writer pass for every meeting of the DB, oldest first. One LLM run for
 * each meeting. The tokens come from `llm_calls` of those runs.
 */
export async function buildLedger(
  db: DatabaseSync,
  makeLlm: (threadId: string) => Promise<ChatLlm>,
  log: (s: string) => void,
): Promise<LedgerStats> {
  db.exec(DDL);
  const started = Date.now();
  const meetings = db
    .prepare(
      `SELECT m.id, m.title, COALESCE(m.started_at, m.created_at) AS at, m.folder_id, s.summary_json
         FROM meetings m LEFT JOIN meeting_summaries s ON s.meeting_id = m.id
        ORDER BY COALESCE(m.started_at, m.created_at), m.id`,
    )
    .all() as unknown as MeetingRow[];
  const st: LedgerStats = {
    meetings: meetings.length,
    items: 0,
    marks: 0,
    quoteOk: 0,
    failed: 0,
    ms: 0,
    tokensIn: 0,
    tokensOut: 0,
    tokensCached: 0,
    tokensCacheWrite: 0,
    tokensReasoning: 0,
  };
  let seq = 0;
  for (const m of meetings) {
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
      return [{ startMs: s.start_ms ?? 0, text: t, line: `${who}: ${t}` }];
    });
    const summary = parseSummary(m.summary_json);
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
            ? `Action items: ${summary.actionItems.map((a) => `${a.task}${a.owner ? ` (${a.owner})` : ""}`).join("; ")}`
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
    const user = `OPEN ITEMS of this project:\n${openText}\n\nMEETING "${m.title ?? "Untitled"}" (${new Date(m.at).toISOString().slice(0, 10)})\nSUMMARY:\n${summaryText}\n\nTRANSCRIPT:\n${lines.map((l) => l.line).join("\n")}`;
    const llm = await makeLlm(`ledger-${m.id}`);
    try {
      const r = await llm.structured({
        step: "chatDig",
        unitKey: `ledger/${m.id}`,
        schema: WRITER_SCHEMA,
        system: WRITER_SYSTEM,
        messages: [{ role: "user", content: user }],
        maxOutputTokens: 2500,
      });
      llm.finish("succeeded");
      const hay = normalizeText(lines.map((l) => l.text).join(" "));
      const now = Date.now();
      for (const it of r.object.items as {
        id: string;
        kind: ItemKind;
        text: string;
        status: MarkStatus;
        owner: string | null;
        reason: string | null;
        blocked_by: string | null;
        quote: string;
      }[]) {
        // The id is a label of the OPEN ITEMS list of this folder, else a new item.
        const n = /^L(\d+)$/.exec(it.id.trim());
        const known = n ? open[Number(n[1]) - 1] : undefined;
        let itemId = known?.id;
        if (!itemId) {
          itemId = `li${++seq}`;
          db.prepare(
            "INSERT INTO ledger_items (id, folder_id, kind, text, first_meeting_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          ).run(itemId, m.folder_id, it.kind, it.text, m.id, m.at);
          st.items++;
        }
        const q = normalizeText(it.quote);
        const ok = q.length >= 8 && hay.includes(q);
        const seg = ok
          ? lines.find((l) => normalizeText(l.text).includes(q.slice(0, 40)))
          : undefined;
        db.prepare(
          `INSERT INTO ledger_marks (id, item_id, meeting_id, meeting_date, status, owner, reason, blocked_by,
             quote, quote_start_ms, quote_ok, writer_model, written_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          `lm${++seq}`,
          itemId,
          m.id,
          m.at,
          it.status,
          it.owner,
          it.reason,
          it.blocked_by,
          it.quote,
          seg?.startMs ?? null,
          ok ? 1 : 0,
          llm.modelId,
          now,
        );
        st.marks++;
        if (ok) st.quoteOk++;
      }
    } catch (e) {
      st.failed++;
      llm.finish("failed", { errorKind: (e as { kind?: string }).kind });
      log(
        `ledger ${m.id}: failed (${(e as { kind?: string }).kind ?? (e as Error).message.slice(0, 80)})`,
      );
    }
    const u = usageOfRun(db, llm.runId);
    st.tokensIn += u.in;
    st.tokensOut += u.out;
    st.tokensCached += u.cached;
    st.tokensCacheWrite += u.cacheWrite;
    st.tokensReasoning += u.reasoning;
  }
  st.ms = Date.now() - started;
  return st;
}

export interface ListQuery {
  status: "open" | "done" | "all";
  kind: ItemKind | null;
  owner: string | null;
  meetingIds: string[] | null;
  dateFrom: number | null;
  limit: number;
}

export interface LedgerItemView {
  id: string;
  kind: ItemKind;
  text: string;
  nowStatus: MarkStatus;
  firstDate: number;
  firstMeetingId: string;
  marks: {
    meetingId: string;
    date: number;
    status: MarkStatus;
    owner: string | null;
    reason: string | null;
    blockedBy: string | null;
    quote: string;
    quoteOk: boolean;
  }[];
}

/** Items of the ledger inside `allowed` meetings (the scope), oldest first. */
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
    if (marks.length === 0) continue;
    if (wantMeetings && !marks.some((k) => wantMeetings.has(k.meetingId)))
      continue;
    if (q.dateFrom !== null && !marks.some((k) => k.date >= q.dateFrom!))
      continue;
    if (
      want &&
      !marks.some((k) => k.owner && normalizeText(k.owner).includes(want))
    )
      continue;
    const last = marks[marks.length - 1]!;
    const closed = last.status === "done" || last.status === "dropped";
    if (q.status === "open" && closed) continue;
    if (q.status === "done" && !closed) continue;
    out.push({
      id: it.id,
      kind: it.kind,
      text: it.text,
      nowStatus: last.status,
      firstDate: marks[0]!.date,
      firstMeetingId: marks[0]!.meetingId,
      marks,
    });
  }
  return { total: out.length, items: out.slice(0, q.limit) };
}
