// eval.mts: evaluate meeting Enhance + Summarize across LLM models on the
// owner's real reference meetings (`pnpm meeting:eval`).
//
// Usage (from the repo root):
//   pnpm meeting:eval --models <id,...> [--meetings <id8,...>] [--out <dir>]
//     [--keep] [--no-download] [--gold [--gold-dir <dir>] | --answer-key <file>]
//     [--save-baseline <name> [--noise-from <baseline>]] [--compare <baseline>]
//     [--hf-cache <dir>] [--port <n>] [--timeout-sec <n>]
//   pnpm meeting:eval --rescore <out> [gold and baseline flags]
//
// Models: the catalog ids of the built-in MLX LLM
// (apps/server/src/lib/mlx-llm/constants.ts). Only the app's built-in MLX
// models run: the tool never calls the owner's oMLX server
// (127.0.0.1:8123; owner rule 2026-10-21).
// Meetings: id8 or full ids. The default is the 4 council meetings.
// Gold: --gold loads ~/.openstyle-eval/gold/<id8>.json for each meeting
// (gold.mts); --answer-key loads a v1 answer key (fixes only). The scorers
// are in score.mts. Baselines (baseline.mts): --save-baseline writes
// eval-baselines/<date>-<name>.json (numbers only); --compare prints the
// delta table and exits 3 on a regression.
//
// Steps:
//   1. setup-scratch.sh copies the meetings read-only into a private scratch
//      profile (/tmp/meeting-eval/asr/work/<pid>). An isolated server checks that each LLM, the built-in ASR
//      model and the aligner are in the HF cache, and downloads a missing one
//      through the app routes (--no-download fails instead). The tool sets
//      the default voice row of the scratch DB to the built-in MLX ASR model
//      (ASR_VOICE). Each meeting has an ASR input hash (voice row,
//      vocabulary, languages, its audio, the contents of the server ASR code,
//      the worker and the diarizer). A meeting whose hash is in the cache
//      (/tmp/meeting-eval/asr/cache) comes from there; the others are transcribed by
//      run-baseline.mjs --run R0d under the GPU lock and stored in the cache.
//      The run DB (arms/transcribed.db) joins them.
//   2. Per model: an isolated server on a copy of the run DB sets the
//      default LLM row (read back from the DB after the server stops).
//   3. Per model, under one GPU lock: run-enhance.mjs --arm new --summarize
//      for each meeting, with a scratch HOME and HF cache and the dev worker.
//      A sampler records the peak RSS of the LLM worker.
//   4. Per model and meeting: the hard-fail checks (checks.mts), the metrics,
//      the gold scorecard (score.mts), and the judge pack (compare file RAW
//      vs MODEL, summary Markdown).
//   5. results.json and results.md, the self-check, the baseline save and
//      compare, the cleanup.
//
// Privacy: the out folder holds real meeting text (runs/, pack/, arms/).
// Without --keep the tool deletes them after it prints. The transcription
// cache (/tmp/meeting-eval/asr) also holds real text and audio; the tool
// prints the command that deletes it. results.md and
// results.json hold numbers and segment keys only. The console prints paths
// and counts only. OPENSTYLE_LOG_DIR and the tracing variables are removed
// from every server environment.
//
// Exit codes: 0 ok; 1 a run, a check or the self-check failed; 2 usage;
// 3 --compare found a worse metric or a new hard fail.

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { MLX_LLM_MODELS } from "../../../apps/server/src/lib/mlx-llm/constants.ts";
import {
  buildBaseline,
  compareBaselines,
  noiseBands,
  parseBaseline,
  saveBaseline,
} from "./baseline.mts";
import {
  attendeeNames,
  type CallRow,
  checkChunks,
  checkLabels,
  checkNames,
  checkNegations,
  checkNumbers,
  checkSegments,
  checkSpeakerNames,
  checkSummary,
  knownForms,
  type LinkRow,
  metadataNames,
  parseAnswerKey,
  runMetrics,
  type SegmentRow,
} from "./checks.mts";
import {
  DEFAULT_GOLD_DIR,
  type Gold,
  goldFromAnswerKey,
  goldInfo,
  loadGold,
} from "./gold.mts";
import {
  CHECKS,
  type CheckName,
  floorModel,
  hardFailsOf,
  type MeetingInfo,
  type Results,
  type RunResult,
  renderResults,
  selfCheck,
} from "./report.mts";
import {
  ASR_DEF,
  ASR_MODEL_ID,
  ASR_VOICE,
  type Call,
  checkBuild,
  ensureTranscribed as ensureTranscribedIn,
  isTmp,
  needPort,
  ROOT,
  releaseLock,
  removeAllScratch,
  removeScratch,
  repoRoot,
  resolveMeetingIds,
  runChild,
  SERVER_HOME,
  serverEnv,
  setupScratch as setupScratchIn,
  sleep,
  takeLock,
  unqueue,
  WORKER,
  withServer as withServerOn,
} from "./runtime.mts";
import { scoreRun } from "./score.mts";

const DEFAULT_MEETINGS = [
  "2943c36a-532e-4db9-af09-b5e66f0bdf2d",
  "5578edb0-68fc-4a7f-9fd5-b9e17e43ed7e",
  "ca70f895-ebe9-47e3-b663-eeb2c7bd97a6",
  "9243bea0-567f-443b-bf3b-9980f69993fd",
];

// --- Arguments ------------------------------------------------------------------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);
function usage(msg: string): never {
  console.error(msg);
  console.error(
    "usage: pnpm meeting:eval --models <id,...> [--meetings <id8,...>] [--out <dir>] [--keep] [--no-download] [--gold [--gold-dir <dir>] | --answer-key <file>] [--save-baseline <name> [--noise-from <file>]] [--compare <file>] [--hf-cache <dir>] [--port <n>] [--timeout-sec <n>]\n       pnpm meeting:eval --rescore <out dir of a --keep run> [the gold and baseline flags]",
  );
  process.exit(2);
}

const rescoreDir = arg("rescore");
const models = (arg("models") ?? "").split(",").filter(Boolean);
if (models.length === 0 && !rescoreDir) usage("--models is required");
if (rescoreDir && !isTmp(rescoreDir))
  usage(`--rescore must be under /tmp: ${rescoreDir}`);
const catalog = new Map(MLX_LLM_MODELS.map((m) => [m.id, m]));
for (const m of models)
  if (!catalog.has(m))
    usage(
      `unknown model ${m}; allowed (built-in MLX only): ${[...catalog.keys()].join(", ")}`,
    );
const meetingArgs = (arg("meetings") ?? "").split(",").filter(Boolean);
const keep = has("keep");
const noDownload = has("no-download");
const hfCache = resolve(arg("hf-cache") ?? join(ROOT, "hf"));
// The private scratch profiles (work/<pid>) and the shared transcription
// cache (cache/), see runtime.mts.
const ASR_DIR = join(ROOT, "asr");
const basePort = Number(arg("port") ?? "4797");
const timeoutSec = Number(arg("timeout-sec") ?? "7200");
const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace("T", "-")
  .slice(0, 15);
const outDir = resolve(arg("out") ?? join(ROOT, "out", stamp));
const answerKeyPath = arg("answer-key");
const useGold = has("gold");
const goldDir = resolve(arg("gold-dir") ?? DEFAULT_GOLD_DIR);
if (useGold && answerKeyPath) usage("pass --gold or --answer-key, not both");
if (arg("gold-dir") && !useGold) usage("--gold-dir needs --gold");
const saveName = arg("save-baseline");
const comparePath = arg("compare");
const noiseFromPath = arg("noise-from");
if (noiseFromPath && !saveName) usage("--noise-from needs --save-baseline");
if (saveName && !/^[a-z0-9][a-z0-9.-]{0,60}$/.test(saveName))
  usage("--save-baseline name must match [a-z0-9][a-z0-9.-]{0,60}");
const BASELINE_DIR = join(repoRoot, "eval-baselines");
const compareBase = comparePath
  ? parseBaseline(readFileSync(comparePath, "utf8"))
  : null;
const noiseFrom = noiseFromPath
  ? parseBaseline(readFileSync(noiseFromPath, "utf8"))
  : null;
if (!isTmp(outDir))
  usage(`--out must be under /tmp (it holds meeting text): ${outDir}`);
if (!isTmp(hfCache)) usage(`--hf-cache must be under /tmp: ${hfCache}`);
if (!Number.isInteger(basePort) || basePort < 1024)
  usage("--port must be a port number");
for (let p = basePort; p < basePort + 4; p++)
  if (p === 4649)
    usage("the ports must not include 4649 (the installed app owns it)");
const answerKey = answerKeyPath
  ? goldFromAnswerKey(parseAnswerKey(readFileSync(answerKeyPath, "utf8")))
  : null;

/** The gold of the meetings: --gold files, the --answer-key entries, or none. */
function goldFor(id8s: string[]): Map<string, Gold> {
  if (useGold) return loadGold(id8s, goldDir);
  if (answerKey)
    return new Map(
      id8s.flatMap((k) =>
        answerKey.has(k) ? [[k, answerKey.get(k) as Gold]] : [],
      ),
    );
  return new Map();
}

const slug = (model: string) => model.replace(/[^A-Za-z0-9.-]+/g, "-");

const resolveMeetings = () =>
  meetingArgs.length === 0
    ? DEFAULT_MEETINGS
    : resolveMeetingIds(meetingArgs, ASR_DIR);
const setupScratch = (ids: string[]) =>
  setupScratchIn(ASR_DIR, ids, basePort + 2);
// The run DB lives in arms/, so a run without --keep deletes it.
const ensureTranscribed = (work: string, ids: string[]) =>
  ensureTranscribedIn({
    asrDir: ASR_DIR,
    work,
    ids,
    voice: ASR_VOICE,
    port: basePort + 3,
    hfCache,
    out: join(outDir, "arms", "transcribed.db"),
  });
const withServer = <T,>(
  dbPath: string,
  logPath: string,
  fn: (call: Call) => Promise<T>,
) => withServerOn({ port: basePort, hfCache, dbPath, logPath }, fn);

// --- 2. Arm database (download, default LLM row) ---------------------------------------------

async function modelStatus(call: Call, model: string) {
  const r = await call("GET", "/api/mlx-llm/status");
  return (r.json?.models ?? []).find(
    (m: { model: string }) => m.model === model,
  ) as { status: string; downloadProgress?: { percent: number } } | undefined;
}

/**
 * Every model must be in the HF cache: each LLM, the built-in ASR model and
 * the aligner. A missing model is downloaded through the app's own route
 * (curated allow patterns); --no-download fails. No GPU work: the download
 * is network and disk only.
 */
async function ensureDownloaded(seedDb: string): Promise<void> {
  const dir = join(outDir, "arms");
  mkdirSync(dir, { recursive: true });
  const db = join(dir, "download.db");
  for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
  copyFileSync(seedDb, db);
  try {
    await withServer(db, join(dir, "download.log"), async (call) => {
      for (const model of models) {
        const def = catalog.get(model) as (typeof MLX_LLM_MODELS)[number];
        let st = await modelStatus(call, model);
        if (st?.status === "ready") {
          console.log(`model ${model}: in ${hfCache}`);
          continue;
        }
        if (noDownload)
          throw new Error(
            `${model} is not downloaded in ${hfCache} (--no-download)`,
          );
        console.log(
          `download ${model}: ${(def.sizeBytes / 1e9).toFixed(2)} GB into ${hfCache}`,
        );
        const d = await call("POST", `/api/mlx-llm/models/${model}/download`);
        if (d.status !== 200)
          throw new Error(`download route answered ${d.status}`);
        let lastPrint = 0;
        const end = Date.now() + 2 * 3600_000;
        while (Date.now() < end) {
          await sleep(3000);
          st = await modelStatus(call, model);
          if (st?.status === "ready" || st?.status === "error") break;
          if (Date.now() - lastPrint > 30_000) {
            lastPrint = Date.now();
            console.log(
              `download ${model}: ${st?.downloadProgress?.percent ?? 0} %`,
            );
          }
        }
        if (st?.status !== "ready")
          throw new Error(
            `download of ${model} ended with status ${st?.status ?? "?"}`,
          );
        console.log(`download ${model}: ready`);
      }
      // The built-in ASR model of the transcription (ASR_VOICE).
      const asr = async () =>
        (
          ((await call("GET", "/api/mlx-asr/status")).json?.models ?? []) as {
            model: string;
            status: string;
          }[]
        ).find((m) => m.model === ASR_MODEL_ID);
      let as = await asr();
      if (as?.status !== "ready") {
        if (noDownload)
          throw new Error(
            `${ASR_MODEL_ID} is not downloaded in ${hfCache} (--no-download)`,
          );
        console.log(
          `download ${ASR_MODEL_ID}: ${(ASR_DEF.sizeBytes / 1e9).toFixed(2)} GB into ${hfCache}`,
        );
        const d = await call(
          "POST",
          `/api/mlx-asr/models/${ASR_MODEL_ID}/download`,
        );
        if (d.status !== 200)
          throw new Error(`ASR download route answered ${d.status}`);
        const end = Date.now() + 2 * 3600_000;
        while (Date.now() < end) {
          await sleep(5000);
          as = await asr();
          if (as?.status === "ready" || as?.status === "error") break;
        }
        if (as?.status !== "ready")
          throw new Error(
            `download of ${ASR_MODEL_ID} ended with status ${as?.status ?? "?"}`,
          );
        console.log(`download ${ASR_MODEL_ID}: ready`);
      }
      // The transcription (R0d, diarization on) needs the forced aligner. The
      // server starts its download at boot. Wait for it here, so that no
      // transcription runs while the aligner is still missing.
      const aligner = async () =>
        (await call("GET", "/api/mlx-asr/status")).json?.aligner as
          | { status: string; sizeBytes?: number }
          | undefined;
      let al = await aligner();
      if (al?.status !== "ready") {
        if (noDownload)
          throw new Error(`the aligner is not in ${hfCache} (--no-download)`);
        console.log(
          `download aligner: ${((al?.sizeBytes ?? 0) / 1e9).toFixed(2)} GB into ${hfCache}`,
        );
        const end = Date.now() + 2 * 3600_000;
        while (Date.now() < end && al?.status !== "ready") {
          await sleep(5000);
          al = await aligner();
          if (al?.status === "error" || al?.status === "not_downloaded") {
            // The background download did not start or failed: start it.
            await call(
              "POST",
              "/api/mlx-asr/models/qwen3-forced-aligner-0.6b-8bit/download",
            );
          }
        }
        if (al?.status !== "ready")
          throw new Error(
            `the aligner download ended with status ${al?.status ?? "?"}`,
          );
        console.log("download aligner: ready");
      }
    });
  } finally {
    for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
  }
}

/** A copy of the transcribed DB with the default LLM row set to the model. */
async function prepareArm(model: string, transcribed: string): Promise<string> {
  const armDb = join(outDir, "arms", `${slug(model)}.db`);
  mkdirSync(dirname(armDb), { recursive: true });
  for (const f of [armDb, `${armDb}-wal`, `${armDb}-shm`])
    rmSync(f, { force: true });
  copyFileSync(transcribed, armDb);
  await withServer(
    armDb,
    join(outDir, "arms", `${slug(model)}.log`),
    async (call) => {
      if ((await modelStatus(call, model))?.status !== "ready")
        throw new Error(`${model} is not ready in ${hfCache}`);
      const row = {
        provider: "local-mlx-llm",
        model_id: `local-mlx-llm/${model}`,
        model_name: model,
      };
      const k = await call("PUT", "/api/settings/mlx_llm_keep_alive_minutes", {
        value: "-1",
      });
      if (k.status !== 200)
        throw new Error(`keep-alive setting answered ${k.status}`);
      const c = await call("POST", "/api/models/configured", {
        ...row,
        type: "llm",
        is_default: true,
      });
      if (c.status >= 300)
        throw new Error(`POST /api/models/configured answered ${c.status}`);
    },
  );
  // Read the row back: a 200 is not proof that the row is stored.
  const db = new DatabaseSync(armDb);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const rows = db
    .prepare(
      "SELECT provider, model_id FROM model_configs WHERE type = 'llm' AND is_default = 1",
    )
    .all() as { provider: string; model_id: string }[];
  db.close();
  if (rows.length !== 1 || rows[0]?.model_id !== `local-mlx-llm/${model}`)
    throw new Error(
      `arm DB for ${model}: default LLM row not stored (${rows.length} rows)`,
    );
  return armDb;
}

// --- 3. One Enhance run, with an RSS sampler -------------------------------------------------

function workerRssKb(): number {
  const ps = spawnSync("ps", ["-axwwo", "rss=,args="], { encoding: "utf8" });
  let peak = 0;
  for (const line of ps.stdout.split("\n")) {
    if (!line.includes(WORKER) || !line.includes("--llm")) continue;
    peak = Math.max(peak, Number(line.trim().split(/\s+/)[0]) || 0);
  }
  return peak;
}

async function runEnhance(
  model: string,
  armDb: string,
  id: string,
  runDir: string,
) {
  await needPort(basePort + 1);
  let peakKb = 0;
  const timer = setInterval(() => {
    peakKb = Math.max(peakKb, workerRssKb());
  }, 2000);
  const rc = await runChild(
    process.execPath,
    [
      join(repoRoot, "scripts", "meeting-v2", "run-enhance.mjs"),
      "--meeting",
      id,
      "--run",
      `EV-${slug(model)}`,
      "--arm",
      "new",
      "--from-db",
      armDb,
      "--summarize",
      "--port",
      String(basePort + 1),
      "--server-repo",
      repoRoot,
      "--out-dir",
      runDir,
      "--timeout-sec",
      String(timeoutSec),
      "--server-home",
      SERVER_HOME,
    ],
    serverEnv(hfCache, {}),
  );
  clearInterval(timer);
  return {
    rc,
    peakRssGb: Math.round((peakKb / 1048576) * 100) / 100,
  };
}

// --- 4. Checks, metrics, judge pack -------------------------------------------------------------

function readRun(dbPath: string, id: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const segments = db
    .prepare(
      "SELECT id, source, idx, start_ms, text, enhanced_text FROM meeting_segments WHERE meeting_id = ? ORDER BY source, idx, start_ms",
    )
    .all(id) as unknown as SegmentRow[];
  const meeting = db
    .prepare(
      "SELECT title, context, calendar_title, calendar_attendees FROM meetings WHERE id = ?",
    )
    .get(id) as Record<string, string | null>;
  const speakers = db
    .prepare(
      "SELECT speaker_label AS label, suggested_name, suggested_kind FROM meeting_speakers WHERE meeting_id = ?",
    )
    .all(id) as {
    label: string;
    suggested_name: string | null;
    suggested_kind: string | null;
  }[];
  const vocabulary = (
    db.prepare("SELECT term FROM vocabulary").all() as { term: string }[]
  ).map((v) => v.term);
  // The meeting tags, as getMeetingTags (apps/server/src/lib/meetings/tags.ts)
  // reads them. A DB from before the tags migration has no table: no tags.
  let tags: string[] = [];
  try {
    tags = (
      db
        .prepare(
          "SELECT t.name FROM meeting_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.meeting_id = ? ORDER BY t.name",
        )
        .all(id) as { name: string }[]
    ).map((t) => t.name);
  } catch {
    tags = [];
  }
  const summary = db
    .prepare(
      "SELECT markdown, summary_json FROM meeting_summaries WHERE meeting_id = ?",
    )
    .get(id) as
    | { markdown: string | null; summary_json: string | null }
    | undefined;
  const runIds = (
    db.prepare("SELECT id FROM llm_runs WHERE meeting_id = ?").all(id) as {
      id: string;
    }[]
  ).map((r) => r.id);
  const inRuns = `run_id IN (${runIds.map(() => "?").join(",") || "''"})`;
  const calls = db
    .prepare(
      `SELECT run_id, step_key, schema_name, attempt, finish_unified FROM llm_calls WHERE ${inRuns}`,
    )
    .all(...runIds) as unknown as CallRow[];
  const links = db
    .prepare(
      `SELECT l.target_type, l.outcome, l.reason FROM llm_call_links l JOIN llm_calls c ON c.id = l.call_id WHERE c.${inRuns}`,
    )
    .all(...runIds) as unknown as LinkRow[];
  db.close();
  return {
    segments,
    meeting,
    speakers,
    summary,
    calls,
    links,
    vocabulary,
    tags,
  };
}

function evaluate(
  raw: ReturnType<typeof readRun>,
  run: ReturnType<typeof readRun>,
  m: Record<string, unknown>,
  checkSummaryPass: boolean | null,
): Record<CheckName, { count: number; keys: string[] }> {
  // The metadata as the app reads it (prepare.ts): title, user context and
  // the attendee names (never the emails).
  const meta = [
    raw.meeting.title,
    raw.meeting.context,
    ...attendeeNames(raw.meeting.calendar_attendees),
  ];
  const rawTexts = raw.segments.map((s) => s.text);
  return {
    segments: checkSegments(raw.segments, run.segments),
    numbers: checkNumbers(run.segments),
    names: checkNames(
      run.segments,
      metadataNames([...meta, raw.meeting.calendar_title]),
      knownForms([...rawTexts, ...meta], raw.vocabulary),
    ),
    negations: checkNegations(run.segments),
    labels: checkLabels(run.segments),
    chunks: checkChunks(
      (m.failedChunks as number[] | undefined) ?? [],
      (m.chunksFailed as number | undefined) ?? 0,
      run.calls,
    ),
    summary: checkSummary(
      checkSummaryPass,
      run.summary?.summary_json ?? null,
      run.summary?.markdown ?? null,
    ),
    speakers: checkSpeakerNames(run.speakers, [...rawTexts, ...meta]),
  };
}

async function judgePack(
  model: string,
  id: string,
  runDir: string,
  rawDump: string,
): Promise<boolean> {
  const pack = join(outDir, "pack");
  const id8 = id.slice(0, 8);
  const rc = await runChild(
    process.execPath,
    [
      "--import",
      "./scripts/meeting-v2/ts-register.mjs",
      "scripts/meeting-v2/compare-speakers.mts",
      "--x",
      rawDump,
      "--y",
      join(runDir, "dump.json"),
      "--x-name",
      "RAW",
      "--y-name",
      slug(model),
      "--out",
      join(pack, `${slug(model)}-${id8}.compare.md`),
    ],
    process.env,
  );
  const db = new DatabaseSync(join(runDir, "test.db"), { readOnly: true });
  const s = db
    .prepare("SELECT markdown FROM meeting_summaries WHERE meeting_id = ?")
    .get(id) as { markdown: string | null } | undefined;
  db.close();
  writeFileSync(
    join(pack, `${slug(model)}-${id8}.summary.md`),
    `${s?.markdown ?? "(no summary row)"}\n`,
  );
  return rc === 0;
}

/** The gold scorecard of one run, or null with no gold for the meeting. */
function scorecardOf(
  gold: Gold | undefined,
  run: ReturnType<typeof readRun>,
  hash: string | null,
) {
  return gold
    ? scoreRun(
        gold,
        {
          segments: run.segments,
          summaryJson: run.summary?.summary_json ?? null,
          tags: run.tags,
          speakers: run.speakers,
        },
        hash,
      )
    : null;
}

/**
 * --compare and --save-baseline on finished results. The compare table goes
 * to the console and to `<dir>/<compareFile>`. The saved baseline is read
 * back and parsed. Returns 3 on a regression, else 0.
 */
function baselines(results: Results, dir: string, compareFile: string): 0 | 3 {
  let code: 0 | 3 = 0;
  const now = buildBaseline(results, saveName ?? "run");
  if (compareBase) {
    const c = compareBaselines(compareBase, now);
    writeFileSync(join(dir, compareFile), c.text);
    console.log(c.text);
    console.log(`compare: ${join(dir, compareFile)} (exit ${c.exitCode})`);
    code = c.exitCode;
  }
  if (saveName) {
    const b = buildBaseline(
      results,
      saveName,
      noiseFrom ? noiseBands(noiseFrom, now) : null,
    );
    const path = saveBaseline(b, BASELINE_DIR);
    const back = parseBaseline(readFileSync(path, "utf8"));
    if (back.runs.length !== b.runs.length)
      throw new Error(`baseline ${path}: read back ${back.runs.length} runs`);
    console.log(`baseline saved: ${path} (${back.runs.length} runs)`);
  }
  return code;
}

// --- Main --------------------------------------------------------------------------------------

async function main(): Promise<number> {
  // Read HEAD at the start: a commit made during a long run must not
  // label results that ran on the older code.
  const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).stdout.trim();
  checkBuild();
  const ids = resolveMeetings();
  const golds = goldFor(ids.map((id) => id.slice(0, 8)));
  mkdirSync(join(outDir, "pack"), { recursive: true });
  console.log(`out: ${outDir}`);
  console.log(
    `asr model: ${ASR_MODEL_ID}${process.env.MEETING_EVAL_ASR_MODEL ? " (MEETING_EVAL_ASR_MODEL)" : " (default)"}`,
  );
  const work = await setupScratch(ids);
  mkdirSync(join(outDir, "arms"), { recursive: true });
  await ensureDownloaded(join(work, "test.db"));
  const {
    path: transcribed,
    hash: asrHashValue,
    hashes: asrHashes,
  } = await ensureTranscribed(work, ids);
  removeScratch(work);

  // The raw dumps: the transcribed DB with enhanced_text = null.
  const raws = new Map<string, ReturnType<typeof readRun>>();
  const meetingInfo: MeetingInfo[] = [];
  for (const id of ids) {
    const id8 = id.slice(0, 8);
    const rawDump = join(outDir, "pack", `raw-${id8}.json`);
    const d = spawnSync(process.execPath, [
      join(repoRoot, "scripts", "meeting-v2", "dump-speakers.mjs"),
      transcribed,
      id,
      rawDump,
    ]);
    if (d.status !== 0) throw new Error(`raw dump failed for ${id8}`);
    const dump = JSON.parse(readFileSync(rawDump, "utf8"));
    for (const s of dump.segments) s.enhanced_text = null;
    writeFileSync(rawDump, JSON.stringify(dump, null, 1));
    const raw = readRun(transcribed, id);
    raws.set(id, raw);
    const db = new DatabaseSync(transcribed, { readOnly: true });
    const dur = db
      .prepare("SELECT duration_ms FROM meetings WHERE id = ?")
      .get(id) as { duration_ms: number };
    db.close();
    meetingInfo.push({
      id8,
      id,
      segments: raw.segments.length,
      durationSeconds: Math.round(dur.duration_ms / 1000),
      asrHash: asrHashes[id] ?? null,
    });
  }

  const runs: RunResult[] = [];
  let failed = false;
  for (const model of models) {
    let armDb: string;
    try {
      armDb = await prepareArm(model, transcribed);
    } catch (e) {
      console.error(`model ${model}: ${(e as Error).message}`);
      failed = true;
      for (const id of ids) runs.push(emptyRun(model, id.slice(0, 8), null));
      continue;
    }
    const minutes =
      Math.ceil(meetingInfo.reduce((a, m) => a + m.durationSeconds, 0) / 600) +
      5;
    const done: {
      id: string;
      runDir: string;
      rc: number;
      peakRssGb: number | null;
    }[] = [];
    await takeLock(slug(model), minutes);
    try {
      for (const id of ids) {
        const runDir = join(outDir, "runs", slug(model), id.slice(0, 8));
        const r = await runEnhance(model, armDb, id, runDir);
        console.log(`run ${model} ${id.slice(0, 8)}: exit ${r.rc}`);
        done.push({ id, runDir, ...r });
      }
    } catch (e) {
      console.error(`model ${model}: ${(e as Error).message}`);
      failed = true;
    } finally {
      releaseLock();
    }
    for (const id of ids) {
      const id8 = id.slice(0, 8);
      const d = done.find((x) => x.id === id);
      const dbPath = d ? join(d.runDir, "test.db") : "";
      const metricsPath = d ? join(d.runDir, "metrics-enhance.json") : "";
      if (
        !d ||
        !existsSync(dbPath) ||
        !existsSync(join(d.runDir, "dump.json")) ||
        !existsSync(metricsPath)
      ) {
        runs.push(emptyRun(model, id8, d?.rc ?? null));
        failed = true;
        continue;
      }
      const m = JSON.parse(readFileSync(metricsPath, "utf8"));
      const run = readRun(dbPath, id);
      const raw = raws.get(id) as ReturnType<typeof readRun>;
      const csPath = join(d.runDir, "check-summary.json");
      const csPass = existsSync(csPath)
        ? JSON.parse(readFileSync(csPath, "utf8")).pass === true
        : null;
      const checks = evaluate(raw, run, m, csPass);
      const packOk = await judgePack(
        model,
        id,
        d.runDir,
        join(outDir, "pack", `raw-${id8}.json`),
      );
      if (!packOk) failed = true;
      const r: RunResult = {
        model,
        meeting: id8,
        status: "ok",
        exitCode: d.rc,
        seconds:
          Math.round(((m.seconds ?? 0) + (m.summarizeSeconds ?? 0)) * 10) / 10,
        peakRssGb: d.peakRssGb,
        diskBytes: catalog.get(model)?.sizeBytes ?? null,
        inputTokens: m.inputTokens ?? null,
        outputTokens: m.outputTokens ?? null,
        chunksAttempted: m.chunksAttempted ?? null,
        chunksFailed: m.chunksFailed ?? null,
        metrics: runMetrics(run.links, run.calls, run.speakers),
        checks,
        hardFails: 0,
        scorecard: scorecardOf(golds.get(id8), run, asrHashes[id] ?? null),
      };
      r.hardFails = hardFailsOf(r);
      runs.push(r);
    }
  }

  const results: Results = {
    createdAt: new Date().toISOString(),
    commit,
    models,
    meetings: meetingInfo,
    asrHash: asrHashValue,
    asrModel: ASR_VOICE.model_id,
    gold: goldInfo(golds),
    runs,
    floor: null,
  };
  results.floor = floorModel(results);
  const jsonPath = join(outDir, "results.json");
  const mdPath = join(outDir, "results.md");
  writeFileSync(jsonPath, `${JSON.stringify(results, null, 1)}\n`);
  writeFileSync(mdPath, renderResults(results));

  // Self-check: re-read both files, compare them, and recompute the checks
  // from a fresh read of every run database.
  const back = JSON.parse(readFileSync(jsonPath, "utf8")) as Results;
  const errors = selfCheck(readFileSync(mdPath, "utf8"), back);
  for (const r of back.runs) {
    if (r.status !== "ok") continue;
    const runDir = join(outDir, "runs", slug(r.model), r.meeting);
    const id = ids.find((x) => x.startsWith(r.meeting)) as string;
    const m = JSON.parse(
      readFileSync(join(runDir, "metrics-enhance.json"), "utf8"),
    );
    const csPath = join(runDir, "check-summary.json");
    const csPass = existsSync(csPath)
      ? JSON.parse(readFileSync(csPath, "utf8")).pass === true
      : null;
    const fresh = readRun(join(runDir, "test.db"), id);
    const again = evaluate(readRun(transcribed, id), fresh, m, csPass);
    const sc = scorecardOf(golds.get(r.meeting), fresh, asrHashes[id] ?? null);
    if (JSON.stringify(sc) !== JSON.stringify(r.scorecard ?? null))
      errors.push(
        `${r.model} ${r.meeting}: a fresh read gives another scorecard than results.json`,
      );
    for (const c of CHECKS)
      if (again[c].count !== r.checks?.[c].count)
        errors.push(
          `${r.model} ${r.meeting} ${c}: a fresh read gives ${again[c].count}, results.json has ${r.checks?.[c].count}`,
        );
    for (const f of [
      `${slug(r.model)}-${r.meeting}.compare.md`,
      `${slug(r.model)}-${r.meeting}.summary.md`,
    ])
      if (!existsSync(join(outDir, "pack", f)))
        errors.push(`judge pack file missing: ${f}`);
  }
  if (errors.length > 0) {
    console.error(`SELF-CHECK FAILED (${errors.length}):`);
    for (const e of errors.slice(0, 20)) console.error(`  ${e}`);
    failed = true;
  } else {
    console.log(
      `self-check ok: ${back.runs.length} runs, ${back.meetings.length} meetings`,
    );
  }

  for (const r of runs)
    console.log(
      `${r.model} ${r.meeting}: hard fails ${r.hardFails} (${CHECKS.map((c) => `${c}=${r.checks?.[c].count ?? "-"}`).join(" ")})`,
    );
  console.log(`floor: ${results.floor ?? "none"}`);
  // No baseline from results that failed the self-check.
  const compareCode =
    errors.length === 0 ? baselines(results, outDir, "compare.md") : 0;
  console.log(`results.md: ${mdPath}`);
  console.log(`results.json: ${jsonPath}`);
  console.log(`judge pack (private text): ${join(outDir, "pack")}`);
  console.log(
    `cleanup (private text): rm -rf ${join(outDir, "runs")} ${join(outDir, "pack")} ${join(outDir, "arms")}; the transcription cache: rm -rf ${join(ASR_DIR, "cache")}`,
  );
  if (!keep) {
    for (const d of ["runs", "pack", "arms"])
      rmSync(join(outDir, d), { recursive: true, force: true });
    console.log(
      "deleted runs/, pack/ and arms/ (no --keep); results.md and results.json stay",
    );
  }
  return failed ? 1 : compareCode;
}

/**
 * --rescore <out>: run the checks and the gold scores again on the run
 * databases of a kept run (runs/ and arms/), with no model and no GPU. The
 * gold comes from the --gold or --answer-key flag of this call. It writes
 * results-rescore.md and results-rescore.json next to the old files and
 * self-checks them; --compare and --save-baseline work on the new results.
 */
function rescore(dir: string): number {
  const old = JSON.parse(
    readFileSync(join(dir, "results.json"), "utf8"),
  ) as Partial<Results> &
    Pick<Results, "createdAt" | "commit" | "models" | "meetings" | "runs">;
  const golds = goldFor(old.meetings.map((m) => m.id8));
  const errors: string[] = [];
  const runs = old.runs.map((was): RunResult => {
    // Results from before the scorecard have an answerKey field: drop it.
    const { answerKey: _old, ...r } = {
      ...was,
      scorecard: was.scorecard ?? null,
    } as RunResult & { answerKey?: unknown };
    if (r.status !== "ok") return { ...r, scorecard: null };
    const runDir = join(dir, "runs", slug(r.model), r.meeting);
    const rawDb = join(dir, "arms", `${slug(r.model)}.db`);
    const id = old.meetings.find((m) => m.id8 === r.meeting)?.id as string;
    for (const f of [rawDb, join(runDir, "test.db")])
      if (!existsSync(f)) errors.push(`missing ${f}`);
    if (errors.length > 0) return r;
    const m = JSON.parse(
      readFileSync(join(runDir, "metrics-enhance.json"), "utf8"),
    );
    const csPath = join(runDir, "check-summary.json");
    const csPass = existsSync(csPath)
      ? JSON.parse(readFileSync(csPath, "utf8")).pass === true
      : null;
    const run = readRun(join(runDir, "test.db"), id);
    const checks = evaluate(readRun(rawDb, id), run, m, csPass);
    const next: RunResult = {
      ...r,
      metrics: runMetrics(run.links, run.calls, run.speakers),
      checks,
      scorecard: scorecardOf(
        golds.get(r.meeting),
        run,
        old.meetings.find((x) => x.id8 === r.meeting)?.asrHash ??
          old.asrHash ??
          null,
      ),
    };
    next.hardFails = hardFailsOf(next);
    return next;
  });
  if (errors.length > 0) {
    for (const e of errors) console.error(e);
    return 1;
  }
  const results: Results = {
    createdAt: old.createdAt,
    commit: old.commit,
    models: old.models,
    meetings: old.meetings,
    asrHash: old.asrHash ?? null,
    asrModel: old.asrModel ?? null,
    gold: goldInfo(golds),
    runs,
    floor: null,
  };
  results.floor = floorModel(results);
  const jsonPath = join(dir, "results-rescore.json");
  const mdPath = join(dir, "results-rescore.md");
  writeFileSync(jsonPath, `${JSON.stringify(results, null, 1)}\n`);
  writeFileSync(mdPath, renderResults(results));
  const back = JSON.parse(readFileSync(jsonPath, "utf8")) as Results;
  const bad = selfCheck(readFileSync(mdPath, "utf8"), back);
  if (bad.length > 0) {
    console.error(`SELF-CHECK FAILED (${bad.length}):`);
    for (const e of bad.slice(0, 20)) console.error(`  ${e}`);
    return 1;
  }
  for (const r of back.runs) {
    const was = old.runs.find(
      (o) => o.model === r.model && o.meeting === r.meeting,
    );
    console.log(
      `${r.model} ${r.meeting}: hard fails ${was?.hardFails ?? "-"} -> ${r.hardFails} (${CHECKS.map((c) => `${c}=${r.checks?.[c].count ?? "-"}`).join(" ")})`,
    );
  }
  console.log(`floor: ${results.floor ?? "none"}`);
  console.log(`self-check ok: ${back.runs.length} runs`);
  console.log(`results: ${mdPath}`);
  return baselines(results, dir, "compare-rescore.md");
}

function emptyRun(
  model: string,
  meeting: string,
  exitCode: number | null,
): RunResult {
  return {
    model,
    meeting,
    status: "failed",
    exitCode,
    seconds: null,
    peakRssGb: null,
    diskBytes: catalog.get(model)?.sizeBytes ?? null,
    inputTokens: null,
    outputTokens: null,
    chunksAttempted: null,
    chunksFailed: null,
    metrics: null,
    checks: null,
    hardFails: 1,
    scorecard: null,
  };
}

(rescoreDir
  ? Promise.resolve().then(() => rescore(resolve(rescoreDir)))
  : main()
).then(
  (code) => {
    releaseLock();
    unqueue();
    removeAllScratch();
    process.exit(code);
  },
  (e) => {
    // Messages name steps, ids and HTTP codes, never meeting text.
    console.error(`meeting:eval failed: ${(e as Error).message}`);
    releaseLock();
    unqueue();
    removeAllScratch();
    process.exit(1);
  },
);
