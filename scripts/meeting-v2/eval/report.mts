// report.mts: results.md of the meeting Enhance eval, the floor model, and
// the self-check that parses results.md back and compares it with
// results.json. Numbers and segment keys only, never meeting text.

import type { AnswerKeyScore, Finding, RunMetrics } from "./checks.mts";

export const CHECKS = [
  "segments",
  "numbers",
  "names",
  "negations",
  "chunks",
  "summary",
  "speakers",
] as const;
export type CheckName = (typeof CHECKS)[number];

export interface RunResult {
  model: string;
  meeting: string;
  /** "failed" when the run left no database to check. */
  status: "ok" | "failed";
  exitCode: number | null;
  seconds: number | null;
  peakRssGb: number | null;
  diskBytes: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  chunksAttempted: number | null;
  chunksFailed: number | null;
  metrics: RunMetrics | null;
  checks: Record<CheckName, Finding> | null;
  hardFails: number;
  answerKey: AnswerKeyScore | null;
}

export interface MeetingInfo {
  id8: string;
  id: string;
  segments: number;
  durationSeconds: number;
}

export interface Results {
  createdAt: string;
  commit: string;
  models: string[];
  meetings: MeetingInfo[];
  answerKey: boolean;
  runs: RunResult[];
  floor: string | null;
}

/** Hard fails of a run: the sum of the check counts, or 1 for a failed run. */
export function hardFailsOf(r: Pick<RunResult, "status" | "checks">): number {
  if (r.status !== "ok" || !r.checks) return 1;
  return CHECKS.reduce((a, c) => a + (r.checks?.[c].count ?? 0), 0);
}

/**
 * The floor: the smallest model by disk size with 0 hard fails on every
 * meeting. A model with no catalog size (oMLX) sorts last.
 */
export function floorModel(
  results: Pick<Results, "models" | "meetings" | "runs">,
): string | null {
  const size = (m: string) =>
    results.runs.find((r) => r.model === m)?.diskBytes ??
    Number.POSITIVE_INFINITY;
  const clean = results.models.filter((m) =>
    results.meetings.every((mt) =>
      results.runs.some(
        (r) =>
          r.model === m &&
          r.meeting === mt.id8 &&
          r.status === "ok" &&
          r.hardFails === 0,
      ),
    ),
  );
  clean.sort((a, b) => size(a) - size(b));
  return clean[0] ?? null;
}

const n = (v: number | null | undefined, digits = 0): string =>
  v === null || v === undefined ? "-" : v.toFixed(digits);
const gb = (bytes: number | null) =>
  bytes === null ? "-" : (bytes / 1e9).toFixed(2);
const tally = (o: Record<string, number> | undefined) =>
  o && Object.keys(o).length
    ? Object.entries(o)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")
    : "0";
const finish = (m: RunMetrics | null, step: string) => {
  const f = m?.finish[step];
  return f ? `${f.stop}/${f.length}` : "-";
};

export const MEETING_HEADER = [
  "Model",
  "Hard fails",
  ...CHECKS,
  "Seconds",
  "Peak RSS GB",
  "Disk GB",
  "In tok",
  "Out tok",
  "Chunks failed",
  "Applied",
  "Echo rate",
  "Finish stop/length correct",
  "Finish stop/length speakers",
  "Finish stop/length summary",
  "Suggestions",
];

export function meetingCells(r: RunResult): string[] {
  return [
    r.model,
    String(r.hardFails),
    ...CHECKS.map((c) => (r.checks ? String(r.checks[c].count) : "-")),
    n(r.seconds, 1),
    n(r.peakRssGb, 2),
    gb(r.diskBytes),
    n(r.inputTokens),
    n(r.outputTokens),
    n(r.chunksFailed),
    n(r.metrics?.applied),
    n(r.metrics?.echoRate, 3),
    finish(r.metrics, "correct_chunk"),
    finish(r.metrics, "identify_speakers"),
    finish(r.metrics, "meeting_summary"),
    n(r.metrics?.suggestions),
  ];
}

export const MODEL_HEADER = [
  "Model",
  "Disk GB",
  "Meetings run",
  "Meetings with 0 hard fails",
  "Hard fails",
  "Seconds",
  "Peak RSS GB",
  "In tok",
  "Out tok",
  "Applied",
  "Fixes found/missed",
  "Must-not-change violations",
];

export function modelCells(model: string, runs: RunResult[]): string[] {
  const own = runs.filter((r) => r.model === model);
  const sum = (f: (r: RunResult) => number | null) =>
    own.some((r) => f(r) !== null)
      ? own.reduce((a, r) => a + (f(r) ?? 0), 0)
      : null;
  const peak = own.reduce<number | null>(
    (a, r) => (r.peakRssGb === null ? a : Math.max(a ?? 0, r.peakRssGb)),
    null,
  );
  const keyed = own.filter((r) => r.answerKey);
  return [
    model,
    gb(own[0]?.diskBytes ?? null),
    String(own.length),
    String(own.filter((r) => r.status === "ok" && r.hardFails === 0).length),
    String(own.reduce((a, r) => a + r.hardFails, 0)),
    n(
      sum((r) => r.seconds),
      1,
    ),
    n(peak, 2),
    n(sum((r) => r.inputTokens)),
    n(sum((r) => r.outputTokens)),
    n(sum((r) => r.metrics?.applied ?? null)),
    keyed.length
      ? `${keyed.reduce((a, r) => a + (r.answerKey?.fixesFound ?? 0), 0)}/${keyed.reduce((a, r) => a + (r.answerKey?.fixesMissed ?? 0), 0)}`
      : "-",
    keyed.length
      ? String(
          keyed.reduce(
            (a, r) => a + (r.answerKey?.mustNotChangeViolations ?? 0),
            0,
          ),
        )
      : "-",
  ];
}

const row = (cells: string[]) => `| ${cells.join(" | ")} |`;
const table = (header: string[], rows: string[][]) => [
  row(header),
  row(header.map(() => "---")),
  ...rows.map(row),
];
const MAX_KEYS = 20;

export function renderResults(res: Results): string {
  const out: string[] = [
    "# Meeting Enhance eval",
    "",
    "Numbers and segment keys (source:idx@start_ms) only. The judge pack holds the text.",
    "",
    `- Created: ${res.createdAt}`,
    `- Commit: ${res.commit}`,
    `- Models: ${res.models.join(", ")}`,
    `- Meetings: ${res.meetings.map((m) => m.id8).join(", ")}`,
    `- Answer key: ${res.answerKey ? "yes" : "no"}`,
    `- Floor (smallest model with 0 hard fails on every meeting): ${res.floor ?? "none"}`,
    "",
    "Hard-fail checks: segments (lost, added or moved; raw text changed), numbers (number or time token changed), names (capitalized name removed or changed, not a spelling fix), negations (added or removed), chunks (failed chunks; last attempt finish length), summary (check-summary failed; owner or due placeholder), speakers (suggested name not in the meeting text or metadata).",
    "",
  ];
  for (const m of res.meetings) {
    const runs = res.runs.filter((r) => r.meeting === m.id8);
    out.push(
      `## Meeting ${m.id8}`,
      "",
      `Segments: ${m.segments}. Duration: ${m.durationSeconds} s.`,
      "",
      ...table(MEETING_HEADER, runs.map(meetingCells)),
      "",
      `### Drops by reason, meeting ${m.id8}`,
      "",
      ...table(
        ["Model", "Correction step", "Speaker step"],
        runs.map((r) => [
          r.model,
          tally(r.metrics?.dropsCorrection),
          tally(r.metrics?.dropsSpeaker),
        ]),
      ),
      "",
      `### Hard-fail keys, meeting ${m.id8}`,
      "",
    );
    let any = false;
    for (const r of runs) {
      if (r.status !== "ok") {
        out.push(`- ${r.model} run: failed (exit ${r.exitCode ?? "-"})`);
        any = true;
        continue;
      }
      for (const c of CHECKS) {
        const f = r.checks?.[c];
        if (!f || f.count === 0) continue;
        any = true;
        const more =
          f.keys.length > MAX_KEYS
            ? ` (+${f.keys.length - MAX_KEYS} more)`
            : "";
        out.push(
          `- ${r.model} ${c} (${f.count}): ${f.keys.slice(0, MAX_KEYS).join(", ")}${more}`,
        );
      }
      if (r.answerKey) {
        const a = r.answerKey;
        out.push(
          `- ${r.model} answer key: fixes found ${a.fixesFound}, missed ${a.fixesMissed}${a.missedKeys.length ? ` (${a.missedKeys.join(", ")})` : ""}; must-not-change violations ${a.mustNotChangeViolations}${a.violationKeys.length ? ` (${a.violationKeys.join(", ")})` : ""}; bad entries ${a.badEntries}`,
        );
        any = true;
      }
    }
    if (!any) out.push("- none");
    out.push("");
  }
  out.push(
    "## Summary per model",
    "",
    ...table(
      MODEL_HEADER,
      res.models.map((m) => modelCells(m, res.runs)),
    ),
    "",
  );
  return out.join("\n");
}

/**
 * Self-check: every table row of results.md must equal the row that the
 * re-read results.json gives, every hard-fail total must equal the sum of
 * its checks, every check count must equal its key count, and the floor
 * must equal a fresh computation. Returns the errors (empty = pass).
 */
export function selfCheck(md: string, res: Results): string[] {
  const errors: string[] = [];
  const lines = md.split("\n");
  const rowsOf = (section: string) => {
    const start = lines.indexOf(section);
    if (start < 0) return null;
    const out: string[] = [];
    let i = start + 1;
    while (i < lines.length && !lines[i]?.startsWith("|")) i++;
    i += 2; // header and separator
    while (i < lines.length && lines[i]?.startsWith("|"))
      out.push(lines[i++] as string);
    return out;
  };
  for (const m of res.meetings) {
    const got = rowsOf(`## Meeting ${m.id8}`);
    const want = res.runs
      .filter((r) => r.meeting === m.id8)
      .map((r) => row(meetingCells(r)));
    if (!got) errors.push(`meeting ${m.id8}: section missing`);
    else if (JSON.stringify(got) !== JSON.stringify(want))
      errors.push(`meeting ${m.id8}: table differs from results.json`);
  }
  const got = rowsOf("## Summary per model");
  const want = res.models.map((m) => row(modelCells(m, res.runs)));
  if (JSON.stringify(got) !== JSON.stringify(want))
    errors.push("model summary table differs from results.json");
  for (const r of res.runs) {
    if (r.hardFails !== hardFailsOf(r))
      errors.push(
        `${r.model} ${r.meeting}: hard fails differ from the check sum`,
      );
    for (const c of CHECKS) {
      const f = r.checks?.[c];
      if (f && f.count !== f.keys.length)
        errors.push(
          `${r.model} ${r.meeting} ${c}: count differs from key count`,
        );
    }
  }
  if (floorModel(res) !== res.floor)
    errors.push("floor differs from a fresh computation");
  if (
    !md.includes(
      `- Floor (smallest model with 0 hard fails on every meeting): ${res.floor ?? "none"}`,
    )
  )
    errors.push("floor line missing");
  return errors;
}
