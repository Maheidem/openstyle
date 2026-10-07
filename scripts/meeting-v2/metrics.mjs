#!/usr/bin/env node
// Phase 0b metrics (specs/meeting-transcription-v2.md, section 7.4).
//
// Computes the run metrics for one finished transcribe run over the scratch
// DB and writes them to metrics.json. It reads segment text locally to
// compute counts and a hash; it prints counts, ids and file paths only. It
// never prints transcript text.
//
// Usage:
//   node scripts/meeting-v2/metrics.mjs --db <test.db> --meeting <id> \
//     --out <metrics.json> --wall <seconds> [--log <server.log>] \
//     [--diarizer-seconds <n>]
//
// Metric definitions follow spec 7.4. `multiTurnChunks` is null in the
// baseline: the old order never stores diarizer turns, only labels. Phase 4
// (spec 3.4) stores the raw turns in meeting_diarizer_turns. A chunk counts
// as multi-turn when it overlaps turns of TWO OR MORE distinct speakers by
// more than the 300 ms snap window: the cut rule only cuts at speaker
// changes, so same-speaker multi-turn overlap (a 15 s chunk over several
// utterance turns of one voice) is normal, and a sub-window sliver is the
// sanctioned snap artifact (the cut lands in the quiet part). Only a
// second speaker inside one chunk violates G4.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const dbPath = arg("db");
const meetingId = arg("meeting");
const outPath = arg("out");
const wallRaw = arg("wall");
const logPath = arg("log");
const diarizerSecondsRaw = arg("diarizer-seconds");

if (!dbPath || !meetingId || !outPath || wallRaw === undefined) {
  console.error(
    "usage: metrics.mjs --db <db> --meeting <id> --out <json> --wall <s> [--log <server.log>] [--diarizer-seconds <n>]",
  );
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: true });

const meeting = db
  .prepare("SELECT duration_ms, language, audio_dir FROM meetings WHERE id = ?")
  .get(meetingId);
if (!meeting) {
  console.error(`meeting row not found: ${meetingId}`);
  process.exit(1);
}

const segments = db
  .prepare(
    `SELECT source, idx, start_ms, end_ms, text, status, speaker_label, enhanced_text
     FROM meeting_segments WHERE meeting_id = ?
     ORDER BY source, idx`,
  )
  .all(meetingId);

const vocabulary = db.prepare("SELECT term FROM vocabulary").all();

// The diarizer's raw turns (spec 3.4). Absent table (a scratch DB from
// before phase 4) or no rows (diarization did not run) → null metric.
let turns = null;
try {
  const t = db
    .prepare(
      `SELECT speaker_id, start_ms, end_ms FROM meeting_diarizer_turns
       WHERE meeting_id = ? ORDER BY idx`,
    )
    .all(meetingId);
  turns = t.length > 0 ? t : null;
} catch {
  turns = null;
}
db.close();

const bySource = { mic: [], system: [] };
for (const s of segments) bySource[s.source] ??= [];

const chunks = {
  mic: segments.filter((s) => s.source === "mic").length,
  system: segments.filter((s) => s.source === "system").length,
  total: segments.length,
};
const chunksUnder3s = segments.filter(
  (s) => s.end_ms - s.start_ms < 3000,
).length;

const systemRows = segments.filter((s) => s.source === "system");
const labeledSystem = systemRows.filter((s) => s.speaker_label != null);
const distinctLabels = new Set(labeledSystem.map((s) => s.speaker_label));

const statusCount = { ok: 0, filtered: 0, empty: 0, failed: 0, other: 0 };
for (const s of segments) {
  if (s.status in statusCount) statusCount[s.status] += 1;
  else statusCount.other += 1;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// termHits: whole-word, case-insensitive occurrences of each vocabulary
// spelling in the raw text and in enhanced_text, all channels. Counts only.
function countTerm(text, re) {
  return (text.match(re) ?? []).length;
}
let termHits = 0;
for (const { term } of vocabulary) {
  const t = term.trim();
  if (!t) continue;
  const re = new RegExp(`\\b${escapeRegex(t)}\\b`, "gi");
  for (const s of segments) {
    termHits += countTerm(s.text ?? "", re);
    termHits += countTerm(s.enhanced_text ?? "", re);
  }
}

// textHash: sha256 over the ordered segment rows. Equal hash means equal
// output without revealing any text.
const hash = createHash("sha256");
for (const s of segments) {
  hash.update(
    `${s.source}|${s.idx}|${s.start_ms}|${s.end_ms}|${s.status}|${s.text ?? ""}\n`,
  );
}
const textHash = hash.digest("hex");

// normalizeText as in packages/stt/src/text.ts: lower case, no punctuation.
function words(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// dupJoins: neighbor pairs in one channel whose last k words of A equal the
// first k words of B. k at least 1 (dupJoins), also k at least 2.
let dupJoins = 0;
let dupJoinsK2 = 0;
for (const source of ["mic", "system"]) {
  const rows = bySource[source] ?? [];
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1];
    const next = rows[i];
    const a = words(prev.text ?? "");
    const b = words(next.text ?? "");
    if (a.length === 0 || b.length === 0) continue;
    const maxK = Math.min(a.length, b.length, 6);
    let k = 0;
    for (let candidate = maxK; candidate >= 1; candidate -= 1) {
      let match = true;
      for (let j = 0; j < candidate; j += 1) {
        if (a[a.length - candidate + j] !== b[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        k = candidate;
        break;
      }
    }
    if (k >= 1) dupJoins += 1;
    if (k >= 2) dupJoinsK2 += 1;
  }
}

// contiguousCuts: neighbor pairs in one channel with a gap under 1000 ms.
let contiguousCuts = 0;
for (const source of ["mic", "system"]) {
  const rows = bySource[source] ?? [];
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].start_ms - rows[i - 1].end_ms < 1000) contiguousCuts += 1;
  }
}

// langMismatch: chunks whose tinyld top candidate is not the meeting
// language (as language.ts does). No declared language means 0.
let langMismatch = 0;
const meetingLanguage = meeting.language;
if (meetingLanguage) {
  const require = createRequire(
    join(repoRoot, "apps", "server", "package.json"),
  );
  const { detectAll } = require("tinyld");
  for (const s of segments) {
    const text = s.text ?? "";
    if (!text.trim()) continue;
    const ranked = detectAll(text);
    const top = ranked?.[0]?.lang;
    if (top && top !== meetingLanguage) langMismatch += 1;
  }
}

// Diarizer wall time: prefer the explicit measurement (standalone binary
// runs); otherwise read the in-pipeline "diarization labeled" line time and
// the previous log line as a lower bound. Null when diarization did not run.
let diarizerSeconds = null;
if (diarizerSecondsRaw !== undefined) {
  diarizerSeconds = Number(diarizerSecondsRaw);
} else if (logPath && existsSync(logPath)) {
  const lines = readFileSync(logPath, "utf8").split("\n");
  const labeledIdx = lines.findIndex((l) => l.includes("diarization labeled"));
  if (labeledIdx >= 0 && labeledIdx > 0) {
    const parseTs = (line) => {
      const m = line.match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{3})/);
      if (!m) return null;
      return (
        Number(m[1]) * 3600 +
        Number(m[2]) * 60 +
        Number(m[3]) +
        Number(m[4]) / 1000
      );
    };
    const tEnd = parseTs(lines[labeledIdx]);
    // Phase 4 (spec 3.4): the "diarization started"/"finished" lines
    // bracket the binary's wall time (the labeled line comes after
    // transcription in the new order and would include the whole STT
    // run). Old-order logs have neither — fall back to the previous log
    // line before "labeled" as a lower bound.
    let pair = null;
    const finishedIdx = lines.findIndex((l) =>
      l.includes("diarization finished"),
    );
    const startedIdx = lines.findIndex((l) =>
      l.includes("diarization started"),
    );
    if (startedIdx >= 0 && finishedIdx >= 0) {
      pair = [parseTs(lines[startedIdx]), parseTs(lines[finishedIdx])];
    } else if (labeledIdx > 0) {
      let tStart = null;
      for (let i = labeledIdx - 1; i >= 0; i -= 1) {
        tStart = parseTs(lines[i]);
        if (tStart !== null) break;
      }
      pair = [tStart, tEnd];
    }
    if (pair && pair[0] !== null && pair[1] !== null && pair[1] >= pair[0]) {
      diarizerSeconds = Math.round((pair[1] - pair[0]) * 100) / 100;
    }
  }
}

const audioSeconds = meeting.duration_ms ? meeting.duration_ms / 1000 : null;

// multiTurnChunks: system chunks overlapping turns of two or more
// distinct speakers by more than the 300 ms snap window (see header).
// Null when no turns were stored (old-order runs).
const SNAP_TOLERANCE_MS = 300;
let multiTurnChunks = null;
if (turns) {
  multiTurnChunks = 0;
  for (const s of systemRows) {
    const speakers = new Set();
    for (const t of turns) {
      const overlap =
        Math.min(s.end_ms, t.end_ms) - Math.max(s.start_ms, t.start_ms);
      if (overlap > SNAP_TOLERANCE_MS) {
        speakers.add(t.speaker_id);
        if (speakers.size >= 2) break;
      }
    }
    if (speakers.size >= 2) multiTurnChunks += 1;
  }
}

const metrics = {
  meetingId,
  wallSeconds: Math.round(Number(wallRaw) * 100) / 100,
  chunks,
  chunksUnder3s,
  labeled: {
    count: labeledSystem.length,
    distinctLabels: distinctLabels.size,
  },
  multiTurnChunks,
  termHits,
  textHash,
  dupJoins,
  dupJoinsK2,
  contiguousCuts,
  langMismatch,
  filtered: statusCount.filtered,
  empty: statusCount.empty,
  failed: statusCount.failed,
  ok: statusCount.ok,
  diarizerSeconds,
  audioSeconds,
  diarizerPercentOfAudio:
    diarizerSeconds !== null && audioSeconds
      ? Math.round((diarizerSeconds / audioSeconds) * 1000) / 1000
      : null,
  enhanceSeconds: 0,
};

writeFileSync(outPath, `${JSON.stringify(metrics, null, 2)}\n`);
console.log(`metrics written: ${outPath}`);
console.log(
  [
    `chunks=${metrics.chunks.total} (mic=${metrics.chunks.mic} system=${metrics.chunks.system})`,
    `wallSeconds=${metrics.wallSeconds}`,
    `labeled=${metrics.labeled.count}/${metrics.labeled.distinctLabels} multiTurnChunks=${metrics.multiTurnChunks}`,
    `termHits=${metrics.termHits}`,
    `dupJoins=${metrics.dupJoins} (k>=2: ${metrics.dupJoinsK2})`,
    `contiguousCuts=${metrics.contiguousCuts}`,
    `chunksUnder3s=${metrics.chunksUnder3s}`,
    `filtered=${metrics.filtered} empty=${metrics.empty} failed=${metrics.failed}`,
    `langMismatch=${metrics.langMismatch}`,
    `diarizerSeconds=${metrics.diarizerSeconds} percentOfAudio=${metrics.diarizerPercentOfAudio}`,
    `textHash=${metrics.textHash.slice(0, 16)}…`,
  ].join(" "),
);
