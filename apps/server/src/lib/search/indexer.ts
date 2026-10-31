import type { DatabaseSync } from "node:sqlite";
import { createAppLogger, errorMessage } from "@openstyle/utils";
import type { SearchStatus } from "@openstyle/validations";
import { getDb, withTransaction } from "../db.js";
import {
  isDictationActive,
  waitForDictationIdle,
} from "../dictation-activity.js";
import { activeJobCount, hasJob } from "../meetings/job-registry.js";
import { EmbedError } from "../mlx-embed/client.js";
import { getSearchEmbeddingModelId } from "../mlx-embed/server.js";
import { embedInt8 } from "./embedder.js";
import { getExtensionState, isVecReady } from "./extension.js";
import {
  type FtsRow,
  ftsBackfillMeeting,
  ftsDrainGc,
  ftsUpsertChunks,
} from "./fts.js";
import {
  pendingMeetingCount,
  setIndexerModelGone,
  setIndexerWake,
  takePendingMeetings,
} from "./notify.js";
import {
  buildMeetingChunks,
  type IndexChunk,
  loadMeetingSource,
  type MeetingSource,
  sourceHash,
} from "./source.js";
import { searchState } from "./state.js";
import {
  drainGc,
  insertVectors,
  moveVectors,
  vectorChunkCount,
} from "./vec-store.js";

// The search indexer (specs/local-semantic-search.md section 6). One loop,
// one meeting at a time. The source hash is the truth; change hints only
// make it faster. All rows of one meeting go in one transaction (S4).

const log = createAppLogger("search");

/** Chunks per embedding request (spec 5.4). */
const EMBED_BATCH = 16;
/** Meeting statuses that are not ready for the index (6.3). */
const BUSY_STATUSES = ["recording", "transcribing"];
/** Waits after failure 1, 2 and 3 (6.7). After that: the next text change. */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000];
/** Loop waits. */
const OFF_POLL_MS = 5_000;
const GATE_POLL_MS = 2_000;
/** The slow scan: one meeting per second while idle (6.3 source 3). */
const SLOW_SCAN_MS = 1_000;

export type IndexOutcome =
  | "done"
  | "moved"
  | "indexed"
  | "missing"
  | "busy"
  | "off"
  | "retry";

interface StateRow {
  model_id: string;
  source_hash: string;
  folder_key: string;
  chunk_count: number;
  indexed_at: number;
  error_kind: string | null;
  attempts: number;
}

class RetryLater extends Error {}

let embeddedChunks = 0;

function readState(db: DatabaseSync, meetingId: string): StateRow | undefined {
  return db
    .prepare(
      `SELECT model_id, source_hash, folder_key, chunk_count, indexed_at, error_kind, attempts
         FROM meeting_index_state WHERE meeting_id = ?`,
    )
    .get(meetingId) as StateRow | undefined;
}

function isCurrent(state: StateRow | undefined, modelId: string, hash: string) {
  return (
    !!state &&
    state.error_kind === null &&
    state.model_id === modelId &&
    state.source_hash === hash
  );
}

/** True when the stored index of the meeting matches its text and model. */
export function isMeetingIndexCurrent(
  db: DatabaseSync,
  meetingId: string,
  modelId: string,
): boolean {
  const src = loadMeetingSource(db, meetingId);
  if (!src) return false;
  return isCurrent(readState(db, meetingId), modelId, sourceHash(src, modelId));
}

/**
 * Move the vectors of one meeting to the partition `folderKey` and record it
 * (6.5, S3). Read, delete and insert again: no embedding call. Run it in the
 * caller's transaction. Does nothing when the vec0 table is not ready.
 */
export function moveMeetingIndex(
  db: DatabaseSync,
  meetingId: string,
  folderKey: string,
): number {
  if (!isVecReady()) return 0;
  const ids = (
    db
      .prepare("SELECT id FROM meeting_chunks WHERE meeting_id = ?")
      .all(meetingId) as { id: number }[]
  ).map((r) => r.id);
  const moved = moveVectors(db, ids, folderKey);
  db.prepare(
    "UPDATE meeting_index_state SET folder_key = ? WHERE meeting_id = ?",
  ).run(folderKey, meetingId);
  return moved;
}

/** Delete the vectors that wait in meeting_chunk_gc (6.6). */
export function drainSearchGc(db: DatabaseSync = getDb()): number {
  if (!isVecReady()) return 0;
  return withTransaction(db, () => {
    ftsDrainGc(db);
    return drainGc(db);
  });
}

function recordFailure(
  db: DatabaseSync,
  src: MeetingSource,
  modelId: string,
  kind: string,
): void {
  const old = readState(db, src.meetingId);
  db.prepare(
    `INSERT INTO meeting_index_state
       (meeting_id, model_id, source_hash, folder_key, chunk_count, indexed_at, error_kind, attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(meeting_id) DO UPDATE SET model_id = excluded.model_id,
       source_hash = excluded.source_hash, indexed_at = excluded.indexed_at,
       error_kind = excluded.error_kind, attempts = meeting_index_state.attempts + 1`,
  ).run(
    src.meetingId,
    modelId,
    sourceHash(src, modelId),
    old?.folder_key ?? src.folderKey,
    old?.chunk_count ?? 0,
    Date.now(),
    kind,
  );
}

function errorKindOf(err: unknown): string {
  if (err instanceof EmbedError) {
    return err.kind === "embed_bad_response"
      ? "embed_bad_response"
      : "worker_unavailable";
  }
  return "worker_unavailable";
}

function kindCount(chunks: readonly IndexChunk[], kind: IndexChunk["kind"]) {
  return chunks.filter((c) => c.kind === kind).length;
}

interface Plan {
  src: MeetingSource;
  chunks: IndexChunk[];
  hash: string;
  state: StateRow | undefined;
}

function plan(
  db: DatabaseSync,
  meetingId: string,
  modelId: string,
): Plan | null {
  const src = loadMeetingSource(db, meetingId);
  if (!src) return null;
  return {
    src,
    chunks: buildMeetingChunks(src),
    hash: sourceHash(src, modelId),
    state: readState(db, meetingId),
  };
}

/**
 * Index one meeting (6.4). Embeds only the chunks whose text hash has no row
 * yet (D5), then writes all its rows in one transaction. `signal` aborts
 * between batches; nothing is written for an aborted meeting.
 */
export async function indexMeeting(
  meetingId: string,
  signal?: AbortSignal,
): Promise<IndexOutcome> {
  const st = searchState();
  if (st.state === "off") return "off";
  const modelId = st.modelId;
  const db = getDb();
  const p = plan(db, meetingId, modelId);
  if (!p) {
    drainSearchGc(db);
    return "missing";
  }
  if (BUSY_STATUSES.includes(p.src.status) || hasJob(meetingId)) return "busy";

  if (isCurrent(p.state, modelId, p.hash)) {
    if (p.state?.folder_key === p.src.folderKey) return "done";
    withTransaction(db, () => moveMeetingIndex(db, meetingId, p.src.folderKey));
    return "moved";
  }

  // Step 3: keep existing rows of this model whose text hash matches (D5).
  const existing = db
    .prepare(
      `SELECT id, text_hash FROM meeting_chunks
        WHERE meeting_id = ? AND model_id = ? ORDER BY ordinal`,
    )
    .all(meetingId, modelId) as { id: number; text_hash: string }[];
  const free = new Map<string, number[]>();
  for (const row of existing) {
    free.set(row.text_hash, [...(free.get(row.text_hash) ?? []), row.id]);
  }
  const keep = new Map<number, number>(); // chunk ordinal -> kept row id
  const toEmbed: IndexChunk[] = [];
  for (const c of p.chunks) {
    const ids = free.get(c.textHash);
    const id = ids?.shift();
    if (id !== undefined) keep.set(c.ordinal, id);
    else toEmbed.push(c);
  }

  // Step 4: embed in batches; check the gates between batches.
  const started = Date.now();
  const vectors: Int8Array[] = [];
  let realTokens = 0;
  let estTokens = 0;
  for (let i = 0; i < toEmbed.length; i += EMBED_BATCH) {
    if (isDictationActive()) {
      await waitForDictationIdle({
        isDictationActive,
        shouldAbort: () => signal?.aborted === true,
      });
    }
    if (signal?.aborted) return "retry";
    if (hasJob(meetingId) || getSearchEmbeddingModelId() !== modelId) {
      return "retry";
    }
    const batch = toEmbed.slice(i, i + EMBED_BATCH);
    const res = await embedInt8(
      batch.map((c) => c.text),
      "document",
      signal,
    );
    if (res.modelId !== modelId) return "retry";
    vectors.push(...res.vectors);
    batch.forEach((c, j) => {
      const t = res.tokens[j] ?? 0;
      if (t > 0) {
        realTokens += t;
        estTokens += c.tokenEstimate;
      }
    });
  }
  embeddedChunks += toEmbed.length;

  // Step 5: one transaction for all rows of this meeting.
  let outcome: IndexOutcome = "indexed";
  try {
    withTransaction(db, () => {
      const now = loadMeetingSource(db, meetingId);
      if (!now) {
        outcome = "missing";
        return;
      }
      if (sourceHash(now, modelId) !== p.hash) throw new RetryLater();
      // The model was deleted or changed during the embed (9.2, 6.8):
      // write nothing for it.
      if (signal?.aborted || getSearchEmbeddingModelId() !== modelId) {
        throw new RetryLater();
      }
      const keptIds = [...keep.values()];
      const slots = keptIds.map(() => "?").join(", ");
      db.prepare(
        `DELETE FROM meeting_chunks WHERE meeting_id = ?
           AND (model_id != ?${keptIds.length ? ` OR id NOT IN (${slots})` : " OR 1"})`,
      ).run(meetingId, modelId, ...keptIds);
      const update = db.prepare(
        `UPDATE meeting_chunks SET ordinal = ?, segment_ids = ?, char_start = ?, char_end = ?,
           start_ms = ?, end_ms = ?, token_estimate = ? WHERE id = ?`,
      );
      const insert = db.prepare(
        `INSERT INTO meeting_chunks (meeting_id, ordinal, segment_ids, char_start, char_end,
           start_ms, end_ms, token_estimate, text_hash, model_id, created_at, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const created = Date.now();
      const rows: Parameters<typeof insertVectors>[1][number][] = [];
      // The BM25 rows of every chunk, in this transaction (7.4.1). A kept
      // chunk is written again: its title may have changed.
      const ftsRows: FtsRow[] = [];
      const title = now.title ?? "";
      let v = 0;
      for (const c of p.chunks) {
        const kept = keep.get(c.ordinal);
        const fields = [
          c.ordinal,
          JSON.stringify(c.segmentIds),
          c.charStart,
          c.charEnd,
          c.startMs,
          c.endMs,
          c.tokenEstimate,
        ] as const;
        if (kept !== undefined) {
          update.run(...fields, kept);
          ftsRows.push({ id: kept, text: c.text, title });
          continue;
        }
        const id = Number(
          insert.run(meetingId, ...fields, c.textHash, modelId, created, c.kind)
            .lastInsertRowid,
        );
        ftsRows.push({ id, text: c.text, title });
        rows.push({
          chunkId: id,
          folderKey: now.folderKey,
          vector: vectors[v++] as Int8Array,
          meetingId,
          modelId,
        });
      }
      insertVectors(db, rows);
      moveVectors(db, keptIds, now.folderKey);
      ftsUpsertChunks(db, ftsRows);
      ftsDrainGc(db);
      drainGc(db);
      db.prepare(
        `INSERT INTO meeting_index_state
           (meeting_id, model_id, source_hash, folder_key, chunk_count, indexed_at, error_kind, attempts)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 0)
         ON CONFLICT(meeting_id) DO UPDATE SET model_id = excluded.model_id,
           source_hash = excluded.source_hash, folder_key = excluded.folder_key,
           chunk_count = excluded.chunk_count, indexed_at = excluded.indexed_at,
           error_kind = NULL, attempts = 0`,
      ).run(
        meetingId,
        modelId,
        p.hash,
        now.folderKey,
        p.chunks.length,
        Date.now(),
      );
    });
  } catch (err) {
    if (err instanceof RetryLater) return "retry";
    throw err;
  }
  if (outcome === "indexed") {
    const ratio = estTokens > 0 ? (realTokens / estTokens).toFixed(3) : "n/a";
    log.info(
      `indexed meeting ${meetingId}: chunks=${p.chunks.length} meta=${kindCount(p.chunks, "meta")} summary=${kindCount(p.chunks, "summary")} embedded=${toEmbed.length} kept=${keep.size} ms=${Date.now() - started} tokenRatio=${ratio} dbBytes=${dbBytes(db)} vectorChunks=${vectorChunkCount(db)}`,
    );
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// The loop (6.3)
// ---------------------------------------------------------------------------

const queue: string[] = [];
let loop: Promise<void> | null = null;
let stopping = false;
let controller: AbortController | null = null;
/** The model of the meeting in flight (9.2). */
let runningModel: string | null = null;
let wakeNow: (() => void) | null = null;
let scannedModel: string | null = null;
let slowScanCursor = 0;

function enqueue(ids: readonly string[]): void {
  for (const id of ids) if (!queue.includes(id)) queue.push(id);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      wakeNow = null;
      resolve();
    };
    const timer = setTimeout(done, ms);
    wakeNow = done;
  });
}

/** True when a failed meeting may run again now (6.7). */
function retryDue(state: StateRow): boolean {
  if (state.error_kind === null) return true;
  const delay = RETRY_DELAYS_MS[state.attempts - 1];
  if (delay === undefined) return false;
  return Date.now() >= state.indexed_at + delay;
}

/** Boot scan (6.3 source 2): state missing, other model, other folder. */
export function bootScan(db: DatabaseSync, modelId: string): string[] {
  const rows = db
    .prepare(
      `SELECT m.id, s.model_id, s.folder_key, s.error_kind, s.attempts, s.indexed_at,
              s.source_hash, s.chunk_count, COALESCE(m.folder_id, '') AS fk
         FROM meetings m LEFT JOIN meeting_index_state s ON s.meeting_id = m.id
        WHERE m.status NOT IN ('recording', 'transcribing')
        ORDER BY m.started_at DESC`,
    )
    .all() as unknown as (Partial<StateRow> & { id: string; fk: string })[];
  return rows
    .filter((r) => {
      if (r.model_id === undefined || r.model_id === null) return true;
      if (r.error_kind) return retryDue(r as StateRow);
      return r.model_id !== modelId || r.folder_key !== r.fk;
    })
    .map((r) => r.id);
}

/**
 * One step of the slow scan: compare one meeting's source hash (6.3). A
 * meeting whose index is current also gets the BM25 rows it misses (the
 * rebuild of the FTS table after the schema step, 7.4.1). A meeting that is
 * not current is indexed again, and that writes its BM25 rows.
 */
function slowScanStep(db: DatabaseSync, modelId: string): void {
  const ids = (
    db
      .prepare(
        `SELECT id FROM meetings WHERE status NOT IN ('recording', 'transcribing')
          ORDER BY id`,
      )
      .all() as { id: string }[]
  ).map((r) => r.id);
  if (ids.length === 0) return;
  const id = ids[slowScanCursor % ids.length] as string;
  slowScanCursor++;
  const p = plan(db, id, modelId);
  if (!p) return;
  if (p.state?.error_kind) {
    // A failed meeting runs again on its retry time, or on a text change.
    if (retryDue(p.state) || p.state.source_hash !== p.hash) enqueue([id]);
    return;
  }
  if (!isCurrent(p.state, modelId, p.hash)) enqueue([id]);
  else if (p.state?.folder_key !== p.src.folderKey) enqueue([id]);
  else ftsBackfillMeeting(db, id, modelId);
}

async function runLoop(): Promise<void> {
  while (!stopping) {
    try {
      const st = searchState();
      if (st.state === "off") {
        await sleep(OFF_POLL_MS);
        continue;
      }
      const db = getDb();
      if (scannedModel !== st.modelId) {
        drainSearchGc(db);
        enqueue(bootScan(db, st.modelId));
        scannedModel = st.modelId;
      }
      enqueue(takePendingMeetings());
      if (activeJobCount() > 0 || isDictationActive()) {
        await sleep(GATE_POLL_MS);
        continue;
      }
      const id = queue.shift();
      if (id === undefined) {
        slowScanStep(db, st.modelId);
        if (queue.length === 0) await sleep(SLOW_SCAN_MS);
        continue;
      }
      controller = new AbortController();
      runningModel = st.modelId;
      let outcome: IndexOutcome;
      try {
        outcome = await indexMeeting(id, controller.signal);
      } catch (err) {
        if (err instanceof EmbedError && err.kind === "no_model") continue;
        // The model was deleted (9.2) or changed (6.8) during the embed:
        // the worker stop is not a failure of this meeting.
        if (getSearchEmbeddingModelId() !== st.modelId) continue;
        const src = loadMeetingSource(db, id);
        if (src && !controller.signal.aborted) {
          const kind = errorKindOf(err);
          log.warn(`index of meeting ${id} failed: ${kind}`);
          recordFailure(db, src, st.modelId, kind);
        }
        continue;
      } finally {
        controller = null;
        runningModel = null;
      }
      // A job took the meeting, the text moved under us, or the model
      // changed: try again later. A busy meeting comes back by its hint.
      if (outcome === "retry" && !stopping) {
        enqueue([id]);
        await sleep(GATE_POLL_MS);
      }
    } catch (err) {
      log.error(`search indexer loop error: ${errorMessage(err)}`);
      await sleep(OFF_POLL_MS);
    }
  }
}

/**
 * The files of an embedding model were deleted (9.2). Abort the meeting that
 * embeds with it, so nothing is written and no failure is recorded. Empty the
 * queue: the rows of the model are gone, so a later Use of it runs the boot
 * scan again and indexes every meeting.
 */
function onModelDeleted(modelId: string): void {
  if (runningModel === modelId) controller?.abort();
  if (scannedModel === modelId) scannedModel = null;
  queue.length = 0;
  wakeNow?.();
}

/** Start the indexer loop once (spec 6.1 step 5). Search off: it waits. */
export function startSearchIndexer(): void {
  if (loop || !isVecReady()) return;
  stopping = false;
  setIndexerWake(() => wakeNow?.());
  setIndexerModelGone(onModelDeleted);
  loop = runLoop().finally(() => {
    loop = null;
  });
}

/** Stop the loop and abort the meeting in flight (6.7). */
export async function stopSearchIndexer(): Promise<void> {
  stopping = true;
  controller?.abort();
  wakeNow?.();
  setIndexerWake(null);
  setIndexerModelGone(null);
  await loop;
  queue.length = 0;
  scannedModel = null;
}

// ---------------------------------------------------------------------------
// Status (7.4, 9.4)
// ---------------------------------------------------------------------------

function dbBytes(db: DatabaseSync): number {
  try {
    const pc = db.prepare("PRAGMA page_count").get() as { page_count: number };
    const ps = db.prepare("PRAGMA page_size").get() as { page_size: number };
    return pc.page_count * ps.page_size;
  } catch {
    return 0;
  }
}

export function searchIndexStatus(): SearchStatus {
  const db = getDb();
  const st = searchState();
  const ext = getExtensionState();
  const modelId = st.state === "on" ? st.modelId : getSearchEmbeddingModelId();
  const count = (sql: string, ...params: string[]) =>
    (db.prepare(sql).get(...params) as { n: number }).n;
  const busy = "m.status NOT IN ('recording', 'transcribing')";
  return {
    state: st.state,
    reason: st.state === "off" ? st.reason : null,
    model_id: modelId,
    vec_version: ext.vecVersion,
    meetings: {
      eligible: count(`SELECT COUNT(*) AS n FROM meetings m WHERE ${busy}`),
      indexed: modelId
        ? count(
            `SELECT COUNT(*) AS n FROM meeting_index_state s JOIN meetings m ON m.id = s.meeting_id
              WHERE ${busy} AND s.error_kind IS NULL AND s.model_id = ?
                AND s.folder_key = COALESCE(m.folder_id, '')`,
            modelId,
          )
        : 0,
      failed: count(
        `SELECT COUNT(*) AS n FROM meeting_index_state s JOIN meetings m ON m.id = s.meeting_id
          WHERE ${busy} AND s.error_kind IS NOT NULL`,
      ),
      queued: queue.length + pendingMeetingCount(),
    },
    index: {
      db_bytes: dbBytes(db),
      vector_chunks: vectorChunkCount(db),
      embedded_chunks: embeddedChunks,
    },
  };
}
