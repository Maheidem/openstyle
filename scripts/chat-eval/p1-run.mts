// p1-run.mts: the P1 eval of the meeting chat agent (specs/meeting-chat-agent.md
// 8, P0 report section 7 and 9). It runs the P0 gold set through the P1
// production code in this process, on a scratch profile (no mock):
//   retrieval  the 147 queries through the production retrieve()
//   router     the production router prompt on the gold and the blind set
//   slots      the production slot fill with the gold intent
//   e2e        the full production pipeline runChatTurn on the 190 questions
//   a0         the A0 numbers on the same question ids
//   scale      (only with --scale N) retrieve() latency at N x the corpus
//   bars       the table of pass bars from the runs of this invocation
// Every part is one MLflow run named p1-<part> (run.mts logs and reads back).
// The corpus is fictional.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { buildCorpus } from "./corpus.mts";
import { buildThreads } from "./gold.mts";
import {
  mean,
  ndcgAt,
  percentile,
  recallAt,
  scoreAnswer,
  scoreSet,
} from "./keys.mts";
import {
  answerFromTurn,
  barsTable,
  buildIdMaps,
  checkCites,
  citeCounts,
  confusion,
  evaluateBars,
  firstTool,
  goldSpans,
  type IdMaps,
  nativeOutcome,
  scoreProdSlots,
  scoreToolArgs,
} from "./p1-score.mts";
import { runThread, summarize as summarizeThreads } from "./p1-threads.mts";
import { gradesFor, loadChunks } from "./retrieval.mts";
import type { RunOut } from "./retrieval-run.mts";
import { heldoutRouterItems } from "./router-data.mts";
import {
  bootStack,
  EMBED_MODEL_ID,
  loadCorpus,
  OUT,
  RssSampler,
  type Stack,
} from "./stack.mts";
import type {
  Corpus,
  GoldSet,
  Intent,
  Lang,
  Question,
  QuestionType,
} from "./types.mts";

export const PARTS = [
  "retrieval",
  "router",
  "slots",
  "e2e",
  "threads",
  "a0",
  "scale",
  "bars",
] as const;
export type Part = (typeof PARTS)[number];

export interface P1Options {
  /** null = the default parts (all but scale; scale runs with --scale N). */
  only: Set<Part> | null;
  /** Pick N items spread over each set (smoke test). */
  limit: number | null;
  scale: number;
}

export interface P1Result {
  text: string;
  result: Record<string, unknown>;
  runs: RunOut[];
}

// Any built-in catalog id (apps/server/src/lib/mlx-llm/constants.ts). E2B is the floor.
const MODEL_ID = process.env.CHAT_EVAL_MODEL ?? "gemma-4-e2b-qat-4bit";
const LLM_STORED_ID = `local-mlx-llm/${MODEL_ID}`;
// An OpenAI-compatible server (llama.cpp, oMLX, ...) for the chat LLM instead
// of the built-in MLX worker. The app's own-server provider carries the call:
// CHAT_EVAL_BASE_URL is the server address, CHAT_EVAL_MODEL the model name the
// server lists. The address is read from the environment only (never logged).
const BASE_URL = process.env.CHAT_EVAL_BASE_URL?.trim() || null;
const BACKEND =
  process.env.CHAT_EVAL_BACKEND?.trim() ||
  (BASE_URL ? "remote-openai" : "mac-mlx");
const DAY = 86_400_000;
const f3 = (x: number) => x.toFixed(3);
const pct = (x: number) => `${(x * 100).toFixed(1)}`;
const ms0 = (x: number) => `${Math.round(x)}`;
const safe = (s: string) => s.replace(/[^A-Za-z0-9_]+/g, "_");

/** N items spread evenly over a list (all of them when N is null or large). */
function spread<T>(xs: T[], n: number | null): T[] {
  if (n === null || n >= xs.length) return xs;
  const out: T[] = [];
  for (let i = 0; i < n; i++)
    out.push(xs[Math.floor((i * xs.length) / n)] as T);
  return out;
}

const sha16 = (x: unknown) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex").slice(0, 16);

interface Env {
  stack: Stack;
  corpus: Corpus;
  gold: GoldSet;
  hashes: { corpus: string; gold: string };
  maps: IdMaps;
  mods: {
    pipeline: typeof import("../../apps/server/src/lib/chat/pipeline.ts");
    llm: typeof import("../../apps/server/src/lib/chat/llm.ts");
    settings: typeof import("../../apps/server/src/lib/chat/settings.ts");
    prompts: typeof import("../../apps/server/src/lib/chat/prompts.ts");
    plan: typeof import("../../apps/server/src/lib/chat/plan.ts");
    choices: typeof import("../../apps/server/src/lib/chat/choices.ts");
    context: typeof import("../../apps/server/src/lib/chat/context.ts");
    rerankConst: typeof import("../../apps/server/src/lib/mlx-rerank/constants.ts");
    llmServer: typeof import("../../apps/server/src/lib/mlx-llm/server.ts");
    rerankServer: typeof import("../../apps/server/src/lib/mlx-rerank/server.ts");
  };
  log: (s: string) => void;
  opts: P1Options;
  /** Set by the driver when the corpus is indexed (retrieval, e2e and scale need it). */
  index: { indexMs: number; chunks: ReturnType<typeof loadChunks> } | null;
}

interface PartOut {
  text: string;
  data: unknown;
  run: RunOut;
}

function baseTags(env: Env, arm: string): Record<string, string> {
  return {
    "chat.stage": "p1",
    "chat.corpus_hash": env.hashes.corpus,
    "chat.gold_hash": env.hashes.gold,
    "chat.model": MODEL_ID,
    backend: BACKEND,
    model: MODEL_ID,
    "chat.embed_model": EMBED_MODEL_ID,
    "chat.arm": arm,
  };
}

/** ChatMessage[] of the gold history: user and assistant pairs with the gold answer. */
function historyMessages(q: Question) {
  const out: import("@openstyle/validations").ChatMessage[] = [];
  let id = 1;
  const base = {
    thread_id: `eval-${q.id}`,
    cites: [],
    trace: null,
    model_id: null,
    provider: null,
    ms: null,
    created_at: 0,
  };
  for (const t of q.history) {
    out.push({
      ...base,
      id: id++,
      role: "user",
      content: t.q,
      blocks: [],
    });
    out.push({
      ...base,
      id: id++,
      role: "assistant",
      content: t.a,
      blocks: [{ kind: "text", text: t.a, cites: [] }],
    });
  }
  return out;
}

async function newLlm(env: Env, id: string, signal: AbortSignal) {
  return env.mods.llm.createChatLlm(env.stack.db, {
    threadId: `eval-${id}`,
    signal,
  });
}

// ===================================================================================
// A. retrieval
// ===================================================================================

interface ArmDef {
  id: string;
  extra: Record<string, unknown>;
}

async function partRetrieval(
  env: Env,
  M: Record<string, number>,
): Promise<PartOut> {
  const { stack, corpus, gold, log } = env;
  const st = stack.mod.searchState();
  if (st.state !== "on") throw new Error(`search is off: ${st.reason}`);
  const rssAll = new RssSampler(/--embed|--rerank/, 2000);
  const rssRerank = new RssSampler(/--rerank/, 2000);
  rssAll.start();
  rssRerank.start();
  const { indexMs, chunks } = env.index as NonNullable<Env["index"]>;
  const queries = spread(gold.retrieval, env.opts.limit);
  const rangeOf = (q: (typeof queries)[number]) =>
    q.dateFrom && q.dateTo
      ? {
          fromMs: Date.parse(`${q.dateFrom}T00:00:00Z`),
          toMs: Date.parse(`${q.dateTo}T00:00:00Z`) + DAY,
        }
      : undefined;
  const call = (
    q: (typeof queries)[number],
    extra: Record<string, unknown>,
  ) => {
    const range = rangeOf(q);
    return stack.mod.retrieve({
      query: { kind: "text", text: q.text },
      scope: { kind: "all" },
      k: 10,
      ...(range ? { dateRange: range } : {}),
      ...extra,
    } as Parameters<typeof stack.mod.retrieve>[0]);
  };
  const arms: ArmDef[] = [
    { id: "dense", extra: {} },
    { id: "hybrid", extra: { mode: "hybrid" } },
    {
      id: "hybrid_rerank15",
      extra: { mode: "hybrid", rerank: { candidates: 15 } },
    },
    {
      id: "hybrid_rerank30",
      extra: { mode: "hybrid", rerank: { candidates: 30 } },
    },
  ];
  const slices = ["names", "numbers", "concept", "asr_names", "date"];
  const metrics: Record<string, number> = {};
  const per: Record<string, unknown> = {};
  let text = `Production retrieve(), k=10, scope all, ${queries.length} queries, corpus ${env.hashes.corpus}, gold ${env.hashes.gold}. Default rerank candidates in the code: ${env.mods.rerankConst.RERANK_CANDIDATES}, batch ${env.mods.rerankConst.RERANK_BATCH}.\n\n`;
  text += `| arm | n | r@1 | r@5 | r@10 | r@10 any | nDCG@10 | p50 ms | p95 ms | rerank p50 | rerank p95 | applied |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
  const sliceLines: string[] = [];
  for (const arm of arms) {
    const warm = queries[0] as (typeof queries)[number];
    for (let i = 0; i < 3; i++) await call(warm, arm.extra);
    interface Row {
      lang: Lang;
      slice: string;
      r1: number;
      r5: number;
      r10: number;
      r10any: number;
      ndcg: number;
    }
    const rows: Row[] = [];
    const times: number[] = [];
    const rerankMs: number[] = [];
    let applied = 0;
    let i = 0;
    for (const q of queries) {
      const grades = gradesFor(q, chunks, corpus);
      const ideal = [...grades.values()].sort((a, b) => b - a);
      const ts = performance.now();
      const res = await call(q, arm.extra);
      times.push(performance.now() - ts);
      if (res.status !== "ok")
        throw new Error(`${arm.id} ${q.id}: ${res.status}`);
      if (res.rerank === "applied") applied++;
      if (res.ms) rerankMs.push(res.ms.rerank);
      const g = res.hits.map((h) => grades.get(h.chunkId) ?? 0);
      rows.push({
        lang: q.lang,
        slice: q.slice,
        r1: recallAt(g, 1),
        r5: recallAt(g, 5),
        r10: recallAt(g, 10),
        r10any: recallAt(g, 10, 1),
        ndcg: ndcgAt(g, ideal, 10),
      });
      if (++i % 5 === 0) {
        rssAll.sample();
        rssRerank.sample();
      }
    }
    const agg = (sel: (r: Row) => boolean, p: string) => {
      const rs = rows.filter(sel);
      if (rs.length === 0) return;
      for (const k of ["r1", "r5", "r10", "r10any", "ndcg"] as const)
        metrics[`${arm.id}.${k}.${p}`] = mean(rs.map((r) => r[k]));
    };
    agg(() => true, "all");
    agg((r) => r.lang === "en", "en");
    agg((r) => r.lang === "pt", "pt");
    for (const s of slices) agg((r) => r.slice === s, s);
    metrics[`${arm.id}.latency_ms.p50`] = percentile(times, 50);
    metrics[`${arm.id}.latency_ms.p95`] = percentile(times, 95);
    if (arm.extra.rerank) {
      metrics[`${arm.id}.rerank_ms.p50`] = percentile(rerankMs, 50);
      metrics[`${arm.id}.rerank_ms.p95`] = percentile(rerankMs, 95);
      metrics[`${arm.id}.rerank_applied`] = applied / queries.length;
    }
    text += `| ${arm.id} | ${rows.length} | ${pct(metrics[`${arm.id}.r1.all`] as number)} | ${pct(metrics[`${arm.id}.r5.all`] as number)} | ${pct(metrics[`${arm.id}.r10.all`] as number)} | ${pct(metrics[`${arm.id}.r10any.all`] as number)} | ${f3(metrics[`${arm.id}.ndcg.all`] as number)} | ${ms0(percentile(times, 50))} | ${ms0(percentile(times, 95))} | ${arm.extra.rerank ? ms0(percentile(rerankMs, 50)) : "-"} | ${arm.extra.rerank ? ms0(percentile(rerankMs, 95)) : "-"} | ${arm.extra.rerank ? `${applied}/${queries.length}` : "-"} |\n`;
    sliceLines.push(
      `| ${arm.id} | ${slices.map((s) => `${f3(metrics[`${arm.id}.ndcg.${s}`] as number)} / ${pct(metrics[`${arm.id}.r10.${s}`] as number)}`).join(" | ")} | ${pct(metrics[`${arm.id}.r10any.en`] as number)} / ${pct(metrics[`${arm.id}.r10any.pt`] as number)} |\n`,
    );
    per[arm.id] = rows;
    log(
      `retrieval ${arm.id}: nDCG@10 ${f3(metrics[`${arm.id}.ndcg.all`] as number)}`,
    );
  }
  rssAll.stop();
  rssRerank.stop();
  metrics.embed_rerank_rss_peak_mb = rssAll.peakMb;
  metrics.rerank_rss_peak_mb = rssRerank.peakMb;
  metrics.index_s = indexMs / 1000;
  metrics.chunks = chunks.length;
  text += `\nPer slice (nDCG@10 / recall@10) and recall@10 any evidence per language (EN / PT):\n\n| arm | ${slices.join(" | ")} | r@10 any en / pt |\n|---|${slices.map(() => "---").join("|")}|---|\n${sliceLines.join("")}`;
  text += `\nWorker RSS: embed + rerank peak ${rssAll.peakMb} MB (sum), rerank alone ${rssRerank.peakMb} MB.\n`;

  M["ret.ndcg"] = metrics["hybrid_rerank15.ndcg.all"] as number;
  M["ret.r10any"] = metrics["hybrid_rerank15.r10any.all"] as number;
  M["ret.numbers15"] = metrics["hybrid_rerank15.r10.numbers"] as number;
  M["ret.names15"] = metrics["hybrid_rerank15.r10.names"] as number;
  M["ret.numbers30"] = metrics["hybrid_rerank30.r10.numbers"] as number;
  M["ret.names30"] = metrics["hybrid_rerank30.r10.names"] as number;
  M["ret.rerank15"] = metrics["hybrid_rerank15.rerank_ms.p95"] as number;
  M["ret.rerank30"] = metrics["hybrid_rerank30.rerank_ms.p95"] as number;
  if (rssRerank.peakMb > 0) M["ret.ram"] = rssRerank.peakMb;
  return {
    text,
    data: { metrics, per },
    run: {
      name: "p1-retrieval",
      params: {
        queries: queries.length,
        k: 10,
        scope: "all",
        rerank_default: env.mods.rerankConst.RERANK_CANDIDATES,
        rerank_batch: env.mods.rerankConst.RERANK_BATCH,
      },
      tags: baseTags(env, "dense+hybrid+rerank15+rerank30"),
      metrics,
    },
  };
}

// ===================================================================================
// B. router
// ===================================================================================

async function partRouter(
  env: Env,
  M: Record<string, number>,
): Promise<PartOut> {
  const { mods, gold, log } = env;
  const intents = new Set<string>([
    "lookup",
    "who_said",
    "aggregate",
    "temporal",
    "review",
    "status",
    "write",
    "other",
  ]);
  const prevOf = (q: Question) =>
    mods.context
      .compactHistory(
        historyMessages(q).map((m) => ({
          role: m.role,
          content: m.content,
          blocks: m.blocks,
          cites: m.cites,
        })),
      )
      .at(-1)?.question ?? null;
  interface Item {
    id: string;
    set: "gold" | "heldout";
    lang: string;
    text: string;
    prev: string | null;
    gold: Intent;
  }
  const items: Item[] = [
    ...spread(gold.questions, env.opts.limit).map((q) => ({
      id: q.id,
      set: "gold" as const,
      lang: q.lang,
      text: q.text,
      prev: prevOf(q),
      gold: q.intent,
    })),
    ...spread(heldoutRouterItems(), env.opts.limit).map((h) => ({
      id: h.id,
      set: "heldout" as const,
      lang: h.lang,
      text: h.text,
      prev: null,
      gold: h.intent,
    })),
  ];
  const run = async (it: Item) => {
    const signal = AbortSignal.timeout(120_000);
    const llm = await newLlm(env, `route-${it.id}`, signal);
    const t = performance.now();
    try {
      const r = await llm.structured({
        step: "chatRoute",
        unitKey: "route/intent",
        schema: mods.prompts.ROUTER_SCHEMA,
        system: mods.prompts.ROUTER_SYSTEM,
        messages: [
          {
            role: "user",
            content: it.prev
              ? `Previous question: ${it.prev}\nQuestion: ${it.text}`
              : `Question: ${it.text}`,
          },
        ],
        maxOutputTokens: mods.prompts.ROUTER_MAX_TOKENS,
      });
      llm.finish("succeeded");
      const raw = r.object.intent as Intent;
      const pred = intents.has(raw)
        ? mods.plan.refineIntent(it.text, raw, env.corpus.todayMs)
        : raw;
      return {
        pred: intents.has(pred) ? pred : null,
        ms: performance.now() - t,
      };
    } catch (e) {
      llm.finish("failed", { errorDetail: String(e).slice(0, 200) });
      return { pred: null, ms: performance.now() - t };
    }
  };
  // Warm-up: the first call loads the model. It is not scored.
  await run(items[0] as Item);
  const rows: (Item & { pred: Intent | null; ms: number })[] = [];
  for (const it of items) {
    rows.push({ ...it, ...(await run(it)) });
    if (rows.length % 50 === 0) log(`router ${rows.length}/${items.length}`);
  }
  const metrics: Record<string, number> = {};
  let text = `Production router (ROUTER_SYSTEM + ROUTER_SCHEMA, step chatRoute), temperature by the Auto path. Gold intent labels: new rules ("When is X?" temporal, "Who will do X?" who_said), gold hash ${env.hashes.gold}.\n\n`;
  const confs: Record<string, ReturnType<typeof confusion>> = {};
  for (const set of ["gold", "heldout"] as const) {
    const rs = rows.filter((r) => r.set === set);
    const c = confusion(rs.map((r) => ({ gold: r.gold, pred: r.pred })));
    confs[set] = c;
    metrics[`acc.${set}`] = c.accuracy;
    metrics[`n.${set}`] = c.n;
    metrics[`latency_ms.${set}.p50`] = percentile(
      rs.map((r) => r.ms),
      50,
    );
    metrics[`latency_ms.${set}.p95`] = percentile(
      rs.map((r) => r.ms),
      95,
    );
    metrics[`invalid.${set}`] = rs.filter((r) => r.pred === null).length;
    const langs = [...new Set(rs.map((r) => r.lang))].sort();
    text += `${set}: accuracy ${pct(c.accuracy)}% of ${c.n}; latency p50 ${ms0(metrics[`latency_ms.${set}.p50`] as number)} ms, p95 ${ms0(metrics[`latency_ms.${set}.p95`] as number)} ms; invalid ${metrics[`invalid.${set}`]}.\n`;
    for (const l of langs) {
      const lr = rs.filter((r) => r.lang === l);
      const a = mean(lr.map((r) => (r.pred === r.gold ? 1 : 0)));
      metrics[`acc.${set}.${l}`] = a;
      text += `  ${l}: ${pct(a)}% (n ${lr.length})\n`;
    }
    const cols = [...intents, "invalid"];
    text += `\nConfusion (${set}; rows = labelled intent, columns = predicted):\n\n| gold \\ pred | ${cols.join(" | ")} |\n|---|${cols.map(() => "---").join("|")}|\n`;
    for (const g of intents) {
      const row = c.matrix[g];
      if (!row) continue;
      text += `| ${g} | ${cols.map((p) => row[p] ?? 0).join(" | ")} |\n`;
    }
    text += "\n";
  }
  const hl = rows.filter((r) => r.set === "heldout");
  const hw = hl.filter(
    (r) => r.gold === "lookup" && r.pred === "temporal",
  ).length;
  text += `Note: the blind labels are from a second writer. "When is X?" style items there may be labelled lookup (lookup read as temporal: ${hw}).\n`;
  M["route.blind"] = metrics["acc.heldout"] as number;
  M["route.gold"] = metrics["acc.gold"] as number;
  M["route.spec"] = metrics["acc.gold"] as number;
  return {
    text,
    data: {
      confusion: confs,
      rows: rows.map((r) => ({
        id: r.id,
        set: r.set,
        lang: r.lang,
        gold: r.gold,
        pred: r.pred,
        ms: Math.round(r.ms),
      })),
    },
    run: {
      name: "p1-router",
      params: {
        gold: metrics["n.gold"] as number,
        heldout: metrics["n.heldout"] as number,
        step: "chatRoute",
      },
      tags: baseTags(env, "structured-router"),
      metrics,
    },
  };
}

// ===================================================================================
// C. slots
// ===================================================================================

async function partSlots(
  env: Env,
  M: Record<string, number>,
): Promise<PartOut> {
  const { mods, gold, corpus, maps, stack, log } = env;
  const qs = spread(
    gold.questions.filter((q) => q.intent !== "status"),
    env.opts.limit,
  );
  interface Row {
    q: Question;
    pass: boolean;
    keys: Record<string, boolean>;
    ms: number;
    err: string | null;
  }
  const rows: Row[] = [];
  for (const q of qs) {
    const turns = mods.context.compactHistory(
      historyMessages(q).map((m) => ({
        role: m.role,
        content: m.content,
        blocks: m.blocks,
        cites: m.cites,
      })),
    );
    const scope = { kind: q.scope.kind, id: q.scope.id };
    const choices = mods.choices.buildChoices(
      stack.db,
      scope,
      q.text,
      turns.map((t) => t.question),
      corpus.todayMs,
    );
    const zod = mods.plan.slotZod(q.intent, choices);
    // No slot call for an intent with no model field (query = the question,
    // dates by code): its default slots are scored, with no model call.
    if (!zod && q.intent === "status") continue;
    const signal = AbortSignal.timeout(120_000);
    const llm = zod ? await newLlm(env, `slots-${q.id}`, signal) : null;
    const historyText = mods.context.renderHistory(turns.slice(-2));
    const t = performance.now();
    let slots: Record<string, unknown> = {
      ...mods.plan.defaultSlots(
        q.text,
        turns.map((t) => ({ question: t.question, answer: t.answer })),
        q.intent,
      ),
    };
    let err: string | null = null;
    try {
      if (!zod || !llm) throw new Error("no slot call");
      const r = await llm.structured({
        step: "chatSlots",
        unitKey: "route/slots",
        schema: { name: "chat_slots", version: 1, zod },
        system: mods.plan.slotSystem(
          q.intent,
          choices,
          mods.prompts.isoDay(corpus.todayMs),
        ),
        messages: [
          {
            role: "user",
            content: `${historyText ? `Earlier: ${historyText}\n` : ""}Question: ${q.text}`,
          },
        ],
        maxOutputTokens: mods.prompts.SLOT_MAX_TOKENS,
      });
      slots = { ...slots, ...(r.object as object) };
      llm.finish("succeeded");
    } catch (e) {
      if (zod && llm) {
        err = String(e).slice(0, 160);
        llm.finish("failed", { errorDetail: err });
      }
    }
    const ms = performance.now() - t;
    const dates = mods.choices.datesFromQuestion(q.text, corpus.todayMs);
    const s = scoreProdSlots(q, slots, dates, choices, maps);
    rows.push({ q, pass: s.pass, keys: s.keys, ms, err });
    if (rows.length % 40 === 0) log(`slots ${rows.length}/${qs.length}`);
  }
  const timed = rows.slice(1).map((r) => r.ms);
  const metrics: Record<string, number> = {
    n: rows.length,
    acc: mean(rows.map((r) => (r.pass ? 1 : 0))),
    errors: rows.filter((r) => r.err).length,
    latency_ms_p50: percentile(timed, 50),
    latency_ms_p95: percentile(timed, 95),
  };
  let text = `Production slot fill with the gold intent (slotZod + slotSystem, step chatSlots); dates by code (datesFromQuestion). ${rows.length} questions (status has no slots). Accuracy ${pct(metrics.acc as number)}%. Slot call p50 ${ms0(metrics.latency_ms_p50 as number)} ms, p95 ${ms0(metrics.latency_ms_p95 as number)} ms; errors ${metrics.errors}.\n\n| intent | n | accuracy |\n|---|---|---|\n`;
  const byIntent = new Map<string, Row[]>();
  for (const r of rows) {
    const a = byIntent.get(r.q.intent) ?? [];
    a.push(r);
    byIntent.set(r.q.intent, a);
  }
  for (const [k, rs] of byIntent) {
    const a = mean(rs.map((r) => (r.pass ? 1 : 0)));
    metrics[`acc.intent.${k}`] = a;
    text += `| ${k} | ${rs.length} | ${pct(a)} |\n`;
  }
  const byKey = new Map<string, boolean[]>();
  for (const r of rows)
    for (const [k, v] of Object.entries(r.keys)) {
      const a = byKey.get(k) ?? [];
      a.push(v);
      byKey.set(k, a);
    }
  text += `\n| arg | n | accuracy |\n|---|---|---|\n`;
  for (const [k, vs] of byKey) {
    const a = mean(vs.map((v) => (v ? 1 : 0)));
    metrics[`acc.arg.${k}`] = a;
    text += `| ${k} | ${vs.length} | ${pct(a)} |\n`;
  }
  const fails = rows.filter((r) => !r.pass);
  text += `\nFailed questions (${fails.length}): ${fails
    .slice(0, 60)
    .map(
      (r) =>
        `${r.q.id}[${Object.entries(r.keys)
          .filter(([, v]) => !v)
          .map(([k]) => k)
          .join(",")}]`,
    )
    .join(" ")}\n`;
  M.slots = metrics.acc as number;
  return {
    text,
    data: {
      rows: rows.map((r) => ({
        id: r.q.id,
        intent: r.q.intent,
        pass: r.pass,
        keys: r.keys,
        err: r.err,
      })),
    },
    run: {
      name: "p1-slots",
      params: { questions: rows.length, step: "chatSlots" },
      tags: baseTags(env, "slots-gold-intent"),
      metrics,
    },
  };
}

// ===================================================================================
// D. end to end
// ===================================================================================

const TYPES: QuestionType[] = [
  "lookup",
  "who_said",
  "aggregation",
  "count",
  "temporal",
  "knowledge_update",
  "not_answerable",
  "scope_trap",
  "follow_up",
  "long_thread",
  "write",
];

/** Hash of the tables that a write by the chat would change. */
function dataHash(stack: Stack): string {
  const h = createHash("sha256");
  for (const t of [
    "meetings",
    "meeting_folders",
    "tags",
    "meeting_tags",
    "folder_action_item_state",
    "meeting_speakers",
    "meeting_summaries",
    "meeting_segments",
  ]) {
    const rows = stack.db.prepare(`SELECT * FROM ${t}`).all();
    h.update(t).update(JSON.stringify(rows));
  }
  return h.digest("hex").slice(0, 16);
}

interface E2eRow {
  id: string;
  type: QuestionType;
  lang: Lang;
  scope: string;
  pass: boolean;
  f1: number | null;
  notFound: boolean;
  err: string | null;
  router: string;
  intent: string | null;
  calls: number;
  ms: number;
  routeMs: number;
  native: string;
  tool: string | null;
  toolOk: boolean;
  argsOk: boolean;
  argKeys: Record<string, boolean>;
  proposalKindIds: boolean | null;
  sourcesDropped: number;
  cites: number;
  citeHitsStart: number;
  citeHitsRange: number;
  citeHitsMeeting: number;
  goldSpans: number;
  coveredStart: number;
  coveredRange: number;
  invalidCites: string[];
  /** Count of the shown cites by source kind. */
  citeKinds?: Record<string, number>;
  /** Meeting id and start_ms of each shown cite (diagnosis of the cite precision). */
  citeStarts?: { meeting_id: string; start_ms: number | null; kind: string }[];
  toolCalls: { tool: string; rows: number; args?: unknown }[];
  notes?: string[];
  blocks: string[];
  answer: string;
}

async function partE2e(env: Env, M: Record<string, number>): Promise<PartOut> {
  const { mods, gold, corpus, maps, stack, log } = env;
  const qs = spread(gold.questions, env.opts.limit);
  const rss = new RssSampler(/--llm/, 5000);
  rss.start();
  const before = dataHash(stack);
  const known = {
    meeting: (id: string) =>
      stack.db.prepare("SELECT 1 FROM meetings WHERE id = ?").get(id) !==
      undefined,
    start: (mid: string, s: number) =>
      stack.db
        .prepare(
          "SELECT 1 FROM meeting_segments WHERE meeting_id = ? AND start_ms = ? UNION SELECT 1 FROM meeting_chunks WHERE meeting_id = ? AND start_ms = ?",
        )
        .get(mid, s, mid, s) !== undefined,
    item: (id: string) => maps.prodToItem.has(id),
  };
  const chunkEnd = (mid: string, s: number | null): number | null => {
    if (s === null) return null;
    const r = stack.db
      .prepare(
        "SELECT MAX(end_ms) AS e FROM meeting_chunks WHERE meeting_id = ? AND start_ms = ?",
      )
      .get(mid, s) as { e: number | null } | undefined;
    return r?.e ?? null;
  };
  const rows: E2eRow[] = [];
  const only = process.env.CHAT_EVAL_IDS?.split(",");
  const floor = process.env.CHAT_EVAL_FLOOR
    ? Number(process.env.CHAT_EVAL_FLOOR)
    : undefined;
  for (const q of qs) {
    if (only && !only.includes(q.id)) continue;
    const signal = AbortSignal.timeout(120_000);
    const settings = mods.settings.readChatSettings();
    const scope = { kind: q.scope.kind, id: q.scope.id } as never;
    let row: E2eRow;
    let llm: Awaited<ReturnType<typeof newLlm>> | null = null;
    const t0 = performance.now();
    try {
      llm = await newLlm(env, q.id, signal);
      const res = await mods.pipeline.runChatTurn({
        db: stack.db,
        scope,
        question: q.text,
        history: historyMessages(q),
        settings,
        llm,
        signal,
        now: corpus.todayMs,
        allowProposals: true,
        ...(floor !== undefined ? { scoreFloor: floor } : {}),
      });
      llm.finish("succeeded");
      const wall = performance.now() - t0;
      const answer = answerFromTurn(res, maps, q.key);
      const score = scoreAnswer(answer, q.key);
      const stepNames = res.trace.steps
        .filter((s) => s.stage === "route")
        .map((s) => s.name);
      const tool = firstTool(
        res.toolCalls,
        stepNames,
        res.proposal?.kind ?? null,
      );
      // count_mentions (P1.1) is the code count of a mention question. It stands
      // in for the search that the gold plan lists.
      const toolOk =
        tool !== null &&
        (q.tools.includes(tool) ||
          (tool === "count_mentions" && q.tools.includes("search_chunks")));
      const sa = scoreToolArgs(
        q,
        res.toolCalls[0] ?? null,
        answer.proposal,
        maps,
      );
      const spans = goldSpans(q, corpus);
      const citeSpans = res.cites.map((c) => ({
        meeting_id: c.meeting_id,
        start_ms: c.start_ms,
        end_ms: chunkEnd(c.meeting_id, c.start_ms),
      }));
      const cs = citeCounts(citeSpans, spans, "start");
      const cr = citeCounts(citeSpans, spans, "range");
      const cm = citeCounts(citeSpans, spans, "meeting");
      const chk = checkCites(res, known);
      const routeMs = res.trace.steps
        .filter((s) => s.stage === "route" || s.stage === "slots")
        .reduce((a, s) => a + s.ms, 0);
      let proposalKindIds: boolean | null = null;
      if (q.key.kind === "write") {
        const p = answer.proposal;
        proposalKindIds =
          p !== null &&
          p.kind === q.key.change &&
          scoreSet(p.ids, q.key.ids).pass;
      }
      row = {
        id: q.id,
        type: q.type,
        lang: q.lang,
        scope: q.scope.kind,
        pass: score.pass,
        f1: score.f1,
        notFound: answer.notFound,
        err: null,
        router: res.trace.router,
        intent: res.trace.intent,
        calls: res.trace.calls,
        ms: wall,
        routeMs,
        native: nativeOutcome(stepNames),
        tool,
        toolOk,
        argsOk: sa.pass,
        argKeys: sa.keys,
        proposalKindIds,
        sourcesDropped: res.trace.sources_dropped.length,
        cites: res.cites.length,
        citeHitsStart: cs.hit,
        citeHitsRange: cr.hit,
        citeHitsMeeting: cm.hit,
        goldSpans: spans.length,
        coveredStart: cs.covered,
        coveredRange: cr.covered,
        invalidCites: chk.invalid,
        citeKinds: res.cites.reduce<Record<string, number>>((m, c) => {
          m[c.kind] = (m[c.kind] ?? 0) + 1;
          return m;
        }, {}),
        citeStarts: res.cites.map((c) => ({
          meeting_id: c.meeting_id,
          start_ms: c.start_ms,
          kind: c.kind,
        })),
        toolCalls: res.toolCalls.map((c) => ({
          tool: c.tool,
          rows: c.rows,
          args: c.args,
        })),
        blocks: res.blocks.map((b) =>
          b.kind === "not_found" ? `not_found:${b.reason}` : b.kind,
        ),
        answer: res.content.slice(0, 300),
        notes: res.trace.steps
          .filter((s) => s.note)
          .map((s) => `${s.stage}:${s.name}:${s.note}`),
      };
    } catch (e) {
      llm?.finish("failed", { errorDetail: String(e).slice(0, 200) });
      row = {
        id: q.id,
        type: q.type,
        lang: q.lang,
        scope: q.scope.kind,
        pass: false,
        f1: null,
        notFound: false,
        err: String(e).slice(0, 300),
        router: "error",
        intent: null,
        calls: llm?.calls() ?? 0,
        ms: performance.now() - t0,
        routeMs: 0,
        native: "off",
        tool: null,
        toolOk: false,
        argsOk: false,
        argKeys: {},
        proposalKindIds: q.key.kind === "write" ? false : null,
        sourcesDropped: 0,
        cites: 0,
        citeHitsStart: 0,
        citeHitsRange: 0,
        citeHitsMeeting: 0,
        goldSpans: 0,
        coveredStart: 0,
        coveredRange: 0,
        invalidCites: [],
        toolCalls: [],
        blocks: [],
        answer: "",
      };
    }
    rows.push(row);
    if (rows.length % 10 === 0) {
      rss.sample();
      log(
        `e2e ${rows.length}/${qs.length}: pass ${rows.filter((r) => r.pass).length}`,
      );
    }
  }
  rss.stop();
  const after = dataHash(stack);
  const warm = rows.slice(1);
  const answerable = rows.filter((r) => qkey(r.id).kind !== "not_found");
  function qkey(id: string) {
    return (gold.questions.find((q) => q.id === id) as Question).key;
  }
  const nfRows = rows.filter(
    (r) => r.type === "not_answerable" || r.type === "scope_trap",
  );
  const metrics: Record<string, number> = {};
  metrics.n = rows.length;
  metrics.errors = rows.filter((r) => r.err).length;
  metrics.acc = mean(rows.map((r) => (r.pass ? 1 : 0)));
  const typeLines: string[] = [];
  for (const t of TYPES) {
    const rs = rows.filter((r) => r.type === t);
    if (rs.length === 0) continue;
    const a = mean(rs.map((r) => (r.pass ? 1 : 0)));
    metrics[`acc.type.${t}`] = a;
    typeLines.push(
      `| ${t} | ${rs.length} | ${rs.filter((r) => r.pass).length} | ${pct(a)} |`,
    );
  }
  // Lookup + follow-up.
  const lf = rows.filter((r) => r.type === "lookup" || r.type === "follow_up");
  metrics["acc.lookup_followup"] = mean(lf.map((r) => (r.pass ? 1 : 0)));
  metrics["n.lookup_followup"] = lf.length;
  // The 22 questions of A0 (meeting or folder scope, text, count or not-found key).
  const a0Ids = new Set(
    gold.questions
      .filter(
        (q) =>
          (q.type === "lookup" || q.type === "follow_up") &&
          ["text", "not_found", "count"].includes(q.key.kind) &&
          (q.scope.kind === "meeting" || q.scope.kind === "folder"),
      )
      .map((q) => q.id),
  );
  const a22 = rows.filter((r) => a0Ids.has(r.id));
  metrics["acc.a0_subset"] = mean(a22.map((r) => (r.pass ? 1 : 0)));
  metrics["n.a0_subset"] = a22.length;
  // Not-found.
  metrics["nf.acc"] = mean(nfRows.map((r) => (r.notFound ? 1 : 0)));
  metrics["nf.n"] = nfRows.length;
  metrics["nf.false"] = mean(answerable.map((r) => (r.notFound ? 1 : 0)));
  metrics["nf.false_n"] = answerable.filter((r) => r.notFound).length;
  // List F1: aggregation questions with a set key.
  const agg = rows.filter((r) => r.type === "aggregation");
  metrics["f1.aggregation"] = mean(agg.map((r) => r.f1 ?? 0));
  const aggNoStatus = agg.filter(
    (r) => r.intent !== "status" && !r.blocks.includes("status"),
  );
  metrics["f1.aggregation_no_status"] = mean(aggNoStatus.map((r) => r.f1 ?? 0));
  const setRows = rows.filter((r) => qkey(r.id).kind === "set");
  metrics["f1.all_set"] = mean(setRows.map((r) => r.f1 ?? 0));
  // Cites.
  const shown = rows.reduce((a, r) => a + r.cites, 0);
  const invalid = rows.reduce((a, r) => a + r.invalidCites.length, 0);
  const shownAll = shown + 0;
  metrics["cite.shown"] = shownAll;
  metrics["cite.invalid"] = invalid;
  metrics["cite.validity"] =
    shownAll === 0 ? 1 : Math.max(0, 1 - invalid / shownAll);
  const withGold = rows.filter((r) => r.goldSpans > 0);
  const sum = (f: (r: E2eRow) => number, rs = withGold) =>
    rs.reduce((a, r) => a + f(r), 0);
  const shownG = sum((r) => r.cites);
  metrics["cite.precision_start"] =
    shownG === 0 ? 0 : sum((r) => r.citeHitsStart) / shownG;
  metrics["cite.precision_range"] =
    shownG === 0 ? 0 : sum((r) => r.citeHitsRange) / shownG;
  metrics["cite.precision_meeting"] =
    shownG === 0 ? 0 : sum((r) => r.citeHitsMeeting) / shownG;
  const goldN = sum((r) => r.goldSpans);
  metrics["cite.recall_start"] =
    goldN === 0 ? 0 : sum((r) => r.coveredStart) / goldN;
  metrics["cite.recall_range"] =
    goldN === 0 ? 0 : sum((r) => r.coveredRange) / goldN;
  metrics["cite.n_questions_with_gold"] = withGold.length;
  // Tool choice and args.
  const toolRows = rows.filter(
    (r) =>
      (gold.questions.find((q) => q.id === r.id) as Question).tools.length > 0,
  );
  metrics["tool.acc"] = mean(toolRows.map((r) => (r.toolOk ? 1 : 0)));
  metrics["args.acc"] = mean(toolRows.map((r) => (r.argsOk ? 1 : 0)));
  metrics["toolargs.acc"] = mean(
    toolRows.map((r) => (r.toolOk && r.argsOk ? 1 : 0)),
  );
  const wr = rows.filter((r) => r.type === "write");
  metrics["write.kind_ids"] = mean(wr.map((r) => (r.proposalKindIds ? 1 : 0)));
  metrics["write.full"] = mean(wr.map((r) => (r.pass ? 1 : 0)));
  metrics["write.tool"] = mean(wr.map((r) => (r.toolOk ? 1 : 0)));
  metrics["write.toolargs"] = mean(
    wr.map((r) => (r.toolOk && r.argsOk ? 1 : 0)),
  );
  // Router used.
  for (const k of ["native", "structured", "default", "skipped", "error"])
    metrics[`router.${k}`] =
      rows.filter((r) => r.router === k).length / rows.length;
  const natives = rows.filter((r) => r.native !== "off");
  for (const k of ["ok", "invalid", "none", "error"])
    metrics[`native.${k}`] =
      natives.length === 0
        ? 0
        : natives.filter((r) => r.native === k).length / natives.length;
  metrics["native.attempts"] = natives.length;
  // Calls, latency, RAM, dropped.
  metrics["calls.mean"] = mean(rows.map((r) => r.calls));
  metrics["calls.max"] = Math.max(...rows.map((r) => r.calls));
  metrics["latency_ms.p50"] = percentile(
    warm.map((r) => r.ms),
    50,
  );
  metrics["latency_ms.p95"] = percentile(
    warm.map((r) => r.ms),
    95,
  );
  metrics["latency_ms.first"] = rows[0]?.ms ?? 0;
  metrics["route_ms.p50"] = percentile(
    warm.map((r) => r.routeMs),
    50,
  );
  metrics["route_ms.p95"] = percentile(
    warm.map((r) => r.routeMs),
    95,
  );
  metrics["llm_rss_peak_mb"] = rss.peakMb;
  metrics["sources_dropped.turns"] = rows.filter(
    (r) => r.sourcesDropped > 0,
  ).length;
  metrics["sources_dropped.total"] = rows.reduce(
    (a, r) => a + r.sourcesDropped,
    0,
  );
  const lt = rows.filter((r) => r.type === "long_thread");
  metrics["sources_dropped.long_thread_turns"] = lt.filter(
    (r) => r.sourcesDropped > 0,
  ).length;
  metrics["writes.direct"] = before === after ? 0 : 1;
  const who = rows.filter((r) => r.type === "who_said");
  metrics["acc.who_said"] = mean(who.map((r) => (r.pass ? 1 : 0)));

  let text = `End to end: runChatTurn on ${rows.length} gold questions (default settings from readChatSettings(), allowProposals, now = corpus clock, history = gold answers). ${metrics.errors} turn errors.\n\n`;
  text += `| type | N | pass | pass % |\n|---|---|---|---|\n${typeLines.join("\n")}\n| all | ${rows.length} | ${rows.filter((r) => r.pass).length} | ${pct(metrics.acc as number)} |\n\n`;
  text += `Answer accuracy lookup + follow-up: ${pct(metrics["acc.lookup_followup"] as number)}% of ${lf.length}; on the A0 subset ${pct(metrics["acc.a0_subset"] as number)}% of ${a22.length}.\n`;
  text += `Not-found accuracy ${pct(metrics["nf.acc"] as number)}% of ${nfRows.length}; false not-found ${pct(metrics["nf.false"] as number)}% (${metrics["nf.false_n"]} of ${answerable.length}).\n`;
  text += `List F1 aggregation ${f3(metrics["f1.aggregation"] as number)} (without status ${f3(metrics["f1.aggregation_no_status"] as number)}); all set keys ${f3(metrics["f1.all_set"] as number)}.\n`;
  const kinds: Record<string, number> = {};
  for (const r of rows)
    for (const [k, n] of Object.entries(r.citeKinds ?? {}))
      kinds[k] = (kinds[k] ?? 0) + n;
  text += `Cite kinds: ${Object.entries(kinds)
    .map(([k, n]) => `${k} ${n}`)
    .join(", ")}.\n`;
  text += `Cites: ${shownAll} shown, ${invalid} invalid (validity ${pct(metrics["cite.validity"] as number)}%). Precision (start_ms in gold segment) ${f3(metrics["cite.precision_start"] as number)}, range overlap ${f3(metrics["cite.precision_range"] as number)}, meeting level ${f3(metrics["cite.precision_meeting"] as number)}. Recall (start) ${f3(metrics["cite.recall_start"] as number)}, (range) ${f3(metrics["cite.recall_range"] as number)}; ${withGold.length} questions with gold evidence.\n`;
  text += `Tool choice ${pct(metrics["tool.acc"] as number)}%, args ${pct(metrics["args.acc"] as number)}%, together ${pct(metrics["toolargs.acc"] as number)}% of ${toolRows.length}. Write: kind + ids ${pct(metrics["write.kind_ids"] as number)}%, with arg ${pct(metrics["write.full"] as number)}%, tool ${pct(metrics["write.tool"] as number)}%, tool + args ${pct(metrics["write.toolargs"] as number)}% of ${wr.length}.\n`;
  text += `Router used: native ${pct(metrics["router.native"] as number)}%, structured ${pct(metrics["router.structured"] as number)}%, default ${pct(metrics["router.default"] as number)}%. Native call outcome (${natives.length} attempts): ok ${pct(metrics["native.ok"] as number)}%, invalid ${pct(metrics["native.invalid"] as number)}%, none ${pct(metrics["native.none"] as number)}%, error ${pct(metrics["native.error"] as number)}%.\n`;
  text += `Calls per turn mean ${(metrics["calls.mean"] as number).toFixed(2)}, max ${metrics["calls.max"]}. Latency (warm, first turn dropped) p50 ${ms0(metrics["latency_ms.p50"] as number)} ms, p95 ${ms0(metrics["latency_ms.p95"] as number)} ms; first turn ${ms0(metrics["latency_ms.first"] as number)} ms. Route + slots p50 ${ms0(metrics["route_ms.p50"] as number)} ms, p95 ${ms0(metrics["route_ms.p95"] as number)} ms.\n`;
  text += `LLM worker RSS peak ${rss.peakMb} MB. Sources dropped: ${metrics["sources_dropped.turns"]} turns, ${metrics["sources_dropped.total"]} sources (long threads: ${metrics["sources_dropped.long_thread_turns"]} turns). Data hash before ${before}, after ${after}: direct writes ${metrics["writes.direct"]}.\n`;
  const fails = rows.filter((r) => !r.pass);
  text += `\nFailed questions (${fails.length}): ${fails.map((r) => `${r.id}(${r.type}${r.err ? ",ERR" : ""})`).join(" ")}\n`;

  M["toolargs"] = metrics["toolargs.acc"] as number;
  M.write = metrics["write.kind_ids"] as number;
  M["route.lat"] = metrics["route_ms.p95"] as number;
  M["a0.22"] = metrics["acc.a0_subset"] as number;
  M["a0.35"] = metrics["acc.lookup_followup"] as number;
  M["cite.valid"] = metrics["cite.validity"] as number;
  M["cite.invalid"] = invalid;
  M["nf.acc"] = metrics["nf.acc"] as number;
  M["nf.false"] = metrics["nf.false"] as number;
  M.listf1 = metrics["f1.aggregation"] as number;
  M["cite.prec"] = metrics["cite.precision_start"] as number;
  M["lat.p95"] = metrics["latency_ms.p95"] as number;
  M.writes = metrics["writes.direct"] as number;
  M.whosaid = metrics["acc.who_said"] as number;
  M["a0.subset_n"] = a22.length;
  return {
    text,
    data: { rows, dataHash: { before, after }, a0Ids: [...a0Ids] },
    run: {
      name: "p1-e2e",
      params: {
        questions: rows.length,
        native_tools: mods.settings.readChatSettings().nativeTools,
        rounds: mods.settings.readChatSettings().rounds,
        k: mods.settings.readChatSettings().k,
        source_budget: mods.settings.readChatSettings().sourceBudget,
        deadline_ms: mods.settings.readChatSettings().deadlineMs,
        rerank: true,
      },
      tags: baseTags(env, "pipeline"),
      metrics,
    },
  };
}

// ===================================================================================
// D2. Multi-turn threads (P1.2)
// ===================================================================================

async function partThreads(
  env: Env,
  M: Record<string, number>,
): Promise<PartOut> {
  const threads = buildThreads(env.corpus);
  const use = spread(threads, env.opts.limit);
  const rows: Awaited<ReturnType<typeof runThread>> = [];
  // At most 4 threads at once (owner rule); default 2: a desktop llama.cpp
  // server with few slots queues the calls and a turn hits its deadline.
  const par = Math.min(4, Number(process.env.CHAT_EVAL_THREADS_PAR ?? 2) || 2);
  let next = 0;
  const worker = async () => {
    while (next < use.length) {
      const th = use[next++] as (typeof use)[number];
      const r = await runThread(env, th);
      rows.push(...r);
      env.log(
        `threads ${th.id}: ${r.filter((x) => x.pass).length}/${r.length}`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(par, use.length) }, worker));
  rows.sort((a, b) => a.thread.localeCompare(b.thread) || a.turn - b.turn);
  const m = summarizeThreads(rows);
  let text = `Threads: ${m.threads} threads, ${m.turns} turns (real answers fed back). Turn accuracy ${pct(m.acc as number)}%; decided ${pct(m["acc.decided"] ?? 0)}%, steps ${pct(m["acc.steps"] ?? 0)}%, fact ${pct(m["acc.fact"] ?? 0)}%, why ${pct(m["acc.why"] ?? 0)}%, switch ${pct(m["acc.switch"] ?? 0)}%, who ${pct(m["acc.who"] ?? 0)}%, overview ${pct(m["acc.overview"] ?? 0)}%. Repeated answers ${m.repeats}; cite marker leaks ${m.leaks}; errors ${m.errors}; threads all pass ${m.threads_all_pass} of ${m.threads}.\n`;
  text += `\n| thread | turn | kind | pass | repeat | tool | cites | answer |\n|---|---|---|---|---|---|---|---|\n`;
  for (const r of rows)
    text += `| ${r.thread} | ${r.turn} | ${r.kind} | ${r.pass ? "ok" : "FAIL"} | ${r.repeat ? "REPEAT" : ""} | ${r.tool ?? ""} | ${r.cites.join(" ")} | ${r.answer.replace(/\s+/g, " ").slice(0, 80)} |\n`;
  M["thr.acc"] = m.acc as number;
  M["thr.repeats"] = m.repeats as number;
  return {
    text,
    data: { rows, metrics: m },
    run: {
      name: "p1-threads",
      params: { threads: m.threads, turns: m.turns, history: "real answers" },
      tags: baseTags(env, "threads"),
      metrics: m,
    },
  };
}

// ===================================================================================
// E. A0 on the same questions
// ===================================================================================

function partA0(env: Env, M: Record<string, number>): PartOut {
  const { gold } = env;
  const ids = gold.questions
    .filter(
      (q) =>
        ["text", "not_found", "count"].includes(q.key.kind) &&
        (q.scope.kind === "meeting" || q.scope.kind === "folder"),
    )
    .map((q) => q.id);
  const files = existsSync(OUT)
    ? readdirSync(OUT)
        .filter((f) => /^a0-\d+\.json$/.test(f))
        .sort()
    : [];
  const file = files.at(-1);
  if (!file) throw new Error(`no A0 result in ${OUT}; run: pnpm chat-eval a0`);
  const saved = JSON.parse(readFileSync(join(OUT, file), "utf8")) as {
    rows: { id: string; type: string; pass: boolean }[];
  };
  const savedIds = saved.rows.map((r) => r.id);
  const same =
    ids.length === savedIds.length &&
    sha16([...ids].sort()) === sha16([...savedIds].sort());
  const metrics: Record<string, number> = {
    ids_current: ids.length,
    ids_saved: savedIds.length,
    same_ids: same ? 1 : 0,
  };
  let text = `A0 result file ${file}: ${savedIds.length} question ids; the gold set now has ${ids.length} for the A0 filter. The id sets are ${same ? "the SAME" : "DIFFERENT"}.\n`;
  if (!same) {
    text +=
      "The A0 numbers do not apply. Run: pnpm chat-eval a0 (separate process), then run p1 again.\n";
    return {
      text,
      data: { same, file },
      run: {
        name: "p1-a0",
        params: { file },
        tags: baseTags(env, "A0"),
        metrics,
      },
    };
  }
  const lf = saved.rows.filter(
    (r) => r.type === "lookup" || r.type === "follow_up",
  );
  metrics.a0_lookup_followup_n = lf.length;
  metrics.a0_lookup_followup_acc = mean(lf.map((r) => (r.pass ? 1 : 0)));
  text += `A0 on lookup + follow-up (${lf.length} questions): ${pct(metrics.a0_lookup_followup_acc as number)}% (${lf.filter((r) => r.pass).length} passes). The P1 bar is A0 + 10 points = ${pct((metrics.a0_lookup_followup_acc as number) + 0.1)}%.\n`;
  M["a0.baseline"] = metrics.a0_lookup_followup_acc as number;
  return {
    text,
    data: { same, file, lookupFollowup: lf.length },
    run: {
      name: "p1-a0",
      params: { file, same_ids: true },
      tags: baseTags(env, "A0"),
      metrics,
    },
  };
}

// ===================================================================================
// Scale: latency at N x the corpus
// ===================================================================================

async function partScale(
  env: Env,
  M: Record<string, number>,
): Promise<PartOut> {
  const { stack, corpus, gold, log } = env;
  const n = env.opts.scale > 1 ? env.opts.scale : 256;
  const extra: Corpus[] = [];
  for (let i = 1; i < n; i++) {
    const x = buildCorpus(corpus.seed + i * 7919, `s${i}-`);
    loadCorpus(stack, { ...x, folders: [] });
    extra.push(x);
  }
  const t0 = performance.now();
  let done = 0;
  for (const x of extra)
    for (const m of x.meetings) {
      await stack.mod.indexMeeting(m.id);
      if (++done % 500 === 0) log(`scale: indexed ${done} meetings`);
    }
  const rows = (
    stack.db.prepare("SELECT COUNT(*) AS n FROM meeting_chunks").get() as {
      n: number;
    }
  ).n;
  log(
    `scale: ${rows} chunk rows, indexed in ${((performance.now() - t0) / 60000).toFixed(1)} min`,
  );
  const queries = spread(gold.retrieval, env.opts.limit);
  const rangeOf = (q: (typeof queries)[number]) =>
    q.dateFrom && q.dateTo
      ? {
          fromMs: Date.parse(`${q.dateFrom}T00:00:00Z`),
          toMs: Date.parse(`${q.dateTo}T00:00:00Z`) + DAY,
        }
      : undefined;
  const metrics: Record<string, number> = { scale: n, chunk_rows: rows };
  let text = `Scale x${n}: ${rows} chunk rows, ${queries.length} queries, production retrieve() k=10, warm.\n\n| arm | p50 ms | p95 ms | rerank p95 ms |\n|---|---|---|---|\n`;
  const rssAll = new RssSampler(/--embed|--rerank/, 2000);
  rssAll.start();
  for (const [id, extraOpts] of [
    ["dense", {}],
    ["hybrid", { mode: "hybrid" }],
    ["hybrid_rerank15", { mode: "hybrid", rerank: { candidates: 15 } }],
  ] as [string, Record<string, unknown>][]) {
    const call = (q: (typeof queries)[number]) => {
      const range = rangeOf(q);
      return stack.mod.retrieve({
        query: { kind: "text", text: q.text },
        scope: { kind: "all" },
        k: 10,
        ...(range ? { dateRange: range } : {}),
        ...extraOpts,
      } as Parameters<typeof stack.mod.retrieve>[0]);
    };
    for (let i = 0; i < 3; i++)
      await call(queries[0] as (typeof queries)[number]);
    const times: number[] = [];
    const rr: number[] = [];
    for (const q of queries) {
      const ts = performance.now();
      const res = await call(q);
      times.push(performance.now() - ts);
      if (res.status !== "ok")
        throw new Error(`scale ${id} ${q.id}: ${res.status}`);
      if (res.ms) rr.push(res.ms.rerank);
    }
    metrics[`${id}.latency_ms.p50`] = percentile(times, 50);
    metrics[`${id}.latency_ms.p95`] = percentile(times, 95);
    if (extraOpts.rerank) metrics[`${id}.rerank_ms.p95`] = percentile(rr, 95);
    text += `| ${id} | ${ms0(percentile(times, 50))} | ${ms0(percentile(times, 95))} | ${extraOpts.rerank ? ms0(percentile(rr, 95)) : "-"} |\n`;
    rssAll.sample();
  }
  rssAll.stop();
  metrics.rss_peak_mb = rssAll.peakMb;
  M["ret.lat.scale"] = metrics["hybrid.latency_ms.p95"] as number;
  return {
    text,
    data: { metrics },
    run: {
      name: "p1-scale",
      params: { scale: n, queries: queries.length },
      tags: baseTags(env, "scale"),
      metrics,
    },
  };
}

// ===================================================================================
// The driver
// ===================================================================================

export async function runP1(
  corpus: Corpus,
  gold: GoldSet,
  hashes: { corpus: string; gold: string },
  opts: P1Options,
  emit: (run: RunOut) => Promise<void>,
  save: (partial: Record<string, unknown>) => void,
): Promise<P1Result> {
  const log = (s: string) =>
    console.log(`[${new Date().toTimeString().slice(0, 8)}] ${s}`);
  for (const v of ["OPENSTYLE_MLX_LLM_WORKER", "OPENSTYLE_EVAL_HF_HOME"]) {
    if (!process.env[v])
      throw new Error(
        `set ${v} (see .claude/skills/chat-eval/SKILL.md, section P1)`,
      );
  }
  const want = (p: Part) =>
    opts.only ? opts.only.has(p) : p !== "scale" || opts.scale > 1;
  const stack = await bootStack("p1", true);
  // The reranker worker is the same dev launcher as the LLM and embed worker.
  process.env.OPENSTYLE_MLX_RERANK_WORKER ??=
    process.env.OPENSTYLE_MLX_LLM_WORKER;
  loadCorpus(stack, corpus);
  const s = (p: string) => import(`../../apps/server/src/lib/${p}`);
  const [
    pipeline,
    llm,
    settings,
    prompts,
    plan,
    choices,
    context,
    rerankConst,
    llmServer,
    rerankServer,
  ] = await Promise.all([
    s("chat/pipeline.ts"),
    s("chat/llm.ts"),
    s("chat/settings.ts"),
    s("chat/prompts.ts"),
    s("chat/plan.ts"),
    s("chat/choices.ts"),
    s("chat/context.ts"),
    s("mlx-rerank/constants.ts"),
    s("mlx-llm/server.ts"),
    s("mlx-rerank/server.ts"),
  ]);
  // The scratch profile: the default LLM, the search model, the chat switches.
  const w = stack.mod.writeSetting;
  w("search_embedding_model", EMBED_MODEL_ID);
  w("meeting_chat_enabled", "true");
  w("chat_native_tools", "true");
  stack.db
    .prepare("UPDATE model_configs SET is_default = 0 WHERE type = 'llm'")
    .run();
  let defaultProvider = "local-mlx-llm";
  let defaultModelId = LLM_STORED_ID;
  if (BASE_URL) {
    // The scratch DB gets one own-server row, as the Models page would add it.
    const servers = await import("../../apps/server/src/lib/own-servers.ts");
    const row = servers.insertOwnServer({
      baseUrl: BASE_URL.replace(/\/v1\/?$/, ""),
      apiKey: null,
      flavor: "openai",
    });
    defaultProvider = "server";
    defaultModelId = `server/${row.id}/${MODEL_ID}`; // serverModelId() of the app
  }
  stack.db
    .prepare(
      `INSERT INTO model_configs (provider, model_id, model_name, type, is_default)
       VALUES (?, ?, ?, 'llm', 1)
       ON CONFLICT(provider, model_id, type) DO UPDATE SET is_default = 1`,
    )
    .run(defaultProvider, defaultModelId, MODEL_ID);
  const maps = buildIdMaps(corpus, stack.mod.actionItemKey);
  const env: Env = {
    stack,
    corpus,
    gold,
    hashes,
    maps,
    mods: {
      pipeline,
      llm,
      settings,
      prompts,
      plan,
      choices,
      context,
      rerankConst,
      llmServer,
      rerankServer,
    },
    log,
    opts,
    index: null,
  };
  if (want("retrieval") || want("e2e") || want("threads") || want("scale")) {
    const st = stack.mod.searchState();
    if (st.state !== "on") throw new Error(`search is off: ${st.reason}`);
    const t0 = performance.now();
    for (const m of corpus.meetings) await stack.mod.indexMeeting(m.id);
    const indexMs = performance.now() - t0;
    const chunks = loadChunks(stack, st.modelId);
    log(`indexed ${chunks.length} chunks in ${(indexMs / 1000).toFixed(1)} s`);
    env.index = { indexMs, chunks };
  }
  const M: Record<string, number> = {};
  const outputs: Record<string, PartOut | { error: string }> = {};
  const texts: string[] = [];
  const runs: RunOut[] = [];
  const errors: string[] = [];
  const done = async (name: Part, f: () => Promise<PartOut> | PartOut) => {
    if (!want(name)) return;
    log(`part ${name} starts`);
    try {
      const out = await f();
      outputs[name] = out;
      texts.push(`## ${name}\n\n${out.text}`);
      runs.push(out.run);
      console.log(`\n## ${name}\n\n${out.text}`);
      await emit(out.run);
    } catch (e) {
      const msg = `${name}: ${(e as Error).stack ?? e}`;
      errors.push(msg);
      outputs[name] = { error: String(e) };
      console.error(`part ${name} FAILED: ${msg}`);
    }
    save({
      hashes,
      options: { ...opts, only: opts.only ? [...opts.only] : null },
      measured: M,
      parts: outputs,
    });
  };
  const llmRss = new RssSampler(/--llm/, 5000);
  try {
    await done("retrieval", () => partRetrieval(env, M));
    llmRss.start();
    await done("router", () => partRouter(env, M));
    await done("slots", () => partSlots(env, M));
    await done("e2e", () => partE2e(env, M));
    await done("threads", () => partThreads(env, M));
    await done("a0", () => partA0(env, M));
    await done("scale", () => partScale(env, M));
    llmRss.stop();
    let barsText = "";
    let barRows = evaluateBars(M);
    if (want("bars")) {
      barsText = barsTable(barRows);
      const bm: Record<string, number> = {};
      let pass = 0;
      let fail = 0;
      let notRun = 0;
      for (const r of barRows) {
        if (r.status === "PASS") pass++;
        else if (r.status === "FAIL") fail++;
        else if (r.status === "NOT RUN") notRun++;
        bm[`bar.${safe(r.id)}`] =
          r.status === "PASS" ? 1 : r.status === "FAIL" ? 0 : -1;
        const v = M[r.id];
        if (v !== undefined && Number.isFinite(v))
          bm[`measured.${safe(r.id)}`] = v;
      }
      bm.pass = pass;
      bm.fail = fail;
      bm.not_run = notRun;
      const run: RunOut = {
        name: "p1-bars",
        params: { bars: barRows.length, thresholds: "report 7 and spec 8.7" },
        tags: baseTags(env, "bars"),
        metrics: bm,
      };
      const text = `${barsText}\n\nPASS ${pass}, FAIL ${fail}, NOT RUN ${notRun}, of ${barRows.length} bars.\n`;
      outputs.bars = { text, data: barRows, run };
      texts.push(`## bars\n\n${text}`);
      runs.push(run);
      console.log(`\n## bars\n\n${text}`);
      await emit(run);
    } else {
      barRows = [];
    }
    save({
      hashes,
      options: { ...opts, only: opts.only ? [...opts.only] : null },
      measured: M,
      parts: outputs,
      bars: barRows,
    });
    if (errors.length > 0) {
      texts.push(`## errors\n\n${errors.join("\n")}`);
      process.exitCode = 1;
    }
    return {
      text: texts.join("\n\n"),
      result: { hashes, measured: M, parts: outputs, bars: barRows, errors },
      runs,
    };
  } finally {
    llmRss.stop();
    await stack.mod.stopMlxEmbedWorker().catch(() => {});
    await llmServer.stopMlxLlmWorker().catch(() => {});
    await rerankServer.stopMlxRerankWorker().catch(() => {});
  }
}
