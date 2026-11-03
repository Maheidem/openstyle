/**
 * Tokens and USD of one chat run (2026-11-03). The gateway records every call
 * of a run in `llm_calls` (scratch DB). This file sums them by run id and
 * prices them with the prices of `cloud-models.ts`. A local model costs 0.
 * Anthropic cache-write tokens are in `params_json` as `cache_write_tokens`.
 */
import type { DatabaseSync } from "node:sqlite";

export interface Usage {
  in: number;
  out: number;
  cached: number;
  cacheWrite: number;
  reasoning: number;
}

export interface Prices {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export const ZERO_USAGE: Usage = {
  in: 0,
  out: 0,
  cached: 0,
  cacheWrite: 0,
  reasoning: 0,
};

/** Sums the tokens of every call of one run (all attempts, also failed ones). */
export function usageOfRun(db: DatabaseSync, runId: string): Usage {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(input_tokens), 0) AS i,
              COALESCE(SUM(output_tokens), 0) AS o,
              COALESCE(SUM(cached_tokens), 0) AS c,
              COALESCE(SUM(reasoning_tokens), 0) AS r,
              COALESCE(SUM(CAST(json_extract(params_json, '$.cache_write_tokens') AS INTEGER)), 0) AS w
         FROM llm_calls WHERE run_id = ?`,
    )
    .get(runId) as { i: number; o: number; c: number; r: number; w: number };
  return {
    in: Number(r.i),
    out: Number(r.o),
    cached: Number(r.c),
    cacheWrite: Number(r.w),
    reasoning: Number(r.r),
  };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    in: a.in + b.in,
    out: a.out + b.out,
    cached: a.cached + b.cached,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
  };
}

/**
 * USD of a usage. `in` holds all input tokens, cached ones included. The
 * plain part is billed at the input price. Reasoning tokens are inside `out`.
 */
export function usdOf(u: Usage, p: Prices | null): number {
  if (!p) return 0;
  const plain = Math.max(0, u.in - u.cached - u.cacheWrite);
  return (
    (plain * p.input +
      u.cached * p.cacheRead +
      u.cacheWrite * p.cacheWrite +
      u.out * p.output) /
    1_000_000
  );
}

/** Prices of the cloud model of this run, or null for a local or remote server model. */
export async function loadPrices(): Promise<Prices | null> {
  const provider = process.env.CHAT_EVAL_CLOUD_PROVIDER?.trim();
  const model = process.env.CHAT_EVAL_MODEL?.trim();
  if (!provider || !model) return null;
  const { cloudLlmPrices } = await import(
    "../../apps/server/src/lib/cloud-models.ts"
  );
  return cloudLlmPrices(provider, model);
}

/** Metrics for MLflow and the summary line, from the sum of the rows. */
export function usageMetrics(
  u: Usage,
  usd: number,
  turns: number,
): Record<string, number> {
  return {
    tokens_in: u.in,
    tokens_out: u.out,
    tokens_cached: u.cached,
    tokens_cache_write: u.cacheWrite,
    tokens_reasoning: u.reasoning,
    usd_total: usd,
    usd_per_turn: turns > 0 ? usd / turns : 0,
  };
}

export const usageLine = (m: Record<string, number>): string =>
  `Tokens in ${m.tokens_in} / out ${m.tokens_out} / cached ${m.tokens_cached} / cache write ${m.tokens_cache_write}; USD total ${m.usd_total.toFixed(4)}, per digging turn ${m.usd_per_turn.toFixed(4)}.`;

// ---------------------------------------------------------------------------
// Evidence of a turn (eval only, 2026-11-03). Everything comes from the call
// records of the scratch DB, so the product code is not changed.
// ---------------------------------------------------------------------------

import { execSync } from "node:child_process";

let sha: string | null = null;
/** The commit of the code under test. */
export function commitSha(): string {
  if (sha === null) {
    try {
      sha = execSync("git rev-parse --short HEAD", {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      sha = "unknown";
    }
  }
  return sha;
}

export interface CallEvidence {
  node: string;
  step: string;
  attempt: number;
  finish: string | null;
  in: number | null;
  out: number | null;
  ms: number | null;
  /** The parsed answer of a worker call (chatDig), cut. */
  parsed: string | null;
}

export interface TurnEvidence {
  sha: string;
  calls: CallEvidence[];
  /** The messages of the LAST chatAnswer call: the sources that reached the answer call. */
  answerPrompt: string | null;
}

const cut = (s: string | null, n: number): string | null =>
  s === null ? null : s.length > n ? `${s.slice(0, n)}...` : s;

export function evidenceOfRun(db: DatabaseSync, runId: string): TurnEvidence {
  const rows = db
    .prepare(
      `SELECT node, step_key, attempt, finish_unified, input_tokens,
              output_tokens, latency_ms, parsed_json, messages_json
         FROM llm_calls WHERE run_id = ? ORDER BY id`,
    )
    .all(runId) as {
    node: string;
    step_key: string;
    attempt: number;
    finish_unified: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    latency_ms: number | null;
    parsed_json: string | null;
    messages_json: string | null;
  }[];
  let answerPrompt: string | null = null;
  for (const r of rows)
    if (r.node === "chatAnswer") answerPrompt = r.messages_json;
  return {
    sha: commitSha(),
    calls: rows.map((r) => ({
      node: r.node,
      step: r.step_key,
      attempt: r.attempt,
      finish: r.finish_unified,
      in: r.input_tokens,
      out: r.output_tokens,
      ms: r.latency_ms,
      parsed: r.node === "chatDig" ? cut(r.parsed_json, 3000) : null,
    })),
    answerPrompt,
  };
}
