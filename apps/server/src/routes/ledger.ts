// The open items of the folders: the item ledger of the Ask tool loop
// (specs/meeting-chat-agent.md 11.10.3.1, D22). Mounted at `/api/ledger`. An
// agent reads and keeps the ledger through MCP (specs/mcp.md 4.2). Marks are
// append only: a change of state is a new mark.
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  createLedgerItem,
  deleteLedgerItem,
  ITEM_KINDS,
  insertLedgerMark,
  ledgerItemFolder,
  ledgerMeeting,
  readLedger,
  updateLedgerItem,
} from "../lib/chat/loop/ledger.js";
import { getDb } from "../lib/db.js";

const QUOTE_MAX = 240;

const listQuerySchema = z.object({
  /** A folder id, or "none" for the meetings with no folder. */
  folder_id: z.string().min(1).optional(),
  kind: z.enum(ITEM_KINDS).optional(),
  status: z.enum(["open", "done", "all"]).default("open"),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  /** The number of items to skip (newest mark first). The default is 0. */
  offset: z.coerce.number().int().min(0).default(0),
});

const writer = z.string().trim().min(1).max(200);
const quote = z.string().trim().min(1).max(QUOTE_MAX);
const owner = z.string().trim().min(1).max(200).nullable().optional();

const createSchema = z.object({
  meeting_id: z.string().min(1),
  kind: z.enum(ITEM_KINDS),
  text: z.string().trim().min(1).max(1000),
  quote,
  owner,
  agent: writer,
});

const updateSchema = z
  .object({
    text: z.string().trim().min(1).max(1000).optional(),
    kind: z.enum(ITEM_KINDS).optional(),
  })
  .refine((v) => v.text !== undefined || v.kind !== undefined, {
    message: "Provide text or kind",
  });

const markSchema = z.object({
  meeting_id: z.string().min(1),
  status: z.enum(["open", "done", "dropped", "changed"]),
  quote,
  owner,
  reason: z.string().trim().min(1).max(500).nullable().optional(),
  agent: writer,
});

/** The meeting ids of a folder ("none": no folder), or of all meetings. */
function meetingsOf(folderId: string | undefined): string[] {
  const db = getDb();
  const rows =
    folderId === undefined
      ? db.prepare("SELECT id FROM meetings").all()
      : folderId === "none"
        ? db.prepare("SELECT id FROM meetings WHERE folder_id IS NULL").all()
        : db
            .prepare("SELECT id FROM meetings WHERE folder_id = ?")
            .all(folderId);
  return (rows as { id: string }[]).map((r) => r.id);
}

const ledger = new Hono()
  .get("/items", zValidator("query", listQuerySchema), (c) => {
    const q = c.req.valid("query");
    const { total, items } = readLedger(getDb(), meetingsOf(q.folder_id), {
      status: q.status,
      kind: q.kind ?? null,
      owner: null,
      meetingIds: null,
      dateFrom: null,
      limit: q.offset + q.limit,
    });
    return c.json({
      total,
      offset: q.offset,
      limit: q.limit,
      items: items.slice(q.offset),
    });
  })
  .post("/items", zValidator("json", createSchema), (c) => {
    const body = c.req.valid("json");
    const db = getDb();
    const meeting = ledgerMeeting(db, body.meeting_id);
    if (!meeting) return c.json({ error: "Meeting not found" }, 404);
    const created = createLedgerItem(db, meeting, {
      kind: body.kind,
      text: body.text,
      quote: body.quote,
      owner: body.owner ?? null,
      writer: `agent:${body.agent}`,
    });
    return c.json({
      id: created.id,
      mark_id: created.markId,
      folder_id: meeting.folderId,
      quote_ok: created.quoteOk,
    });
  })
  .patch("/items/:id", zValidator("json", updateSchema), (c) => {
    const id = c.req.param("id");
    if (!updateLedgerItem(getDb(), id, c.req.valid("json"))) {
      return c.json({ error: "Item not found" }, 404);
    }
    return c.json({ ok: true });
  })
  .post("/items/:id/marks", zValidator("json", markSchema), (c) => {
    const id = c.req.param("id");
    const body = c.req.valid("json");
    const db = getDb();
    const folder = ledgerItemFolder(db, id);
    if (folder === undefined) return c.json({ error: "Item not found" }, 404);
    const meeting = ledgerMeeting(db, body.meeting_id);
    if (!meeting) return c.json({ error: "Meeting not found" }, 404);
    // The list of a folder reads only the marks of its meetings.
    if (meeting.folderId !== folder) {
      return c.json(
        { error: "The meeting is not in the folder of this item" },
        400,
      );
    }
    const mark = insertLedgerMark(db, id, {
      meetingId: meeting.id,
      meetingDate: meeting.at,
      status: body.status,
      quote: body.quote,
      owner: body.owner ?? null,
      reason: body.reason ?? null,
      writer: `agent:${body.agent}`,
    });
    return c.json({ id: mark.id, quote_ok: mark.quoteOk });
  })
  .delete("/items/:id", (c) => {
    if (!deleteLedgerItem(getDb(), c.req.param("id"))) {
      return c.json({ error: "Item not found" }, 404);
    }
    return c.json({ ok: true });
  });

export default ledger;
