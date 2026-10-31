// run.mts: the command line of the chat eval (specs/meeting-chat-agent.md
// section 8 and 9.1, phase P0). Run from the repo root:
//
//   pnpm chat-eval corpus                 build the corpus and the gold set, print counts and hashes
//   pnpm chat-eval retrieval [--no-mlflow] arms V0, H1, H2, H3 (+ scope/date check), MLflow
//   pnpm chat-eval router [--no-mlflow]   router arms A1, A3, A5, T1 on Gemma 4 E2B
//
// The corpus is fictional. The scratch profile is /tmp/chatp0/run/<name>. The
// results go to ~/.openstyle-eval/chat-p0/ (numbers and fictional ids only).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { releaseLock, takeLock, unqueue } from "../meeting-v2/eval/runtime.mts";
import { buildCorpus } from "./corpus.mts";
import { buildGold } from "./gold.mts";
import { logRun } from "./mlflow.mts";
import { runRetrieval } from "./retrieval-run.mts";
import { runRouter } from "./router-run.mts";
import { OUT, sha } from "./stack.mts";

const flag = (n: string) => process.argv.includes(`--${n}`);

export function corpusInfo() {
  const corpus = buildCorpus();
  const gold = buildGold(corpus);
  const byType: Record<string, number> = {};
  for (const q of gold.questions) byType[q.type] = (byType[q.type] ?? 0) + 1;
  const bySlice: Record<string, number> = {};
  for (const q of gold.retrieval) bySlice[q.slice] = (bySlice[q.slice] ?? 0) + 1;
  return {
    corpus,
    gold,
    hashes: { corpus: sha(corpus).slice(0, 16), gold: sha(gold).slice(0, 16) },
    counts: {
      meetings: corpus.meetings.length,
      segments: corpus.meetings.reduce((a, m) => a + m.segments.length, 0),
      facts: corpus.facts.length,
      questions: gold.questions.length,
      retrieval: gold.retrieval.length,
      byType,
      bySlice,
    },
  };
}

async function main() {
  const cmd = process.argv[2] ?? "";
  mkdirSync(OUT, { recursive: true, mode: 0o700 });
  if (cmd === "corpus") {
    const info = corpusInfo();
    console.log(JSON.stringify({ hashes: info.hashes, counts: info.counts }, null, 1));
    if (flag("write")) {
      writeFileSync(join(OUT, "corpus.json"), JSON.stringify(info.corpus));
      writeFileSync(join(OUT, "gold.json"), JSON.stringify(info.gold));
      console.log(`written to ${OUT}`);
    }
    return;
  }
  if (cmd === "retrieval" || cmd === "router") {
    const info = corpusInfo();
    const mlflow = !flag("no-mlflow");
    await takeLock(`chat-eval-${cmd}`, 45);
    try {
      const res =
        cmd === "retrieval"
          ? await runRetrieval(info.corpus, info.gold, info.hashes)
          : await runRouter(info.corpus, info.gold, info.hashes);
      writeFileSync(join(OUT, `${cmd}-${Date.now()}.json`), JSON.stringify(res.result, null, 1));
      console.log(res.text);
      if (mlflow) {
        for (const r of res.runs) {
          const out = await logRun(r.name, r.params, r.tags, r.metrics);
          console.log(`MLflow ${out.experiment} run ${out.runId} ${r.name}: ${out.n} metrics, READ BACK OK`);
        }
      }
    } finally {
      releaseLock();
      unqueue();
    }
    return;
  }
  console.error("usage: pnpm chat-eval corpus [--write] | retrieval [--no-mlflow] | router [--no-mlflow]");
  process.exitCode = 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    () => process.exit(process.exitCode ?? 0),
    (e) => {
      console.error(e);
      releaseLock();
      unqueue();
      process.exit(1);
    },
  );
}
