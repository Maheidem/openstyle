#!/usr/bin/env node
// Enhance benchmark runner (specs/meeting-enhance-agentic.md 10.15, WP10a).
//
// One run = one fresh copy of the transcribed scratch database, one isolated
// server, one Enhance call, numbers out. `--arm old|new` is a LABEL only: the
// arm is the server build (`main` for old, the WP5b build for new). Point
// `--server-repo` at the worktree that holds the build to measure.
//
// Old arm: POST /enhance holds the request open and answers 200 (or 502 when
// every chunk failed) with the counts in the body. New arm: the route answers
// 202 { ok, id, runId }. The script polls GET /api/meetings/<id> until the job
// is null, then reads the run with GET /api/meetings/<id>/llm-runs?run_id=<runId>
// (chunk steps, typed failure kinds, correctedCount) and sums the tokens from
// llm_calls of the run in the scratch database. Checked on the candidate build
// in WP10b.
//
// Writes, in <out-dir> (default $SCRATCH/enhance/<run>-<id8>/):
//   metrics-enhance.json  numbers only
//   dump.json             dump-speakers.mjs format (private text: never print or commit)
//   server.log, test.db   scratch files
// Prints counts, durations, hashes, ids and paths only. No transcript text.
//
// Usage:
//   node scripts/meeting-v2/run-enhance.mjs --meeting <id> --run <name> \
//     --arm old|new --from-db <transcribed .backup copy> [--summarize] \
//     [--port 4790] [--server-repo <dir>] [--out-dir <dir>] [--timeout-sec 7200] \
//     [--server-home <dir>]
//
// --server-home <dir>: the HOME of the server child only (a folder under
// /tmp). A local MLX LLM run needs it: the server keeps the managed MLX
// runtime under homedir(), and the real one belongs to the installed app.
// The script itself keeps the caller's HOME, so `pnpm` still works.
//
// --summarize: old arm posts /summarize after Enhance (the old path does not
// chain). New arm: the Enhance run already holds the summarize stage. If the
// meeting has no summary after the run, the script posts /summarize (202 with
// a runId) and waits for that run too. Either way it then runs
// `pnpm meeting:check-summary` and merges the numbers.
//
// Exit codes: 0 ok; 1 run failed or a check failed; 2 usage.

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratch = process.env.SCRATCH ?? "/tmp/meeting-v2";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const has = (name) => process.argv.includes(`--${name}`);

const meetingId = arg("meeting");
const runName = arg("run");
const arm = arg("arm");
const fromDb = arg("from-db");
const summarize = has("summarize");
const port = Number(arg("port") ?? "4790");
const serverRepo = resolve(arg("server-repo") ?? repoRoot);
const timeoutSec = Number(arg("timeout-sec") ?? "7200");
const serverHome = arg("server-home");
if (!meetingId || !runName || !fromDb || (arm !== "old" && arm !== "new")) {
  console.error(
    "usage: run-enhance.mjs --meeting <id> --run <name> --arm old|new --from-db <db> [--summarize] [--port n] [--server-repo dir] [--out-dir dir] [--timeout-sec n] [--server-home dir]",
  );
  process.exit(2);
}
if (port === 4649) {
  console.error("refusing to use port 4649 (the installed app owns it)");
  process.exit(2);
}
if (serverHome && !/^\/(private\/)?tmp\//.test(resolve(serverHome))) {
  console.error(`--server-home must be under /tmp: ${serverHome}`);
  process.exit(2);
}
if (!existsSync(fromDb)) {
  console.error(`--from-db does not exist: ${fromDb}`);
  process.exit(2);
}
const serverEntry = join(serverRepo, "apps", "server", "dist", "startup.js");
if (!existsSync(serverEntry)) {
  console.error(
    `no server build at ${serverEntry} (pnpm turbo build --filter=@openstyle/server)`,
  );
  process.exit(2);
}

const runDir = resolve(
  arg("out-dir") ??
    join(scratch, "enhance", `${runName}-${meetingId.slice(0, 8)}`),
);
const dbPath = join(runDir, "test.db");
const logPath = join(runDir, "server.log");
const dumpPath = join(runDir, "dump.json");
const metricsPath = join(runDir, "metrics-enhance.json");
mkdirSync(runDir, { recursive: true });
for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, logPath])
  rmSync(f, { force: true });
copyFileSync(fromDb, dbPath);

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** Hashes of what the run must not change (text) and of the meeting context. */
function readFingerprints() {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const m = db
    .prepare(
      `SELECT title, context, language, calendar_title, calendar_attendees
       FROM meetings WHERE id = ?`,
    )
    .get(meetingId);
  if (!m) {
    db.close();
    throw new Error(`meeting ${meetingId} not in ${fromDb}`);
  }
  const segs = db
    .prepare(
      "SELECT source, idx, text FROM meeting_segments WHERE meeting_id = ? ORDER BY source, idx",
    )
    .all(meetingId);
  db.close();
  return {
    contextHash: sha(JSON.stringify(m)),
    textHash: sha(JSON.stringify(segs.map((s) => s.text))),
    segments: segs.length,
  };
}
const before = readFingerprints();

// --- Isolated server -----------------------------------------------------
const token = randomUUID();
const env = { ...process.env };
// Real meetings: no request trace on disk, no tracing export (rule B12).
delete env.OPENSTYLE_LOG_DIR;
for (const k of Object.keys(env)) {
  if (/^(LANGSMITH|LANGCHAIN|MLFLOW|OKTO_NEURON|MARGINALIA)/i.test(k))
    delete env[k];
}
env.OPENSTYLE_DB_PATH = dbPath;
env.PORT = String(port);
env.HOST = "127.0.0.1";
env.OPENSTYLE_AUTH_TOKEN = token;
if (serverHome) {
  mkdirSync(serverHome, { recursive: true });
  env.HOME = resolve(serverHome);
}

const logStream = createWriteStream(logPath, { flags: "a" });
const server = spawn(process.execPath, ["../server/dist/startup.js"], {
  cwd: join(serverRepo, "apps", "electron"),
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.pipe(logStream, { end: false });
server.stderr.pipe(logStream, { end: false });
let serverExited = false;
server.on("exit", () => {
  serverExited = true;
});

// A signal skips the finally block: kill the server here so it does not keep
// the port and the scratch database.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (!serverExited && server.pid != null) {
      try {
        process.kill(server.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    process.exit(1);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stopServer() {
  if (serverExited || server.pid == null) return;
  try {
    process.kill(server.pid, "SIGTERM");
  } catch {
    return;
  }
  for (let i = 0; i < 50; i += 1) {
    if (serverExited) return;
    await sleep(200);
  }
  try {
    process.kill(server.pid, "SIGKILL");
  } catch {
    // already gone
  }
  await sleep(200);
}

/** node:http, not fetch: the old /enhance holds the request open for minutes
 *  and fetch cuts a response header wait at 5 minutes. */
function call(method, path, timeoutMs, what = "request") {
  return new Promise((resolveCall, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: { Authorization: `Bearer ${token}` },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let body = null;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            // not JSON
          }
          resolveCall({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    if (timeoutMs !== undefined) {
      // Destroy the request at the run deadline so the finally block runs.
      const timer = setTimeout(
        () => req.destroy(new Error(`timed out waiting for ${what}`)),
        Math.max(1, timeoutMs),
      );
      req.on("close", () => clearTimeout(timer));
    }
    req.end();
  });
}

/** Poll GET /<id> until the job slot is empty. Returns the last progress. */
async function waitForJobEnd(deadline) {
  let progress = null;
  let seenJob = false;
  while (performance.now() < deadline) {
    const res = await call(
      "GET",
      `/api/meetings/${meetingId}`,
      deadline - performance.now(),
      "job poll",
    );
    if (res.status === 200) {
      const job = res.body?.job ?? null;
      if (job) {
        seenJob = true;
        progress = job.progress ?? job;
      } else if (seenJob) {
        return { ended: true, progress, jobError: res.body?.job_error ?? null };
      } else {
        // Job not visible yet or already over: give it one more poll.
        await sleep(500);
        const again = await call(
          "GET",
          `/api/meetings/${meetingId}`,
          deadline - performance.now(),
          "job poll",
        );
        if (!again.body?.job)
          return {
            ended: true,
            progress,
            jobError: again.body?.job_error ?? null,
          };
      }
    }
    await sleep(2000);
  }
  return { ended: false, progress, jobError: null };
}

const metrics = {
  run: runName,
  arm,
  meetingId,
  contextHash: before.contextHash,
  segments: before.segments,
};
let exitCode = 0;
const t0 = performance.now();
const deadline = t0 + timeoutSec * 1000;
try {
  let healthy = false;
  for (let i = 0; i < 120 && !serverExited; i += 1) {
    try {
      if ((await call("GET", "/api/health")).status === 200) {
        healthy = true;
        break;
      }
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  if (!healthy) throw new Error(`server not healthy; log: ${logPath}`);

  // --- Enhance --------------------------------------------------------
  const runIds = [];
  /** Wait for a 202 run: job slot empty, then run record no longer running. */
  async function waitForRun(label, startBody) {
    if (typeof startBody?.runId !== "string")
      throw new Error(`${label} 202 answer has no runId`);
    runIds.push(startBody.runId);
    const end = await waitForJobEnd(deadline);
    if (!end.ended) throw new Error(`timed out waiting for ${label}`);
    // The slot can be empty between two stages of one run: the run record
    // decides.
    for (;;) {
      const r = await call(
        "GET",
        `/api/meetings/${meetingId}/llm-runs?run_id=${startBody.runId}`,
        deadline - performance.now(),
        `${label} run record`,
      );
      if (r.status !== 200) throw new Error(`run record answered ${r.status}`);
      const run = r.body?.runs?.[0];
      if (run && run.status !== "running") return { end, run };
      if (performance.now() >= deadline)
        throw new Error(`timed out waiting for ${label} run record`);
      await sleep(1000);
    }
  }
  const newRuns = [];
  const post = await call(
    "POST",
    `/api/meetings/${meetingId}/enhance`,
    deadline - performance.now(),
    "enhance",
  );
  metrics.httpStatus = post.status;
  const body = post.body ?? {};
  let progress = null;
  if (post.status === 202) {
    const done = await waitForRun("the job", body);
    progress = done.end.progress;
    metrics.jobFailed = done.run.status === "failed";
    newRuns.push(done.run);
  } else if (post.status !== 200 && post.status !== 502) {
    throw new Error(`POST /enhance answered ${post.status}`);
  }
  metrics.seconds = Math.round((performance.now() - t0) / 100) / 10;

  // --- Summarize --------------------------------------------------------
  if (summarize) {
    if (arm === "old") {
      const s0 = performance.now();
      const sp = await call(
        "POST",
        `/api/meetings/${meetingId}/summarize`,
        deadline - performance.now(),
        "summarize",
      );
      if (sp.status !== 202)
        throw new Error(`POST /summarize answered ${sp.status}`);
      const end = await waitForJobEnd(deadline);
      if (!end.ended) throw new Error("timed out waiting for the summary");
      metrics.summarizeSeconds =
        Math.round((performance.now() - s0) / 100) / 10;
      metrics.summarizeFailed = end.jobError !== null;
    } else if (post.status === 202) {
      // New arm: the Enhance run holds the summarize stage. When the meeting
      // still has no summary row, start the Summarize route and wait for it.
      const has = new DatabaseSync(dbPath, { readOnly: true });
      const n = has
        .prepare(
          "SELECT COUNT(*) AS n FROM meeting_summaries WHERE meeting_id = ?",
        )
        .get(meetingId).n;
      has.close();
      if (n === 0) {
        const s0 = performance.now();
        const sp = await call(
          "POST",
          `/api/meetings/${meetingId}/summarize`,
          deadline - performance.now(),
          "summarize",
        );
        if (sp.status !== 202)
          throw new Error(`POST /summarize answered ${sp.status}`);
        const done = await waitForRun("the summary", sp.body);
        newRuns.push(done.run);
        metrics.summarizeSeconds =
          Math.round((performance.now() - s0) / 100) / 10;
        metrics.summarizeFailed = done.run.status === "failed";
      } else {
        metrics.summarizeFailed = false;
      }
    }
  }

  await stopServer();
  logStream.end();

  // --- Numbers ----------------------------------------------------------
  const logText = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  const failureReasons = { timeout: 0, parse: 0, provider: 0, unknown: 0 };
  const failedChunks = [];
  for (const m of logText.matchAll(
    /enhance chunk (\d+)\/\d+ call failed \((timeout|parse|provider)\)/g,
  )) {
    failureReasons[m[2]] += 1;
    failedChunks.push(Number(m[1]));
  }
  for (const m of logText.matchAll(/enhance chunk (\d+)\/\d+ parse failed/g)) {
    failureReasons.parse += 1;
    failedChunks.push(Number(m[1]));
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const corrected = db
    .prepare(
      `SELECT COUNT(*) AS n FROM meeting_segments
       WHERE meeting_id = ? AND enhanced_text IS NOT NULL AND enhanced_text <> text`,
    )
    .get(meetingId).n;
  const suggestions = db
    .prepare(
      `SELECT COUNT(*) AS n FROM meeting_speakers
       WHERE meeting_id = ? AND suggested_name IS NOT NULL AND TRIM(suggested_name) <> ''`,
    )
    .get(meetingId).n;
  db.close();

  if (post.status === 200 || post.status === 502) {
    metrics.chunksAttempted = body.chunksAttempted ?? 0;
    metrics.chunksSucceeded = body.chunksSucceeded ?? 0;
    metrics.chunksFailed = body.chunksFailed ?? 0;
    metrics.correctedCount = body.correctedCount ?? corrected;
    // Same method in both arms: the database count. The body value is kept
    // apart, because it counts only this run's proposals.
    metrics.speakerSuggestions = suggestions;
    metrics.speakerSuggestionsBody = body.speakerSuggestions ?? null;
    metrics.namesRespelled = body.namesRespelled ?? 0;
    metrics.partial = body.partial ?? false;
    metrics.stoppedEarly = body.stopped_early ?? false;
    // 502 body names the first failure; the log has the others.
    if (
      post.status === 502 &&
      failedChunks.length === 0 &&
      ["timeout", "parse", "provider"].includes(body.reason)
    ) {
      failureReasons[body.reason] += 1;
    }
  } else {
    // New arm: the run records (chunk steps) and the database.
    const chunkSteps = newRuns
      .flatMap((r) => r.steps ?? [])
      .filter((st) => st.key.startsWith("chunk:"));
    // GET llm-runs?run_id= holds all steps, so the chunk steps give the
    // total. The job progress counts every unit (speakers, summary too), so
    // it is only a fallback.
    const bad = chunkSteps.filter(
      (st) => st.status === "failed" || st.status === "partial",
    );
    const enhanceRun = newRuns.find((r) => r.kind === "enhance");
    const total =
      chunkSteps.length > 0 ? chunkSteps.length : (progress?.total ?? 0);
    metrics.chunksAttempted = total;
    metrics.chunksFailed = bad.length;
    metrics.chunksSucceeded = Math.max(0, total - bad.length);
    metrics.correctedCount = enhanceRun?.correctedCount ?? corrected;
    metrics.speakerSuggestions = suggestions;
    metrics.speakerSuggestionsBody = enhanceRun?.suggestionCount ?? null;
    metrics.namesRespelled = null;
    metrics.partial = bad.length > 0;
    metrics.stoppedEarly = false;
    metrics.runStatus = newRuns.map((r) => r.status);
    for (const st of bad) {
      const k = st.errorKind ?? "unknown";
      failureReasons[k] = (failureReasons[k] ?? 0) + 1;
      const n = Number(st.key.slice("chunk:".length));
      if (Number.isInteger(n)) failedChunks.push(n);
    }
  }
  if (arm === "old") {
    const typed =
      failureReasons.timeout + failureReasons.parse + failureReasons.provider;
    failureReasons.unknown = Math.max(0, metrics.chunksFailed - typed);
    metrics.failureReasons = failureReasons;
  } else {
    // Typed kinds come from the failed steps; a step with no kind counts as
    // unknown, which check-enhance-metrics.mjs reports as untyped.
    metrics.failureReasons = {
      unknown: 0,
      ...Object.fromEntries(
        Object.entries(failureReasons).filter(
          ([k, n]) => n > 0 || k === "unknown",
        ),
      ),
    };
    // Tokens: sum of the llm_calls rows of the run(s) in the scratch database
    // (the old path stores none).
    const tdb = new DatabaseSync(dbPath, { readOnly: true });
    const q = tdb.prepare(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS i,
              COALESCE(SUM(output_tokens),0) AS o, COALESCE(SUM(reasoning_tokens),0) AS r
       FROM llm_calls WHERE run_id = ?`,
    );
    const tok = {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    };
    for (const id of runIds) {
      const row = q.get(id);
      tok.calls += row.calls;
      tok.inputTokens += row.i;
      tok.outputTokens += row.o;
      tok.reasoningTokens += row.r;
    }
    tdb.close();
    metrics.runIds = runIds;
    metrics.calls = tok.calls;
    metrics.tokens = tok.inputTokens + tok.outputTokens + tok.reasoningTokens;
    metrics.inputTokens = tok.inputTokens;
    metrics.outputTokens = tok.outputTokens;
    metrics.reasoningTokens = tok.reasoningTokens;
  }
  metrics.failedChunks = [...new Set(failedChunks)].sort((a, b) => a - b);

  const after = readFingerprints();
  metrics.textHash = after.textHash;
  metrics.textUnchanged = after.textHash === before.textHash;
  if (!metrics.textUnchanged) {
    console.error("raw segment text changed during the run");
    exitCode = 1;
  }
  writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 1)}\n`);

  const dump = spawnSync(
    process.execPath,
    [
      join(repoRoot, "scripts", "meeting-v2", "dump-speakers.mjs"),
      dbPath,
      meetingId,
      dumpPath,
    ],
    { stdio: "inherit" },
  );
  if (dump.status !== 0) exitCode = 1;

  // --- Summary check ----------------------------------------------------
  if (summarize) {
    const csOut = join(runDir, "check-summary.json");
    rmSync(csOut, { force: true });
    const cs = spawnSync(
      "pnpm",
      [
        "meeting:check-summary",
        "--db",
        dbPath,
        "--meeting",
        meetingId,
        "--arm",
        arm,
        "--out",
        csOut,
      ],
      { cwd: repoRoot, stdio: ["ignore", "ignore", "inherit"] },
    );
    if (existsSync(csOut)) {
      const { arm: _arm, ...nums } = JSON.parse(readFileSync(csOut, "utf8"));
      Object.assign(metrics, nums);
      writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 1)}\n`);
      // Exit 1 from the gated new arm is a real failure; the old arm exits 0.
      if (cs.status !== 0) exitCode = 1;
    } else {
      console.error("check-summary wrote no output");
      exitCode = 1;
    }
  }
  console.log(
    `${runName} (${arm}): http=${metrics.httpStatus} seconds=${metrics.seconds} chunks=${metrics.chunksAttempted} ok=${metrics.chunksSucceeded} failed=${metrics.chunksFailed} corrected=${metrics.correctedCount} suggestions=${metrics.speakerSuggestions} contextHash=${metrics.contextHash} textHash=${metrics.textHash}`,
  );
  console.log(`metrics-enhance.json: ${metricsPath}`);
  console.log(`dump: ${dumpPath}`);
} catch (e) {
  // Messages here name steps and HTTP codes, never transcript text.
  console.error(`run-enhance failed: ${e.message}`);
  exitCode = 1;
} finally {
  await stopServer();
  logStream.end();
}
process.exit(exitCode);
