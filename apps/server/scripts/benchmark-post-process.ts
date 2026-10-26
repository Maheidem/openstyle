// Dictation cleanup benchmark.
//
// Groq (default):
//   pnpm dlx tsx apps/server/scripts/benchmark-post-process.ts --suite=full
// Local MLX LLM (the app's local-mlx-llm provider and worker):
//   HF_HOME=/tmp/meeting-eval/hf OPENSTYLE_MLX_LLM_WORKER=<worker binary> \
//   pnpm dlx tsx apps/server/scripts/benchmark-post-process.ts \
//     --provider=local-mlx --models=gemma-4-e2b-qat-4bit --suite=full --out=/tmp/dictation-bench.json
// (node's strip-only TypeScript mode cannot load the server sources.)
// --models takes catalog ids (apps/server/src/lib/mlx-llm/constants.ts) or their HF ids.
// Without OPENSTYLE_MLX_LLM_WORKER the managed runtime worker runs.
import { writeFileSync } from "node:fs";
import {
  maxOutputTokensForCleanup,
  sanitizeTranscriptText,
} from "@openstyle/stt";
import type { LanguageModel } from "ai";
import { generateText } from "ai";
import { buildRewritePrompt } from "../src/lib/editor/prompts.ts";
import { getGroqChatModel } from "../src/lib/groq-http.ts";
import {
  getLlmProvider,
  groqCleanupProviderOptions,
} from "../src/lib/llm/registry.ts";
import {
  MLX_LLM_MODELS,
  MLX_LLM_PROVIDER_ID,
} from "../src/lib/mlx-llm/constants.ts";
import {
  ensureMlxLlmWorker,
  mlxLlmWorkerOverride,
  stopMlxLlmWorker,
} from "../src/lib/mlx-llm/server.ts";
import {
  type BenchmarkCase,
  POST_PROCESS_BENCHMARK_CASES,
} from "./post-process-benchmark-cases.ts";

type PromptVariant = "baseline" | "dynamic-language";
type BenchmarkSuite = "quick" | "full";
type Provider = "groq" | "local-mlx";

interface BenchmarkResult {
  provider: Provider;
  modelId: string;
  variant: PromptVariant;
  passed: number;
  total: number;
  byLanguage: Record<string, { passed: number; total: number }>;
  latencyMs: { p50: number; p95: number };
  failures: string[];
  /** Every case with its output, for a later blind quality pass. */
  cases: {
    id: string;
    language: string;
    pass: boolean;
    latencyMs: number;
    inputTokens: number;
    outputTokens: number;
    actual: string;
    /** local-mlx only: the worker stats from the response usage. */
    workerUsage?: WorkerUsage;
  }[];
  /** local-mlx only: worker time to first token, from the response usage. */
  ttftMs?: { p50: number; p95: number };
  /** local-mlx only: the worker binary and the worker start + model load time. */
  worker?: { binary: string; startMs: number };
}

/** The mlx-lm stats that the local LLM worker adds to usage (specs/llm-runtime-tuning.md). */
interface WorkerUsage {
  ttft_ms?: number;
  total_ms?: number;
  prompt_tps?: number;
  generation_tps?: number;
  peak_memory_bytes?: number;
  /** Prompt tokens that came from the worker prefix cache (cleanup only). */
  cached_tokens?: number;
}

function workerUsageOf(body: unknown): WorkerUsage | undefined {
  const usage = (body as { usage?: Record<string, unknown> } | undefined)
    ?.usage;
  if (!usage || typeof usage.ttft_ms !== "number") return undefined;
  const out: WorkerUsage = {};
  for (const key of [
    "ttft_ms",
    "total_ms",
    "prompt_tps",
    "generation_tps",
    "peak_memory_bytes",
    "cached_tokens",
  ] as const) {
    if (typeof usage[key] === "number") out[key] = usage[key] as number;
  }
  return out;
}

const MODELS = [
  "llama-3.1-8b-instant",
  "openai/gpt-oss-20b",
  "qwen/qwen3-32b",
  "meta-llama/llama-4-scout-17b-16e-instruct",
] as const;

const QUICK_CASE_PREFIXES = [
  "date-correction",
  "recipient-correction",
  "dictated-list",
  "superseded-plan",
] as const;

function normalizeForCompare(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/\r\n/g, "\n")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim();
}

function containsAll(text: string, patterns: RegExp[]): boolean {
  return patterns.every((pattern) => pattern.test(text));
}

function containsNone(text: string, patterns: RegExp[]): boolean {
  return patterns.every((pattern) => !pattern.test(text));
}

function evaluateCase(testCase: BenchmarkCase, actual: string): boolean {
  const normalized = normalizeForCompare(actual);

  if (testCase.id.startsWith("date-correction")) {
    if (testCase.language === "en") {
      return (
        containsAll(normalized, [/friday/i, /\bthree\b/i]) &&
        containsNone(normalized, [/thursday/i])
      );
    }
    if (testCase.language === "es") {
      return (
        containsAll(normalized, [/viernes/i, /tres/i]) &&
        containsNone(normalized, [/jueves/i])
      );
    }
    return (
      containsAll(normalized, [/周五/, /三点/]) &&
      containsNone(normalized, [/周四/])
    );
  }

  if (testCase.id.startsWith("recipient-correction")) {
    if (testCase.language === "en" || testCase.language === "es") {
      return (
        containsAll(normalized, [/legal/i]) &&
        containsNone(normalized, [/marketing/i])
      );
    }
    return (
      containsAll(normalized, [/法务/]) && containsNone(normalized, [/市场部/])
    );
  }

  if (testCase.id.startsWith("dictated-list")) {
    if (testCase.language === "en") {
      return containsAll(normalized, [
        /^here'?s what i need by end of week:/i,
        /1\./,
        /2\./,
        /3\./,
        /sam/i,
        /design/i,
        /finance/i,
      ]);
    }
    if (testCase.language === "es") {
      return containsAll(normalized, [
        /^esto es lo que necesito para fin de semana:/i,
        /1\./,
        /2\./,
        /3\./,
        /sam/i,
        /diseno/i,
        /finanzas/i,
      ]);
    }
    return containsAll(normalized, [
      /^这是我(?:在)?周末前需要的[:：]/,
      /1[.．、]/,
      /2[.．、]/,
      /3[.．、]/,
      /Sam/i,
      /设计/,
      /财务/,
    ]);
  }

  if (testCase.id.startsWith("superseded-plan")) {
    if (testCase.language === "en" || testCase.language === "es") {
      return (
        containsAll(normalized, [/zoom/i]) &&
        containsNone(normalized, [/san francisco/i, /oakland/i])
      );
    }
    return (
      containsAll(normalized, [/Zoom/i]) &&
      containsNone(normalized, [/旧金山/, /奥克兰/])
    );
  }

  return normalizeForCompare(testCase.expected) === normalized;
}

function buildBenchmarkPrompt(
  input: string,
  language: BenchmarkCase["language"],
  variant: PromptVariant,
): { system: string; prompt: string } {
  return buildRewritePrompt(
    input,
    variant === "baseline" ? undefined : { languages: [language] },
  );
}

/** The catalog id of a local MLX model, from a catalog id or its HF id. */
function localCatalogId(modelId: string): string {
  const def = MLX_LLM_MODELS.find(
    (m) => m.id === modelId || m.hfId === modelId,
  );
  if (!def) {
    throw new Error(
      `Unknown local MLX model: ${modelId}. Use one of: ${MLX_LLM_MODELS.map((m) => m.id).join(", ")}`,
    );
  }
  return def.id;
}

/** The app's own local-mlx-llm provider (llm/registry.ts), so the request matches the app. */
async function localMlxModel(catalogId: string): Promise<LanguageModel> {
  const provider = getLlmProvider(MLX_LLM_PROVIDER_ID);
  if (!provider) throw new Error(`No provider ${MLX_LLM_PROVIDER_ID}`);
  return provider.createModel(catalogId, "local", { task: "cleanup" });
}

async function runCase(
  provider: Provider,
  modelId: string,
  variant: PromptVariant,
  testCase: BenchmarkCase,
) {
  const started = Date.now();
  const model =
    provider === "local-mlx"
      ? await localMlxModel(modelId)
      : getGroqChatModel(modelId);
  const { system, prompt } = buildBenchmarkPrompt(
    testCase.input,
    testCase.language,
    variant,
  );
  const result = await generateText({
    model,
    instructions: system,
    prompt,
    temperature: 0,
    maxOutputTokens: maxOutputTokensForCleanup(testCase.input),
    providerOptions:
      provider === "groq" ? groqCleanupProviderOptions(modelId, false) : {},
    // The worker stats are in the raw usage (workerUsageOf).
    include: { responseBody: provider === "local-mlx" },
  });

  const actual = sanitizeTranscriptText(result.text);
  return {
    actual,
    latencyMs: Date.now() - started,
    inputTokens: result.usage?.inputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
    workerUsage: workerUsageOf(result.response?.body),
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, index)] as number;
}

function parseArg(name: string): string | null {
  const arg = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : null;
}

function parseCsvArg(name: string): string[] | null {
  const arg = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  if (!arg) return null;
  return (
    arg
      .split("=")[1]
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) ?? null
  );
}

async function runBenchmarkSuite(
  provider: Provider,
  variant: PromptVariant,
  suite: BenchmarkSuite,
): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];
  const modelArg = parseCsvArg("models");
  if (provider === "local-mlx" && !modelArg) {
    throw new Error("--provider=local-mlx needs --models=<catalog id,...>");
  }
  const selectedModels =
    provider === "local-mlx"
      ? (modelArg ?? []).map(localCatalogId)
      : (modelArg ?? [...MODELS]);
  const requestedLanguages = new Set(parseCsvArg("languages") ?? []);
  const selectedCases =
    suite === "quick"
      ? POST_PROCESS_BENCHMARK_CASES.filter((testCase) =>
          QUICK_CASE_PREFIXES.some((prefix) => testCase.id.startsWith(prefix)),
        )
      : POST_PROCESS_BENCHMARK_CASES;
  const filteredCases =
    requestedLanguages.size > 0
      ? selectedCases.filter((testCase) =>
          requestedLanguages.has(testCase.language),
        )
      : selectedCases;

  for (const modelId of selectedModels) {
    const byLanguage: BenchmarkResult["byLanguage"] = {};
    let passed = 0;
    const latencies: number[] = [];
    const failures: string[] = [];
    const cases: BenchmarkResult["cases"] = [];
    let worker: BenchmarkResult["worker"];

    if (provider === "local-mlx") {
      // Start the worker and load the model before the first case, so the
      // case latencies hold no model load.
      const startedAt = Date.now();
      await ensureMlxLlmWorker(modelId);
      worker = {
        binary: mlxLlmWorkerOverride() ?? "managed runtime worker",
        startMs: Date.now() - startedAt,
      };
      console.log(
        `[local-mlx] ${modelId}: worker ${worker.binary} ready in ${worker.startMs}ms`,
      );
    }

    for (const testCase of filteredCases) {
      const outcome = await runCase(provider, modelId, variant, testCase);
      const ok = evaluateCase(testCase, outcome.actual);
      latencies.push(outcome.latencyMs);
      if (!ok) failures.push(testCase.id);
      cases.push({
        id: testCase.id,
        language: testCase.language,
        pass: ok,
        latencyMs: outcome.latencyMs,
        inputTokens: outcome.inputTokens,
        outputTokens: outcome.outputTokens,
        actual: outcome.actual,
        ...(outcome.workerUsage ? { workerUsage: outcome.workerUsage } : {}),
      });
      if (!byLanguage[testCase.language]) {
        byLanguage[testCase.language] = { passed: 0, total: 0 };
      }
      byLanguage[testCase.language].total += 1;
      if (ok) {
        passed += 1;
        byLanguage[testCase.language].passed += 1;
      }
      console.log(
        `[${variant}/${suite}] ${modelId} :: ${testCase.id} :: ${ok ? "PASS" : "FAIL"} (${outcome.latencyMs}ms, in=${outcome.inputTokens}, out=${outcome.outputTokens})`,
      );
      if (!ok) {
        console.log(`  expected: ${JSON.stringify(testCase.expected)}`);
        console.log(`  actual:   ${JSON.stringify(outcome.actual)}`);
      }
    }

    const sorted = [...latencies].sort((a, b) => a - b);
    const ttfts = cases
      .map((c) => c.workerUsage?.ttft_ms)
      .filter((t): t is number => typeof t === "number")
      .sort((a, b) => a - b);
    results.push({
      provider,
      modelId,
      variant,
      passed,
      total: filteredCases.length,
      byLanguage,
      latencyMs: { p50: percentile(sorted, 50), p95: percentile(sorted, 95) },
      ...(ttfts.length
        ? { ttftMs: { p50: percentile(ttfts, 50), p95: percentile(ttfts, 95) } }
        : {}),
      failures,
      cases,
      ...(worker ? { worker } : {}),
    });
  }

  return results;
}

function printSummary(results: BenchmarkResult[]): void {
  console.log("\nSummary");
  for (const result of results) {
    const byLang = Object.entries(result.byLanguage)
      .map(([lang, stats]) => `${lang} ${stats.passed}/${stats.total}`)
      .join(" | ");
    console.log(
      `${result.variant} :: ${result.modelId} => ${result.passed}/${result.total} (${byLang}) p50 ${result.latencyMs.p50}ms p95 ${result.latencyMs.p95}ms`,
    );
    if (result.failures.length > 0) {
      console.log(`  failures: ${result.failures.join(", ")}`);
    }
    if (result.worker) {
      console.log(
        `  worker: ${result.worker.binary} (start ${result.worker.startMs}ms)`,
      );
    }
    if (result.ttftMs) {
      console.log(
        `  ttft p50 ${result.ttftMs.p50}ms p95 ${result.ttftMs.p95}ms (worker usage)`,
      );
    }
  }
}

async function main() {
  const variantArg = process.argv.find((arg) => arg.startsWith("--variant="));
  const suiteArg = process.argv.find((arg) => arg.startsWith("--suite="));
  const variant =
    (variantArg?.split("=")[1] as PromptVariant | undefined) ?? "baseline";
  const suite =
    (suiteArg?.split("=")[1] as BenchmarkSuite | undefined) ?? "quick";

  if (variant !== "baseline" && variant !== "dynamic-language") {
    throw new Error(`Unsupported variant: ${variant}`);
  }
  if (suite !== "quick" && suite !== "full") {
    throw new Error(`Unsupported suite: ${suite}`);
  }
  const provider = (parseArg("provider") ?? "groq") as Provider;
  if (provider !== "groq" && provider !== "local-mlx") {
    throw new Error(`Unsupported provider: ${provider}`);
  }

  try {
    const results = await runBenchmarkSuite(provider, variant, suite);
    printSummary(results);
    const out = parseArg("out");
    if (out) {
      writeFileSync(
        out,
        `${JSON.stringify({ createdAt: new Date().toISOString(), suite, results }, null, 2)}\n`,
      );
      console.log(`json: ${out}`);
    }
  } finally {
    if (provider === "local-mlx") await stopMlxLlmWorker();
  }
}

void main();
