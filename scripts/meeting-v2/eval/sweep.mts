// sweep.mts: the per-stage parameter sweep (`pnpm meeting:eval:sweep`,
// PR #308, issue #307).
//
// Usage (from the repo root):
//   1. Capture (no GPU): the stage calls of a kept meeting:eval run.
//      pnpm meeting:eval:sweep --capture <out dir of `meeting:eval --keep`>
//   2. Replay proof (GPU): every stored call again at the stored settings.
//      pnpm meeting:eval:sweep --replay-check --models <id,...> [--meetings <id8,...>]
//   3. Sweep (GPU):
//      pnpm meeting:eval:sweep --stage <correctChunk|identifySpeakers|summarize|suggestTags>
//        --models <id,...> --space <file> [--meetings <id8,...>] [--out <dir>]
//        [--save-baseline <name>] [--port <n>] [--hf-cache <dir>]
//
// The captures live in ~/.openstyle-eval/sweep/<id8>/ (folder 0700, files
// 0600; real meeting text). The gold keys come from ~/.openstyle-eval/gold.
// The out folder gets results.md and results.json with numbers, parameter
// values and gold-free metric names only. --save-baseline writes
// eval-baselines/<date>-<name>.json (numbers only).
//
// GPU: each model's job takes the shared GPU lock in queue order
// (runtime.mts takeLock) and releases it at the end of the job. The tool
// starts its own MLX worker (built-in models only) on 127.0.0.1:<port>.
// It never calls the owner's model server or the installed app.
//
// Exit codes: 0 ok; 1 a run or a check failed; 2 usage.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { MLX_LLM_MODELS } from "../../../apps/server/src/lib/mlx-llm/constants.ts";
import { DEFAULT_GOLD_DIR, type Gold, loadGold } from "./gold.mts";
import {
  isTmp,
  ROOT,
  releaseLock,
  repoRoot,
  SERVER_HOME,
  takeLock,
  unqueue,
  WORKER,
} from "./runtime.mts";
import {
  type Capture,
  type Complete,
  capturePaths,
  captureRun,
  finalCalls,
  loadCapture,
  type MeetingInput,
  NODE_OF,
  PERTURB,
  readMeeting,
  rebuildCheck,
  removeWorkDir,
  runStage,
  STAGES,
  type StageName,
  type StageOutput,
  type StoredCall,
  slug,
  startWorker,
  wireBody,
  workerClient,
} from "./stage-replay.mts";
import { type Metrics, scoreStage } from "./stage-score.mts";
import {
  type ComboResult,
  keyOf,
  parseSpace,
  type SearchResult,
  search,
} from "./sweep-search.mts";

const DEFAULT_MEETINGS = ["2943c36a", "5578edb0", "ca70f895", "9243bea0"];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);
function usage(msg: string): never {
  console.error(msg);
  console.error(
    "usage: pnpm meeting:eval:sweep --capture <out dir>\n       pnpm meeting:eval:sweep --replay-check --models <id,...> [--meetings <id8,...>]\n       pnpm meeting:eval:sweep --stage <name> --models <id,...> --space <file> [--meetings <id8,...>] [--out <dir>] [--save-baseline <name>] [--port <n>] [--hf-cache <dir>]",
  );
  process.exit(2);
}

const catalog = new Map(MLX_LLM_MODELS.map((m) => [m.id, m]));
const models = (arg("models") ?? "").split(",").filter(Boolean);
for (const m of models)
  if (!catalog.has(m)) usage(`unknown model ${m} (built-in MLX only)`);
const meetingIds = (arg("meetings") ?? DEFAULT_MEETINGS.join(","))
  .split(",")
  .filter(Boolean)
  .map((m) => m.slice(0, 8));
const port = Number(arg("port") ?? "4805");
if (!Number.isInteger(port) || port < 1024 || port === 4649 || port === 8123)
  usage("--port must be a free port number (never 4649 or 8123)");
const hfCache = resolve(arg("hf-cache") ?? join(ROOT, "hf"));
if (!isTmp(hfCache)) usage("--hf-cache must be under /tmp");
const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace("T", "-")
  .slice(0, 15);

// --- Shared ---------------------------------------------------------------------------

interface Loaded {
  id8: string;
  cap: Capture;
  meeting: MeetingInput;
  durationMs: number;
}

/** The captures of one model, shortest meeting first (early stop reads the first two). */
function loadMeetings(model: string): Loaded[] {
  const out = meetingIds.map((id8) => {
    const cap = loadCapture(id8, model);
    const db = capturePaths(id8, model).db;
    const meeting = readMeeting(db, cap.meetingId);
    return {
      id8,
      cap,
      meeting,
      durationMs: Number(meeting.row.duration_ms ?? 0),
    };
  });
  return out.sort((a, b) => a.durationMs - b.durationMs);
}

function checkWorker(): void {
  if (!existsSync(WORKER)) throw new Error(`no worker at ${WORKER}`);
  const help = spawnSync(WORKER, ["--help"], { encoding: "utf8" });
  if (!`${help.stdout}`.includes("--llm"))
    throw new Error(`the worker at ${WORKER} has no --llm mode`);
}

async function withWorker<T>(
  model: string,
  job: string,
  minutes: number,
  logDir: string,
  fn: (complete: Complete) => Promise<T>,
): Promise<{ value: T; gpuSeconds: number }> {
  await takeLock(`sweep-${job}-${slug(model)}`, minutes);
  const t0 = Date.now();
  try {
    const w = await startWorker({
      worker: WORKER,
      model,
      port,
      hfCache,
      home: SERVER_HOME,
      log: join(logDir, `worker-${slug(model)}.log`),
    });
    try {
      return { value: await fn(workerClient(w.baseUrl)), gpuSeconds: 0 };
    } finally {
      await w.stop();
    }
  } finally {
    releaseLock();
    const gpu = Math.round((Date.now() - t0) / 1000);
    console.log(`GPU time ${job} ${model}: ${gpu} s`);
    lastGpuSeconds = gpu;
  }
}
let lastGpuSeconds = 0;

// --- 1. Capture -------------------------------------------------------------------------

function capture(dir: string): number {
  const results = JSON.parse(
    readFileSync(join(dir, "results.json"), "utf8"),
  ) as {
    runs: { model: string; meeting: string; status: string }[];
    meetings: { id8: string; id: string; asrHash: string | null }[];
  };
  let n = 0;
  for (const r of results.runs) {
    if (r.status !== "ok") {
      console.error(`skip ${r.model} ${r.meeting}: status ${r.status}`);
      continue;
    }
    const m = results.meetings.find((x) => x.id8 === r.meeting);
    if (!m) throw new Error(`results.json has no meeting ${r.meeting}`);
    const runDb = join(dir, "runs", slug(r.model), r.meeting, "test.db");
    const c = captureRun({
      runDb,
      meetingId: m.id,
      model: r.model,
      asrHash: m.asrHash,
    });
    console.log(`captured ${r.model} ${r.meeting}: ${c.calls} calls`);
    n++;
  }
  return n > 0 ? 0 : 1;
}

// --- 2. Replay proof ----------------------------------------------------------------------

/** The stored state of the run DB that each stage output must reproduce. */
function storedOutput(dbPath: string, meetingId: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const corrections = Object.fromEntries(
      (
        db
          .prepare(
            "SELECT id, enhanced_text FROM meeting_segments WHERE meeting_id = ? AND enhanced_text IS NOT NULL",
          )
          .all(meetingId) as { id: string; enhanced_text: string }[]
      ).map((r) => [r.id, r.enhanced_text]),
    );
    const speakers = (
      db
        .prepare(
          "SELECT speaker_label AS label, suggested_name, suggested_kind FROM meeting_speakers WHERE meeting_id = ? AND suggested_name IS NOT NULL ORDER BY speaker_label",
        )
        .all(meetingId) as {
        label: string;
        suggested_name: string;
        suggested_kind: string;
      }[]
    ).map((r) => ({ ...r }));
    const tags = (
      db
        .prepare(
          "SELECT t.name FROM meeting_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.meeting_id = ? ORDER BY t.name",
        )
        .all(meetingId) as { name: string }[]
    ).map((t) => t.name);
    const s = db
      .prepare(
        "SELECT summary_json FROM meeting_summaries WHERE meeting_id = ?",
      )
      .get(meetingId) as { summary_json: string | null } | undefined;
    return {
      corrections,
      speakers,
      tags,
      summaryJson: s?.summary_json ?? null,
    };
  } finally {
    db.close();
  }
}

const sortedJson = (o: Record<string, string>) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(o).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );

function outputEqual(
  stage: StageName,
  out: StageOutput,
  st: ReturnType<typeof storedOutput>,
): boolean {
  if (stage === "correctChunk")
    return sortedJson(out.corrections ?? {}) === sortedJson(st.corrections);
  if (stage === "identifySpeakers")
    return (
      JSON.stringify(
        [...(out.speakers ?? [])].sort((a, b) =>
          a.label.localeCompare(b.label),
        ),
      ) === JSON.stringify(st.speakers)
    );
  if (stage === "summarize") return out.summaryJson === st.summaryJson;
  return (
    JSON.stringify([...(out.tags ?? [])].sort()) === JSON.stringify(st.tags)
  );
}

async function replayCheck(outDir: string): Promise<number> {
  checkWorker();
  mkdirSync(outDir, { recursive: true });
  const report: Record<string, unknown>[] = [];
  let bad = 0;
  for (const model of models) {
    const loaded = loadMeetings(model);
    // No GPU: the rebuilt requests at the current settings vs the stored ones.
    for (const l of loaded)
      for (const stage of STAGES) {
        const r = await rebuildCheck(stage, l.cap, l.meeting);
        if (r.equal !== r.stored || r.rebuilt !== r.stored) bad++;
        report.push({ model, meeting: l.id8, stage, check: "rebuild", ...r });
        console.log(
          `rebuild ${model} ${l.id8} ${stage}: stored ${r.stored}, rebuilt ${r.rebuilt}, byte-equal ${r.equal}`,
        );
      }
    await withWorker(model, "replay-check", 30, outDir, async (complete) => {
      for (const l of loaded) {
        const st = storedOutput(capturePaths(l.id8, model).db, l.cap.meetingId);
        for (const stage of STAGES) {
          const stored = finalCalls(l.cap.calls, NODE_OF[stage]);
          const byBody = new Map<string, StoredCall>(
            stored.map((c) => [JSON.stringify(wireBody(c)), c]),
          );
          let same = 0;
          let differ = 0;
          let unmatched = 0;
          const wrapped: Complete = async (body) => {
            const reply = await complete(body);
            const hit = byBody.get(JSON.stringify(body));
            if (!hit) unmatched++;
            else if (reply.text === hit.rawText && reply.finish === hit.finish)
              same++;
            else differ++;
            return reply;
          };
          const out = await runStage(stage, l.cap, l.meeting, {}, wrapped);
          const eq = outputEqual(stage, out, st);
          if (differ > 0 || unmatched > 0 || !eq) bad++;
          report.push({
            model,
            meeting: l.id8,
            stage,
            check: "replay",
            calls: stored.length,
            byteEqual: same,
            differ,
            unmatched,
            outputEqualsStored: eq,
          });
          console.log(
            `replay ${model} ${l.id8} ${stage}: ${stored.length} stored calls, byte-equal ${same}, differ ${differ}, unmatched ${unmatched}, output = stored DB state: ${eq}`,
          );
        }
      }
    });
    report.push({ model, check: "gpu", gpuSeconds: lastGpuSeconds });
  }
  const path = join(outDir, "replay-check.json");
  writeFileSync(
    path,
    `${JSON.stringify({ createdAt: new Date().toISOString(), worker: workerSha(), report }, null, 1)}\n`,
  );
  console.log(`replay-check: ${path} (${bad === 0 ? "PASS" : `FAIL ${bad}`})`);
  return bad === 0 ? 0 : 1;
}

function workerSha(): string {
  const r = spawnSync("shasum", [WORKER], { encoding: "utf8" });
  return r.stdout.split(" ")[0]?.slice(0, 16) ?? "?";
}

// --- 3. Sweep --------------------------------------------------------------------------------

const KEY_METRICS: Record<StageName, string[]> = {
  correctChunk: [
    "wer",
    "werDelta",
    "fixesFound",
    "mustNotChangeHits",
    "applied",
    "droppedByChecks",
    "droppedDeletesWords",
  ],
  identifySpeakers: [
    "speakersCorrect",
    "speakersWrong",
    "speakersMissing",
    "suggestions",
  ],
  summarize: [
    "factsMatched",
    "ownerCorrect",
    "ownerWrong",
    "dueCorrect",
    "dueWrong",
    "mustNotClaimHits",
    "inventedItems",
    "summaryChars",
  ],
  suggestTags: ["tagsPrecision", "tagsRecall", "tagsOutput"],
};
const CALL_METRICS = [
  "calls",
  "finishLength",
  "jsonInvalid",
  "failedUnits",
  "outputTokens",
  "latencyMs",
];

const fmtParams = (p: Record<string, unknown>) =>
  Object.entries(p)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ") || "(current)";
const fmt = (v: unknown) => (v === null || v === undefined ? "-" : String(v));

interface ModelResult {
  model: string;
  meetings: string[];
  gpuSeconds: number;
  result: SearchResult;
}

function renderMd(
  stage: StageName,
  space: string,
  rs: ModelResult[],
  commit: string,
): string {
  const cols = [...KEY_METRICS[stage], ...CALL_METRICS];
  const lines: string[] = [
    `# Parameter sweep: ${stage}`,
    "",
    `Commit ${commit}. Space ${space}. Worker sha ${workerSha()}. Numbers only; metrics are sums over the meetings (rates are means).`,
    "",
    "## Summary",
    "",
    "| Model | Baseline | Baseline objective | Best | Best objective | Delta | Noise band | Beats noise | Combinations | GPU s |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of rs) {
    const s = r.result;
    lines.push(
      `| ${r.model} | ${fmtParams(s.baseline.params)} | ${s.baseline.objective} | ${fmtParams(s.best.params)} | ${s.best.objective} | ${s.delta} | ${s.band.objective} | ${s.beatsNoise ? "yes" : "no"} | ${s.combos.length} | ${r.gpuSeconds} |`,
    );
  }
  lines.push("", "## Proposal", "");
  for (const r of rs) {
    const s = r.result;
    lines.push(
      s.beatsNoise
        ? `- ${r.model}: ${fmtParams(s.best.params)} (objective +${s.delta}, band ${s.band.objective}). Prove it in the app with meeting:eval before a default change.`
        : `- ${r.model}: keep the current settings (best delta ${s.delta} is not above the noise band ${s.band.objective}).`,
    );
  }
  for (const r of rs) {
    const s = r.result;
    lines.push(
      "",
      `## ${r.model}`,
      "",
      `Meetings (shortest first): ${r.meetings.join(", ")}.`,
      "",
      `| Phase | Parameters | Objective | Repeats (objectives) | Meetings | Early stop | ${cols.join(" | ")} |`,
      `|---|---|---|---|---|---|${cols.map(() => "---").join("|")}|`,
    );
    const row = (c: ComboResult) =>
      `| ${c.phase} | ${fmtParams(c.params)} | ${c.objective} | ${c.repeats} (${c.objectives.join(", ")}) | ${c.meetingsRun} | ${c.earlyStopped ? "yes" : "no"} | ${cols.map((k) => fmt(c.totals[k])).join(" | ")} |`;
    lines.push(row(s.baseline), row(s.noise));
    for (const c of s.combos) if (c.phase !== "baseline") lines.push(row(c));
    lines.push(
      `| band | \\|noise - baseline\\| | ${s.band.objective} | | | | ${cols.map((k) => fmt(s.band[k])).join(" | ")} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

async function sweep(
  stage: StageName,
  spacePath: string,
  outDir: string,
): Promise<number> {
  checkWorker();
  const space = parseSpace(readFileSync(spacePath, "utf8"));
  if (space.stage !== stage)
    usage(`the space is for ${space.stage}, not ${stage}`);
  const golds = loadGold(meetingIds, DEFAULT_GOLD_DIR) as Map<string, Gold>;
  mkdirSync(outDir, { recursive: true });
  const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).stdout.trim();
  const results: ModelResult[] = [];
  for (const model of models) {
    const loaded = loadMeetings(model);
    for (const l of loaded)
      if (finalCalls(l.cap.calls, NODE_OF[stage]).length === 0)
        throw new Error(`${model} ${l.id8}: the capture has no ${stage} call`);
    const { value } = await withWorker(model, stage, 120, outDir, (complete) =>
      search(
        space,
        loaded.length,
        async (params, mi, _repeat, perturb) => {
          const l = loaded[mi] as Loaded;
          const out = await runStage(
            stage,
            l.cap,
            l.meeting,
            params,
            complete,
            perturb ? { perturb: PERTURB[stage] } : {},
          );
          return scoreStage(
            stage,
            out,
            golds.get(l.id8) as Gold,
            l.meeting.rows,
          ) as Metrics;
        },
        (line) => console.log(`${model} ${line}`),
      ),
    );
    results.push({
      model,
      meetings: loaded.map((l) => l.id8),
      gpuSeconds: lastGpuSeconds,
      result: value,
    });
    // Write after each model, so a stop keeps the finished part.
    writeOut(stage, spacePath, results, commit, outDir);
  }
  const back = JSON.parse(readFileSync(join(outDir, "results.json"), "utf8"));
  if (back.models.length !== results.length)
    throw new Error("results.json read back with another model count");
  const name = arg("save-baseline");
  if (name) {
    if (!/^[a-z0-9][a-z0-9.-]{0,60}$/.test(name))
      usage("--save-baseline name must match [a-z0-9][a-z0-9.-]{0,60}");
    const path = join(
      repoRoot,
      "eval-baselines",
      `${new Date().toISOString().slice(0, 10)}-${name}.json`,
    );
    if (existsSync(path)) throw new Error(`${path} exists; pick another name`);
    writeFileSync(
      path,
      `${JSON.stringify(baselineOf(stage, results, commit), null, 1)}\n`,
    );
    JSON.parse(readFileSync(path, "utf8"));
    console.log(`baseline saved: ${path}`);
  }
  return 0;
}

function baselineOf(stage: StageName, rs: ModelResult[], commit: string) {
  return {
    format: "openstyle-sweep",
    version: 1,
    stage,
    commit,
    createdAt: new Date().toISOString(),
    models: rs.map((r) => ({
      model: r.model,
      meetings: r.meetings,
      gpuSeconds: r.gpuSeconds,
      baseline: {
        params: r.result.baseline.params,
        objective: r.result.baseline.objective,
        totals: r.result.baseline.totals,
      },
      best: {
        params: r.result.best.params,
        objective: r.result.best.objective,
        totals: r.result.best.totals,
      },
      delta: r.result.delta,
      band: r.result.band,
      beatsNoise: r.result.beatsNoise,
    })),
  };
}

function writeOut(
  stage: StageName,
  spacePath: string,
  rs: ModelResult[],
  commit: string,
  outDir: string,
) {
  const json = {
    format: "openstyle-sweep-results",
    version: 1,
    stage,
    commit,
    space: spacePath,
    createdAt: new Date().toISOString(),
    models: rs.map((r) => ({
      model: r.model,
      meetings: r.meetings,
      gpuSeconds: r.gpuSeconds,
      baseline: r.result.baseline,
      noise: r.result.noise,
      band: r.result.band,
      best: {
        params: r.result.best.params,
        objective: r.result.best.objective,
      },
      delta: r.result.delta,
      beatsNoise: r.result.beatsNoise,
      combos: r.result.combos.map((c) => ({ ...c, key: keyOf(c.params) })),
    })),
  };
  writeFileSync(
    join(outDir, "results.json"),
    `${JSON.stringify(json, null, 1)}\n`,
  );
  writeFileSync(
    join(outDir, "results.md"),
    renderMd(stage, spacePath, rs, commit),
  );
  console.log(`results: ${join(outDir, "results.md")}`);
}

// --- Main ------------------------------------------------------------------------------------

async function main(): Promise<number> {
  const cap = arg("capture");
  if (cap) return capture(resolve(cap));
  if (models.length === 0) usage("--models is required");
  if (has("replay-check"))
    return replayCheck(
      resolve(arg("out") ?? join(ROOT, "sweep", `replay-check-${stamp}`)),
    );
  const stage = arg("stage") as StageName | undefined;
  if (!stage || !STAGES.includes(stage))
    usage(`--stage must be one of ${STAGES.join(", ")}`);
  const space = arg("space");
  if (!space) usage("--space is required");
  return sweep(
    stage,
    resolve(space),
    resolve(arg("out") ?? join(ROOT, "sweep", `${stage}-${stamp}`)),
  );
}

main().then(
  (code) => {
    releaseLock();
    unqueue();
    removeWorkDir();
    process.exit(code);
  },
  (e) => {
    console.error(`meeting:eval:sweep failed: ${(e as Error).message}`);
    releaseLock();
    unqueue();
    removeWorkDir();
    process.exit(1);
  },
);
