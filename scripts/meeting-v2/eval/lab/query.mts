// query.mts: list, best, compare and show of Eval Lab runs. Pure functions
// over runs read from MLflow (FlatRun) and their local items. The output
// holds knob values, ids, hashes and numbers only.

import type { FlatRun } from "./ledger.mts";
import type { MeetingScore, SpanItem } from "./score.mts";

/** Metrics where a lower value is better. */
export const lowerIsBetter = (metric: string) =>
  /(^|\.)(wer|possible_insertions|ins_.*_unsup|.*_wall_s|peak_rss.*)$/.test(
    metric,
  );

/** "knob=value" filters: every one must match a param of the run. */
export function parseFilters(xs: string[]): [string, string][] {
  return xs.map((x) => {
    const i = x.indexOf("=");
    if (i <= 0) throw new Error(`filter ${x}: use knob=value`);
    return [x.slice(0, i), x.slice(i + 1)];
  });
}

export function filterRuns(runs: FlatRun[], filters: [string, string][]) {
  return runs.filter((r) => filters.every(([k, v]) => r.params[k] === v));
}

/** The best FINISHED runs by one metric (runs without it are left out). */
export function bestRuns(
  runs: FlatRun[],
  metric: string,
  top: number,
  asc = lowerIsBetter(metric),
): FlatRun[] {
  return runs
    .filter(
      (r) => r.status === "FINISHED" && Number.isFinite(r.metrics[metric]),
    )
    .sort((a, b) => {
      const d = (a.metrics[metric] as number) - (b.metrics[metric] as number);
      return (asc ? d : -d) || b.start - a.start;
    })
    .slice(0, top);
}

/** The knobs whose value differs between runs (for a short table). */
export function changedKnobs(runs: FlatRun[]): string[] {
  const keys = [...new Set(runs.flatMap((r) => Object.keys(r.params)))].sort();
  return keys.filter(
    (k) => new Set(runs.map((r) => r.params[k] ?? "")).size > 1,
  );
}

const fmt = (v: number | undefined) =>
  v === undefined || !Number.isFinite(v)
    ? "-"
    : Number.isInteger(v)
      ? String(v)
      : v.toFixed(2);

export function table(header: string[], rows: string[][]): string {
  const row = (xs: string[]) => `| ${xs.join(" | ")} |`;
  return [row(header), row(header.map(() => "---")), ...rows.map(row)].join(
    "\n",
  );
}

export function listTable(runs: FlatRun[], metrics: string[]): string {
  const knobs = changedKnobs(runs);
  return table(
    ["run", "status", "grid/cell", ...knobs, ...metrics],
    runs.map((r) => [
      r.id.slice(0, 12),
      r.status,
      `${r.tags["lab.grid"] ?? "-"}/${r.tags["lab.cell"] ?? "-"}`,
      ...knobs.map((k) => r.params[k] ?? "-"),
      ...metrics.map((m) => fmt(r.metrics[m])),
    ]),
  );
}

/** The tags that must be equal for a fair comparison. */
export const SAME_BASIS_TAGS = [
  "lab.corpus_sha256",
  "lab.gold_hash",
  "lab.scorer_version",
  "lab.meetings",
];

export interface Comparison {
  warnings: string[];
  metrics: {
    key: string;
    a: number | undefined;
    b: number | undefined;
    delta: number | null;
  }[];
  meetings: { better: string[]; worse: string[]; same: string[] };
  /** Per-span flips (null when a run has no local items). */
  flips: { missToHit: number; hitToMiss: number; common: number } | null;
  knobs: { key: string; a: string; b: string }[];
}

const itemKey = (x: SpanItem) => `${x.m}|${x.ch}|${x.s}|${x.e}|${x.l}`;

/**
 * Compare run B against run A: pooled metric deltas (B - A), per-meeting
 * better/worse/same on span hits, span flips, the changed knobs, and a
 * warning for each basis tag that differs (corpus, gold, scorer, meetings).
 */
export function compareRuns(
  a: FlatRun,
  b: FlatRun,
  ma: MeetingScore[] | null,
  mb: MeetingScore[] | null,
  ia: SpanItem[] | null,
  ib: SpanItem[] | null,
): Comparison {
  const warnings = SAME_BASIS_TAGS.filter(
    (t) => (a.tags[t] ?? "") !== (b.tags[t] ?? ""),
  ).map((t) => `WARN ${t} differs: ${a.tags[t] ?? "-"} vs ${b.tags[t] ?? "-"}`);
  const keys = [
    ...new Set([...Object.keys(a.metrics), ...Object.keys(b.metrics)]),
  ]
    .filter((k) => !k.startsWith("m."))
    .sort();
  const metrics = keys.map((key) => {
    const x = a.metrics[key];
    const y = b.metrics[key];
    return {
      key,
      a: x,
      b: y,
      delta:
        x === undefined || y === undefined
          ? null
          : Math.round((y - x) * 10000) / 10000,
    };
  });
  const meetings = {
    better: [] as string[],
    worse: [] as string[],
    same: [] as string[],
  };
  const hitsOf = (ms: MeetingScore[] | null, run: FlatRun) => {
    const out = new Map<string, number>();
    if (ms) for (const m of ms) out.set(m.m, m.metrics.spans_all_hits ?? 0);
    else
      for (const [k, v] of Object.entries(run.metrics)) {
        const r = /^m\.([0-9a-f]{8})\.spans_all_hits$/.exec(k);
        if (r) out.set(r[1] as string, v);
      }
    return out;
  };
  const ha = hitsOf(ma, a);
  const hb = hitsOf(mb, b);
  for (const m of [...ha.keys()].filter((k) => hb.has(k)).sort()) {
    const d = (hb.get(m) as number) - (ha.get(m) as number);
    (d > 0 ? meetings.better : d < 0 ? meetings.worse : meetings.same).push(m);
  }
  let flips: Comparison["flips"] = null;
  if (ia && ib) {
    const mapA = new Map(ia.map((x) => [itemKey(x), x.hit]));
    flips = { missToHit: 0, hitToMiss: 0, common: 0 };
    for (const x of ib) {
      const prev = mapA.get(itemKey(x));
      if (prev === undefined) continue;
      flips.common++;
      if (!prev && x.hit) flips.missToHit++;
      if (prev && !x.hit) flips.hitToMiss++;
    }
  }
  const knobKeys = [
    ...new Set([...Object.keys(a.params), ...Object.keys(b.params)]),
  ].sort();
  const knobs = knobKeys
    .filter((k) => a.params[k] !== b.params[k])
    .map((key) => ({ key, a: a.params[key] ?? "-", b: b.params[key] ?? "-" }));
  return { warnings, metrics, meetings, flips, knobs };
}

export function renderComparison(
  c: Comparison,
  a: FlatRun,
  b: FlatRun,
): string {
  const lines = [
    `A ${a.id}  B ${b.id}`,
    ...c.warnings,
    "",
    table(
      ["knob", "A", "B"],
      c.knobs.map((k) => [k.key, k.a, k.b]),
    ),
    "",
    table(
      ["metric", "A", "B", "B - A"],
      c.metrics.map((m) => [
        m.key,
        fmt(m.a),
        fmt(m.b),
        m.delta === null ? "-" : fmt(m.delta),
      ]),
    ),
    "",
    `meetings (span hits): better ${c.meetings.better.length} [${c.meetings.better.join(",")}], worse ${c.meetings.worse.length} [${c.meetings.worse.join(",")}], same ${c.meetings.same.length}`,
    c.flips
      ? `span flips: miss->hit ${c.flips.missToHit}, hit->miss ${c.flips.hitToMiss}, spans in both ${c.flips.common}`
      : "span flips: - (no local items for a run)",
  ];
  return lines.join("\n");
}
