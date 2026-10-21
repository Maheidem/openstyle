import type { DatabaseSync } from "node:sqlite";
import { isVecReady, markVecTableFailed } from "./extension.js";

// The only reader and writer of the vec0 table (specs/local-semantic-search.md
// 3.3, 9.1). Every function needs the extension. Callers check
// `searchState()` (or `isVecReady()`) first: without the module, any read of
// the table fails with "no such module: vec0" (P1 9b).
//
// Binding rules (P1): chunk_id is a BigInt (3a); a vector goes through
// vec_int8(?) as an Int8Array (3f); the query vector is int8 too (4j).

/** Vector size of EmbeddingGemma 2 (D8). */
export const VEC_DIMS = 768;

/** Ids in one IN list of a KNN query (spec 7.2). */
export const KNN_IN_LIST_MAX = 500;

const CREATE_SQL = `CREATE VIRTUAL TABLE IF NOT EXISTS meeting_chunk_vec USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  folder_id TEXT PARTITION KEY,
  embedding INT8[${VEC_DIMS}] DISTANCE_METRIC=cosine,
  meeting_id TEXT,
  model_id TEXT,
  chunk_size=64
)`;

function assertReady(): void {
  if (!isVecReady()) throw new Error("sqlite-vec is not loaded");
}

/** Create the vec0 table after a successful load (spec 6.1 step 4, S12). */
export function ensureVecTable(db: DatabaseSync): void {
  if (!isVecReady()) return;
  try {
    db.exec(CREATE_SQL);
  } catch (err) {
    markVecTableFailed(err);
  }
}

export interface VecRow {
  chunkId: number;
  /** meetings.folder_id, or '' when unfiled (S2). */
  folderKey: string;
  vector: Int8Array;
  meetingId: string;
  modelId: string;
}

export function insertVectors(db: DatabaseSync, rows: readonly VecRow[]): void {
  assertReady();
  const stmt = db.prepare(
    `INSERT INTO meeting_chunk_vec (chunk_id, folder_id, embedding, meeting_id, model_id)
     VALUES (?, ?, vec_int8(?), ?, ?)`,
  );
  for (const r of rows) {
    stmt.run(BigInt(r.chunkId), r.folderKey, r.vector, r.meetingId, r.modelId);
  }
}

export function deleteVectors(
  db: DatabaseSync,
  chunkIds: readonly number[],
): void {
  assertReady();
  const stmt = db.prepare("DELETE FROM meeting_chunk_vec WHERE chunk_id = ?");
  for (const id of chunkIds) stmt.run(BigInt(id));
}

/** The vec0 row of one chunk, for read-back checks and the move. */
export function readVecRow(db: DatabaseSync, chunkId: number): VecRow | null {
  assertReady();
  const row = db
    .prepare(
      "SELECT embedding, folder_id, meeting_id, model_id FROM meeting_chunk_vec WHERE chunk_id = ?",
    )
    .get(BigInt(chunkId)) as
    | {
        embedding: Uint8Array;
        folder_id: string;
        meeting_id: string;
        model_id: string;
      }
    | undefined;
  if (!row) return null;
  return {
    chunkId,
    folderKey: row.folder_id,
    meetingId: row.meeting_id,
    modelId: row.model_id,
    vector: new Int8Array(
      row.embedding.buffer,
      row.embedding.byteOffset,
      row.embedding.byteLength,
    ).slice(),
  };
}

/**
 * Move the vec0 rows of `chunkIds` to the partition `folderKey`. vec0 refuses
 * an UPDATE of a partition key (P1 5a), so each row is read, deleted and
 * inserted again with its stored vector (S3, P1 5d). No embedding call. The
 * caller runs this inside its transaction. Returns the moved row count.
 */
export function moveVectors(
  db: DatabaseSync,
  chunkIds: readonly number[],
  folderKey: string,
): number {
  assertReady();
  const rows: VecRow[] = [];
  for (const id of chunkIds) {
    const row = readVecRow(db, id);
    if (row && row.folderKey !== folderKey) rows.push({ ...row, folderKey });
  }
  deleteVectors(
    db,
    rows.map((r) => r.chunkId),
  );
  insertVectors(db, rows);
  return rows.length;
}

export interface KnnInput {
  vector: Int8Array;
  k: number;
  modelId: string;
  /** A partition value ('' = unfiled). Absent: all partitions. */
  folderKey?: string;
  /** Meetings to leave out, one `!=` each (spec 7.2: up to 5). */
  excludeMeetingIds?: readonly string[];
  /** Only these meetings (tags, S5). At most KNN_IN_LIST_MAX ids. */
  meetingIds?: readonly string[];
}

export interface KnnHit {
  chunkId: number;
  meetingId: string;
  distance: number;
}

/** One KNN query on the vec0 table (spec 7.2). Never `folder_id IN (...)`. */
export function knn(db: DatabaseSync, input: KnnInput): KnnHit[] {
  assertReady();
  const where = ["embedding MATCH vec_int8(?)", "k = ?", "model_id = ?"];
  const params: (string | number | bigint | Int8Array)[] = [
    input.vector,
    input.k,
    input.modelId,
  ];
  if (input.folderKey !== undefined) {
    where.push("folder_id = ?");
    params.push(input.folderKey);
  }
  for (const id of input.excludeMeetingIds ?? []) {
    where.push("meeting_id != ?");
    params.push(id);
  }
  if (input.meetingIds) {
    if (input.meetingIds.length === 0) return [];
    if (input.meetingIds.length > KNN_IN_LIST_MAX) {
      throw new Error(`At most ${KNN_IN_LIST_MAX} meeting ids per KNN query`);
    }
    where.push(`meeting_id IN (${input.meetingIds.map(() => "?").join(", ")})`);
    params.push(...input.meetingIds);
  }
  const rows = db
    .prepare(
      `SELECT chunk_id, meeting_id, distance FROM meeting_chunk_vec
        WHERE ${where.join(" AND ")} ORDER BY distance`,
    )
    .all(...params) as {
    chunk_id: number | bigint;
    meeting_id: string;
    distance: number;
  }[];
  return rows.map((r) => ({
    chunkId: Number(r.chunk_id),
    meetingId: r.meeting_id,
    distance: r.distance,
  }));
}

/**
 * Delete the vec0 rows whose ids wait in meeting_chunk_gc, then the gc rows,
 * in one transaction of the caller (spec 6.6). Returns the drained count.
 */
export function drainGc(db: DatabaseSync): number {
  assertReady();
  const ids = (
    db.prepare("SELECT chunk_id FROM meeting_chunk_gc").all() as {
      chunk_id: number;
    }[]
  ).map((r) => r.chunk_id);
  if (ids.length === 0) return 0;
  deleteVectors(db, ids);
  const del = db.prepare("DELETE FROM meeting_chunk_gc WHERE chunk_id = ?");
  for (const id of ids) del.run(id);
  return ids.length;
}

/** Row count of the vector chunk shadow table (spec 9.4). */
export function vectorChunkCount(db: DatabaseSync): number {
  if (!isVecReady()) return 0;
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM meeting_chunk_vec_vector_chunks00")
      .get() as { n: number };
    return row.n;
  } catch {
    return 0;
  }
}
