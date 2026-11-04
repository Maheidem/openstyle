// Dictation pipeline bench (specs/dictation-pipeline.md 7): the one-call
// cleanup of main ("main") against the staged pipeline ("pipeline"), on the
// 27 bench cases (medium) and the fictional pipeline cases (own intensity and
// tone), with the app's local MLX provider and worker.
//
// --base-url=http://<host>:<port>/v1 --model=<served id> (env OMLX_KEY) runs the
// same arms on an OpenAI-style server (oMLX) instead of the local worker; add
// --sampling='{"temperature":0.1,"top_k":50,"repetition_penalty":1.1}' to
// override the app's temperature 0 and --thinking=on to keep the model's
// thinking on (default off, as the app sends enable_thinking false).
//
//   HF_HOME=<hf cache> HF_HUB_OFFLINE=1 OPENSTYLE_MLX_LLM_WORKER=<worker binary> \
//   pnpm dlx tsx apps/server/scripts/benchmark-dictation-pipeline.ts \
//     --model=gemma-4-e2b-qat-4bit --arms=main,pipeline --passes=4 --out=/tmp/x.json
//
// The cases run sorted by intensity and tone, so the worker prefix cache sees
// the same prompt run after run, as in real use. The script exits with
// process.exit: the caller kills the worker (it takes minutes after SIGTERM).
import { writeFileSync } from "node:fs";
import {
  maxOutputTokensForCleanup,
  sanitizeTranscriptText,
} from "@openstyle/stt";
import { generateText, type LanguageModel } from "ai";
import {
  type LlmStage,
  runDictationPipeline,
  type StageLlm,
} from "../src/lib/dictation/pipeline.ts";
import type { StagePrompt } from "../src/lib/dictation/prompts.ts";
import {
  buildRewritePrompt,
  resolveToneStage,
} from "../src/lib/editor/prompts.ts";
import { getLlmProvider } from "../src/lib/llm/registry.ts";
import { MLX_LLM_PROVIDER_ID } from "../src/lib/mlx-llm/constants.ts";
import { ensureMlxLlmWorker } from "../src/lib/mlx-llm/server.ts";
import {
  type CaseIntensity,
  type CaseTone,
  DICTATION_PIPELINE_CASES,
} from "./dictation-bench-cases.ts";
import {
  evaluateCase,
  POST_PROCESS_BENCHMARK_CASES,
} from "./post-process-benchmark-cases.ts";

type Arm = "main" | "pipeline";

interface Case {
  id: string;
  language: string;
  feature: string;
  intensity: CaseIntensity;
  tone?: CaseTone;
  input: string;
  check(actual: string): boolean;
}

const CASES: Case[] = [
  ...POST_PROCESS_BENCHMARK_CASES.map((c) => ({
    id: c.id,
    language: c.language,
    feature: "bench",
    intensity: "medium" as const,
    input: c.input,
    check: (a: string) => evaluateCase(c, a),
  })),
  ...DICTATION_PIPELINE_CASES.map((c) => ({
    id: c.id,
    language: c.language,
    feature: c.feature,
    intensity: c.intensity,
    tone: c.tone,
    input: c.input,
    check: (a: string) =>
      c.must.every((r) => r.test(a)) &&
      (c.mustNot ?? []).every((r) => !r.test(a)),
  })),
];

interface CallRec {
  stage: LlmStage | "main";
  ms: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number | null;
  failed: boolean;
}

/** One call, as the app makes it (temperature 0, cleanup answer budget). */
async function callModel(
  model: LanguageModel,
  call: StagePrompt,
  input: string,
  stage: CallRec["stage"],
  recs: CallRec[],
): Promise<string | null> {
  const started = Date.now();
  try {
    const r = await generateText({
      model,
      instructions: call.system,
      prompt: call.prompt,
      temperature: SAMPLING.temperature ?? 0,
      maxOutputTokens: maxOutputTokensForCleanup(input),
      include: { responseBody: true },
    });
    const usage = (
      r.response?.body as { usage?: { cached_tokens?: number } } | undefined
    )?.usage;
    const text = sanitizeTranscriptText(r.text);
    const ok = r.finishReason !== "length" && text.length > 0;
    recs.push({
      stage,
      ms: Date.now() - started,
      inputTokens: r.usage?.inputTokens ?? 0,
      outputTokens: r.usage?.outputTokens ?? 0,
      cachedTokens: usage?.cached_tokens ?? null,
      failed: !ok,
    });
    return ok ? text : null;
  } catch {
    recs.push({
      stage,
      ms: Date.now() - started,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: null,
      failed: true,
    });
    return null;
  }
}

function toneOptions(t: CaseTone | undefined) {
  return {
    destination: t?.destination ?? ("overall" as const),
    personalTone: t?.personalTone,
    workTone: t?.workTone,
    emailTone: t?.emailTone,
    overallTone: t?.overallTone,
  };
}

const SAMPLING = JSON.parse(arg("sampling") ?? "{}") as Record<string, number>;

/** An OpenAI-style server (oMLX): the same chat call as the app's own-server provider. */
async function remoteModel(modelId: string, baseUrl: string) {
  const { createOpenAI } = await import("@ai-sdk/openai");
  return createOpenAI({
    apiKey: process.env.OMLX_KEY ?? "local",
    baseURL: baseUrl,
    fetch: (async (url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const { temperature: _t, ...rest } = SAMPLING;
      Object.assign(body, rest, {
        chat_template_kwargs: {
          enable_thinking: arg("thinking") === "on",
        },
      });
      return fetch(url as string, { ...init, body: JSON.stringify(body) });
    }) as typeof fetch,
  }).chat(modelId);
}

let cleanupModel: LanguageModel;
let plainModel: LanguageModel;

async function runMain(c: Case, recs: CallRec[]): Promise<string> {
  const raw = sanitizeTranscriptText(c.input);
  const call = buildRewritePrompt(raw, {
    languages: [c.language],
    intensity: c.intensity,
    ...toneOptions(c.tone),
  });
  return (await callModel(cleanupModel, call, raw, "main", recs)) ?? raw;
}

async function runPipeline(c: Case, recs: CallRec[]): Promise<string> {
  const llm: StageLlm = async (call) => ({
    text: await callModel(
      call.stage === "cleanup" ? cleanupModel : plainModel,
      call.build(call.input),
      call.input,
      call.stage,
      recs,
    ),
  });
  const r = await runDictationPipeline(
    {
      raw: sanitizeTranscriptText(c.input),
      intensity: c.intensity,
      tone:
        c.intensity === "low" || !c.tone
          ? null
          : resolveToneStage(toneOptions(c.tone)),
      languages: [c.language],
    },
    llm,
  );
  return r.text;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, i)] as number;
}

function arg(name: string): string | undefined {
  return process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
}

/** The latency group of a case: its intensity, or "tone" when a tone is on. */
const groupOf = (c: { intensity: string; tone?: unknown }) =>
  c.tone ? `${c.intensity}+tone` : c.intensity;

interface Row {
  arm: Arm;
  pass: number;
  id: string;
  language: string;
  feature: string;
  group: string;
  ok: boolean;
  latencyMs: number;
  actual: string;
  calls: CallRec[];
}

function summary(rows: Row[], passes: number): void {
  for (const arm of new Set(rows.map((r) => r.arm))) {
    const mine = rows.filter((r) => r.arm === arm);
    const ok = mine.filter((r) => r.ok).length;
    console.log(`\n[${arm}] pass ${ok}/${mine.length}`);
    const by = (key: (r: Row) => string) => {
      const m = new Map<string, { ok: number; n: number }>();
      for (const r of mine) {
        const k = key(r);
        const v = m.get(k) ?? { ok: 0, n: 0 };
        v.n++;
        if (r.ok) v.ok++;
        m.set(k, v);
      }
      return [...m.entries()]
        .map(([k, v]) => `${k} ${v.ok}/${v.n}`)
        .join(" | ");
    };
    console.log(`  feature: ${by((r) => r.feature)}`);
    console.log(`  language: ${by((r) => r.language)}`);
    console.log(`  group: ${by((r) => r.group)}`);
    for (const g of new Set(mine.map((r) => r.group))) {
      const lat = mine
        .filter((r) => r.group === g)
        .map((r) => r.latencyMs)
        .sort((a, b) => a - b);
      console.log(
        `  latency ${g}: p50 ${percentile(lat, 50)} ms, p95 ${percentile(lat, 95)} ms (n=${lat.length})`,
      );
    }
    const ids = new Set(mine.map((r) => r.id));
    let stable = 0;
    for (const id of ids) {
      const outs = new Set(
        mine.filter((r) => r.id === id).map((r) => r.actual),
      );
      if (outs.size === 1) stable++;
    }
    const calls = mine.flatMap((r) => r.calls);
    const cleanup = calls.filter(
      (c) => c.stage === "cleanup" || c.stage === "main",
    );
    const hits = cleanup.filter((c) => (c.cachedTokens ?? 0) > 0).length;
    console.log(
      `  same output in all ${passes} passes: ${stable}/${ids.size}; calls ${calls.length} (failed ${calls.filter((c) => c.failed).length}); cleanup cache hits ${hits}/${cleanup.length}`,
    );
  }
}

/** --mlflow-experiment=<name> [--tag=k=v,k=v]: one run per arm, numbers only, read back. */
async function logMlflow(rows: Row[], modelId: string, passes: number) {
  const exp = arg("mlflow-experiment");
  if (!exp) return;
  const { logRun } = await import("../../../scripts/chat-eval/mlflow.mts");
  const tags = Object.fromEntries(
    (arg("tag") ?? "")
      .split(",")
      .filter(Boolean)
      .map((kv) => [
        kv.slice(0, kv.indexOf("=")),
        kv.slice(kv.indexOf("=") + 1),
      ]),
  );
  for (const arm of new Set(rows.map((r) => r.arm))) {
    const mine = rows.filter((r) => r.arm === arm);
    const metrics: Record<string, number> = {
      pass: mine.filter((r) => r.ok).length,
      total: mine.length,
    };
    const count = (key: (r: Row) => string, prefix: string) => {
      for (const k of new Set(mine.map(key))) {
        const sub = mine.filter((r) => key(r) === k);
        metrics[`${prefix}.${k}.pass`] = sub.filter((r) => r.ok).length;
        metrics[`${prefix}.${k}.n`] = sub.length;
      }
    };
    count((r) => r.language, "lang");
    count((r) => r.feature, "feature");
    for (const g of new Set(mine.map((r) => r.group))) {
      const lat = mine
        .filter((r) => r.group === g)
        .map((r) => r.latencyMs)
        .sort((a, b) => a - b);
      metrics[`latency.${g}.p50`] = percentile(lat, 50);
      metrics[`latency.${g}.p95`] = percentile(lat, 95);
    }
    const calls = mine.flatMap((r) => r.calls);
    metrics.calls = calls.length;
    metrics.callsFailed = calls.filter((c) => c.failed).length;
    metrics.inputTokens = calls.reduce((a, c) => a + c.inputTokens, 0);
    metrics.outputTokens = calls.reduce((a, c) => a + c.outputTokens, 0);
    metrics.callMs = calls.reduce((a, c) => a + c.ms, 0);
    const run = await logRun(
      `dictation-${modelId}-${arm}${arg("label") ? `-${arg("label")}` : ""}`,
      {
        model: modelId,
        arm,
        passes,
        baseUrl: arg("base-url") ? "remote" : "local-worker",
        sampling: arg("sampling") ?? "app (temperature 0)",
        thinking: arg("thinking") ?? "off",
      },
      { "sweep.model": modelId, ...tags },
      metrics,
      exp,
    );
    console.log(`mlflow ${exp} run ${run.runId} (${run.n} metrics, read back)`);
  }
}

async function main(): Promise<void> {
  const modelId = arg("model") ?? "gemma-4-e2b-qat-4bit";
  const arms = (arg("arms") ?? "main,pipeline").split(",") as Arm[];
  const passes = Number(arg("passes") ?? 4);
  const only = arg("only");
  const out = arg("out");
  const cases = CASES.filter(
    (c) =>
      !only ||
      (only === "bench"
        ? c.feature === "bench"
        : only === "new"
          ? c.feature !== "bench"
          : c.id.startsWith(only)),
  );
  const key = (c: Case) => `${c.intensity}|${JSON.stringify(c.tone ?? {})}`;
  const ordered = [...cases].sort((a, b) => key(a).localeCompare(key(b)));
  const t0 = Date.now();
  const baseUrl = arg("base-url");
  if (!baseUrl) await ensureMlxLlmWorker(modelId);
  console.log(
    `[bench] worker ready ${Date.now() - t0} ms; ${ordered.length} cases x ${passes} passes x ${arms.join(",")}`,
  );
  if (baseUrl) {
    cleanupModel = await remoteModel(modelId, baseUrl);
    plainModel = cleanupModel;
  } else {
    const provider = getLlmProvider(MLX_LLM_PROVIDER_ID);
    if (!provider) throw new Error(`no provider ${MLX_LLM_PROVIDER_ID}`);
    cleanupModel = await provider.createModel(modelId, "local", {
      task: "cleanup",
      sampling: {},
    });
    plainModel = await provider.createModel(modelId, "local", {
      task: "cleanup",
      sampling: {},
      prefixCache: false,
    });
  }
  const rows: Row[] = [];
  try {
    for (const arm of arms) {
      for (let pass = 1; pass <= passes; pass++) {
        let ok = 0;
        for (const c of ordered) {
          const calls: CallRec[] = [];
          const started = Date.now();
          const actual =
            arm === "main"
              ? await runMain(c, calls)
              : await runPipeline(c, calls);
          const row: Row = {
            arm,
            pass,
            id: c.id,
            language: c.language,
            feature: c.feature,
            group: groupOf(c),
            ok: c.check(actual),
            latencyMs: Date.now() - started,
            actual,
            calls,
          };
          if (row.ok) ok++;
          rows.push(row);
        }
        console.log(
          `[bench] ${modelId} ${arm} pass ${pass}: ${ok}/${ordered.length}`,
        );
      }
    }
    summary(rows, passes);
    await logMlflow(rows, modelId, passes);
  } finally {
    if (out) {
      writeFileSync(
        out,
        `${JSON.stringify({ createdAt: new Date().toISOString(), modelId, passes, rows }, null, 1)}\n`,
      );
      console.log(`json: ${out}`);
    }
    process.exit(0);
  }
}

void main();
