import type { DatabaseSync } from "node:sqlite";
import type { SearchOffReason } from "@openstyle/validations";
import { getDb } from "../db.js";
import { getMeetingTags } from "../meetings/tags.js";
import { EmbedError } from "../mlx-embed/client.js";
import { RerankError, rerankPairs } from "../mlx-rerank/client.js";
import { type ChunkKind, spanText } from "./chunker.js";
import { embedInt8 } from "./embedder.js";
import { type FtsHit, ftsSearch } from "./fts.js";
import { isMeetingIndexCurrent } from "./indexer.js";
import { buildMeetingChunks, loadMeetingSource, metaText } from "./source.js";
import { searchState } from "./state.js";
import { KNN_IN_LIST_MAX, knn, readVecRow } from "./vec-store.js";

// The one retrieval API (specs/local-semantic-search.md section 8). Search,
// Summary and Enhance (#234) call only this. It reads the index. It never
// writes it.

export type RetrievalScope =
  | { kind: "all" }
  | { kind: "folder"; folderId: string }
  | { kind: "unfiled" }
  // One meeting (specs/meeting-chat-agent.md 7.1). Not used by the search UI.
  | { kind: "meeting"; meetingId: string };

export type RetrievalQuery =
  | { kind: "text"; text: string }
  | { kind: "meeting"; meetingId: string };

export interface RetrieveInput {
  query: RetrievalQuery;
  scope: RetrievalScope;
  /** Tag names, any of them (S5). */
  tags?: readonly string[];
  /**
   * Only meetings that started in [fromMs, toMs) (specs/meeting-chat-agent.md
   * 7.1). A meeting with no start time uses its creation time. Combined with
   * the scope and the tags by AND.
   */
  dateRange?: { fromMs: number; toMs: number };
  /** 1..50 */
  k: number;
  excludeMeetingIds?: readonly string[];
  signal?: AbortSignal;
  /**
   * "dense" (default) is the vector search only: the search UI and the
   * Summary and Enhance memory use it. "hybrid" adds the BM25 channel, fuses
   * both by RRF and can rerank (specs/meeting-chat-agent.md 7.4). A "meeting"
   * query has no text, so it stays dense.
   */
  mode?: "dense" | "hybrid";
  /**
   * Hybrid only: score the top `candidates` fused hits with the reranker and
   * sort them by that score. Without the reranker, the fused order stays.
   */
  rerank?: {
    candidates: number /** Pairs per forward pass. Default: RERANK_BATCH. */;
    batch?: number;
  };
}

export interface RetrievalHit {
  chunkId: number;
  meetingId: string;
  /** 1 - cosine distance. */
  score: number;
  ordinal: number;
  /** transcript, meta (title and tags) or summary (3.2). */
  kind: ChunkKind;
  /** null for meta and summary chunks. */
  startMs: number | null;
  endMs: number | null;
  /** Hybrid only: the rank (from 1) in the fused list, before the rerank. */
  fusedRank?: number;
  /** Hybrid with a rerank only: the reranker score (0..1) of this hit. */
  rerankScore?: number;
}

/** What the reranker did in a hybrid call. */
export type RerankOutcome = "applied" | "unavailable" | "error" | "off";

/** Milliseconds of each step of a hybrid call. */
export interface RetrieveTimings {
  /** The query embedding and the dense search. */
  dense: number;
  /** The BM25 search. 0 when the channel is off. */
  fts: number;
  /** The reranker call. 0 when it did not run. */
  rerank: number;
  total: number;
}

export type RetrieveResult =
  | {
      status: "ok";
      modelId: string;
      hits: RetrievalHit[];
      /** Hybrid mode only. */
      rerank?: RerankOutcome;
      /** Hybrid mode only. */
      ms?: RetrieveTimings;
    }
  | { status: "off"; reason: SearchOffReason }
  | {
      status: "error";
      kind: "worker_unavailable" | "embed_bad_response" | "cancelled";
    };

/** Stored vectors used for a "meeting" query (8.1). */
const MEETING_QUERY_VECTORS = 8;
/** Excludes pushed into the KNN as `!=` (7.2). */
const EXCLUDE_IN_KNN_MAX = 5;
/** Extra k for each exclude above the max: about one meeting of chunks. */
const CHUNKS_PER_MEETING = 46;
/** Hits taken from each channel before the fusion (7.4.2). */
const CHANNEL_K = 50;
/** The RRF constant (7.4.2). */
const RRF_K = 60;
/** Characters of a candidate that go to the reranker. */
const RERANK_DOC_CHARS = 3000;

/**
 * Reciprocal rank fusion (7.4.2): score = sum over channels of 1 / (k + rank),
 * ranks from 1. Ties break by the id, for a stable order.
 */
export function rrf(
  lists: readonly (readonly number[])[],
  k = RRF_K,
): number[] {
  const score = new Map<number, number>();
  for (const list of lists) {
    list.forEach((id, i) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1));
    });
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([id]) => id);
}

/** Cosine of two int8 vectors, the dense score of a hit. */
function cosine(a: Int8Array, b: Int8Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

/** Up to `n` items, evenly spaced, first and last included. */
function evenlySpaced<T>(items: readonly T[], n: number): T[] {
  if (items.length <= n) return [...items];
  return Array.from(
    { length: n },
    (_, i) => items[Math.round((i * (items.length - 1)) / (n - 1))] as T,
  );
}

async function queryVectors(
  db: DatabaseSync,
  query: RetrievalQuery,
  modelId: string,
  signal?: AbortSignal,
): Promise<Int8Array[]> {
  if (query.kind === "text") {
    return (await embedInt8([query.text], "query", signal)).vectors;
  }
  if (isMeetingIndexCurrent(db, query.meetingId, modelId)) {
    const ids = (
      db
        .prepare(
          `SELECT id FROM meeting_chunks WHERE meeting_id = ? AND model_id = ?
            ORDER BY ordinal`,
        )
        .all(query.meetingId, modelId) as { id: number }[]
    ).map((r) => r.id);
    return evenlySpaced(ids, MEETING_QUERY_VECTORS)
      .map((id) => readVecRow(db, id)?.vector)
      .filter((v): v is Int8Array => v !== undefined);
  }
  // Not indexed yet (a workflow run holds the meeting's job slot, 6.3):
  // embed up to 8 chunks now. They are not stored.
  const src = loadMeetingSource(db, query.meetingId);
  if (!src) return [];
  const chunks = evenlySpaced(buildMeetingChunks(src), MEETING_QUERY_VECTORS);
  if (chunks.length === 0) return [];
  return (
    await embedInt8(
      chunks.map((c) => c.text),
      "document",
      signal,
    )
  ).vectors;
}

function tagMeetingIds(db: DatabaseSync, tags: readonly string[]): string[] {
  const slots = tags.map(() => "?").join(", ");
  return (
    db
      .prepare(
        `SELECT DISTINCT mt.meeting_id FROM meeting_tags mt JOIN tags t ON t.id = mt.tag_id
          WHERE t.name IN (${slots}) ORDER BY mt.meeting_id`,
      )
      .all(...tags) as { meeting_id: string }[]
  ).map((r) => r.meeting_id);
}

/** The ids of the meetings that started in [fromMs, toMs). */
function dateMeetingIds(
  db: DatabaseSync,
  range: { fromMs: number; toMs: number },
): string[] {
  return (
    db
      .prepare(
        `SELECT id FROM meetings
          WHERE COALESCE(started_at, created_at) >= ? AND COALESCE(started_at, created_at) < ?
          ORDER BY id`,
      )
      .all(range.fromMs, range.toMs) as { id: string }[]
  ).map((r) => r.id);
}

function errorResult(err: unknown, signal?: AbortSignal): RetrieveResult {
  if (signal?.aborted || (err as Error)?.name === "AbortError") {
    return { status: "error", kind: "cancelled" };
  }
  if (err instanceof EmbedError && err.kind === "no_model") {
    return { status: "off", reason: "no_model" };
  }
  if (err instanceof EmbedError && err.kind === "embed_bad_response") {
    return { status: "error", kind: "embed_bad_response" };
  }
  return { status: "error", kind: "worker_unavailable" };
}

export async function retrieve(input: RetrieveInput): Promise<RetrieveResult> {
  const t0 = performance.now();
  const st = searchState();
  if (st.state === "off") return { status: "off", reason: st.reason };
  const modelId = st.modelId;
  const db = getDb();
  const k = Math.max(1, Math.min(50, Math.floor(input.k)));
  const ok = (hits: RetrievalHit[]): RetrieveResult => ({
    status: "ok",
    modelId,
    hits,
  });

  let folderKey: string | undefined;
  if (input.scope.kind === "folder") {
    const known = db
      .prepare("SELECT 1 FROM meeting_folders WHERE id = ?")
      .get(input.scope.folderId);
    if (!known) return ok([]);
    folderKey = input.scope.folderId;
  } else if (input.scope.kind === "unfiled") {
    folderKey = "";
  }

  // The allow list of meeting ids: the meeting scope, the tags and the date
  // range, ANDed. No filter means no list (the KNN scans the partition).
  const narrow = (cur: string[] | undefined, ids: string[]): string[] => {
    const set = new Set(ids);
    return cur === undefined ? ids : cur.filter((id) => set.has(id));
  };
  let allow: string[] | undefined;
  if (input.scope.kind === "meeting") {
    allow = narrow(allow, [input.scope.meetingId]);
  }
  if (input.tags && input.tags.length > 0) {
    allow = narrow(allow, tagMeetingIds(db, input.tags));
  }
  if (input.dateRange)
    allow = narrow(allow, dateMeetingIds(db, input.dateRange));
  let groups: (string[] | undefined)[] = [undefined];
  if (allow !== undefined) {
    if (allow.length === 0) return ok([]);
    groups = [];
    for (let i = 0; i < allow.length; i += KNN_IN_LIST_MAX) {
      groups.push(allow.slice(i, i + KNN_IN_LIST_MAX));
    }
  }

  const exclude = [...new Set(input.excludeMeetingIds ?? [])];
  const inKnn = exclude.length <= EXCLUDE_IN_KNN_MAX ? exclude : [];
  const hybrid = input.mode === "hybrid" && input.query.kind === "text";
  const denseK = hybrid ? Math.max(k, CHANNEL_K) : k;
  const knnK = Math.min(
    4096,
    inKnn.length === exclude.length
      ? denseK
      : denseK + CHUNKS_PER_MEETING * exclude.length,
  );

  let vectors: Int8Array[];
  try {
    vectors = await queryVectors(db, input.query, modelId, input.signal);
  } catch (err) {
    return errorResult(err, input.signal);
  }
  if (input.signal?.aborted) return { status: "error", kind: "cancelled" };

  const best = new Map<number, { meetingId: string; score: number }>();
  for (const vector of vectors) {
    for (const meetingIds of groups) {
      for (const hit of knn(db, {
        vector,
        k: knnK,
        modelId,
        folderKey,
        excludeMeetingIds: inKnn,
        meetingIds,
      })) {
        const score = 1 - hit.distance;
        const old = best.get(hit.chunkId);
        if (!old || score > old.score) {
          best.set(hit.chunkId, { meetingId: hit.meetingId, score });
        }
      }
    }
  }

  // Join the base rows. Drop gc rows not drained yet (7.1 step 5), excluded
  // meetings, and a hit whose meeting left the scope folder since its vectors
  // were written.
  const excluded = new Set(exclude);
  const rowStmt = db.prepare(
    `SELECT c.ordinal, c.kind, c.start_ms, c.end_ms, COALESCE(m.folder_id, '') AS fk
       FROM meeting_chunks c JOIN meetings m ON m.id = c.meeting_id
      WHERE c.id = ? AND c.model_id = ?`,
  );
  const hits: RetrievalHit[] = [];
  for (const [chunkId, h] of best) {
    if (excluded.has(h.meetingId)) continue;
    const row = rowStmt.get(chunkId, modelId) as
      | {
          ordinal: number;
          kind: ChunkKind;
          start_ms: number | null;
          end_ms: number | null;
          fk: string;
        }
      | undefined;
    if (!row) continue;
    if (folderKey !== undefined && row.fk !== folderKey) continue;
    hits.push({
      chunkId,
      meetingId: h.meetingId,
      score: h.score,
      ordinal: row.ordinal,
      kind: row.kind,
      startMs: row.start_ms,
      endMs: row.end_ms,
    });
  }
  hits.sort((a, b) => b.score - a.score || a.chunkId - b.chunkId);
  if (!hybrid || input.query.kind !== "text") return ok(hits.slice(0, k));

  // Hybrid (7.4): the BM25 channel, the RRF fusion and the reranker.
  const tDense = performance.now();
  const queryText = input.query.text;
  const ftsHits = ftsSearch(db, {
    text: queryText,
    allowMeetingIds: allow,
    excludeMeetingIds: exclude,
    folderKey,
    modelId,
    k: CHANNEL_K,
  });
  const tFts = performance.now();
  const byId = new Map<number, RetrievalHit>(hits.map((h) => [h.chunkId, h]));
  const ftsById = new Map<number, FtsHit>(ftsHits.map((h) => [h.chunkId, h]));
  const fused = rrf([
    hits.slice(0, CHANNEL_K).map((h) => h.chunkId),
    ftsHits.map((h) => h.chunkId),
  ]);
  // The score of a hit from the BM25 channel only is its dense cosine, read
  // from the stored vector.
  const toHit = (id: number, rank: number): RetrievalHit => {
    const known = byId.get(id);
    if (known) return { ...known, fusedRank: rank };
    const f = ftsById.get(id) as FtsHit;
    const stored = readVecRow(db, id)?.vector;
    const q = vectors[0];
    return {
      chunkId: id,
      meetingId: f.meetingId,
      score: stored && q ? cosine(q, stored) : 0,
      ordinal: f.ordinal,
      kind: f.kind,
      startMs: f.startMs,
      endMs: f.endMs,
      fusedRank: rank,
    };
  };
  let ordered = fused.map((id, i) => toHit(id, i + 1));
  let outcome: RerankOutcome = "off";
  let rerankMs = 0;
  if (input.rerank && ordered.length > 0) {
    const n = Math.max(
      1,
      Math.min(CHANNEL_K * 2, Math.floor(input.rerank.candidates)),
    );
    const head = ordered.slice(0, n);
    const tRerank = performance.now();
    try {
      const docs = head.map((h) => hitText(h, RERANK_DOC_CHARS));
      const scores = await rerankPairs(
        queryText,
        docs,
        input.signal,
        input.rerank.batch,
      );
      const scored = head
        .map((h, i) => ({ ...h, rerankScore: scores[i] as number }))
        .sort(
          (a, b) =>
            b.rerankScore - a.rerankScore ||
            (a.fusedRank as number) - (b.fusedRank as number),
        );
      ordered = [...scored, ...ordered.slice(n)];
      outcome = "applied";
    } catch (err) {
      if (input.signal?.aborted || (err as Error)?.name === "AbortError") {
        return { status: "error", kind: "cancelled" };
      }
      outcome =
        err instanceof RerankError && err.kind === "no_model"
          ? "unavailable"
          : "error";
    }
    rerankMs = performance.now() - tRerank;
  }
  const end = performance.now();
  return {
    status: "ok",
    modelId,
    hits: ordered.slice(0, k),
    rerank: outcome,
    ms: {
      dense: tDense - t0,
      fts: tFts - tDense,
      rerank: rerankMs,
      total: end - t0,
    },
  };
}

function currentMetaText(db: DatabaseSync, meetingId: string): string {
  const row = db
    .prepare("SELECT title FROM meetings WHERE id = ?")
    .get(meetingId) as { title: string | null } | undefined;
  return metaText(row?.title ?? null, getMeetingTags(meetingId, db)) ?? "";
}

/**
 * The current text of a hit (7.3). A transcript hit: its segments, cut at
 * the stored offsets, joined with spaces. A meta hit: the title and tags. A
 * summary hit: the summary, cut at the stored offsets. Cut to `maxChars`.
 * No text is stored in the index.
 */
export function hitText(hit: RetrievalHit, maxChars: number): string {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT meeting_id, kind, segment_ids, char_start, char_end FROM meeting_chunks WHERE id = ?",
    )
    .get(hit.chunkId) as
    | {
        meeting_id: string;
        kind: ChunkKind;
        segment_ids: string;
        char_start: number;
        char_end: number | null;
      }
    | undefined;
  if (!row) return "";
  let texts: string[];
  if (row.kind === "meta") {
    texts = [currentMetaText(db, row.meeting_id)];
  } else if (row.kind === "summary") {
    const s = db
      .prepare("SELECT markdown FROM meeting_summaries WHERE meeting_id = ?")
      .get(row.meeting_id) as { markdown: string | null } | undefined;
    texts = [s?.markdown ?? ""];
  } else {
    const ids = JSON.parse(row.segment_ids) as string[];
    const stmt = db.prepare(
      "SELECT COALESCE(NULLIF(enhanced_text, ''), text, '') AS t FROM meeting_segments WHERE id = ?",
    );
    texts = ids.map(
      (id) => (stmt.get(id) as { t: string } | undefined)?.t ?? "",
    );
  }
  const text = spanText(
    texts,
    row.kind === "meta" ? 0 : row.char_start,
    row.kind === "meta" ? null : row.char_end,
  );
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
