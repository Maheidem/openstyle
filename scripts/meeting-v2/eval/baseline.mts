// baseline.mts: numbers-only baselines of the meeting quality eval and the
// regression compare (`pnpm meeting:eval ... --save-baseline <name>`,
// `--compare <file>`). The format is in eval-baselines/README.md.
//
// A baseline holds ids, counts and rates only, never meeting text: it is
// committed to the repo. parseBaseline refuses a file with a string where a
// number must be.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GoldInfo } from "./gold.mts";
import { CHECKS, type Results } from "./report.mts";
import {
  STAGES,
  type Stage,
  type StageMetrics,
  stageMetrics,
} from "./score.mts";

export const BASELINE_STAGES = ["checks", ...STAGES] as const;
export type BaselineStage = (typeof BASELINE_STAGES)[number];

export interface BaselineRun {
  model: string;
  meeting: string;
  stages: Record<BaselineStage, StageMetrics>;
  /** "run:failed", "check:<name>" (count > 0), "claim:<id>", "speaker:<label>". */
  hardFails: string[];
}

export interface Baseline {
  format: "openstyle-eval-baseline";
  version: 1;
  name: string;
  createdAt: string;
  commit: string;
  asrHash: string | null;
  asrModel: string | null;
  models: string[];
  gold: GoldInfo | null;
  /** Noise band per "<stage>.<metric>" (absolute). null = default bands. */
  noise: Record<string, number> | null;
  runs: BaselineRun[];
}

const NAME_RE = /^[a-z0-9][a-z0-9.-]{0,60}$/;

/** Metrics where a lower value is better (and every metric of the checks stage). */
const LOWER_IS_BETTER =
  /^(wer|cer|werVerified|cerVerified|werRaw|werVerifiedRaw)(\.|$)|^(fixesMissed|mustNotChangeViolations|ownerWrong|ownerMissing|dueWrong|dueMissing|mustNotClaimHits|wrong|missing)$/;
const RATE =
  /^(wer|cer|werVerified|cerVerified|werRaw|werVerifiedRaw)(\.|$)|Recall$|Precision$|^(precision|recall|delta|deltaRaw)$/;

export const lowerIsBetter = (stage: BaselineStage, metric: string) =>
  stage === "checks" || LOWER_IS_BETTER.test(metric);

/** The default noise band: 0.005 for a rate, 0 for a count (the runs are deterministic). */
export const defaultNoise = (metric: string) => (RATE.test(metric) ? 0.005 : 0);

// --- Build and save ---------------------------------------------------------------

export function buildBaseline(
  results: Results,
  name: string,
  noise: Record<string, number> | null = null,
): Baseline {
  if (!NAME_RE.test(name))
    throw new Error("baseline name must match [a-z0-9][a-z0-9.-]{0,60}");
  return {
    format: "openstyle-eval-baseline",
    version: 1,
    name,
    createdAt: results.createdAt,
    commit: results.commit,
    asrHash: results.asrHash,
    asrModel: results.asrModel,
    models: results.models,
    gold: results.gold,
    noise,
    runs: results.runs.map((r): BaselineRun => {
      const checks: StageMetrics = { hardFails: r.hardFails };
      for (const c of CHECKS) checks[c] = r.checks?.[c].count ?? null;
      const gold = r.scorecard
        ? stageMetrics(r.scorecard)
        : (Object.fromEntries(STAGES.map((s) => [s, {}])) as Record<
            Stage,
            StageMetrics
          >);
      return {
        model: r.model,
        meeting: r.meeting,
        stages: { checks, ...gold },
        hardFails: [
          ...(r.status === "ok" ? [] : ["run:failed"]),
          ...CHECKS.filter((c) => (r.checks?.[c].count ?? 0) > 0).map(
            (c) => `check:${c}`,
          ),
          ...(r.scorecard?.hardFails ?? []),
        ],
      };
    }),
  };
}

/** eval-baselines/<YYYY-MM-DD>-<name>.json (local date). */
export function baselinePath(dir: string, name: string, now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const day = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  return join(dir, `${day}-${name}.json`);
}

/** Write a baseline. It refuses to replace a file. Returns the path. */
export function saveBaseline(
  b: Baseline,
  dir: string,
  now = new Date(),
): string {
  const path = baselinePath(dir, b.name, now);
  if (existsSync(path))
    throw new Error(`baseline ${path} exists; pick another name`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(b, null, 1)}\n`);
  return path;
}

/** Parse and validate a baseline file: every metric value is a number or null. */
export function parseBaseline(json: string): Baseline {
  const b = JSON.parse(json) as Baseline;
  if (b?.format !== "openstyle-eval-baseline" || b.version !== 1)
    throw new Error(
      "baseline: format must be openstyle-eval-baseline, version 1",
    );
  if (!Array.isArray(b.runs))
    throw new Error("baseline: runs must be an array");
  b.runs.forEach((r, i) => {
    if (typeof r?.model !== "string" || typeof r?.meeting !== "string")
      throw new Error(`baseline: runs[${i}] needs model and meeting`);
    for (const [stage, m] of Object.entries(r.stages ?? {}))
      for (const [k, v] of Object.entries(m ?? {}))
        if (v !== null && typeof v !== "number")
          throw new Error(
            `baseline: runs[${i}].stages.${stage}.${k} must be a number or null`,
          );
    if (
      !Array.isArray(r.hardFails) ||
      r.hardFails.some((h) => typeof h !== "string")
    )
      throw new Error(`baseline: runs[${i}].hardFails must be an array of ids`);
  });
  for (const [k, v] of Object.entries(b.noise ?? {}))
    if (typeof v !== "number" || v < 0)
      throw new Error(`baseline: noise.${k} must be a number of 0 or more`);
  return b;
}

/**
 * Noise bands from two runs of the same setup: per "<stage>.<metric>", the
 * largest absolute difference over all model x meeting pairs.
 */
export function noiseBands(a: Baseline, b: Baseline): Record<string, number> {
  const out: Record<string, number> = {};
  for (const ra of a.runs) {
    const rb = b.runs.find(
      (x) => x.model === ra.model && x.meeting === ra.meeting,
    );
    if (!rb) continue;
    for (const stage of BASELINE_STAGES)
      for (const [k, va] of Object.entries(ra.stages[stage] ?? {})) {
        const vb = rb.stages[stage]?.[k];
        if (typeof va !== "number" || typeof vb !== "number") continue;
        const key = `${stage}.${k}`;
        out[key] = Math.max(
          out[key] ?? 0,
          Math.round(Math.abs(va - vb) * 1e4) / 1e4,
        );
      }
  }
  return Object.fromEntries(
    Object.entries(out).sort(([x], [y]) => x.localeCompare(y)),
  );
}

// --- Compare ----------------------------------------------------------------------

export type Verdict = "better" | "worse" | "same" | "missing" | "new";

export interface CompareRow {
  model: string;
  meeting: string;
  stage: BaselineStage;
  metric: string;
  base: number | null;
  now: number | null;
  noise: number;
  verdict: Verdict;
}

export interface CompareResult {
  rows: CompareRow[];
  /** Metrics marked worse or missing. */
  worse: number;
  /** "<model> <meeting> <hard fail id>" for hard fails that the baseline did not have. */
  newHardFails: string[];
  /** model x meeting pairs in one side only. */
  notCompared: string[];
  /** 0 = no regression, 3 = a worse metric or a new hard fail. */
  exitCode: 0 | 3;
  text: string;
}

function verdictOf(
  stage: BaselineStage,
  metric: string,
  base: number | null,
  now: number | null,
  noise: number,
): Verdict {
  if (base === null && now === null) return "same";
  if (now === null) return "missing";
  if (base === null) return "new";
  const d = now - base;
  const eps = 1e-9;
  if (Math.abs(d) <= noise + eps) return "same";
  const up = d > 0;
  return up === !lowerIsBetter(stage, metric) ? "better" : "worse";
}

const fmt = (v: number | null) =>
  v === null ? "-" : String(Math.round(v * 1e4) / 1e4);

/**
 * The metrics of a baseline made before the normalized WER (2026-10-22):
 * its WER keys held the raw WER, so they move to the raw names (wer to
 * werRaw, werVerified to werVerifiedRaw, delta to deltaRaw, also per
 * channel). A stage that has werRaw already is returned as it is.
 */
export function legacyRawKeys(m: StageMetrics): StageMetrics {
  if (!("wer" in m) || "werRaw" in m) return m;
  const out: StageMetrics = {};
  for (const [k, v] of Object.entries(m)) {
    const raw = k
      .replace(/^wer(\.|$)/, "werRaw$1")
      .replace(/^werVerified(\.|$)/, "werVerifiedRaw$1")
      .replace(/^delta$/, "deltaRaw");
    out[raw] = v;
  }
  return out;
}

/**
 * Compare a run (as a baseline object) with a stored baseline. A metric is
 * worse when it moved the wrong way by more than its noise band (the
 * baseline's band, else the default band), or when it is missing now. A
 * hard fail id that the baseline run did not have is new.
 */
export function compareBaselines(base: Baseline, now: Baseline): CompareResult {
  const rows: CompareRow[] = [];
  const newHardFails: string[] = [];
  const notCompared: string[] = [];
  for (const rb of base.runs)
    if (!now.runs.some((r) => r.model === rb.model && r.meeting === rb.meeting))
      notCompared.push(`${rb.model} ${rb.meeting} (baseline only)`);
  for (const rn of now.runs) {
    const rb = base.runs.find(
      (r) => r.model === rn.model && r.meeting === rn.meeting,
    );
    if (!rb) {
      notCompared.push(`${rn.model} ${rn.meeting} (this run only)`);
      continue;
    }
    for (const stage of BASELINE_STAGES) {
      const stored = rb.stages[stage] ?? {};
      const mb = legacyRawKeys(stored);
      // A legacy baseline keeps its noise bands under the old names.
      const noiseKey = (metric: string) =>
        mb === stored
          ? metric
          : metric
              .replace(/^werVerifiedRaw/, "werVerified")
              .replace(/^werRaw/, "wer")
              .replace(/^deltaRaw$/, "delta");
      const mn = rn.stages[stage] ?? {};
      const keys = [
        ...new Set([...Object.keys(mb), ...Object.keys(mn)]),
      ].sort();
      for (const metric of keys) {
        const b = mb[metric] ?? null;
        const n = mn[metric] ?? null;
        const noise =
          base.noise?.[`${stage}.${noiseKey(metric)}`] ?? defaultNoise(metric);
        rows.push({
          model: rn.model,
          meeting: rn.meeting,
          stage,
          metric,
          base: b,
          now: n,
          noise,
          verdict: verdictOf(stage, metric, b, n, noise),
        });
      }
    }
    for (const h of rn.hardFails)
      if (!rb.hardFails.includes(h))
        newHardFails.push(`${rn.model} ${rn.meeting} ${h}`);
  }
  const worse = rows.filter(
    (r) => r.verdict === "worse" || r.verdict === "missing",
  ).length;
  const exitCode = worse > 0 || newHardFails.length > 0 ? 3 : 0;

  const lines: string[] = [
    `# Compare with baseline ${base.name} (commit ${base.commit})`,
    "",
    `Noise bands: ${base.noise ? "from the baseline" : "default (0.005 for a rate, 0 for a count)"}.`,
    "",
    "| Model | Meeting | Stage | Better | Worse | Same | Worse metrics |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  const groups = new Map<string, CompareRow[]>();
  for (const r of rows) {
    const k = `${r.model}|${r.meeting}|${r.stage}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  for (const [k, g] of groups) {
    const [model, meeting, stage] = k.split("|");
    const count = (v: Verdict[]) =>
      g.filter((r) => v.includes(r.verdict)).length;
    const bad = g.filter(
      (r) => r.verdict === "worse" || r.verdict === "missing",
    );
    lines.push(
      `| ${model} | ${meeting} | ${stage} | ${count(["better"])} | ${bad.length} | ${count(["same", "new"])} | ${bad.map((r) => r.metric).join(", ") || "-"} |`,
    );
  }
  const changed = rows.filter((r) => r.verdict !== "same");
  lines.push("", "## Changed metrics", "");
  if (changed.length === 0) lines.push("- none");
  else {
    lines.push(
      "| Model | Meeting | Stage | Metric | Baseline | Now | Delta | Noise | Verdict |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const r of changed)
      lines.push(
        `| ${r.model} | ${r.meeting} | ${r.stage} | ${r.metric} | ${fmt(r.base)} | ${fmt(r.now)} | ${r.base === null || r.now === null ? "-" : fmt(r.now - r.base)} | ${r.noise} | ${r.verdict} |`,
      );
  }
  lines.push(
    "",
    "## New hard fails",
    "",
    ...(newHardFails.length ? newHardFails.map((h) => `- ${h}`) : ["- none"]),
  );
  if (notCompared.length)
    lines.push("", "## Not compared", "", ...notCompared.map((p) => `- ${p}`));
  lines.push(
    "",
    `Result: ${exitCode === 0 ? "no regression" : `REGRESSION (${worse} worse metrics, ${newHardFails.length} new hard fails)`}`,
    "",
  );
  return {
    rows,
    worse,
    newHardFails,
    notCompared,
    exitCode,
    text: lines.join("\n"),
  };
}
