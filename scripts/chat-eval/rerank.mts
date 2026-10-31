// rerank.mts: arm R1 (spec 7.4.3). The candidates of the H1 arm go to a
// Qwen3 reranker under MLX (rerank.py, one forward pass per pair). The
// candidate text is the text the indexer embedded. Latency is the reranker
// time per query; the load time and the peak RSS come from the process.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ARMS, type ChunkRow, type QueryPass, rankArm } from "./retrieval.mts";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface RerankStats {
  model: string;
  candidates: number;
  loadMs: number;
  rssMb: number;
  wallMs: number;
}

export function runRerank(
  passes: QueryPass[],
  chunks: ChunkRow[],
  dir: string,
  modelDir: string,
  python: string,
  candidates = 30,
): RerankStats {
  const text = new Map(chunks.map((c) => [c.id, c.text]));
  const base = ARMS.find((a) => a.id === "H1");
  if (!base) throw new Error("no H1 arm");
  const queries = passes.map((p) => ({
    id: p.q.id,
    query: p.q.text,
    docs: rankArm(p, base)
      .ids.slice(0, candidates)
      .map((id) => ({ id, text: text.get(id) ?? "" })),
  }));
  const inP = join(dir, "r1-in.json");
  const outP = join(dir, "r1-out.json");
  writeFileSync(inP, JSON.stringify({ queries }));
  const t0 = performance.now();
  const r = spawnSync(
    python,
    ["-I", join(HERE, "rerank.py"), modelDir, inP, outP],
    {
      encoding: "utf8",
      env: { ...process.env, HF_HUB_OFFLINE: "1" },
      maxBuffer: 1 << 26,
    },
  );
  const wallMs = performance.now() - t0;
  if (r.status !== 0 || !existsSync(outP))
    throw new Error(`rerank.py failed: ${`${r.stderr}`.slice(-600)}`);
  const out = JSON.parse(readFileSync(outP, "utf8")) as {
    load_ms: number;
    rss_mb: number;
    queries: { id: string; ms: number; scores: Record<string, number> }[];
  };
  const byId = new Map(out.queries.map((q) => [q.id, q]));
  for (const p of passes) {
    const q = byId.get(p.q.id);
    if (!q) throw new Error(`no rerank scores for ${p.q.id}`);
    const h1 = rankArm(p, base);
    p.rerank = {};
    // The pairs are scored one after the other, so the first N pairs of the 30
    // give the order of an N-candidate run, and its time is about N/30 of the run.
    for (const arm of ARMS.filter((a) => a.fusion === "rerank")) {
      const n = Math.min(candidates, arm.rerankN ?? candidates);
      const head = h1.ids.slice(0, n);
      const sorted = [...head].sort(
        (a, b) =>
          (q.scores[String(b)] ?? 0) - (q.scores[String(a)] ?? 0) || a - b,
      );
      p.rerank[arm.id] = {
        ids: [...sorted, ...h1.ids.slice(n)],
        ms: (q.ms * n) / candidates + h1.ms,
      };
    }
  }
  return {
    model: modelDir.split("/").slice(-3)[0] ?? "",
    candidates,
    loadMs: out.load_ms,
    rssMb: out.rss_mb,
    wallMs,
  };
}
