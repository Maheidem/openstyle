// sweep-search.mts: the search driver of the per-stage parameter sweep.
// Pure logic: the caller gives an `evaluate` function (one stage run on one
// meeting with one parameter set), so tests run on fictional numbers.
//
// The search:
//   1. The baseline (the current app settings) on every meeting.
//   2. The noise band: the baseline again with a one-word change in the
//      stage's system prompt. Band = |perturbed - baseline| per metric and
//      for the objective.
//   3. The coarse grid: every combination of the space. Temperature > 0
//      runs `repeats` times (median objective). A combination stops early
//      when, after the first `earlyStopAfter` meetings, its objective is
//      below the best objective on those meetings by more than
//      max(2 x the noise band on those meetings, earlyStopMargin).
//   4. The fine grid: around the best coarse combination, each numeric
//      parameter takes the midpoints to its neighbour values (halved steps).
//   5. The winner beats noise when (best - baseline) > the objective band.

import type { StageName } from "./stage-replay.mts";
import { type Metrics, objective, totals } from "./stage-score.mts";

export type ParamValue = number | boolean | null;
export type Params = Record<string, ParamValue>;

export interface ParamSpec {
  values: ParamValue[];
  /** Round fine-grid midpoints to whole numbers. */
  integer?: boolean;
  /** "temperature>0": the parameter applies only then (left out otherwise). */
  when?: string;
}

export interface Space {
  stage: StageName;
  baseline: Params;
  params: Record<string, ParamSpec>;
  fine?: boolean;
  repeats?: number;
  earlyStopAfter?: number;
  earlyStopMargin?: number;
}

export function parseSpace(json: string): Space {
  const s = JSON.parse(json) as Space;
  if (!s.stage || typeof s.params !== "object" || !s.baseline)
    throw new Error("space: needs stage, baseline and params");
  for (const [k, p] of Object.entries(s.params)) {
    if (!Array.isArray(p.values) || p.values.length === 0)
      throw new Error(`space: ${k} needs values`);
    if (p.when && !/^[a-z_]+>[0-9.]+$/i.test(p.when))
      throw new Error(`space: ${k}.when must look like "temperature>0"`);
  }
  return s;
}

function holds(when: string | undefined, p: Params): boolean {
  if (!when) return true;
  const [k, v] = when.split(">") as [string, string];
  return typeof p[k] === "number" && (p[k] as number) > Number(v);
}

/** Drop the parameters whose `when` does not hold; a stable key for the set. */
export function normalize(space: Space, p: Params): Params {
  const out: Params = {};
  for (const k of Object.keys(space.params).sort())
    if (p[k] !== undefined && holds(space.params[k]?.when, p))
      out[k] = p[k] as ParamValue;
  return out;
}
export const keyOf = (p: Params) => JSON.stringify(p);

function cartesian(choices: [string, ParamValue[]][]): Params[] {
  let acc: Params[] = [{}];
  for (const [k, vals] of choices)
    acc = acc.flatMap((p) => vals.map((v) => ({ ...p, [k]: v })));
  return acc;
}

/** Every distinct combination of the space (after `when`). */
export function coarseGrid(space: Space): Params[] {
  const seen = new Map<string, Params>();
  for (const p of cartesian(
    Object.entries(space.params).map(([k, s]) => [k, s.values]),
  )) {
    const n = normalize(space, p);
    seen.set(keyOf(n), n);
  }
  return [...seen.values()];
}

/**
 * The fine grid around `best`: each numeric parameter takes its value and the
 * midpoints to the next lower and higher values of its list (halved steps).
 * A parameter left out of `best` (its `when` does not hold) is tried at its
 * first listed value too, so a fine step of temperature above 0 is complete.
 */
export function fineGrid(space: Space, best: Params): Params[] {
  const choices: [string, ParamValue[]][] = [];
  for (const [k, s] of Object.entries(space.params)) {
    const v = best[k];
    const nums = s.values.filter((x): x is number => typeof x === "number");
    if (typeof v !== "number" || nums.length < 2) {
      choices.push([k, v === undefined ? [s.values[0] as ParamValue] : [v]]);
      continue;
    }
    const sorted = [...new Set(nums)].sort((a, b) => a - b);
    const i = sorted.indexOf(v);
    const round = (x: number) =>
      s.integer ? Math.round(x) : Math.round(x * 1000) / 1000;
    const vals = new Set<number>([v]);
    if (i > 0) vals.add(round(((sorted[i - 1] as number) + v) / 2));
    if (i >= 0 && i < sorted.length - 1)
      vals.add(round((v + (sorted[i + 1] as number)) / 2));
    choices.push([k, [...vals]]);
  }
  const seen = new Map<string, Params>();
  for (const p of cartesian(choices)) {
    const n = normalize(space, p);
    seen.set(keyOf(n), n);
  }
  return [...seen.values()];
}

export interface ComboResult {
  params: Params;
  phase: "baseline" | "noise" | "coarse" | "fine";
  /** Median over the repeats. */
  objective: number;
  objectives: number[];
  repeats: number;
  meetingsRun: number;
  earlyStopped: boolean;
  /** Metrics summed over the meetings, mean over the repeats. */
  totals: Metrics;
  /** Per meeting (index order), mean over the repeats. */
  perMeeting: Metrics[];
}

export interface SearchResult {
  stage: StageName;
  baseline: ComboResult;
  noise: ComboResult;
  /** Per metric: |noise - baseline|; `objective` holds the objective band. */
  band: Metrics;
  combos: ComboResult[];
  best: ComboResult;
  delta: number;
  beatsNoise: boolean;
}

export type Evaluate = (
  params: Params,
  meeting: number,
  repeat: number,
  perturb: boolean,
) => Promise<Metrics>;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2
    ? (s[m] as number)
    : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

function meanMetrics(list: Metrics[]): Metrics {
  const out: Metrics = {};
  const keys = new Set(list.flatMap((m) => Object.keys(m)));
  for (const k of keys) {
    const v = list
      .map((m) => m[k])
      .filter((x): x is number => typeof x === "number");
    out[k] = v.length
      ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10000) / 10000
      : null;
  }
  return out;
}

export function repeatsFor(space: Space, p: Params): number {
  return typeof p.temperature === "number" && p.temperature > 0
    ? (space.repeats ?? 3)
    : 1;
}

export async function search(
  space: Space,
  meetings: number,
  evaluate: Evaluate,
  log: (line: string) => void = () => {},
): Promise<SearchResult> {
  const stage = space.stage;
  const after = Math.min(space.earlyStopAfter ?? 2, meetings);
  const margin = space.earlyStopMargin ?? 1;
  const done = new Map<string, ComboResult>();

  async function runCombo(
    params: Params,
    phase: ComboResult["phase"],
    gate: ((partial: number) => boolean) | null,
  ): Promise<ComboResult> {
    const reps = phase === "noise" ? 1 : repeatsFor(space, params);
    const runs: Metrics[][] = Array.from({ length: reps }, () => []);
    let stopped = false;
    for (let mi = 0; mi < meetings; mi++) {
      for (let r = 0; r < reps; r++)
        (runs[r] as Metrics[]).push(
          await evaluate(params, mi, r, phase === "noise"),
        );
      if (gate && mi + 1 === after && mi + 1 < meetings) {
        const partial = median(runs.map((m) => objective(stage, m)));
        if (gate(partial)) {
          stopped = true;
          break;
        }
      }
    }
    const objectives = runs.map((m) => objective(stage, m));
    const res: ComboResult = {
      params,
      phase,
      objective: median(objectives),
      objectives,
      repeats: reps,
      meetingsRun: (runs[0] as Metrics[]).length,
      earlyStopped: stopped,
      totals: meanMetrics(runs.map(totals)),
      perMeeting: (runs[0] as Metrics[]).map((_, mi) =>
        meanMetrics(runs.map((m) => m[mi] as Metrics)),
      ),
    };
    log(
      `${phase} ${keyOf(params)}: objective ${res.objective}${stopped ? ` (early stop after ${res.meetingsRun})` : ""}`,
    );
    return res;
  }

  const base = normalize(space, space.baseline);
  const baseline = await runCombo(base, "baseline", null);
  done.set(keyOf(base), baseline);
  const noise = await runCombo(base, "noise", null);
  const band: Metrics = {};
  for (const k of Object.keys(baseline.totals)) {
    const a = baseline.totals[k];
    const b = noise.totals[k];
    band[k] =
      typeof a === "number" && typeof b === "number"
        ? Math.round(Math.abs(a - b) * 10000) / 10000
        : null;
  }
  band.objective =
    Math.round(Math.abs(noise.objective - baseline.objective) * 10000) / 10000;
  const partialBand = Math.abs(
    objective(stage, noise.perMeeting.slice(0, after)) -
      objective(stage, baseline.perMeeting.slice(0, after)),
  );

  const partialOf = (c: ComboResult) =>
    c.meetingsRun >= after
      ? objective(stage, c.perMeeting.slice(0, after))
      : -Infinity;
  const gate = (partial: number) => {
    const best = Math.max(...[...done.values()].map(partialOf));
    return partial < best - Math.max(2 * partialBand, margin);
  };
  const full = () => [...done.values()].filter((c) => !c.earlyStopped);

  for (const p of coarseGrid(space)) {
    if (done.has(keyOf(p))) continue;
    done.set(keyOf(p), await runCombo(p, "coarse", gate));
  }
  if (space.fine !== false) {
    const bestCoarse = full().sort(
      (a, b) => b.objective - a.objective,
    )[0] as ComboResult;
    for (const p of fineGrid(space, bestCoarse.params)) {
      if (done.has(keyOf(p))) continue;
      done.set(keyOf(p), await runCombo(p, "fine", gate));
    }
  }
  // Ties go to the baseline, then to the earlier combination.
  const ranked = full().sort((a, b) => b.objective - a.objective);
  const top = ranked[0] as ComboResult;
  const best = top.objective === baseline.objective ? baseline : top;
  const delta =
    Math.round((best.objective - baseline.objective) * 10000) / 10000;
  return {
    stage,
    baseline,
    noise,
    band,
    combos: [...done.values()],
    best,
    delta,
    beatsNoise: delta > (band.objective as number),
  };
}
