// retrieval.mts: the P0 retrieval workstream (spec 7.4). Arms:
//   V0  dense vectors only (today: retrieve() on the real embed worker)
//   H1  V0 + BM25 of SQLite FTS5 (unicode61, accents folded) fused by RRF
//   H2  V0 + BM25 of FTS5 with the trigram tokenizer, RRF
//   H3  V0 + both BM25 channels, RRF (extra arm)
// plus weighted RRF and a normalized score sum (7.4.2). One pass over the
// queries gathers each channel's ranked chunk ids and times; the arms are
// then combinations of those lists. Graded gold: 2 = a transcript chunk that
// holds the gold segment, 1 = a summary chunk of that meeting that holds the
// fact value (7.4.6).

import { mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  mean,
  mrrAt,
  ndcgAt,
  normalize,
  percentile,
  recallAt,
  rrf,
} from "./keys.mts";
import type { Stack } from "./stack.mts";
import type { Corpus, Fact, Lang, RetrievalQuery } from "./types.mts";

export interface ChunkRow {
  id: number;
  meetingId: string;
  ordinal: number;
  kind: "transcript" | "meta" | "summary";
  segmentIds: string[];
  text: string;
  title: string;
}

/** Chunk rows of the index, with the text the indexer embedded (same builder). */
export function loadChunks(stack: Stack, modelId: string): ChunkRow[] {
  const { db, mod } = stack;
  const rows = db
    .prepare(
      "SELECT id, meeting_id, ordinal, kind, segment_ids FROM meeting_chunks WHERE model_id = ? ORDER BY meeting_id, ordinal",
    )
    .all(modelId) as {
    id: number;
    meeting_id: string;
    ordinal: number;
    kind: ChunkRow["kind"];
    segment_ids: string;
  }[];
  const textOf = new Map<string, string>();
  const titles = new Map<string, string>();
  for (const mid of new Set(rows.map((r) => r.meeting_id))) {
    const src = mod.loadMeetingSource(db, mid);
    if (!src) continue;
    titles.set(mid, src.title ?? "");
    for (const c of mod.buildMeetingChunks(src))
      textOf.set(`${mid}|${c.ordinal}`, c.text);
  }
  return rows.map((r) => ({
    id: r.id,
    meetingId: r.meeting_id,
    ordinal: r.ordinal,
    kind: r.kind,
    segmentIds: JSON.parse(r.segment_ids) as string[],
    text: textOf.get(`${r.meeting_id}|${r.ordinal}`) ?? "",
    title: titles.get(r.meeting_id) ?? "",
  }));
}

// --- FTS5 ------------------------------------------------------------------

export type Tok = "word" | "trigram";
const TOKENIZE: Record<Tok, string> = {
  word: "unicode61 remove_diacritics 2",
  trigram: "trigram",
};

export interface Fts {
  tok: Tok;
  db: DatabaseSync;
  path: string;
  bytes: number;
  buildMs: number;
}

export function buildFts(
  dir: string,
  tok: Tok,
  chunks: ChunkRow[],
  contentless = false,
): Fts {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `fts-${tok}${contentless ? "-nocontent" : ""}.db`);
  for (const f of [path, `${path}-wal`, `${path}-shm`])
    rmSync(f, { force: true });
  const db = new DatabaseSync(path);
  const t0 = performance.now();
  if (contentless) {
    db.exec(
      `CREATE VIRTUAL TABLE fts USING fts5(text, title, content='', tokenize='${TOKENIZE[tok]}')`,
    );
  } else {
    db.exec(
      `CREATE VIRTUAL TABLE fts USING fts5(text, title, meeting_id UNINDEXED, tokenize='${TOKENIZE[tok]}')`,
    );
  }
  db.exec("BEGIN");
  const ins = contentless
    ? db.prepare("INSERT INTO fts (rowid, text, title) VALUES (?, ?, ?)")
    : db.prepare(
        "INSERT INTO fts (rowid, text, title, meeting_id) VALUES (?, ?, ?, ?)",
      );
  for (const c of chunks) {
    if (contentless) ins.run(c.id, c.text, c.title);
    else ins.run(c.id, c.text, c.title, c.meetingId);
  }
  db.exec("COMMIT");
  db.exec("INSERT INTO fts(fts) VALUES('optimize')");
  const buildMs = performance.now() - t0;
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  const ro = new DatabaseSync(path, { readOnly: true });
  return { tok, db: ro, path, bytes: statSync(path).size, buildMs };
}

const STOP = new Set(
  (
    "a an and are as at be by did do does for from had has have how i in is it of on or our that the their there they this to was we were what when where which who whom why will with you your " +
    "a o os as um uma uns umas de do da dos das em no na nos nas por para com sem que qual quais quando onde quem como foi sao e ou se ao aos ha tem temos tinha ele ela eles elas nos eu voce"
  ).split(" "),
);

/** The FTS5 query of a text: stop words out, each term quoted, joined by OR (7.4.1 point 4). */
export function ftsQuery(text: string, tok: Tok): string {
  const min = tok === "trigram" ? 3 : 2;
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of text.split(/[^\p{L}\p{N}]+/u)) {
    const w = raw.toLowerCase();
    if (w.length < min || STOP.has(normalize(w)) || seen.has(w)) continue;
    seen.add(w);
    terms.push(`"${w.replace(/"/g, "")}"`);
  }
  return terms.join(" OR ");
}

export function ftsSearch(
  fts: Fts,
  text: string,
  limit: number,
  meetingIds?: readonly string[],
): number[] {
  const q = ftsQuery(text, fts.tok);
  if (!q) return [];
  const filter = meetingIds
    ? ` AND meeting_id IN (${meetingIds.map(() => "?").join(",")})`
    : "";
  const rows = fts.db
    .prepare(
      `SELECT rowid AS id FROM fts WHERE fts MATCH ?${filter} ORDER BY rank LIMIT ?`,
    )
    .all(q, ...(meetingIds ?? []), limit) as { id: number }[];
  return rows.map((r) => Number(r.id));
}

// --- Grades -----------------------------------------------------------------

function needles(f: Fact, c: Corpus): string[] {
  switch (f.family) {
    case "quote":
    case "metric":
    case "date":
    case "org":
      return [f.value];
    case "decision": {
      const d = f.slots.d as { choice: readonly [string, string] };
      return [d.choice[0], d.choice[1]];
    }
    case "assign":
    case "approve": {
      const p = c.people.find((x) => x.id === f.value);
      return p ? [p.full.split(" ").pop() as string] : [];
    }
    default:
      return [];
  }
}

/** Chunk id to grade (2 or 1) for the gold of one query. */
export function gradesFor(
  q: { gold: { meetingId: string; segmentIdx: number }[] },
  chunks: ChunkRow[],
  c: Corpus,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const g of q.gold) {
    const segId = `${g.meetingId}-s${g.segmentIdx}`;
    const fact = c.facts.find(
      (f) => f.meetingId === g.meetingId && f.segmentIdx === g.segmentIdx,
    );
    const ns = fact ? needles(fact, c).map((n) => normalize(n)) : [];
    for (const ch of chunks) {
      if (ch.meetingId !== g.meetingId) continue;
      if (ch.kind === "transcript" && ch.segmentIds.includes(segId))
        out.set(ch.id, 2);
      else if (ch.kind === "summary" && !out.has(ch.id)) {
        const t = ` ${normalize(ch.text)} `;
        if (ns.some((n) => n && t.includes(` ${n} `))) out.set(ch.id, 1);
      }
    }
  }
  return out;
}

// --- The pass -----------------------------------------------------------------

export interface Channel {
  ids: number[];
  ms: number;
  /** Score by chunk id (dense: cosine; fts: -rank is not exposed, so rank order only). */
  scores?: Map<number, number>;
}
export interface QueryPass {
  q: RetrievalQuery;
  dense: Channel;
  word: Channel;
  tri: Channel;
  grades: Map<number, number>;
  ideal: number[];
  /** R1: the reranked ids (set by rerank.mts) and the added time. */
  rerank?: Record<string, { ids: number[]; ms: number }>;
}

export async function runPass(
  stack: Stack,
  c: Corpus,
  chunks: ChunkRow[],
  queries: RetrievalQuery[],
  ftsWord: Fts,
  ftsTri: Fts,
  modelId: string,
  log: (s: string) => void,
  onTick: () => void = () => {},
): Promise<QueryPass[]> {
  const out: QueryPass[] = [];
  const DAY = 86_400_000;
  let i = 0;
  for (const q of queries) {
    i++;
    const range =
      q.dateFrom && q.dateTo
        ? {
            fromMs: Date.parse(`${q.dateFrom}T00:00:00Z`),
            toMs: Date.parse(`${q.dateTo}T00:00:00Z`) + DAY,
          }
        : undefined;
    const t0 = performance.now();
    const res = await stack.mod.retrieve({
      query: { kind: "text", text: q.text },
      scope: { kind: "all" },
      k: 50,
      ...(range ? { dateRange: range } : {}),
    });
    const denseMs = performance.now() - t0;
    if (res.status !== "ok")
      throw new Error(`retrieve ${q.id}: ${JSON.stringify(res)}`);
    const dense: Channel = {
      ids: res.hits.map((h) => h.chunkId),
      ms: denseMs,
      scores: new Map(res.hits.map((h) => [h.chunkId, h.score])),
    };
    const allow = range
      ? c.meetings
          .filter(
            (m) => m.startedAt >= range.fromMs && m.startedAt < range.toMs,
          )
          .map((m) => m.id)
      : undefined;
    const t1 = performance.now();
    const w = ftsSearch(ftsWord, q.text, 50, allow);
    const t2 = performance.now();
    const t = ftsSearch(ftsTri, q.text, 50, allow);
    const t3 = performance.now();
    const grades = gradesFor(q, chunks, c);
    const ideal = [...grades.values()].sort((a, b) => b - a);
    out.push({
      q,
      dense,
      word: { ids: w, ms: t2 - t1 },
      tri: { ids: t, ms: t3 - t2 },
      grades,
      ideal,
    });
    if (i % 10 === 0) onTick();
    if (i % 30 === 0) log(`retrieval pass ${i}/${queries.length}`);
  }
  void modelId;
  return out;
}

// --- Arms ------------------------------------------------------------------------

export interface ArmSpec {
  id: string;
  desc: string;
  channels: ("dense" | "word" | "tri")[];
  fusion: "none" | "rrf" | "sum" | "rerank";
  weights?: number[];
  /** For fusion "rerank": how many H1 candidates go to the reranker. */
  rerankN?: number;
}
export const ARMS: ArmSpec[] = [
  { id: "V0", desc: "dense only (today)", channels: ["dense"], fusion: "none" },
  { id: "B1", desc: "BM25 word only", channels: ["word"], fusion: "none" },
  { id: "B2", desc: "BM25 trigram only", channels: ["tri"], fusion: "none" },
  {
    id: "H1",
    desc: "dense + BM25 word, RRF k=60",
    channels: ["dense", "word"],
    fusion: "rrf",
  },
  {
    id: "H2",
    desc: "dense + BM25 trigram, RRF k=60",
    channels: ["dense", "tri"],
    fusion: "rrf",
  },
  {
    id: "H3",
    desc: "dense + word + trigram, RRF k=60",
    channels: ["dense", "word", "tri"],
    fusion: "rrf",
  },
  {
    id: "H1w",
    desc: "H1 weights dense 1, bm25 0.5",
    channels: ["dense", "word"],
    fusion: "rrf",
    weights: [1, 0.5],
  },
  {
    id: "R1",
    desc: "H1 top 30 reranked by Qwen3-Reranker-0.6B (MLX)",
    channels: ["dense", "word"],
    fusion: "rerank",
    rerankN: 30,
  },
  {
    id: "R1c15",
    desc: "H1 top 15 reranked (time scaled from the 30 run)",
    channels: ["dense", "word"],
    fusion: "rerank",
    rerankN: 15,
  },
  {
    id: "R1c10",
    desc: "H1 top 10 reranked (time scaled from the 30 run)",
    channels: ["dense", "word"],
    fusion: "rerank",
    rerankN: 10,
  },
  {
    id: "H1s",
    desc: "H1 min-max score sum (rank-normalized bm25)",
    channels: ["dense", "word"],
    fusion: "sum",
  },
];

/** The ranked chunk ids of one arm for one query pass, and the fusion time. */
export function rankArm(
  p: QueryPass,
  arm: ArmSpec,
): { ids: number[]; ms: number } {
  if (arm.fusion === "rerank") return p.rerank?.[arm.id] ?? { ids: [], ms: 0 };
  const lists = arm.channels.map(
    (ch) => p[ch === "dense" ? "dense" : ch === "word" ? "word" : "tri"],
  );
  const chMs = lists.reduce((a, l) => a + l.ms, 0);
  if (arm.fusion === "none")
    return { ids: (lists[0] as Channel).ids, ms: chMs };
  const t0 = performance.now();
  let ids: number[];
  if (arm.fusion === "rrf") {
    ids = rrf(
      lists.map((l) => l.ids),
      60,
      arm.weights,
    );
  } else {
    // Dense: cosine min-max over the list. BM25 exposes ranks only here, so it
    // gets a linear rank score. Sum, then sort.
    const score = new Map<number, number>();
    lists.forEach((l, li) => {
      if (li === 0 && l.scores) {
        const vals = [...l.scores.values()];
        const lo = Math.min(...vals);
        const hi = Math.max(...vals);
        for (const [id, s] of l.scores)
          score.set(
            id,
            (score.get(id) ?? 0) + (hi === lo ? 1 : (s - lo) / (hi - lo)),
          );
      } else {
        l.ids.forEach((id, r) =>
          score.set(
            id,
            (score.get(id) ?? 0) + 1 - r / Math.max(1, l.ids.length),
          ),
        );
      }
    });
    ids = [...score.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .map(([id]) => id);
  }
  return { ids, ms: chMs + (performance.now() - t0) };
}

export interface ArmMetrics {
  n: number;
  r1: number;
  r5: number;
  r10: number;
  /** recall@10 when a summary chunk with the value also counts (grade 1 or 2). */
  r10any: number;
  mrr10: number;
  ndcg10: number;
  /** Meeting-level: the right meeting appears in the top 10. */
  meeting10: number;
}

export function metricsOf(
  passes: QueryPass[],
  arm: ArmSpec,
  filter: (p: QueryPass) => boolean,
): ArmMetrics {
  const sel = passes.filter(filter);
  const per = sel.map((p) => {
    const ids = rankArm(p, arm).ids;
    const grades = ids.map((id) => p.grades.get(id) ?? 0);
    const goldMeetings = new Set(p.q.gold.map((g) => g.meetingId));
    return {
      r1: recallAt(grades, 1),
      r5: recallAt(grades, 5),
      r10: recallAt(grades, 10),
      r10any: recallAt(grades, 10, 1),
      mrr: mrrAt(grades, 10),
      ndcg: ndcgAt(grades, p.ideal, 10),
      m10: ids
        .slice(0, 10)
        .some((id) => goldMeetings.has(chunkMeeting.get(id) ?? ""))
        ? 1
        : 0,
    };
  });
  return {
    n: sel.length,
    r1: mean(per.map((x) => x.r1)),
    r5: mean(per.map((x) => x.r5)),
    r10: mean(per.map((x) => x.r10)),
    r10any: mean(per.map((x) => x.r10any)),
    mrr10: mean(per.map((x) => x.mrr)),
    ndcg10: mean(per.map((x) => x.ndcg)),
    meeting10: mean(per.map((x) => x.m10)),
  };
}

/** chunk id to meeting id; set by the runner before metricsOf. */
export const chunkMeeting = new Map<number, string>();

export function latencyOf(
  passes: QueryPass[],
  arm: ArmSpec,
): { p50: number; p95: number; sumP50: number } {
  const ms = passes.map((p) => rankArm(p, arm).ms);
  return {
    p50: percentile(ms, 50),
    p95: percentile(ms, 95),
    sumP50: percentile(ms, 50),
  };
}

export const langOf = (p: QueryPass): Lang => p.q.lang;
