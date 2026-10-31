// retrieval-run.mts: the P0 retrieval run (spec 7.4): index the corpus with the
// real embed worker, run the queries, build the FTS5 channels, compare the
// arms, time them and sample the RAM.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { mean, percentile } from "./keys.mts";
import {
  ARMS as ALL_ARMS,
  type ArmSpec,
  buildFts,
  type ChunkRow,
  chunkMeeting,
  gradesFor,
  latencyOf,
  loadChunks,
  metricsOf,
  type QueryPass,
  rankArm,
  runPass,
} from "./retrieval.mts";
import { type RerankStats, runRerank } from "./rerank.mts";
import { bootStack, EMBED_MODEL_ID, loadCorpus, RssSampler } from "./stack.mts";
import type { Corpus, GoldSet, Lang, RetrievalSlice } from "./types.mts";

export interface RunOut {
  name: string;
  params: Record<string, string | number | boolean>;
  tags: Record<string, string>;
  metrics: Record<string, number>;
}
export interface RunResult {
  text: string;
  result: unknown;
  runs: RunOut[];
}

const SLICES: RetrievalSlice[] = ["names", "numbers", "concept", "asr_names", "date"];
const f2 = (x: number) => x.toFixed(3);
const pct = (x: number) => `${(x * 100).toFixed(1)}`;

export async function runRetrieval(
  corpus: Corpus,
  gold: GoldSet,
  hashes: { corpus: string; gold: string },
): Promise<RunResult> {
  const log = (s: string) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${s}`);
  const stack = await bootStack("retrieval", true);
  loadCorpus(stack, corpus);
  stack.mod.writeSetting("search_embedding_model", EMBED_MODEL_ID);
  const st = stack.mod.searchState();
  if (st.state !== "on") throw new Error(`search is off: ${st.reason}`);
  log(`search on: ${st.modelId}`);

  const rss = new RssSampler(/--embed/);
  rss.start();
  // ---- index with the real worker ----------------------------------------------
  const tIdx = performance.now();
  const outcomes = new Map<string, number>();
  for (const m of corpus.meetings) {
    const o = await stack.mod.indexMeeting(m.id);
    outcomes.set(o, (outcomes.get(o) ?? 0) + 1);
    rss.sample();
  }
  const indexMs = performance.now() - tIdx;
  log(`indexed: ${JSON.stringify(Object.fromEntries(outcomes))} in ${(indexMs / 1000).toFixed(1)} s`);
  const chunks = loadChunks(stack, st.modelId);
  for (const ch of chunks) chunkMeeting.set(ch.id, ch.meetingId);
  const audioHours = corpus.meetings.reduce((a, m) => a + m.durationMs, 0) / 3_600_000;
  const kinds = new Map<string, number>();
  for (const ch of chunks) kinds.set(ch.kind, (kinds.get(ch.kind) ?? 0) + 1);

  // Every gold segment must sit in a chunk (the merge may drop a row as echo).
  const missing = gold.retrieval
    .flatMap((q) => q.gold)
    .concat(gold.questions.flatMap((q) => q.gold))
    .filter((g) => !chunks.some((ch) => ch.segmentIds.includes(`${g.meetingId}-s${g.segmentIdx}`)));
  if (missing.length > 0) throw new Error(`${missing.length} gold segments are in no chunk`);

  const textBytes = chunks.reduce((a, c) => a + Buffer.byteLength(c.text), 0);
  const transcriptBytes = corpus.meetings.reduce(
    (a, m) => a + m.segments.reduce((b, s) => b + Buffer.byteLength(s.text), 0),
    0,
  );
  const vecDims = 768;

  // ---- FTS5 channels ---------------------------------------------------------------
  const ftsDir = join(stack.dir, "fts");
  const word = buildFts(ftsDir, "word", chunks);
  const tri = buildFts(ftsDir, "trigram", chunks);
  const wordNc = buildFts(ftsDir, "word", chunks, true);
  const triNc = buildFts(ftsDir, "trigram", chunks, true);
  log(`FTS built: word ${word.bytes} B, trigram ${tri.bytes} B (contentless ${wordNc.bytes} / ${triNc.bytes})`);

  // ---- cold and warm dense latency ---------------------------------------------------
  await stack.mod.stopMlxEmbedWorker();
  const q0 = gold.retrieval[0] as (typeof gold.retrieval)[number];
  const tc = performance.now();
  await stack.mod.retrieve({ query: { kind: "text", text: q0.text }, scope: { kind: "all" }, k: 8 });
  const coldMs = performance.now() - tc;
  log(`cold first query (worker load included): ${Math.round(coldMs)} ms`);

  // ---- the pass ---------------------------------------------------------------------------
  const passes: QueryPass[] = await runPass(stack, corpus, chunks, gold.retrieval, word, tri, st.modelId, log, () => rss.sample());
  rss.stop();

  // ---- R1: the reranker (a separate process, GPU lock held by the caller) ---------------
  const rerankRoot = process.env.CHAT_EVAL_RERANKER_HOME ?? "/tmp/chatp0/hf-r1/hub/models--Qwen--Qwen3-Reranker-0.6B/snapshots";
  const rerankDir = existsSync(rerankRoot) ? join(rerankRoot, readdirSync(rerankRoot)[0] ?? "") : "";
  let rerank: RerankStats | null = null;
  if (rerankDir && existsSync(join(rerankDir, "config.json"))) {
    rerank = runRerank(passes, chunks, stack.dir, rerankDir, process.env.CHAT_EVAL_PYTHON ?? "/tmp/chatp0/venv/bin/python");
    log(`R1 done: load ${Math.round(rerank.loadMs)} ms, rss ${Math.round(rerank.rssMb)} MB, wall ${Math.round(rerank.wallMs)} ms`);
  } else {
    log("R1 skipped: no reranker model folder");
  }
  const ARMS = ALL_ARMS.filter((a) => a.fusion !== "rerank" || rerank !== null);

  // ---- scope and date check on the 190 questions (spec 7.1 measure) ------------------------
  const scopeCheck = await scopeExperiment(stack, corpus, gold, chunks);

  // ---- tables -------------------------------------------------------------------------------------
  const langs: (Lang | "all")[] = ["all", "en", "pt"];
  const rows: Record<string, unknown>[] = [];
  const runs: RunOut[] = [];
  let text = "";
  const header = `| arm | desc | lang | n | r@1 | r@5 | r@10 | r@10 any | MRR@10 | nDCG@10 | meeting@10 |\n|---|---|---|---|---|---|---|---|---|---|---|\n`;
  text += `Corpus ${hashes.corpus}, gold ${hashes.gold}; ${corpus.meetings.length} meetings, ${chunks.length} chunks (${[...kinds].map(([k, n]) => `${k} ${n}`).join(", ")}).\n\n`;
  text += header;
  for (const arm of ARMS) {
    const metrics: Record<string, number> = {};
    for (const lang of langs) {
      const mm = metricsOf(passes, arm, (p) => lang === "all" || p.q.lang === lang);
      text += `| ${arm.id} | ${arm.desc} | ${lang} | ${mm.n} | ${pct(mm.r1)} | ${pct(mm.r5)} | ${pct(mm.r10)} | ${pct(mm.r10any)} | ${f2(mm.mrr10)} | ${f2(mm.ndcg10)} | ${pct(mm.meeting10)} |\n`;
      rows.push({ arm: arm.id, lang, ...mm });
      for (const [k, v] of Object.entries(mm)) if (k !== "n") metrics[`${k}.${lang}`] = v;
      for (const slice of SLICES) {
        const ms = metricsOf(passes, arm, (p) => p.q.slice === slice && (lang === "all" || p.q.lang === lang));
        metrics[`ndcg10.${slice}.${lang}`] = ms.ndcg10;
        metrics[`r10.${slice}.${lang}`] = ms.r10;
        rows.push({ arm: arm.id, lang, slice, ...ms });
      }
    }
    const lat = latencyOf(passes, arm);
    metrics["latency_ms.p50"] = lat.p50;
    metrics["latency_ms.p95"] = lat.p95;
    runs.push({
      name: `retrieval-${arm.id}`,
      params: { arm: arm.id, desc: arm.desc, channels: arm.channels.join("+"), fusion: arm.fusion, queries: passes.length, k: 50 },
      tags: { "chat.stage": "retrieval", "chat.corpus_hash": hashes.corpus, "chat.gold_hash": hashes.gold, "chat.embed_model": st.modelId },
      metrics,
    });
  }
  text += `\nPer slice (nDCG@10 / recall@10), all languages:\n\n| arm | ${SLICES.join(" | ")} |\n|---|${SLICES.map(() => "---").join("|")}|\n`;
  for (const arm of ARMS) {
    const cells = SLICES.map((s) => {
      const m = metricsOf(passes, arm, (p) => p.q.slice === s);
      return `${f2(m.ndcg10)} / ${pct(m.r10)}`;
    });
    text += `| ${arm.id} | ${cells.join(" | ")} |\n`;
  }
  text += `\nLatency per query (ms; channels run one after the other; dense includes the embed of the query):\n\n| arm | p50 | p95 |\n|---|---|---|\n`;
  for (const arm of ARMS) {
    const l = latencyOf(passes, arm);
    text += `| ${arm.id} | ${l.p50.toFixed(1)} | ${l.p95.toFixed(1)} |\n`;
  }
  const dms = passes.map((p) => p.dense.ms);
  const wms = passes.map((p) => p.word.ms);
  const tms = passes.map((p) => p.tri.ms);
  text += `\nChannels p50/p95 ms: dense ${percentile(dms, 50).toFixed(1)}/${percentile(dms, 95).toFixed(1)}, bm25 word ${percentile(wms, 50).toFixed(2)}/${percentile(wms, 95).toFixed(2)}, bm25 trigram ${percentile(tms, 50).toFixed(2)}/${percentile(tms, 95).toFixed(2)}. Cold first query ${Math.round(coldMs)} ms.\n`;
  if (rerank) text += `\nReranker R1 (${rerank.model}, ${rerank.candidates} candidates per query): load ${Math.round(rerank.loadMs)} ms, peak RSS ${Math.round(rerank.rssMb)} MB, added time per query p50 ${percentile(passes.map((p) => (p.rerank?.R1?.ms ?? 0) - rankArm(p, ALL_ARMS.find((a) => a.id === "H1") as ArmSpec).ms), 50).toFixed(0)} ms, p95 ${percentile(passes.map((p) => (p.rerank?.R1?.ms ?? 0) - rankArm(p, ALL_ARMS.find((a) => a.id === "H1") as ArmSpec).ms), 95).toFixed(0)} ms.\n`;
  text += `\nRAM of the embed worker (RSS, sampled after each meeting and every 10 queries): peak ${rss.peakMb} MB over ${rss.samples.length} samples.\n`;
  text += `\nIndex: ${chunks.length} chunks, text ${textBytes} B (transcript ${transcriptBytes} B). Embedding ${(indexMs / 1000).toFixed(1)} s for ${audioHours.toFixed(2)} h of meetings = ${(indexMs / 1000 / 3600 / audioHours * 3600).toFixed(0)} s per audio hour. Vectors int8 ${vecDims} dims = ${chunks.length * vecDims} B.\n`;
  const ratio = (b: number) => (b / transcriptBytes).toFixed(2);
  text += `FTS5 size / transcript text: word with content ${word.bytes} B (${ratio(word.bytes)}x), trigram with content ${tri.bytes} B (${ratio(tri.bytes)}x), word contentless ${wordNc.bytes} B (${ratio(wordNc.bytes)}x), trigram contentless ${triNc.bytes} B (${ratio(triNc.bytes)}x). FTS build ${word.buildMs.toFixed(0)} ms (word), ${tri.buildMs.toFixed(0)} ms (trigram).\n`;
  text += `\n${scopeCheck.text}`;

  void statSync;
  void mean;
  return {
    text,
    result: {
      hashes,
      rows,
      latency: Object.fromEntries(ARMS.map((a) => [a.id, latencyOf(passes, a)])),
      coldMs,
      rssPeakMb: rss.peakMb,
      rerank,
      indexMs,
      audioHours,
      chunks: chunks.length,
      textBytes,
      transcriptBytes,
      fts: { word: word.bytes, trigram: tri.bytes, wordContentless: wordNc.bytes, trigramContentless: triNc.bytes },
      scope: scopeCheck.data,
      perQuery: passes.map((p) => ({
        id: p.q.id,
        slice: p.q.slice,
        lang: p.q.lang,
        arms: Object.fromEntries(ARMS.map((a) => [a.id, rankArm(p, a).ids.slice(0, 10).map((id) => p.grades.get(id) ?? 0)])),
      })),
    },
    runs: [
      ...runs,
      {
        name: "retrieval-index-cost",
        params: { stage: "index" },
        tags: { "chat.stage": "retrieval", "chat.corpus_hash": hashes.corpus, "chat.gold_hash": hashes.gold },
        metrics: {
          chunks: chunks.length,
          embed_rss_peak_mb: rss.peakMb,
          cold_first_query_ms: coldMs,
          index_s_per_audio_hour: (indexMs / 1000) / audioHours,
          fts_word_bytes: word.bytes,
          fts_trigram_bytes: tri.bytes,
          fts_word_contentless_bytes: wordNc.bytes,
          fts_trigram_contentless_bytes: triNc.bytes,
          transcript_bytes: transcriptBytes,
        },
      },
    ],
  };
}

/**
 * Spec 7.1 measure: recall@8 of the gold segment for questions with a meeting or
 * folder scope or a date range. "Before" runs the unscoped search and filters
 * after (k=50, then the scope, then the top 8). "After" passes the filter into
 * retrieve().
 */
async function scopeExperiment(
  stack: Awaited<ReturnType<typeof bootStack>>,
  corpus: Corpus,
  gold: GoldSet,
  chunks: ChunkRow[],
): Promise<{ text: string; data: unknown }> {
  const DAY = 86_400_000;
  const qs = gold.questions.filter(
    (q) =>
      q.gold.length > 0 &&
      q.history.length === 0 &&
      (q.scope.kind === "meeting" || (q.scope.kind === "folder" && q.type !== "aggregation") || q.args.date_from) &&
      ["lookup", "who_said", "temporal", "knowledge_update"].includes(q.type),
  );
  const meetingOf = new Map(corpus.meetings.map((m) => [m.id, m]));
  const inScope = (q: (typeof qs)[number], mid: string) => {
    if (q.scope.kind === "meeting") return mid === q.scope.id;
    if (q.scope.kind === "folder") return meetingOf.get(mid)?.folderId === q.scope.id;
    return true;
  };
  const range = (q: (typeof qs)[number]) =>
    typeof q.args.date_from === "string" && typeof q.args.date_to === "string"
      ? { fromMs: Date.parse(`${q.args.date_from}T00:00:00Z`), toMs: Date.parse(`${q.args.date_to}T00:00:00Z`) + DAY }
      : undefined;
  const rec = { before: [] as number[], after: [] as number[] };
  const byKind: Record<string, { before: number[]; after: number[] }> = {};
  for (const q of qs) {
    const grades = gradesFor(q, chunks, corpus);
    const hit = (ids: number[]) => (ids.slice(0, 8).some((id) => grades.get(id) === 2) ? 1 : 0);
    const r = range(q);
    const unscoped = await stack.mod.retrieve({ query: { kind: "text", text: q.text }, scope: { kind: "all" }, k: 50 });
    const scoped = await stack.mod.retrieve({
      query: { kind: "text", text: q.text },
      scope:
        q.scope.kind === "meeting"
          ? { kind: "meeting", meetingId: q.scope.id as string }
          : q.scope.kind === "folder"
            ? { kind: "folder", folderId: q.scope.id as string }
            : { kind: "all" },
      k: 8,
      ...(r ? { dateRange: r } : {}),
    });
    if (unscoped.status !== "ok" || scoped.status !== "ok") throw new Error("scope experiment: retrieve failed");
    const before = hit(
      unscoped.hits
        .filter((h) => inScope(q, h.meetingId))
        .filter((h) => !r || ((meetingOf.get(h.meetingId)?.startedAt ?? 0) >= r.fromMs && (meetingOf.get(h.meetingId)?.startedAt ?? 0) < r.toMs))
        .map((h) => h.chunkId),
    );
    const after = hit(scoped.hits.map((h) => h.chunkId));
    rec.before.push(before);
    rec.after.push(after);
    const key = q.scope.kind === "meeting" ? "meeting scope" : q.scope.kind === "folder" ? "folder scope" : "date only";
    (byKind[key] ??= { before: [], after: [] }).before.push(before);
    (byKind[key] as { before: number[]; after: number[] }).after.push(after);
  }
  const lines = [
    `Scope and date filter inside retrieve() (spec 7.1 measure), recall@8 of the gold segment on ${qs.length} questions with a scope or a date range:`,
    ``,
    `| group | n | before (search all, filter after, top 8 of 50) | after (filter in retrieve, k=8) |`,
    `|---|---|---|---|`,
    ...Object.entries(byKind).map(([k, v]) => `| ${k} | ${v.before.length} | ${pct(mean(v.before))} | ${pct(mean(v.after))} |`),
    `| all | ${rec.before.length} | ${pct(mean(rec.before))} | ${pct(mean(rec.after))} |`,
    ``,
  ];
  return { text: lines.join("\n"), data: { n: qs.length, before: mean(rec.before), after: mean(rec.after), byKind } };
}

export type { ArmSpec };
