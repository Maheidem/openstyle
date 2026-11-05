// live-arm.mts: the "live" arm of the Eval Lab (knob pass=live).
//
// It replays the real live loop (apps/server/src/lib/meetings/live/loop.ts)
// on the recorded audio of one meeting in the scratch profile, then saves the
// final lines like Stop does (live/finish.ts saveLiveTranscript). The loop is
// not copied: startLive/stopLive run as they run in the app. Only the clock
// and the way the audio arrives are replaced:
//
// - The recorder writes a growing WAV. This script writes a growing copy of
//   mic.wav and system.wav (header with 0 data bytes, like the recorder) and
//   appends TICK_MS (2000 ms, loop.ts TICK_MS) of audio at the start of each
//   tick. The loop reads that file with its own readPcmFrom/planTail.
//   `isDictationActive` is the hook that runs at the start of every tick.
// - Time is virtual: one tick = 2000 ms of audio, whatever the ASR speed. In
//   the app a tick also waits for its own ASR work, so a slow Mac sees bigger
//   windows. This replay assumes the ASR keeps up.
// - At the end of the audio, stopLive(flush) reads the rest, like Stop.
//
// Everything else is the app code with the app defaults: the ASR call (no
// prompt, no context), Silero VAD, the voiced and speech-share gates, the
// hallucination drop, the language lock (tinyld on the first 10 s of speech)
// and the model choice (resolveModel: meeting model, else the dictation model).
//
// Speed-up that does not change the output: after the language is locked, the
// ASR read of the open tail (the partial text that the user sees) feeds
// nothing that is saved, so it is skipped (LIVE_ARM_SKIP_PARTIAL=0 reads it).
// ASR reads are stateless, so the saved lines are the same; the eval proof is
// in the PR description.
//
// Usage (the lab runs it; cwd apps/electron; env SCRATCH, HF and worker as
// run-baseline.mjs): node --import ts-register.mjs live-arm.mts --meeting <id>
// It prints counts and ids only, never text.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

const WAV_HEADER_BYTES = 44;
const SAMPLE_RATE = 16_000;
const TICK_MS = 2000;
const SKIP_PARTIAL = process.env.LIVE_ARM_SKIP_PARTIAL !== "0";
const RUN = "LIVE";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const meetingId = arg("meeting");
const scratch = process.env.SCRATCH;
if (!meetingId || !scratch) {
  console.error("usage: SCRATCH=<dir> live-arm.mts --meeting <id>");
  process.exit(2);
}
const dbPath = join(scratch, "test.db");
process.env.OPENSTYLE_DB_PATH = dbPath;
const meetingDir = join(scratch, "meetings", meetingId);
const runDir = join(scratch, "baseline", `${RUN}-${meetingId.slice(0, 8)}`);
mkdirSync(runDir, { recursive: true });

// --- 1. Reset the scratch DB like run-baseline.mjs does -----------------
{
  const db = new DatabaseSync(dbPath);
  for (const t of [
    "meeting_segments",
    "meeting_speakers",
    "meeting_summaries",
    "meeting_diarizer_turns",
  ])
    db.prepare(`DELETE FROM ${t} WHERE meeting_id = ?`).run(meetingId);
  db.prepare(
    `UPDATE meetings SET status = 'recorded', language = NULL, error = NULL,
       stt_provider = NULL, stt_model = NULL, transcript_source = NULL
     WHERE id = ?`,
  ).run(meetingId);
  db.close();
}

// --- 2. The app code ---------------------------------------------------------
const loopUrl = new URL(
  "../../../../apps/server/src/lib/meetings/live/loop.ts",
  import.meta.url,
);
const { defaultLiveDeps, startLive, stopLive } = await import(loopUrl.href);
const { planTail, slicePcm } = await import(
  new URL(
    "../../../../apps/server/src/lib/meetings/live/tail.ts",
    import.meta.url,
  ).href
);
const { saveLiveTranscript } = await import(
  new URL(
    "../../../../apps/server/src/lib/meetings/live/finish.ts",
    import.meta.url,
  ).href
);
const { getDb } = await import(
  new URL("../../../../apps/server/src/lib/db.ts", import.meta.url).href
);

// --- 3. The growing WAVs --------------------------------------------------------
type Source = "mic" | "system";
const SOURCES: Source[] = ["mic", "system"];
const liveDir = join(scratch, "live-audio", meetingId);
rmSync(liveDir, { recursive: true, force: true });
mkdirSync(liveDir, { recursive: true });
const src: Record<Source, Buffer> = {
  mic: Buffer.alloc(0),
  system: Buffer.alloc(0),
};
for (const s of SOURCES) {
  const p = join(meetingDir, `${s}.wav`);
  if (!existsSync(p)) {
    console.error(`missing ${s}.wav of ${meetingId.slice(0, 8)}`);
    process.exit(1);
  }
  const all = readFileSync(p);
  if (all.readUInt32LE(24) !== SAMPLE_RATE || all.readUInt16LE(22) !== 1)
    throw new Error(`${s}.wav is not 16 kHz mono`);
  src[s] = all.subarray(WAV_HEADER_BYTES);
  const header = Buffer.from(all.subarray(0, WAV_HEADER_BYTES));
  header.writeUInt32LE(0, 40); // the recorder header says 0 data bytes
  writeFileSync(join(liveDir, `${s}.wav`), header);
}
const bytesAt = (ms: number) => Math.floor((ms * SAMPLE_RATE) / 1000) * 2;
const lengthMs = Math.max(
  ...SOURCES.map((s) => (src[s].length / 2 / SAMPLE_RATE) * 1000),
);

// --- 4. The clock hook and the counters --------------------------------------------
let virtualMs = 0;
let allAppended = false;
let stopReady = false;
let flushing = false;
let languageLocked = false;
let ticks = 0;
const calls = { asr: 0, partialSkipped: 0 };
/** The open tail of the window that the loop reads now, per channel. */
const openTail: Partial<Record<Source, Uint8Array>> = {};
const appendedBytes: Record<Source, number> = { mic: 0, system: 0 };

const deps = {
  ...defaultLiveDeps,
  isEnabled: () => true,
  tickMs: 5,
  // The clock: runs at the start of each tick; adds 2000 ms of audio.
  isDictationActive: () => {
    if (allAppended) {
      stopReady = true;
      return true; // the loop skips this tick; the driver then calls stopLive
    }
    ticks++;
    virtualMs += TICK_MS;
    for (const s of SOURCES) {
      const to = Math.min(src[s].length, bytesAt(virtualMs));
      if (to > appendedBytes[s]) {
        appendFileSync(
          join(liveDir, `${s}.wav`),
          src[s].subarray(appendedBytes[s], to),
        );
        appendedBytes[s] = to;
      }
    }
    if (virtualMs >= lengthMs) allAppended = true;
    return false;
  },
  persistLanguage: (id: string, language: string) => {
    languageLocked = true;
    return defaultLiveDeps.persistLanguage(id, language);
  },
  // Find the open tail of the window (same planTail as the loop) so the
  // partial read can be skipped after the lock.
  detectSpeech: async (pcm: Int16Array, source: Source) => {
    openTail[source] = undefined;
    if (SKIP_PARTIAL && !flushing) {
      const fromMs =
        (appendedBytes[source] / 2 - pcm.length) / (SAMPLE_RATE / 1000);
      const plan = planTail(pcm, fromMs);
      if (plan.open) openTail[source] = slicePcm(pcm, fromMs, plan.open);
    }
    return defaultLiveDeps.detectSpeech(pcm, source);
  },
  transcribe: async (opts: { pcm: Uint8Array }) => {
    if (languageLocked && SKIP_PARTIAL) {
      for (const s of SOURCES) {
        const tail = openTail[s];
        if (
          tail &&
          tail.length === opts.pcm.length &&
          Buffer.compare(tail, opts.pcm) === 0
        ) {
          calls.partialSkipped++;
          return "";
        }
      }
    }
    calls.asr++;
    return defaultLiveDeps.transcribe(opts);
  },
};

// --- 5. Replay -------------------------------------------------------------------------------
const t0 = performance.now();
await startLive(meetingId, liveDir, deps);
const hardStop = Date.now() + 6 * 3600_000;
while (!stopReady && Date.now() < hardStop) {
  await new Promise((r) => setTimeout(r, 200));
  // The loop never started (model unavailable): stop with an error.
  if (ticks === 0 && performance.now() - t0 > 120_000) {
    console.error("the live loop did not start a tick in 120 s");
    process.exit(1);
  }
}
if (!stopReady) {
  console.error("replay timeout");
  process.exit(1);
}
flushing = true;
const stopped = await stopLive(meetingId, { flush: true });
const wall = Math.round((performance.now() - t0) / 10) / 100;

// --- 6. Save like Stop does ------------------------------------------------------------------
const saved = saveLiveTranscript(getDb(), meetingId, stopped.lines, {
  provider: "local-mlx",
  modelId: stopped.modelId ?? "unknown",
});
// The lab copies test.db as a plain file (no WAL): flush the WAL first.
getDb().exec("PRAGMA wal_checkpoint(TRUNCATE)");
const db = new DatabaseSync(dbPath, { readOnly: true });
const lang = (
  db.prepare("SELECT language FROM meetings WHERE id = ?").get(meetingId) as
    | { language: string | null }
    | undefined
)?.language;
db.close();
writeFileSync(
  join(runDir, "run.json"),
  `${JSON.stringify({
    wallSeconds: wall,
    pass: "live",
    model: stopped.modelId,
    ticks,
    audioMs: Math.round(lengthMs),
    asrCalls: calls.asr,
    partialReadsSkipped: calls.partialSkipped,
    skipPartial: SKIP_PARTIAL,
    finalLines: stopped.lines.length,
    savedSegments: saved,
    lockedLanguage: lang ?? null,
  })}\n`,
);
console.log(
  `live ${meetingId.slice(0, 8)}: ${ticks} ticks, ${calls.asr} asr calls (${calls.partialSkipped} partial reads skipped), ${stopped.lines.length} lines, ${saved} segments saved, language ${lang ?? "none"}, ${wall}s`,
);
rmSync(liveDir, { recursive: true, force: true });
const { stopMlxServer } = await import(
  new URL("../../../../apps/server/src/lib/mlx-asr/server.ts", import.meta.url)
    .href
);
await stopMlxServer();
process.exit(saved > 0 ? 0 : 1);
