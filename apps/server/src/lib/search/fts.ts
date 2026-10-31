import type { DatabaseSync } from "node:sqlite";
import { withTransaction } from "../db.js";
import type { ChunkKind } from "./chunker.js";
import { buildMeetingChunks, loadMeetingSource } from "./source.js";

// The BM25 channel of the meeting search (specs/meeting-chat-agent.md 7.4.1).
// `meeting_chunks_fts` is a CONTENTLESS FTS5 table (schema v54): it holds the
// index only, the rowid is meeting_chunks.id, and a filter by meeting, folder
// or date is a join with meeting_chunks. If this SQLite has no FTS5, the table
// does not exist. Every function here then does nothing or returns an empty
// list, so the search stays dense only and never throws.

export interface FtsRow {
  /** meeting_chunks.id */
  id: number;
  text: string;
  /** The meeting title. */
  title: string;
}

export interface FtsSearchInput {
  text: string;
  /** Only chunks of these meetings. An empty list matches nothing. */
  allowMeetingIds?: readonly string[];
  excludeMeetingIds?: readonly string[];
  /** COALESCE(meetings.folder_id, ''): a folder id, or "" for unfiled. */
  folderKey?: string;
  /** Only chunks of this embedding model. */
  modelId?: string;
  k: number;
}

export interface FtsHit {
  chunkId: number;
  meetingId: string;
  ordinal: number;
  kind: ChunkKind;
  startMs: number | null;
  endMs: number | null;
}

/** The longest FTS query, in terms. A longer question keeps its first terms. */
const MAX_TERMS = 32;

// Words that carry no search value, English and Portuguese. Ported from the
// P0 prototype (scripts/chat-eval/retrieval.mts).
const STOP_WORDS = new Set(
  (
    "a an and are as at be by did do does for from had has have how i in is it of on or our that the their there they this to was we were what when where which who whom why will with you your " +
    "a o os as um uma uns umas de do da dos das em no na nos nas por para com sem que qual quais quando onde quem como foi sao e ou se ao aos ha tem temos tinha ele ela eles elas nos eu voce"
  ).split(" "),
);

function foldWord(word: string): string {
  return word
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

/**
 * The FTS5 query of a text: stop words out, each term quoted, joined by OR.
 * The text is split at every character that is not a letter or a digit, so no
 * FTS5 syntax (quotes, colons, parentheses, asterisks, AND, NEAR) reaches the
 * parser. Returns "" when no term is left.
 */
export function ftsQuery(text: string): string {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of text.split(/[^\p{L}\p{N}]+/u)) {
    const word = raw.toLowerCase();
    if (word.length < 2 || STOP_WORDS.has(foldWord(word)) || seen.has(word)) {
      continue;
    }
    seen.add(word);
    terms.push(`"${word}"`);
    if (terms.length >= MAX_TERMS) break;
  }
  return terms.join(" OR ");
}

/** True when this SQLite has the FTS table. Checked on each call. */
export function ftsAvailable(db: DatabaseSync): boolean {
  try {
    return (
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meeting_chunks_fts'",
        )
        .get() !== undefined
    );
  } catch {
    return false;
  }
}

/** Delete the index rows of these chunks. A missing rowid is not an error. */
export function ftsDeleteChunks(
  db: DatabaseSync,
  ids: readonly number[],
): void {
  if (ids.length === 0 || !ftsAvailable(db)) return;
  const del = db.prepare("DELETE FROM meeting_chunks_fts WHERE rowid = ?");
  for (const id of ids) del.run(id);
}

/**
 * Write the index rows of these chunks: delete the old row of the same id,
 * then insert. Run it in the caller's transaction, with the chunk rows.
 */
export function ftsUpsertChunks(
  db: DatabaseSync,
  rows: readonly FtsRow[],
): void {
  if (rows.length === 0 || !ftsAvailable(db)) return;
  const del = db.prepare("DELETE FROM meeting_chunks_fts WHERE rowid = ?");
  const ins = db.prepare(
    "INSERT INTO meeting_chunks_fts (rowid, text, title) VALUES (?, ?, ?)",
  );
  for (const r of rows) {
    del.run(r.id);
    ins.run(r.id, r.text, r.title);
  }
}

/**
 * Delete the index rows of the chunks that wait in meeting_chunk_gc (6.6).
 * A meeting delete (cascade) and a model delete put their chunk ids there.
 * Run it before the vector gc drain, in the same transaction.
 */
export function ftsDrainGc(db: DatabaseSync): number {
  if (!ftsAvailable(db)) return 0;
  const ids = (
    db.prepare("SELECT chunk_id FROM meeting_chunk_gc").all() as {
      chunk_id: number;
    }[]
  ).map((r) => r.chunk_id);
  ftsDeleteChunks(db, ids);
  return ids.length;
}

/**
 * BM25 search. Returns the chunks in BM25 order (best first), at most `k`.
 * The scope filters are joins with meeting_chunks and meetings.
 */
export function ftsSearch(db: DatabaseSync, input: FtsSearchInput): FtsHit[] {
  const query = ftsQuery(input.text);
  if (!query || !ftsAvailable(db)) return [];
  if (input.allowMeetingIds && input.allowMeetingIds.length === 0) return [];
  const where: string[] = ["meeting_chunks_fts MATCH ?"];
  const params: (string | number)[] = [query];
  if (input.modelId !== undefined) {
    where.push("c.model_id = ?");
    params.push(input.modelId);
  }
  if (input.allowMeetingIds) {
    where.push("c.meeting_id IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify(input.allowMeetingIds));
  }
  if (input.excludeMeetingIds && input.excludeMeetingIds.length > 0) {
    where.push("c.meeting_id NOT IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify(input.excludeMeetingIds));
  }
  if (input.folderKey !== undefined) {
    where.push("COALESCE(m.folder_id, '') = ?");
    params.push(input.folderKey);
  }
  params.push(Math.max(1, Math.floor(input.k)));
  try {
    const rows = db
      .prepare(
        `SELECT c.id, c.meeting_id, c.ordinal, c.kind, c.start_ms, c.end_ms
           FROM meeting_chunks_fts
           JOIN meeting_chunks c ON c.id = meeting_chunks_fts.rowid
           JOIN meetings m ON m.id = c.meeting_id
          WHERE ${where.join(" AND ")}
          ORDER BY bm25(meeting_chunks_fts), c.id
          LIMIT ?`,
      )
      .all(...params) as {
      id: number;
      meeting_id: string;
      ordinal: number;
      kind: ChunkKind;
      start_ms: number | null;
      end_ms: number | null;
    }[];
    return rows.map((r) => ({
      chunkId: r.id,
      meetingId: r.meeting_id,
      ordinal: r.ordinal,
      kind: r.kind,
      startMs: r.start_ms,
      endMs: r.end_ms,
    }));
  } catch {
    // A query the parser refuses: the dense channel answers alone.
    return [];
  }
}

/**
 * The background rebuild (one meeting per call): write the index rows of the
 * chunks of this meeting that have none. Safe to run again: a meeting with
 * all rows present costs one probe per chunk and writes nothing. The text is
 * built by the same builder as the embedder text. It opens its own
 * transaction, only when it writes: do not call it inside one. Returns the
 * number of rows written.
 */
export function ftsBackfillMeeting(
  db: DatabaseSync,
  meetingId: string,
  modelId: string,
): number {
  if (!ftsAvailable(db)) return 0;
  const chunks = db
    .prepare(
      "SELECT id, ordinal FROM meeting_chunks WHERE meeting_id = ? AND model_id = ? ORDER BY ordinal",
    )
    .all(meetingId, modelId) as { id: number; ordinal: number }[];
  if (chunks.length === 0) return 0;
  const probe = db.prepare("SELECT 1 FROM meeting_chunks_fts WHERE rowid = ?");
  const missing = chunks.filter((c) => probe.get(c.id) === undefined);
  if (missing.length === 0) return 0;
  const src = loadMeetingSource(db, meetingId);
  if (!src) return 0;
  const textOf = new Map(
    buildMeetingChunks(src).map((c) => [c.ordinal, c.text] as const),
  );
  const rows: FtsRow[] = [];
  for (const c of missing) {
    const text = textOf.get(c.ordinal);
    if (text !== undefined) {
      rows.push({ id: c.id, text, title: src.title ?? "" });
    }
  }
  withTransaction(db, () => ftsUpsertChunks(db, rows));
  return rows.length;
}
