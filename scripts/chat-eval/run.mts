// run.mts: the command line of the chat eval (specs/meeting-chat-agent.md
// section 8 and 9.1, phase P0). Run from the repo root:
//
//   pnpm chat-eval corpus                 build the corpus and the gold set, print counts and hashes
//   pnpm chat-eval retrieval [--no-mlflow] arms V0, H1, H2, H3 (+ scope/date check), MLflow
//   pnpm chat-eval router [--no-mlflow]   router arms A1, A3, A5, T1 on Gemma 4 E2B
//   pnpm chat-eval p1 [--no-mlflow] [--only a,b] [--limit N] [--scale N]
//                                         the P1 eval: the P0 gold set through the P1 stack
//
// The corpus is fictional. The scratch profile is /tmp/chatp0/run/<name>. The
// results go to ~/.openstyle-eval/chat-p0/ (numbers and fictional ids only).

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { releaseLock, takeLock, unqueue } from "../meeting-v2/eval/runtime.mts";
import { runA0 } from "./a0-run.mts";
import { buildCorpus } from "./corpus.mts";
import { buildGold } from "./gold.mts";
import { EXPERIMENT_P1, logRun } from "./mlflow.mts";
import { PARTS, type Part, runP1 } from "./p1-run.mts";
import { runRetrieval } from "./retrieval-run.mts";
import { runRouter } from "./router-run.mts";
import { OUT, sha } from "./stack.mts";

const flag = (n: string) => process.argv.includes(`--${n}`);
const flagNum = (n: string): number | undefined => {
  const i = process.argv.indexOf(`--${n}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : Number.NaN;
  return Number.isFinite(v) ? v : undefined;
};

export function corpusInfo(seed?: number) {
  const corpus = buildCorpus(seed);
  const gold = buildGold(corpus);
  const byType: Record<string, number> = {};
  for (const q of gold.questions) byType[q.type] = (byType[q.type] ?? 0) + 1;
  const bySlice: Record<string, number> = {};
  for (const q of gold.retrieval)
    bySlice[q.slice] = (bySlice[q.slice] ?? 0) + 1;
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
    console.log(
      JSON.stringify({ hashes: info.hashes, counts: info.counts }, null, 1),
    );
    if (flag("write")) {
      writeFileSync(join(OUT, "corpus.json"), JSON.stringify(info.corpus));
      writeFileSync(join(OUT, "gold.json"), JSON.stringify(info.gold));
      console.log(`written to ${OUT}`);
    }
    return;
  }
  if (cmd === "retrieval" || cmd === "router" || cmd === "a0") {
    const info = corpusInfo();
    const mlflow = !flag("no-mlflow");
    await takeLock(`chat-eval-${cmd}`, 45);
    try {
      const res =
        cmd === "a0"
          ? await runA0(info.corpus, info.gold, info.hashes)
          : cmd === "retrieval"
            ? await runRetrieval(
                info.corpus,
                info.gold,
                info.hashes,
                Number(process.argv[process.argv.indexOf("--scale") + 1]) || 1,
              )
            : await runRouter(info.corpus, info.gold, info.hashes);
      writeFileSync(
        join(OUT, `${cmd}-${Date.now()}.json`),
        JSON.stringify(res.result, null, 1),
      );
      console.log(res.text);
      if (mlflow) {
        for (const r of res.runs) {
          const out = await logRun(r.name, r.params, r.tags, r.metrics);
          console.log(
            `MLflow ${out.experiment} run ${out.runId} ${r.name}: ${out.n} metrics, READ BACK OK`,
          );
        }
      }
    } finally {
      releaseLock();
      unqueue();
    }
    return;
  }
  if (cmd === "p1") {
    const info = corpusInfo(flagNum("seed"));
    const mlflow = !flag("no-mlflow");
    const arg = (n: string) => {
      const i = process.argv.indexOf(`--${n}`);
      return i < 0 ? null : (process.argv[i + 1] ?? null);
    };
    const onlyArg = arg("only");
    const only = onlyArg
      ? new Set(onlyArg.split(",").map((x) => x.trim()) as Part[])
      : null;
    for (const p of only ?? [])
      if (!(PARTS as readonly string[]).includes(p))
        throw new Error(`unknown part ${p}; parts: ${PARTS.join(", ")}`);
    const outDir = join(homedir(), ".openstyle-eval", "chat-p1");
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    const file = join(outDir, `p1-${Date.now()}.json`);
    await takeLock("chat-eval-p1", 45);
    const failed: string[] = [];
    try {
      const res = await runP1(
        info.corpus,
        info.gold,
        info.hashes,
        {
          only,
          limit: Number(arg("limit")) || null,
          scale: Number(arg("scale")) || (only?.has("scale") ? 256 : 1),
        },
        async (r) => {
          if (!mlflow) return;
          try {
            const out = await logRun(
              r.name,
              r.params,
              r.tags,
              r.metrics,
              EXPERIMENT_P1,
            );
            console.log(
              `MLflow ${out.experiment} run ${out.runId} ${r.name}: ${out.n} metrics, READ BACK OK`,
            );
          } catch (e) {
            failed.push(`${r.name}: ${(e as Error).message}`);
            console.error(`MLflow ${r.name} FAILED: ${(e as Error).message}`);
          }
        },
        (partial) => writeFileSync(file, JSON.stringify(partial, null, 1)),
      );
      writeFileSync(file, JSON.stringify(res.result, null, 1));
      console.log(`result file: ${file}`);
      if (failed.length > 0) process.exitCode = 1;
    } finally {
      releaseLock();
      unqueue();
    }
    return;
  }
  console.error(
    "usage: pnpm chat-eval corpus [--write] | retrieval [--no-mlflow] | router [--no-mlflow] | p1 [--no-mlflow] [--only a,b] [--limit N] [--scale N]",
  );
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
