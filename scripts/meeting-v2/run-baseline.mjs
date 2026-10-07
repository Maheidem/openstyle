#!/usr/bin/env node
// Phase 0b runner (specs/meeting-transcription-v2.md, sections 5, 7.2, 7.3).
//
// Runs one baseline run (R0 = diarization off, R0d = diarization on,
// R3a = phase 3a with R0's settings, R3b/R3b2 = phase 3b with R0's
// settings; R3b2 = the review-fixed context guards, R3c-off/R3c-on =
// the context setting (owner decision 2026-10-07) absent / "true")
// of the pipeline against the scratch profile. Starts its own isolated
// server (never port 4649), transcribes the copied meeting, measures the
// wall time from the POST /transcribe reply to status = transcribed, stops
// the server it started, and writes run.json plus metrics.json.
//
// Usage:
//   node scripts/meeting-v2/run-baseline.mjs --meeting <id> --run R0 \
//     [--port 4787] [--timeout-sec 10800] [--diarizer-seconds <n>]
//
// It prints counts, ids, durations and file paths only.

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

const meetingId = arg("meeting");
const runName = arg("run");
const port = Number(arg("port") ?? "4787");
const timeoutSec = Number(arg("timeout-sec") ?? "10800");
const diarizerSecondsRaw = arg("diarizer-seconds");

if (!meetingId || !runName) {
  console.error(
    "usage: run-baseline.mjs --meeting <id> --run R0|R0d|R3a|R3b|R3b2|R3c-off|R3c-on [options]",
  );
  process.exit(2);
}
if (
  runName !== "R0" &&
  runName !== "R0d" &&
  runName !== "R3a" &&
  runName !== "R3b" &&
  runName !== "R3b2" &&
  runName !== "R3c-off" &&
  runName !== "R3c-on"
) {
  console.error(
    `--run must be R0, R0d, R3a, R3b, R3b2, R3c-off or R3c-on, got: ${runName}`,
  );
  process.exit(2);
}
// R3a/R3b/R3b2/R3c-* run with R0's settings: diarization off.
const diarizationOn = runName === "R0d";
// The previous-chunk context setting (owner decision 2026-10-07):
// R3c-on sets it to "true", and so do R3b/R3b2 (their recorded runs
// had context on — the setting did not exist yet); every other run
// removes the row (off).
const asrContextOn =
  runName === "R3c-on" || runName === "R3b" || runName === "R3b2";
if (port === 4649) {
  console.error("refusing to use port 4649 (the installed app owns it)");
  process.exit(2);
}

const dbPath = join(scratch, "test.db");
// One dir per (run, meeting): the proof runs the same run name on two
// meetings and the metrics files must not clobber each other.
const runDir = join(scratch, "baseline", `${runName}-${meetingId.slice(0, 8)}`);
const logPath = join(runDir, "server.log");
mkdirSync(runDir, { recursive: true });
rmSync(logPath, { force: true });

// --- 1. Reset the scratch DB state for a fresh transcribe ----------------
{
  const db = new DatabaseSync(dbPath);
  db.prepare("DELETE FROM meeting_segments WHERE meeting_id = ?").run(
    meetingId,
  );
  db.prepare("DELETE FROM meeting_speakers WHERE meeting_id = ?").run(
    meetingId,
  );
  db.prepare("DELETE FROM meeting_summaries WHERE meeting_id = ?").run(
    meetingId,
  );
  db.prepare(
    `UPDATE meetings
     SET status = 'recorded', language = NULL, error = NULL,
         stt_provider = NULL, stt_model = NULL
     WHERE id = ?`,
  ).run(meetingId);
  if (diarizationOn) {
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('meeting_diarization_enabled', 'true') \
       ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run();
  } else {
    db.prepare(
      "DELETE FROM settings WHERE key = 'meeting_diarization_enabled'",
    ).run();
  }
  if (asrContextOn) {
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('meeting_asr_context', 'true') \
       ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run();
  } else {
    db.prepare("DELETE FROM settings WHERE key = 'meeting_asr_context'").run();
  }
  db.close();
}
console.log(
  `reset scratch DB for ${runName} (diarization ${diarizationOn ? "on" : "off"}, context setting ${asrContextOn ? "on" : "off"})`,
);

// --- 2. Start the isolated server ---------------------------------------
const token = randomUUID();
const env = { ...process.env };
delete env.OPENSTYLE_LOG_DIR;
env.OPENSTYLE_DB_PATH = dbPath;
env.PORT = String(port);
env.HOST = "127.0.0.1";
env.OPENSTYLE_AUTH_TOKEN = token;

const logStream = createWriteStream(logPath, { flags: "a" });
const server = spawn(process.execPath, ["../server/dist/startup.js"], {
  cwd: join(repoRoot, "apps", "electron"),
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.pipe(logStream, { end: false });
server.stderr.pipe(logStream, { end: false });
writeFileSync(join(runDir, "server.pid"), String(server.pid));
let serverExited = false;
server.on("exit", () => {
  serverExited = true;
});

const base = `http://127.0.0.1:${port}`;
const headers = { Authorization: `Bearer ${token}` };

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

let exitCode = 0;
try {
  // --- 3. Wait for health -------------------------------------------------
  let healthy = false;
  for (let i = 0; i < 120; i += 1) {
    if (serverExited) break;
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) {
        healthy = true;
        break;
      }
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  if (!healthy) {
    console.error(`server did not become healthy; log: ${logPath}`);
    exitCode = 1;
  }

  if (exitCode === 0) {
    // --- 4. Kick the transcribe job and measure the wall time -------------
    const post = await fetch(`${base}/api/meetings/${meetingId}/transcribe`, {
      method: "POST",
      headers,
    });
    if (post.status !== 202) {
      console.error(
        `POST /transcribe failed: status ${post.status} ${await post.text()}`,
      );
      exitCode = 1;
    }
    const t0 = performance.now();
    let finalStatus = null;
    let finalError = null;
    let segmentCounts = null;
    const deadline = t0 + timeoutSec * 1000;
    while (performance.now() < deadline) {
      await sleep(2000);
      const res = await fetch(`${base}/api/meetings/${meetingId}`, { headers });
      if (!res.ok) continue;
      const body = await res.json();
      if (
        body.status === "transcribed" ||
        body.status === "summarized" ||
        body.status === "failed"
      ) {
        finalStatus = body.status;
        finalError = body.error ?? null;
        segmentCounts = body.segment_counts ?? null;
        break;
      }
    }
    const wallSeconds =
      Math.round(((performance.now() - t0) / 1000) * 100) / 100;
    if (!finalStatus) {
      console.error(
        `timed out after ${timeoutSec}s; wall so far ${wallSeconds}s`,
      );
      exitCode = 1;
    }

    const run = {
      run: runName,
      meetingId,
      port,
      wallSeconds,
      finalStatus,
      error: finalError,
      segmentCounts,
      finishedAt: new Date().toISOString(),
      logFile: logPath,
    };
    writeFileSync(
      join(runDir, "run.json"),
      `${JSON.stringify(run, null, 2)}\n`,
    );
    console.log(
      `${runName}: status=${finalStatus ?? "timeout"} wallSeconds=${wallSeconds} segments=${segmentCounts ? `${segmentCounts.total} (failed ${segmentCounts.failed})` : "?"}`,
    );

    if (exitCode === 0) {
      // --- 5. Compute the metrics ---------------------------------------
      const args = [
        join(repoRoot, "scripts", "meeting-v2", "metrics.mjs"),
        "--db",
        dbPath,
        "--meeting",
        meetingId,
        "--out",
        join(runDir, "metrics.json"),
        "--wall",
        String(wallSeconds),
        "--log",
        logPath,
      ];
      if (diarizerSecondsRaw !== undefined) {
        args.push("--diarizer-seconds", diarizerSecondsRaw);
      }
      const m = spawnSync(process.execPath, args, { stdio: "inherit" });
      if (m.status !== 0) exitCode = 1;
    }
  }
} finally {
  await stopServer();
  logStream.end();
}

if (existsSync(join(runDir, "run.json"))) {
  console.log(`run.json: ${join(runDir, "run.json")}`);
  console.log(`metrics.json: ${join(runDir, "metrics.json")}`);
}
console.log(`server.log: ${logPath}`);
process.exit(exitCode);
