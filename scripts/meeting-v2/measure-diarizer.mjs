#!/usr/bin/env node
// Diarizer wall-time measurement (specs/meeting-transcription-v2.md 4.3, 7.4).
//
// Runs the same fluidaudio-diarize binary and models the pipeline uses,
// directly on the copied system.wav, N times (default 3). Reports the wall
// seconds of each run and the median. The binary prints only speaker turns
// (no transcript text); stdout is discarded. Prints durations and paths only.
//
// Usage:
//   node scripts/meeting-v2/measure-diarizer.mjs --meeting <id> [--runs 3]

import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratch = process.env.SCRATCH ?? "/tmp/meeting-v2";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const meetingId = arg("meeting");
const runs = Number(arg("runs") ?? "3");
if (!meetingId) {
  console.error("usage: measure-diarizer.mjs --meeting <id> [--runs 3]");
  process.exit(2);
}

const wav = join(scratch, "meetings", meetingId, "system.wav");
if (!existsSync(wav)) {
  console.error(`no system.wav at ${wav}`);
  process.exit(2);
}

// Same resolution order the server uses (diarize.ts), from the apps/electron
// cwd the proof server runs in.
const binary = join(
  repoRoot,
  "apps",
  "electron",
  "resources",
  "bin",
  `${process.platform}-${process.arch}`,
  "fluidaudio-diarize",
);
const modelsDir = join(repoRoot, "apps", "electron", "resources", "models");
if (
  !existsSync(binary) ||
  !existsSync(join(modelsDir, "speaker-diarization"))
) {
  console.error(`diarizer bundle missing (binary: ${binary})`);
  process.exit(2);
}

function runOnce(n) {
  return new Promise((resolveP, rejectP) => {
    // stderr holds the binary's PROGRESS and profiling lines (no audio or
    // text content). Keep them in a file instead of the console.
    const errLog = createWriteStream(
      join(scratch, `diarizer-${meetingId}-run${n}.log`),
      {
        flags: "w",
      },
    );
    const child = spawn(binary, [wav, "--models-dir", modelsDir], {
      cwd: join(repoRoot, "apps", "electron"),
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.pipe(errLog, { end: false });
    const t0 = performance.now();
    child.on("error", (err) => {
      errLog.end();
      rejectP(err);
    });
    child.on("exit", (code) => {
      errLog.end();
      const seconds = Math.round(((performance.now() - t0) / 1000) * 100) / 100;
      if (code !== 0) rejectP(new Error(`diarizer exited ${code}`));
      else resolveP(seconds);
    });
  });
}

const durations = [];
for (let i = 1; i <= runs; i += 1) {
  try {
    const seconds = await runOnce(i);
    durations.push(seconds);
    console.log(`run ${i}/${runs}: ${seconds}s`);
  } catch (err) {
    console.error(`run ${i}/${runs} FAILED: ${String(err.message ?? err)}`);
    process.exit(1);
  }
}
const sorted = [...durations].sort((a, b) => a - b);
const median =
  sorted.length % 2 === 1
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
console.log(`median: ${median}s over ${runs} runs (all succeeded)`);
