// retrieve-prod.mts: measures the PRODUCTION retrieve() (specs/meeting-chat-agent.md
// 7.4, phase P1) on the P0 corpus and its 147 retrieval queries: dense, hybrid,
// hybrid + rerank 15 and hybrid + rerank 30, then the rerank worker alone for
// several batch sizes. Fictional data only. May be replaced by the P1 harness.
//
//   RETRIEVE_PROD_WORKER=<launcher script> pnpm chat-eval-prod   (see the skill)
//   node --import ./scripts/meeting-v2/ts-register.mjs --import ./scripts/meeting-v2/ts-transform.mjs scripts/chat-eval/retrieve-prod.mts
//
// Needs the embed model and the Qwen3-Reranker-0.6B snapshot in one HF cache:
// OPENSTYLE_EVAL_HF_HOME=<folder with hub/models--...>. Takes the GPU lock.

import process from "node:process";
import { releaseLock, takeLock, unqueue } from "../meeting-v2/eval/runtime.mts";
import { buildCorpus } from "./corpus.mts";
import { buildGold } from "./gold.mts";
import { mean, ndcgAt, percentile, recallAt } from "./keys.mts";
import { chunkMeeting, gradesFor, loadChunks } from "./retrieval.mts";
import { bootStack, EMBED_MODEL_ID, loadCorpus, RssSampler } from "./stack.mts";

const f2 = (x: number) => x.toFixed(3);
const ms = (x: number) => `${Math.round(x)}`;
const DAY = 86_400_000;

async function main(): Promise<void> {
  const worker = process.env.RETRIEVE_PROD_WORKER;
  if (!worker) throw new Error("set RETRIEVE_PROD_WORKER to a launcher");
  const corpus = buildCorpus();
  const gold = buildGold(corpus);
  await takeLock("wp-r-p1", 40);
  try {
    const stack = await bootStack("retrieve-prod", true);
    process.env.OPENSTYLE_MLX_EMBED_WORKER = worker;
    process.env.OPENSTYLE_MLX_RERANK_WORKER = worker;
    loadCorpus(stack, corpus);
    stack.mod.writeSetting("search_embedding_model", EMBED_MODEL_ID);
    const rss = new RssSampler(/--embed|--rerank/, 2000);
    const rssRerank = new RssSampler(/--rerank/, 2000);
    rss.start();
    rssRerank.start();
    for (const m of corpus.meetings) await stack.mod.indexMeeting(m.id);
    const chunks = loadChunks(stack, EMBED_MODEL_ID);
    for (const c of chunks) chunkMeeting.set(c.id, c.meetingId);
    console.log(`indexed ${chunks.length} chunks`);

    const rangeOf = (q: (typeof gold.retrieval)[number]) =>
      q.dateFrom && q.dateTo
        ? {
            fromMs: Date.parse(`${q.dateFrom}T00:00:00Z`),
            toMs: Date.parse(`${q.dateTo}T00:00:00Z`) + DAY,
          }
        : undefined;
    const call = (
      q: (typeof gold.retrieval)[number],
      extra: Record<string, unknown>,
    ) => {
      const range = rangeOf(q);
      return stack.mod.retrieve({
        query: { kind: "text", text: q.text },
        scope: { kind: "all" },
        k: 50,
        ...(range ? { dateRange: range } : {}),
        ...extra,
      } as Parameters<typeof stack.mod.retrieve>[0]);
    };

    const withRerank = (candidates: number, batch?: number) => ({
      mode: "hybrid",
      rerank: { candidates, ...(batch ? { batch } : {}) },
    });
    const arms: [string, Record<string, unknown>][] = [
      ["dense", {}],
      ["hybrid", { mode: "hybrid" }],
      ["hybrid+rerank15 batch1", withRerank(15, 1)],
      ["hybrid+rerank15 default", withRerank(15)],
      ["hybrid+rerank30 batch1", withRerank(30, 1)],
      ["hybrid+rerank30 default", withRerank(30)],
    ];
    const slices = ["names", "numbers", "concept", "asr_names", "date"];
    console.log(
      "| arm | nDCG@10 | r@10 | " +
        slices.map((s) => `${s} nDCG`).join(" | ") +
        " | p50 ms | p95 ms | rerank applied |",
    );
    console.log(
      `|---|---|---|${slices.map(() => "---|").join("")}---|---|---|`,
    );
    const warm = gold.retrieval[0] as (typeof gold.retrieval)[number];
    for (const [name, extra] of arms) {
      for (let i = 0; i < 3; i++) await call(warm, extra); // warm up the workers
      const rows: { slice: string; ndcg: number; r10: number }[] = [];
      const times: number[] = [];
      let applied = 0;
      for (const q of gold.retrieval) {
        const grades = gradesFor(q, chunks, corpus);
        const ideal = [...grades.values()].sort((a, b) => b - a);
        const t0 = performance.now();
        const res = await call(q, extra);
        times.push(performance.now() - t0);
        if (res.status !== "ok")
          throw new Error(`${name} ${q.id}: ${res.status}`);
        if (res.rerank === "applied") applied++;
        const g = res.hits.map((h) => grades.get(h.chunkId) ?? 0);
        rows.push({
          slice: q.slice,
          ndcg: ndcgAt(g, ideal, 10),
          r10: recallAt(g, 10),
        });
        rss.sample();
        rssRerank.sample();
      }
      const per = slices.map((s) =>
        f2(mean(rows.filter((r) => r.slice === s).map((r) => r.ndcg))),
      );
      console.log(
        `| ${name} | ${f2(mean(rows.map((r) => r.ndcg)))} | ${f2(mean(rows.map((r) => r.r10)))} | ${per.join(" | ")} | ${ms(percentile(times, 50))} | ${ms(percentile(times, 95))} | ${applied}/${rows.length} |`,
      );
    }

    // The rerank worker alone: the added time per query for the batch sizes.
    const rr = await import("../../apps/server/src/lib/mlx-rerank/client.ts");
    console.log("\nrerank worker alone (ms per query, 147 queries):");
    console.log(
      "| candidates | batch | p50 | p95 | max | max score diff vs batch 1 |",
    );
    console.log("|---|---|---|---|---|---|");
    const sets: { query: string; docs: string[] }[] = [];
    for (const q of gold.retrieval) {
      const res = await call(q, { mode: "hybrid" });
      if (res.status !== "ok") continue;
      sets.push({
        query: q.text,
        docs: res.hits.slice(0, 30).map((h) => stack.mod.hitText(h, 3000)),
      });
    }
    for (const cand of [15, 30]) {
      const ref: number[][] = [];
      for (const batch of [1, 4, 8, 15, 30]) {
        if (batch > cand) continue;
        const times: number[] = [];
        let diff = 0;
        let idx = 0;
        for (const s of sets) {
          const docs = s.docs.slice(0, cand);
          const t0 = performance.now();
          const scores = await rr.rerankPairs(s.query, docs, undefined, batch);
          times.push(performance.now() - t0);
          if (batch === 1) ref.push(scores);
          else
            diff = Math.max(
              diff,
              ...scores.map((x, i) => Math.abs(x - (ref[idx]?.[i] ?? x))),
            );
          idx++;
          rss.sample();
          rssRerank.sample();
        }
        console.log(
          `| ${cand} | ${batch} | ${ms(percentile(times, 50))} | ${ms(percentile(times, 95))} | ${ms(Math.max(...times))} | ${batch === 1 ? "-" : diff.toExponential(2)} |`,
        );
      }
    }
    rss.stop();
    rssRerank.stop();
    console.log(
      `\npeak RSS: embed + rerank workers ${rss.peakMb} MB, rerank worker alone ${rssRerank.peakMb} MB`,
    );
    await stack.mod.stopMlxEmbedWorker();
    const srv = await import("../../apps/server/src/lib/mlx-rerank/server.ts");
    await srv.stopMlxRerankWorker();
  } finally {
    releaseLock();
    unqueue();
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    releaseLock();
    unqueue();
    process.exit(1);
  },
);
