// report.mts: results.md of the meeting Enhance eval, the floor model, and
// the self-check that parses results.md back and compares it with
// results.json. Numbers, segment keys and gold ids only, never meeting text.

import type { Finding, RunMetrics } from "./checks.mts";
import { CHANNELS, type GoldInfo } from "./gold.mts";
import {
  type ChannelScore,
  type ErrorRate,
  pooled,
  type Scorecard,
  STAGES,
  type Stage,
} from "./score.mts";

export const CHECKS = [
  "segments",
  "numbers",
  "names",
  "negations",
  "labels",
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
  /** The gold scores (score.mts); null when the run has no gold key. */
  scorecard: Scorecard | null;
}

export interface MeetingInfo {
  id8: string;
  id: string;
  segments: number;
  durationSeconds: number;
  /** The ASR input hash of this meeting's transcription (a gold key records it). */
  asrHash?: string | null;
}

export interface Results {
  createdAt: string;
  commit: string;
  models: string[];
  meetings: MeetingInfo[];
  /** The ASR config hash of the transcription (eval.mts asrHash). */
  asrHash: string | null;
  /** The voice model row of the transcription ("local-mlx/<id>"). */
  asrModel: string | null;
  gold: GoldInfo | null;
  runs: RunResult[];
  floor: string | null;
}

/**
 * Hard fails of a run: the sum of the check counts plus the gold hard fails
 * (a must-not-claim hit, a wrong speaker name), or 1 for a failed run.
 */
export function hardFailsOf(
  r: Pick<RunResult, "status" | "checks"> & {
    scorecard?: Scorecard | null;
  },
): number {
  if (r.status !== "ok" || !r.checks) return 1;
  return (
    CHECKS.reduce((a, c) => a + (r.checks?.[c].count ?? 0), 0) +
    (r.scorecard?.hardFails.length ?? 0)
  );
}

/**
 * The floor: the smallest model by disk size with 0 hard fails on every
 * meeting. A model with no catalog size sorts last.
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
  const keyed = own.flatMap((r) =>
    r.scorecard ? [r.scorecard.enhance.fixes] : [],
  );
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
      ? `${keyed.reduce((a, f) => a + f.fixesFound, 0)}/${keyed.reduce((a, f) => a + f.fixesMissed, 0)}`
      : "-",
    keyed.length
      ? String(keyed.reduce((a, f) => a + f.mustNotChangeViolations, 0))
      : "-",
  ];
}

// --- Scorecard (gold scores) ------------------------------------------------------------

const r4 = (v: number | null | undefined) =>
  v === null || v === undefined ? "-" : v.toFixed(4);
const ratio = (a: number, b: number) => (b === 0 ? null : a / b);
const sumOf = <T,>(xs: T[], f: (x: T) => number) =>
  xs.reduce((a, x) => a + f(x), 0);

export const SCORECARD_HEADER = [
  "Model",
  "Stage",
  "Meetings scored",
  "Score",
  "Detail",
  "Gold hard fails",
];

function channelsOf(
  scs: Scorecard[],
  pick: (sc: Scorecard) => Record<string, ChannelScore | null> | null,
): (ChannelScore | null)[] {
  return scs.flatMap((sc) => {
    const ch = pick(sc);
    return ch ? CHANNELS.map((c) => ch[c] ?? null) : [];
  });
}

const erText = (e: ErrorRate | null) =>
  e ? `${r4(e.rate)} (${e.ref} ref)` : "-";

/** One Scorecard row of a model and a stage, pooled over its meetings; null = not scored. */
export function scorecardCells(
  model: string,
  stage: Stage,
  runs: RunResult[],
): string[] | null {
  const scs = runs
    .filter((r) => r.model === model && r.scorecard)
    .map((r) => r.scorecard as Scorecard);
  const cells = (n: number, score: string, detail: string, hard: number) => [
    model,
    stage,
    String(n),
    score,
    detail,
    String(hard),
  ];
  if (stage === "asr" || stage === "enhance") {
    const own = scs.filter((sc) =>
      stage === "asr" ? sc.asr : sc.enhance.channels,
    );
    const ch = channelsOf(own, (sc) =>
      stage === "asr" ? sc.asr : sc.enhance.channels,
    );
    const w = pooled(ch, "words");
    const detail = [
      `WER raw ${erText(pooled(ch, "wordsRaw"))}`,
      `CER ${erText(pooled(ch, "chars"))}`,
      `WER verified ${erText(pooled(ch, "wordsVerified"))}`,
      `CER verified ${erText(pooled(ch, "charsVerified"))}`,
    ];
    if (stage === "asr")
      return own.length
        ? cells(own.length, `WER ${erText(w)}`, detail.join("; "), 0)
        : null;
    if (scs.length === 0) return null;
    const a = pooled(
      channelsOf(own, (sc) => sc.asr),
      "words",
    );
    const delta = a?.rate == null || w?.rate == null ? null : a.rate - w.rate;
    const fx = scs.map((sc) => sc.enhance.fixes);
    detail.push(
      `fixes found/missed ${sumOf(fx, (f) => f.fixesFound)}/${sumOf(fx, (f) => f.fixesMissed)}`,
      `must-not-change violations ${sumOf(fx, (f) => f.mustNotChangeViolations)}`,
      `bad entries ${sumOf(fx, (f) => f.badEntries)}`,
    );
    return cells(
      scs.length,
      `WER ${erText(w)}, delta ${r4(delta)}`,
      own.length ? detail.join("; ") : detail.slice(4).join("; "),
      0,
    );
  }
  if (stage === "summary") {
    const ss = scs.flatMap((sc) => (sc.summary ? [sc.summary] : []));
    if (ss.length === 0) return null;
    const m = sumOf(ss, (s) => s.decisions.matched + s.actionItems.matched);
    const g = sumOf(ss, (s) => s.decisions.gold + s.actionItems.gold);
    const vs = (f: "owner" | "due") =>
      `${sumOf(ss, (s) => s[f].correct)}/${sumOf(ss, (s) => s[f].wrong)}/${sumOf(ss, (s) => s[f].missing)}`;
    const hits = sumOf(ss, (s) => s.mustNotClaimHits.length);
    return cells(
      ss.length,
      `matched ${m}/${g} (${r4(ratio(m, g))})`,
      [
        `decisions ${sumOf(ss, (s) => s.decisions.matched)}/${sumOf(ss, (s) => s.decisions.gold)}`,
        `action items ${sumOf(ss, (s) => s.actionItems.matched)}/${sumOf(ss, (s) => s.actionItems.gold)}`,
        `unmatched output ${sumOf(ss, (s) => s.decisions.unmatchedOutput.length + s.actionItems.unmatchedOutput.length)}`,
        `owner c/w/m ${vs("owner")}`,
        `due c/w/m ${vs("due")}`,
        `must-not-claim hits ${hits}`,
        `unparsed ${ss.filter((s) => !s.parsed).length}`,
      ].join("; "),
      hits,
    );
  }
  if (stage === "tags") {
    const ts = scs.flatMap((sc) => (sc.tags ? [sc.tags] : []));
    if (ts.length === 0) return null;
    const o = sumOf(ts, (t) => t.output);
    const e = sumOf(ts, (t) => t.expected);
    return cells(
      ts.length,
      `P ${r4(
        ratio(
          sumOf(ts, (t) => t.matchedOutput),
          o,
        ),
      )} R ${r4(
        ratio(
          sumOf(ts, (t) => t.matchedExpected),
          e,
        ),
      )}`,
      `output ${o}; expected ${e}`,
      0,
    );
  }
  const sp = scs.flatMap((sc) => (sc.speakers ? [sc.speakers] : []));
  if (sp.length === 0) return null;
  const c = sumOf(sp, (s) => s.correct);
  const w = sumOf(sp, (s) => s.wrong);
  const mi = sumOf(sp, (s) => s.missing);
  return cells(
    sp.length,
    `correct ${c}/${c + w + mi}`,
    `wrong ${w}; missing ${mi}`,
    w,
  );
}

export const SCORECARD_MEETING_HEADER = [
  "Model",
  "Meeting",
  "ASR WER",
  "ASR WER verified",
  "Enhance WER",
  "Enhance delta",
  "Fixes found/missed",
  "Summary matched",
  "Owner c/w/m",
  "Due c/w/m",
  "Tags P/R",
  "Speakers c/w/m",
  "Gold hard fails",
];

export function scorecardMeetingCells(r: RunResult): string[] {
  const sc = r.scorecard as Scorecard;
  const all = (
    ch: Record<string, ChannelScore | null> | null,
    f: "words" | "wordsVerified",
  ) => (ch ? r4(pooled(Object.values(ch), f)?.rate) : "-");
  const s = sc.summary;
  const vs = (f: "owner" | "due") =>
    s ? `${s[f].correct}/${s[f].wrong}/${s[f].missing}` : "-";
  const f = sc.enhance.fixes;
  return [
    r.model,
    r.meeting,
    all(sc.asr, "words"),
    all(sc.asr, "wordsVerified"),
    all(sc.enhance.channels, "words"),
    r4(sc.enhance.delta?.all),
    `${f.fixesFound}/${f.fixesMissed}`,
    s
      ? `${s.decisions.matched + s.actionItems.matched}/${s.decisions.gold + s.actionItems.gold}`
      : "-",
    vs("owner"),
    vs("due"),
    sc.tags ? `${r4(sc.tags.precision)}/${r4(sc.tags.recall)}` : "-",
    sc.speakers
      ? `${sc.speakers.correct}/${sc.speakers.wrong}/${sc.speakers.missing}`
      : "-",
    String(sc.hardFails.length),
  ];
}

function scorecardRows(res: Results): string[][] {
  return res.models.flatMap((m) =>
    STAGES.flatMap((st) => {
      const c = scorecardCells(m, st, res.runs);
      return c ? [c] : [];
    }),
  );
}
const scoredRuns = (res: Results) => res.runs.filter((r) => r.scorecard);

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
    `- ASR: ${res.asrModel ?? "-"} (asr hash ${res.asrHash ?? "-"})`,
    `- Gold: ${
      res.gold
        ? `${res.gold.source} (${Object.entries(res.gold.versions)
            .map(([k, v]) => `${k} v${v}`)
            .join(", ")})`
        : "none"
    }`,
    `- Floor (smallest model with 0 hard fails on every meeting): ${res.floor ?? "none"}`,
    "",
    "## Scorecard",
    "",
    ...(res.gold
      ? [
          "One row per model and stage, pooled over the meetings. WER and CER are meeting-level per channel (word alignment of all gold turns vs all segments). WER aligns normalized words (number words as digits, an exact adjacent repeat counted once); WER raw does not. Enhance delta = ASR WER - Enhance WER (positive = Enhance helped). Gold hard fails: must-not-claim hits (summary), wrong speaker names (speakers); they count in the hard fails.",
          "",
          ...table(SCORECARD_HEADER, scorecardRows(res)),
          "",
          "### Scorecard per meeting",
          "",
          ...table(
            SCORECARD_MEETING_HEADER,
            scoredRuns(res).map(scorecardMeetingCells),
          ),
        ]
      : ["No gold key (run with --gold, or --answer-key for a v1 key)."]),
    "",
    "Hard-fail checks: segments (lost, added or moved; raw text changed), numbers (number or time token changed), names (capitalized name removed, lowercased or replaced by a different name; a change of case, spacing or punctuation, a spelling fix or a fix to a known form is no fail), negations (added or removed), labels (enhanced text starts with a speaker label, raw text does not), chunks (failed chunks; last attempt finish length), summary (check-summary failed; owner or due placeholder), speakers (a suggestion that repeats a diarized label, or a name with a word that the transcript, title, user context and attendee names do not hold).",
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
      if (r.scorecard) {
        const sc = r.scorecard;
        const a = sc.enhance.fixes;
        if (sc.hardFails.length)
          out.push(
            `- ${r.model} gold hard fails (${sc.hardFails.length}): ${sc.hardFails.join(", ")}`,
          );
        out.push(
          `- ${r.model} gold fixes: found ${a.fixesFound}, missed ${a.fixesMissed}${a.missedKeys.length ? ` (${a.missedKeys.join(", ")})` : ""}; must-not-change violations ${a.mustNotChangeViolations}${a.violationKeys.length ? ` (${a.violationKeys.join(", ")})` : ""}; bad entries ${a.badEntries}`,
        );
        if (sc.asrHashMatch === false)
          out.push(
            `- ${r.model} gold: built on another ASR hash (speaker labels and fix starts can differ)`,
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
  if (res.gold) {
    const sc = rowsOf("## Scorecard");
    if (JSON.stringify(sc) !== JSON.stringify(scorecardRows(res).map(row)))
      errors.push("scorecard table differs from results.json");
    const per = rowsOf("### Scorecard per meeting");
    if (
      JSON.stringify(per) !==
      JSON.stringify(scoredRuns(res).map((r) => row(scorecardMeetingCells(r))))
    )
      errors.push("scorecard per meeting table differs from results.json");
  } else if (scoredRuns(res).length > 0)
    errors.push("runs have a scorecard but results.json has no gold");
  if (
    lines.find((l) => l.startsWith("## "))?.startsWith("## Scorecard") !== true
  )
    errors.push("the Scorecard section is not the first section");
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
