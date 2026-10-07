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
//     [--diarizer-seconds <n>] [--r0d <r0d-dump.json>]
//
// `--r0d` (spec §3.6): the R0d chunk dump (the source:idx-keyed JSON the
// proof dumps each run). With it, `edgeWordsLost` / `edgeWordsAdded` are
// computed: for every R0d system chunk that the new run splits (the new
// rows over the chunk's span are not exactly the chunk itself), the
// normalized-word multiset of the R0d text minus the multiset of the new
// parts' texts over the same span (and the reverse). Ids + counts only.
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

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
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
const r0dPath = arg("r0d");

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

// wordEndsSentence as in packages/stt/src/text.ts (spec 3.6, Decision
// owner 2026-10-07): ends in . ? ! after dropping trailing closing
// quotes. The cut snap rule makes this the expected state of every
// kept cut, so badCutRatio should be 0.
function wordEndsSentence(word) {
  const w = word.trim();
  if (w.length === 0) return false;
  let end = w.length - 1;
  while (end >= 0 && /["\u201d'\u2019\u00bb\u203a]/.test(w.charAt(end))) {
    end -= 1;
  }
  return end >= 0 && ".?!".includes(w.charAt(end));
}

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

// mergedHash: sha256 over the MERGED transcript the user sees — the exact
// merge code path (apps/server/src/lib/meetings/merge.ts), run in a tsx
// subprocess because the module is TypeScript. textHash hashes the raw DB
// rows, so a merge-filter regression (a chunk surviving or dropping in
// mergeTranscript) is invisible to it; mergedHash is not. The per-segment
// line is speaker|start|end|(enhancedText ?? text), like the UI renders
// it. Null when tsx is not available (the metric is absent, not wrong).
function computeMergedHash() {
  const tsxBin = join(
    repoRoot,
    "apps",
    "server",
    "node_modules",
    ".bin",
    "tsx",
  );
  if (!existsSync(tsxBin) || !meeting.audio_dir) return null;
  // Channel rows exactly as loadMergedTranscript builds them
  // (routes/meetings.ts): status ok with text, speakerLabel when set,
  // enhancedText when set.
  const channel = (source) =>
    segments
      .filter((s) => s.source === source && s.status === "ok" && s.text)
      .map((s) => ({
        startMs: s.start_ms,
        endMs: s.end_ms,
        text: s.text,
        ...(s.speaker_label ? { speakerLabel: s.speaker_label } : {}),
        ...(s.enhanced_text ? { enhancedText: s.enhanced_text } : {}),
      }));
  // sync.json with the same rules as loadSyncData (routes/meetings.ts).
  let sync;
  try {
    const j = JSON.parse(
      readFileSync(join(meeting.audio_dir, "sync.json"), "utf8"),
    );
    if (Number.isFinite(j.sampleRate)) {
      sync = { sampleRate: j.sampleRate, epochs: [], syncMarkers: [] };
      if (typeof j.micT0 === "number")
        sync.epochs.push({ channel: "mic", t0WallclockMs: j.micT0 });
      if (typeof j.systemT0 === "number")
        sync.epochs.push({ channel: "system", t0WallclockMs: j.systemT0 });
      for (const m of j.syncMarkers ?? []) {
        if (
          typeof m.wallclockMs === "number" &&
          typeof m.totalSamples === "number"
        ) {
          sync.syncMarkers.push({
            channel: "system",
            wallclockMs: m.wallclockMs,
            totalSamples: m.totalSamples,
          });
        }
      }
    }
  } catch {
    // No sync file: no drift correction, same as the route.
  }
  const mergeTs = join(
    repoRoot,
    "apps",
    "server",
    "src",
    "lib",
    "meetings",
    "merge.ts",
  );
  const inputs = {
    mic: channel("mic"),
    system: channel("system"),
    sync,
    vocab: vocabulary.map((r) => r.term),
  };
  const code = [
    `import { createHash } from "node:crypto";`,
    `import { mergeTranscript } from ${JSON.stringify(mergeTs)};`,
    `const inputs = ${JSON.stringify(inputs)};`,
    `const merged = mergeTranscript(inputs.mic, inputs.system, inputs.sync, inputs.vocab);`,
    `const h = createHash("sha256");`,
    `for (const s of merged) h.update(s.speaker + "|" + s.startMs + "|" + s.endMs + "|" + (s.enhancedText ?? s.text) + "\\n");`,
    `console.log(h.digest("hex"));`,
  ].join("\n");
  const tmp = join(tmpdir(), `merged-hash-${process.pid}.mts`);
  try {
    writeFileSync(tmp, code);
    const out = execFileSync(tsxBin, [tmp], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      cwd: join(repoRoot, "apps", "server"),
    });
    const hash = out.trim().split("\n").pop();
    return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // best effort
    }
  }
}
const mergedHash = computeMergedHash();

const audioSeconds = meeting.duration_ms ? meeting.duration_ms / 1000 : null;

// multiTurnChunks: system chunks overlapping turns of two or more
// distinct speakers by more than the 300 ms snap window (see header).
// Null when no turns were stored (old-order runs).
const SNAP_TOLERANCE_MS = 300;

// edgeWordsLost / edgeWordsAdded (spec §3.6): needs the R0d dump.
// `words` above is the normalizer (same as normalizeText in @openstyle/stt
// — lower case, punctuation stripped, whitespace-collapsed).
function multisetDiff(a, b) {
  const counts = new Map();
  for (const w of a) counts.set(w, (counts.get(w) ?? 0) + 1);
  for (const w of b) counts.set(w, (counts.get(w) ?? 0) - 1);
  let missing = 0;
  for (const n of counts.values()) if (n > 0) missing += n;
  return missing;
}
let edgeWordsLost = null;
let edgeWordsAdded = null;
let splitChunkCount = null;
let distinctSplitChunks = null;
let punctRatio = null;
let badCutRatio = null;
const edgeWordsLostByChunk = {};
const edgeWordsAddedByChunk = {};
if (r0dPath && existsSync(r0dPath)) {
  const r0dRaw = JSON.parse(readFileSync(r0dPath, "utf8"));
  const r0dSystem = r0dRaw
    .filter((r) => r.source === "system" && r.text)
    .sort((a, b) => a.start_ms - b.start_ms);
  const newSystem = systemRows
    .filter((r) => r.status === "ok" && r.text)
    .sort((a, b) => a.start_ms - b.start_ms);
  edgeWordsLost = 0;
  edgeWordsAdded = 0;
  splitChunkCount = 0;
  distinctSplitChunks = 0;
  let punctInSplitR0d = 0;
  let punctInSplitParts = 0;
  let cutCount = 0;
  let badCuts = 0;
  for (const c of r0dSystem) {
    // The new rows over this chunk's span.
    const over = newSystem.filter(
      (p) => p.start_ms < c.end_ms && p.end_ms > c.start_ms,
    );
    const identical =
      over.length === 1 &&
      over[0].start_ms === c.start_ms &&
      over[0].end_ms === c.end_ms &&
      words(over[0].text).join(" ") === words(c.text).join(" ");
    if (identical) continue; // not divided
    const lost = multisetDiff(
      words(c.text),
      over.flatMap((p) => words(p.text)),
    );
    const added = multisetDiff(
      over.flatMap((p) => words(p.text)),
      words(c.text),
    );
    if (lost > 0) edgeWordsLostByChunk[`${c.source}:${c.idx}`] = lost;
    if (added > 0) edgeWordsAddedByChunk[`${c.source}:${c.idx}`] = added;
    edgeWordsLost += lost;
    edgeWordsAdded += added;
    // Spec 3.6 review: split-chunk health. A SPLIT chunk is one the R0d
    // side divided into two or more new rows (the parts). punctRatio =
    // punctuation marks in the parts / punctuation marks in the R0d
    // text over the same span (the align path must keep the ASR
    // punctuation: expect ~1.0). splitLabelDistinct = split chunks
    // whose parts carry two or more distinct stored labels / split
    // chunks (the parts keep the word-midpoint speakers: expect 1.0
    // unless the turns say otherwise).
    if (over.length >= 2) {
      splitChunkCount += 1;
      // Spec 3.6 (Decision, owner 2026-10-07): badCutRatio = cuts whose
      // previous word does NOT end a sentence / all cuts. The parts are
      // `over` in time order; every internal boundary is one cut and
      // its previous word is the left part's last (raw, punctuated)
      // token.
      for (let k = 1; k < over.length; k += 1) {
        cutCount += 1;
        const leftTokens = (over[k - 1].text ?? "")
          .split(/\s+/)
          .filter((t) => t.length > 0);
        const last = leftTokens[leftTokens.length - 1] ?? "";
        if (!wordEndsSentence(last)) badCuts += 1;
      }
      let punct0 = 0;
      for (const ch of c.text) {
        if (!/[\p{L}\p{N}\s]/u.test(ch)) punct0 += 1;
      }
      let punctNew = 0;
      for (const p of over) {
        for (const ch of p.text ?? "") {
          if (!/[\p{L}\p{N}\s]/u.test(ch)) punctNew += 1;
        }
      }
      punctInSplitR0d += punct0;
      punctInSplitParts += punctNew;
      const distinct = new Set(over.map((p) => p.speaker_label));
      if (distinct.size >= 2) distinctSplitChunks += 1;
    }
  }
  punctRatio =
    punctInSplitR0d > 0
      ? Math.round((punctInSplitParts / punctInSplitR0d) * 1000) / 1000
      : null;
  badCutRatio =
    cutCount > 0 ? Math.round((badCuts / cutCount) * 1000) / 1000 : null;
}

// aligner stats (spec §3.6): parsed from the run's log line
// "aligner split N mixed chunk(s) into M part(s), K call(s) in T s, F
// fallback(s), C cut(s), D dropped(s), W kept whole [reason]" (or the
// no-mixed variant). C/D/W are the sentence-end cut stats (Decision,
// owner 2026-10-07).
let aligner = null;
if (logPath && existsSync(logPath)) {
  const logText = readFileSync(logPath, "utf8");
  const m = logText.match(
    /aligner split (\d+) mixed chunk\(s\) into (\d+) part\(s\), (\d+) call\(s\) in ([\d.]+) s, (\d+) fallback\(s\), (\d+) cut\(s\), (\d+) dropped\(s\), (\d+) kept whole(?: \(([^)]*)\))?/,
  );
  const mOld = logText.match(
    /aligner split (\d+) mixed chunk\(s\) into (\d+) part\(s\), (\d+) call\(s\) in ([\d.]+) s, (\d+) fallback\(s\)(?: \(([^)]*)\))?/,
  );
  const mf = logText.match(/aligner fallback for all mixed chunks \(([^)]*)\)/);
  if (m) {
    aligner = {
      calls: Number(m[3]),
      parts: Number(m[2]),
      chunksSplit: Number(m[1]),
      alignMs: Math.round(Number(m[4]) * 1000),
      fallbacks: Number(m[5]),
      cuts: Number(m[6]),
      cutsDropped: Number(m[7]),
      keptWhole: Number(m[8]),
      ...(m[9] ? { fallbackReason: m[9] } : {}),
    };
  } else if (mOld) {
    // Pre-decision log line (no cut stats).
    aligner = {
      calls: Number(mOld[3]),
      parts: Number(mOld[2]),
      chunksSplit: Number(mOld[1]),
      alignMs: Math.round(Number(mOld[4]) * 1000),
      fallbacks: Number(mOld[5]),
      ...(mOld[6] ? { fallbackReason: mOld[6] } : {}),
    };
  } else if (mf) {
    aligner = {
      calls: 0,
      parts: 0,
      chunksSplit: 0,
      alignMs: 0,
      fallbacks: 1,
      fallbackReason: mf[1],
    };
  } else {
    const fb = logText.match(/speaker alignment fallback: (.*)/);
    if (fb) {
      aligner = {
        calls: 0,
        parts: 0,
        chunksSplit: 0,
        alignMs: 0,
        fallbacks: 0,
        fallbackReason: `plan fallback: ${fb[1].trim()}`,
      };
    }
  }
}
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
  edgeWordsLost,
  edgeWordsAdded,
  edgeWordsLostByChunk,
  edgeWordsAddedByChunk,
  // Spec 3.6 review: split-chunk health (null without a --r0d dump).
  splitChunks: splitChunkCount,
  splitLabelDistinct:
    splitChunkCount !== null && splitChunkCount > 0
      ? Math.round((distinctSplitChunks / splitChunkCount) * 1000) / 1000
      : null,
  punctRatio,
  // Spec 3.6 (Decision, owner 2026-10-07): the cut quality. badCutRatio
  // from the stored parts (null without a --r0d dump); the log-side
  // cut stats ride in `aligner` (cuts/cutsDropped/keptWhole).
  badCutRatio,
  aligner,
  termHits,
  textHash,
  mergedHash,
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
    `edgeWordsLost=${metrics.edgeWordsLost} edgeWordsAdded=${metrics.edgeWordsAdded}`,
    `splitChunks=${metrics.splitChunks} splitLabelDistinct=${metrics.splitLabelDistinct} punctRatio=${metrics.punctRatio} badCutRatio=${metrics.badCutRatio}`,
    `aligner=${metrics.aligner ? `${metrics.aligner.calls} calls, ${metrics.aligner.parts} parts, ${metrics.aligner.alignMs} ms, ${metrics.aligner.fallbacks} fallback(s)${metrics.aligner.fallbackReason ? ` (${metrics.aligner.fallbackReason})` : ""}` : "null"}`,
    `termHits=${metrics.termHits}`,
    `dupJoins=${metrics.dupJoins} (k>=2: ${metrics.dupJoinsK2})`,
    `contiguousCuts=${metrics.contiguousCuts}`,
    `chunksUnder3s=${metrics.chunksUnder3s}`,
    `filtered=${metrics.filtered} empty=${metrics.empty} failed=${metrics.failed}`,
    `langMismatch=${metrics.langMismatch}`,
    `diarizerSeconds=${metrics.diarizerSeconds} percentOfAudio=${metrics.diarizerPercentOfAudio}`,
    `textHash=${metrics.textHash.slice(0, 16)}…`,
    `mergedHash=${metrics.mergedHash ? `${metrics.mergedHash.slice(0, 16)}…` : "null"}`,
  ].join(" "),
);
