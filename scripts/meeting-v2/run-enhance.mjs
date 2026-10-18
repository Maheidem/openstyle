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
// 202 and the run is read by polling GET /api/meetings/<id> until the job
// ends. New-arm counts come from the last job progress and from the database
// (UNVERIFIED until WP5b: WP10b may fix this branch in its first round).
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
//     [--port 4790] [--server-repo <dir>] [--out-dir <dir>] [--timeout-sec 7200]
//
// --summarize: old arm posts /summarize after Enhance (the old path does not
// chain). New arm already summarizes in the same run; the script waits for
// it and reads the summary. Either way it then runs
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
if (!meetingId || !runName || !fromDb || (arm !== "old" && arm !== "new")) {
  console.error(
    "usage: run-enhance.mjs --meeting <id> --run <name> --arm old|new --from-db <db> [--summarize] [--port n] [--server-repo dir] [--out-dir dir] [--timeout-sec n]",
  );
  process.exit(2);
}
if (port === 4649) {
  console.error("refusing to use port 4649 (the installed app owns it)");
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
function call(method, path) {
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
    req.end();
  });
}

/** Poll GET /<id> until the job slot is empty. Returns the last progress. */
async function waitForJobEnd(deadline) {
  let progress = null;
  let seenJob = false;
  while (performance.now() < deadline) {
    const res = await call("GET", `/api/meetings/${meetingId}`);
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
        const again = await call("GET", `/api/meetings/${meetingId}`);
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
  const post = await call("POST", `/api/meetings/${meetingId}/enhance`);
  metrics.httpStatus = post.status;
  const body = post.body ?? {};
  let progress = null;
  if (post.status === 202) {
    const end = await waitForJobEnd(deadline);
    if (!end.ended) throw new Error("timed out waiting for the job");
    progress = end.progress;
    metrics.jobFailed = end.jobError !== null;
  } else if (post.status !== 200 && post.status !== 502) {
    throw new Error(`POST /enhance answered ${post.status}`);
  }
  metrics.seconds = Math.round((performance.now() - t0) / 100) / 10;

  // --- Summarize --------------------------------------------------------
  if (summarize) {
    if (arm === "old") {
      const s0 = performance.now();
      const sp = await call("POST", `/api/meetings/${meetingId}/summarize`);
      if (sp.status !== 202)
        throw new Error(`POST /summarize answered ${sp.status}`);
      const end = await waitForJobEnd(deadline);
      if (!end.ended) throw new Error("timed out waiting for the summary");
      metrics.summarizeSeconds =
        Math.round((performance.now() - s0) / 100) / 10;
      metrics.summarizeFailed = end.jobError !== null;
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
    metrics.speakerSuggestions = body.speakerSuggestions ?? suggestions;
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
    // New arm: job progress and database. UNVERIFIED until WP5b.
    const total = progress?.total ?? 0;
    const failed = progress?.failed ?? 0;
    metrics.chunksAttempted = total;
    metrics.chunksFailed = failed;
    metrics.chunksSucceeded = Math.max(0, total - failed);
    metrics.correctedCount = corrected;
    metrics.speakerSuggestions = suggestions;
    metrics.namesRespelled = null;
    metrics.partial = failed > 0;
    metrics.stoppedEarly = false;
  }
  const typed =
    failureReasons.timeout + failureReasons.parse + failureReasons.provider;
  failureReasons.unknown = Math.max(0, metrics.chunksFailed - typed);
  metrics.failureReasons = failureReasons;
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
