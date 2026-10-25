import { closeSync, existsSync, openSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { zValidator } from "@hono/zod-validator";
import { isVocabLeak, TERMS_MARKER } from "@openstyle/stt";
import { createAppLogger, errorMessage } from "@openstyle/utils";
import {
  type CalendarEvent,
  calendarEventSchema,
  MEETINGS_DIR_NAME,
  type MeetingDetail,
  MIC_WAV,
  meetingDetailResponseSchema,
  meetingFolderErrorSchema,
  meetingFolderFilterSchema,
  meetingFolderIdSchema,
  meetingListResponseSchema,
  meetingStartResponseSchema,
  type StartRunResponse,
  SYNC_JSON,
  SYSTEM_WAV,
} from "@openstyle/validations";
import { type Context, Hono } from "hono";
import { z } from "zod";
import {
  parseWavHeader,
  readWavInfo,
  sliceWav,
  type WavInfo,
  wavDurationMs,
} from "../lib/audio/wav.js";
import { getDb, withTransaction } from "../lib/db.js";
import {
  isDictationActive,
  type WaitForDictationIdleOptions,
  waitForDictationIdle,
} from "../lib/dictation-activity.js";
import { extractContextTerms } from "../lib/meetings/context-terms.js";
import {
  applyDiarization,
  createDefaultDiarizeDeps,
  type DiarizeDeps,
  type DiarizerSegment,
  getMeetingDiarizationEnabledSetting,
  longTurns,
  numberSpeakers,
  probeDiarizationModels,
  runDiarizationPass,
  runDiarizer,
  type SpeakerWinner,
  speakerWinnerFor,
} from "../lib/meetings/diarize.js";
import { meetingFolderExists } from "../lib/meetings/folders.js";
import {
  claimJob,
  getJob,
  getJobKind,
  hasJob,
  isCancelRequested,
  type MeetingJobKind,
  releaseJob,
  requestCancel,
  setProgress,
} from "../lib/meetings/job-registry.js";
import { resolveMeetingLanguage } from "../lib/meetings/language.js";
import {
  isMixedChunk,
  segmentWavFile,
  splitAlignedChunk,
} from "../lib/meetings/segmenter.js";
import {
  getMeetingRow,
  type MeetingRow,
  meetingDisplayStatus,
  omitCalendarColumns,
  toCalendarEvent,
} from "../lib/meetings/store.js";
import { getMeetingTags } from "../lib/meetings/tags.js";
import {
  repairSystemTrack,
  trackRepairState,
} from "../lib/meetings/track-repair.js";
import {
  type ChunkResult,
  createDefaultTranscriberDeps,
  type MeetingSttModelOverride,
  MeetingTranscriber,
  type TranscriberDeps,
} from "../lib/meetings/transcriber.js";
import {
  loadMergedTranscript,
  type SegmentRow,
  writeTranscriptMarkdown,
} from "../lib/meetings/transcript-io.js";
import {
  attachSpeechSpans,
  detectSpeechSpans,
  type VadDeps,
} from "../lib/meetings/vad.js";
import {
  getMeetingEnhanceAutoRunSetting,
  type RunnerDeps,
  startRun,
} from "../lib/meetings/workflow/runner.js";
import {
  alignerLanguageFor,
  isAlignerModelReady,
  maybeStartAlignerDownload,
} from "../lib/mlx-asr/aligner.js";
import {
  isAppleSiliconMac,
  MLX_ASR_PROVIDER_ID,
} from "../lib/mlx-asr/constants.js";
import {
  alignWithMlxAsr,
  canRunMlxAsr,
  type MlxAlignedWord,
} from "../lib/mlx-asr/server.js";
import { getDefaultModels } from "../lib/providers.js";
import { notifyMeetingChanged } from "../lib/search/notify.js";
import { getProvider } from "../lib/streaming/registry.js";
import { loadVocabularyTerms } from "../lib/vocabulary.js";
import { mergeContextVocabTerms } from "../lib/vocabulary-bias.js";
import { WHISPER_PROVIDER_ID } from "../lib/whisper/constants.js";
import { meetingFolders, meetingMoves } from "./meeting-folders.js";
import { meetingTagEdit, meetingTagList } from "./meeting-tags.js";

/**
 * Internal endpoints backing Meeting Mode. The Electron main process (the
 * recorder) owns the audio files on disk; these routes own the DB rows —
 * start/stop lifecycle, the boot-time orphan sweep, list/detail reads, and
 * the transcription/summary pipeline (segmenter → transcriber → merge →
 * summarize).
 */

const log = createAppLogger("meetings");

/**
 * The meetings root the recorder writes into: `<userData>/meetings/`. The
 * server anchors app-data paths off the DB file's directory (same pattern as
 * lib/config.ts resolveConfigPath). Null when no DB path is configured.
 */
function meetingsRootDir(): string | null {
  const dbPath = process.env.OPENSTYLE_DB_PATH ?? process.env.FREESTYLE_DB_PATH;
  if (!dbPath) return null;
  return resolve(join(dirname(dbPath), MEETINGS_DIR_NAME));
}

/**
 * Test seam: the transcriber's dependency factory and the workflow
 * dependencies are swappable so route tests never touch real STT/LLM
 * providers.
 */
interface MeetingsTestOverrides {
  createTranscriberDeps?: typeof createDefaultTranscriberDeps;
  /** I4b (spec §3.6): the aligner call, injectable so route tests never
   * spawn a worker. Default is the real MLX align path. */
  alignChunk?: (
    wav: Uint8Array,
    text: string,
    language: string,
  ) => Promise<MlxAlignedWord[]>;
  /** The align pass's dictation-idle wait: timing knobs only (idle window,
   * poll, clock, sleep), so route tests do not wait out the real 15 s
   * window. The activity source stays the real `isDictationActive`. */
  alignDictationWait?: Omit<WaitForDictationIdleOptions, "isDictationActive">;
  /** I4b: force/forbid the aligner gate in tests (default: the real check).
   * `isAlignerModelReady` and `isAppleSiliconMac` are the other two gate
   * inputs; both are true on this Mac, so a test that wants the fallback
   * passes `alignerReady: false` (or vice versa). The align tests pass the
   * two platform inputs explicitly so they run on Linux CI too. */
  alignerReady?: boolean;
  /** I4b: the gate's `isAppleSiliconMac()` input (default: the real check;
   * the align tests pass true so they are platform-neutral). */
  appleSilicon?: boolean;
  /** I4b: the gate's `canRunMlxAsr()` input (default: the real check). */
  canRunMlx?: boolean;
  /** I4b: the automatic-download trigger (default: the real one). */
  startAlignerDownload?: () => boolean;
  /** Injected into both the pre-flight probe and the real diarization pass
   * on POST /:id/diarize AND the diarization pass inside the transcribe
   * job (after all chunks, before the status flip), mirroring how
   * `meeting-diarize-pipeline.test.ts` drives `runDiarizationPass`
   * directly — a single fake deps object exercises the pre-flight check,
   * the real run, and the follow-up count query together. */
  diarizeDeps?: DiarizeDeps;
  /** The VAD gate helper deps inside runTranscribeJob (default: the real
   * fluidaudio-diarize binary and bundled silero-vad model). */
  vadDeps?: VadDeps;
  /** Merged into the production workflow dependencies by the runner. It
   * serves POST /:id/enhance, POST /:id/summarize and the auto-run call site
   * inside runTranscribeJob, so route tests never touch a real LLM provider. */
  workflowDeps?: RunnerDeps;
}
let testOverrides: MeetingsTestOverrides = {};
export function __setMeetingsTestOverrides(
  overrides: MeetingsTestOverrides = {},
): void {
  testOverrides = overrides;
}
/** The workflow dependencies of the test seam, for the sibling run router. */
export function getWorkflowTestDeps(): RunnerDeps | undefined {
  return testOverrides.workflowDeps;
}

// ---------------------------------------------------------------------------
// Audio + sync helpers
// ---------------------------------------------------------------------------

/**
 * Issue #170: what the meeting page shows for the two tracks, from
 * `sync.json`. A repair (done, or to do at the next transcription) gives the
 * info note. A bad ratio without a repair gives the warning. A recording
 * that runs, a missing file or a broken file gives neither. The recorder
 * writes the final counts at stop.
 */
function loadTrackState(row: {
  status: string;
  audio_dir: string | null;
}): Pick<MeetingDetail, "track_ratio_warning" | "track_repair"> {
  const none = { track_ratio_warning: null, track_repair: null };
  if (!row.audio_dir || row.status === "recording") return none;
  let journal: unknown;
  try {
    journal = JSON.parse(readFileSync(join(row.audio_dir, SYNC_JSON), "utf8"));
  } catch {
    return none;
  }
  if (journal === null || typeof journal !== "object") return none;
  const state = trackRepairState(journal as Record<string, unknown>);
  return {
    track_ratio_warning: state.ratioWarning,
    track_repair: state.repair,
  };
}

/**
 * Phase A1 persist-time leak check (specs/meeting-transcription-quality.md
 * §3.1): a chunk whose text is overwhelmingly drawn from the vocabulary list
 * is stored as `status='filtered'`, `text=NULL` instead of the model's fake
 * echo. Shared by both write paths (the main job's persistChunk and
 * retry-failed's inline UPDATE) so the check can't drift between them.
 */
function leakCheckedTextAndStatus(
  chunk: Pick<ChunkResult, "status" | "text" | "context">,
  vocabTerms: string[],
): { text: string | null; status: string } {
  if (chunk.status !== "ok" || !chunk.text) {
    return { text: chunk.text, status: chunk.status };
  }
  // Phase A1: the classic terms-only leak (label-less echo of the term
  // list). Real speech is almost never drawn this strongly from a
  // proper-noun vocabulary.
  if (isVocabLeak(chunk.text, vocabTerms)) {
    return { text: null, status: "filtered" };
  }
  // Phase 3b (specs/meeting-transcription-v2.md §3.1): the FULL-prompt
  // echo — "Technical terms: A, B, C <context words>" — dilutes below
  // the terms-only threshold (its context words are not terms) and is
  // what the transcriber's echo guard retries away. What a stubborn
  // model still stores must be caught here. It carries the prompt's
  // label (boilerplate, never speech) AND is overwhelmingly drawn from
  // the prompt that was really sent (terms+context). Both together: a
  // real sentence that happens to say "terms:" or that rhymes with the
  // previous chunk's words is kept.
  if (
    TERMS_MARKER.test(chunk.text) &&
    isVocabLeak(
      chunk.text,
      chunk.context ? [...vocabTerms, chunk.context] : vocabTerms,
    )
  ) {
    return { text: null, status: "filtered" };
  }
  return { text: chunk.text, status: chunk.status };
}

/**
 * The 409 text for a meeting whose slot is already held. Names the REAL
 * job kind (from the job registry), so the UI never reads a running
 * Enhance pass as a transcription. `hasJob` implies a kind exists, so the
 * fallback only guards a state the registry invariants make impossible.
 */
function runningJobMessage(kind: MeetingJobKind | null): string {
  switch (kind) {
    case "enhance":
      return "Enhance is already running";
    case "summarize":
      return "Summarize is already running";
    case "diarize":
      return "Speaker identification is already running";
    case "retry-failed":
      return "Retrying failed chunks is already running";
    case "transcribe":
    default:
      return "Transcription is already running";
  }
}

function persistChunk(
  meetingId: string,
  chunk: ChunkResult,
  vocabTerms: string[],
): void {
  const { text, status } = leakCheckedTextAndStatus(chunk, vocabTerms);
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO meeting_segments
         (id, meeting_id, source, idx, start_ms, end_ms, text, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `${meetingId}:${chunk.source}:${chunk.idx}`,
      meetingId,
      chunk.source,
      chunk.idx,
      chunk.startMs,
      chunk.endMs,
      text,
      status,
    );
}

async function buildTranscriberDeps(
  extras: Pick<
    TranscriberDeps,
    "isDictationActive" | "onChunk" | "onProgress" | "shouldStop"
  >,
  modelOverride?: MeetingSttModelOverride,
  contextTerms: string[] = [],
): Promise<TranscriberDeps> {
  const factory =
    testOverrides.createTranscriberDeps ?? createDefaultTranscriberDeps;
  return factory(extras, modelOverride, contextTerms);
}

/** The background transcription job for one meeting. Never throws. */
/**
 * I4b (specs/meeting-transcription-v2.md §3.6): the per-meeting decision
 * for the system track. `align`: segment WITHOUT speaker cuts (the ASR
 * hears whole chunks) and split mixed chunks with the aligner after
 * transcription. `cut`: the phase 4 behavior (cut at speaker changes).
 * `plain`: no diarization turns at all (the pre-phase 4 path).
 */
type AlignPlan =
  | { mode: "align"; languageName: string }
  | { mode: "cut"; reason: string }
  | { mode: "plain" };

/**
 * The §3.6 gate, in fallback order (each reason is the logged one, 3.6
 * step 4). The aligner is MODEL-AGNOSTIC — it aligns whatever text the
 * meeting's provider produced — so the gate never looks at the provider.
 * The language must be DECLARED and one of the aligner's 11 languages.
 */
function decideAlignPlan(input: {
  hasTurns: boolean;
  /** The meeting's resolved language code (undefined = not declared). */
  language: string | undefined;
  appleSilicon: boolean;
  canRun: boolean;
  alignerReady: boolean;
}): AlignPlan {
  if (!input.hasTurns) return { mode: "plain" };
  if (!input.appleSilicon) {
    return {
      mode: "cut",
      reason: "the word-timing aligner needs Apple silicon",
    };
  }
  if (!input.canRun) {
    return {
      mode: "cut",
      reason: "the MLX runtime is not available",
    };
  }
  if (!input.alignerReady) {
    return {
      mode: "cut",
      reason: "the word-timing aligner is not downloaded yet",
    };
  }
  if (input.language === undefined) {
    return {
      mode: "cut",
      reason: "the meeting language is not declared",
    };
  }
  const name = alignerLanguageFor(input.language);
  if (!name) {
    return {
      mode: "cut",
      reason: `the aligner does not support the meeting language (${input.language})`,
    };
  }
  return { mode: "align", languageName: name };
}

/**
 * I4b (spec §3.6 step 3): split the mixed system chunks of one finished
 * run with the aligner, persist the parts, and label every system row.
 * Never throws — any failure leaves the chunks as transcribed (single
 * rows) with the phase 4 winner labels. One info line per meeting: the
 * fallback reason (first one that occurs) or the align summary.
 */
async function runAlignPass(
  id: string,
  audioDir: string,
  systemResults: ChunkResult[],
  turns: DiarizerSegment[],
  plan: Extract<AlignPlan, { mode: "align" }>,
): Promise<void> {
  const db = getDb();
  const alignChunk =
    testOverrides.alignChunk ??
    ((wav: Uint8Array, text: string, language: string) =>
      alignWithMlxAsr({ audio: wav, text, language }));

  const stats = {
    calls: 0,
    alignMs: 0,
    fallbacks: 0,
    fallbackReason: "",
    cuts: 0,
    cutsDropped: 0,
    // 2.14.1: kept cuts whose two parts carried the same speaker label
    // and were merged back into one part.
    sameSpeakerMerges: 0,
    // Mixed chunks the split policy kept WHOLE (no sentence end to cut
    // on, or the aligner's words all map to one speaker). A policy
    // outcome, not a failure: the chunk keeps its winner-overlap label.
    keptWhole: 0,
    keptWholeReason: "",
  };
  const noteFallback = (reason: string): void => {
    stats.fallbacks += 1;
    if (!stats.fallbackReason) stats.fallbackReason = reason;
  };
  const noteKeptWhole = (reason: string): void => {
    stats.keptWhole += 1;
    if (!stats.keptWholeReason) stats.keptWholeReason = reason;
  };

  const alignedByIdx = new Map<
    number,
    Array<{ startMs: number; endMs: number; text: string; speakerId: string }>
  >();
  // Issue #259: the mixed-chunk test and the split use only the long
  // turns (as before the helper kept short turns). The labels below use
  // all turns (`speakerWinnerFor`).
  const splitTurns = longTurns(turns);

  try {
    const fd = openSync(join(audioDir, SYSTEM_WAV), "r");
    try {
      const info = parseWavHeader(fd) as WavInfo;
      for (const r of systemResults) {
        if (r.status !== "ok" || !r.text.trim()) continue;
        if (!isMixedChunk(r.startMs, r.endMs, splitTurns)) continue;
        // An align call loads the aligner into the single MLX worker. That
        // evicts a local MLX dictation model, so yield to live dictation
        // before EACH call, like the transcriber does before a reload.
        // A cancel ends the wait and the pass: the chunks not yet aligned
        // keep their transcribed rows and phase 4 labels (the fallback).
        const aborted = await waitForDictationIdle({
          isDictationActive,
          shouldAbort: () => isCancelRequested(id),
          ...testOverrides.alignDictationWait,
        });
        if (aborted || isCancelRequested(id)) break;
        const t0 = Date.now();
        let words: MlxAlignedWord[];
        try {
          const wav = sliceWav(fd, info, r.startMs, r.endMs);
          words = await alignChunk(wav, r.text, plan.languageName);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          noteFallback(`align call failed (${reason})`);
          continue;
        }
        stats.calls += 1;
        stats.alignMs += Date.now() - t0;
        const res = splitAlignedChunk(
          { startMs: r.startMs, endMs: r.endMs },
          words.map((w) => ({
            text: w.text,
            startMs: w.start * 1000,
            endMs: w.end * 1000,
          })),
          splitTurns,
          // The original ASR text: the parts keep its punctuation and
          // case (1:1 token mapping, spec 3.6 review fix).
          r.text,
        );
        stats.cutsDropped += res.cutsDropped;
        stats.sameSpeakerMerges += res.sameSpeakerMerges;
        if (res.parts.length >= 2) {
          alignedByIdx.set(r.idx, res.parts);
          stats.cuts += res.parts.length - 1;
        } else {
          // Decision (owner, 2026-10-07, spec 3.6): every candidate cut
          // needs a sentence end within one word; without one the chunk
          // stays whole and keeps its winner-overlap label. 2.14.1:
          // a kept cut whose parts carry the same speaker label merges
          // back to one part (the split did no visible work).
          noteKeptWhole(
            res.cutsDropped > 0
              ? "no sentence end to cut on"
              : res.sameSpeakerMerges > 0
                ? "the cut parts had the same speaker"
                : "the aligner's words all map to one speaker",
          );
        }
      }
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    noteFallback(
      `align setup failed (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  // Combined label numbering (spec §7 step 5, extended for §3.6): walk the
  // system chunks in order; an aligned chunk contributes its PARTS' speakers
  // in time order, every other chunk contributes its overlap winner. First-
  // appearance order becomes "1", "2", ... — the parts and the unsplit
  // chunks number against the SAME map, so "2" means the same person both
  // ways. Then, in one transaction: replace each aligned chunk's row with
  // its parts (labels included) and label the rest.
  const rows = db
    .prepare(
      `SELECT id, idx, start_ms, end_ms FROM meeting_segments
       WHERE meeting_id = ? AND source = 'system' ORDER BY idx, start_ms, id`,
    )
    .all(id) as unknown as Array<{
    id: string;
    idx: number;
    start_ms: number;
    end_ms: number;
  }>;
  // Issue #259: a winner from a short turn numbers after every winner
  // from a long turn (`numberSpeakers`), so the old numbers stay.
  const rowWinner = new Map(
    rows.map((r) => [
      r.id,
      speakerWinnerFor({ startMs: r.start_ms, endMs: r.end_ms }, turns),
    ]),
  );
  const walk: (SpeakerWinner | null)[] = [];
  for (const r of rows) {
    const parts = alignedByIdx.get(r.idx);
    if (parts) {
      for (const p of parts)
        walk.push({ speakerId: p.speakerId, fromShortTurn: false });
    } else {
      walk.push(rowWinner.get(r.id) ?? null);
    }
  }
  const indexBySpeaker = numberSpeakers(walk);
  const labelOf = (speakerId: string): string =>
    String(indexBySpeaker.get(speakerId));
  const partLabels = new Map<string, string>();
  for (const r of rows) {
    for (const p of alignedByIdx.get(r.idx) ?? [])
      partLabels.set(`${r.idx}:${p.startMs}`, labelOf(p.speakerId));
  }

  try {
    const del = db.prepare("DELETE FROM meeting_segments WHERE id = ?");
    const insPart = db.prepare(
      `INSERT OR REPLACE INTO meeting_segments
         (id, meeting_id, source, idx, start_ms, end_ms, text, status, speaker_label)
       VALUES (?, ?, 'system', ?, ?, ?, ?, 'ok', ?)`,
    );
    const updLabel = db.prepare(
      "UPDATE meeting_segments SET speaker_label = ? WHERE id = ?",
    );
    withTransaction(db, () => {
      for (const r of rows) {
        const parts = alignedByIdx.get(r.idx);
        if (!parts) continue;
        del.run(r.id);
        parts.forEach((p, k) => {
          insPart.run(
            `${id}:system:${r.idx}:${k}`,
            id,
            r.idx,
            p.startMs,
            p.endMs,
            p.text,
            partLabels.get(`${r.idx}:${p.startMs}`) ?? null,
          );
        });
      }
      for (const r of rows) {
        if (alignedByIdx.has(r.idx)) continue;
        const winner = rowWinner.get(r.id);
        updLabel.run(winner ? labelOf(winner.speakerId) : null, r.id);
      }
    });
  } catch (err) {
    log.warn(`meeting ${id}: failed to persist aligned parts: ${String(err)}`);
    return;
  }

  const totalParts = [...alignedByIdx.values()].reduce(
    (a, p) => a + p.length,
    0,
  );
  // The metrics parse this line (spec 3.6): the sentence-end cut stats
  // (Decision, owner 2026-10-07) ride along as cut(s)/dropped(s)/
  // kept whole; the 2.14.1 same-speaker merge count rides along after
  // "kept whole" (the metrics' regex reads up to the reason, unanchored).
  const detail = `${stats.cuts} cut(s), ${stats.cutsDropped} dropped(s), ${stats.keptWhole} kept whole, ${stats.sameSpeakerMerges} same-speaker merge(s)`;
  const firstReason = stats.fallbackReason || stats.keptWholeReason;
  const logLine =
    stats.calls > 0 || stats.fallbacks > 0 || stats.keptWhole > 0
      ? `meeting ${id}: aligner split ${alignedByIdx.size} mixed chunk(s) into ${totalParts} part(s), ${stats.calls} call(s) in ${(stats.alignMs / 1000).toFixed(1)} s, ${stats.fallbacks} fallback(s), ${detail}${firstReason ? ` (${firstReason})` : ""}`
      : `meeting ${id}: aligner had no mixed chunk to split`;
  log.info(logLine);
  // Same "diarization labeled" shape as applyDiarization (the metrics read
  // the line): aligned chunks count as their parts, unsplit ones as rows.
  const labeledNow = rows.reduce(
    (a, r) =>
      a +
      (alignedByIdx.has(r.idx)
        ? alignedByIdx.get(r.idx)!.length
        : rowWinner.get(r.id)
          ? 1
          : 0),
    0,
  );
  log.info(
    `meeting ${id}: diarization labeled ${labeledNow}/${
      rows.length - alignedByIdx.size + totalParts
    } system segments`,
  );
}

/**
 * I4b: persist the diarizer turns (the §3.4 measurement reads the table)
 * for an align-plan run — the align pass labels the rows itself, so
 * applyDiarization (which would re-label everything) must not run.
 */
function storeDiarizerTurns(id: string, turns: DiarizerSegment[]): void {
  const db = getDb();
  const clearTurns = db.prepare(
    "DELETE FROM meeting_diarizer_turns WHERE meeting_id = ?",
  );
  const insertTurn = db.prepare(
    `INSERT INTO meeting_diarizer_turns
       (meeting_id, idx, speaker_id, start_ms, end_ms)
     VALUES (?, ?, ?, ?, ?)`,
  );
  try {
    withTransaction(db, () => {
      clearTurns.run(id);
      for (let i = 0; i < turns.length; i += 1) {
        const t = turns[i];
        insertTurn.run(
          id,
          i,
          t.speakerId,
          Math.round(t.startTimeSeconds * 1000),
          Math.round(t.endTimeSeconds * 1000),
        );
      }
    });
  } catch (err) {
    log.warn(`meeting ${id}: failed to persist diarizer turns: ${String(err)}`);
  }
}

/**
 * VAD gate: the speech spans of one track, or null on any failure.
 * `detectSpeechSpans` never throws; a bad WAV header only sets the
 * timeout to its floor.
 */
async function speechSpansFor(wavPath: string) {
  let durationMs = 0;
  try {
    durationMs = wavDurationMs(readWavInfo(wavPath));
  } catch {
    // detectSpeechSpans logs the real failure.
  }
  return detectSpeechSpans(wavPath, durationMs, testOverrides.vadDeps);
}

async function runTranscribeJob(id: string, audioDir: string): Promise<void> {
  const db = getDb();
  // Set when the auto-run handoff below hands the slot to a workflow run
  // (specs/meeting-enhance-agentic.md 3.4.2): the outer finally must then
  // leave that run's slot alone. The runner owns it.
  let handedOff = false;
  try {
    // I4b (spec §3.6 step 1): the FIRST meeting job starts the automatic
    // aligner download in the background (Apple silicon + MLX +
    // diarization on + a meeting exists; once per process). Fire-and-
    // forget — this job uses the aligner only if it is ready NOW.
    (testOverrides.startAlignerDownload ?? maybeStartAlignerDownload)();
    // Loaded once per job, not per chunk — vocabulary rarely changes
    // mid-meeting and loadVocabularyTerms() hits the DB.
    const vocabTerms = loadVocabularyTerms();
    // PR #39: terms extracted from the meeting's free-text context
    // (the calendar invitee list). They are prepended to this meeting's
    // vocabulary bias (winning the provider caps, 900 chars in
    // particular) and widen this meeting's persist-time leak check, so
    // a prompt echo of the invitee names is still caught. Dictation and
    // meetings without a context are untouched. Stored nowhere.
    const contextTerms = extractContextTerms(getMeetingRow(id)?.context ?? "");
    const meetingVocabTerms =
      contextTerms.length > 0
        ? mergeContextVocabTerms(contextTerms, vocabTerms)
        : vocabTerms;
    const deps = await buildTranscriberDeps(
      {
        isDictationActive,
        onChunk: (chunk) => persistChunk(id, chunk, meetingVocabTerms),
        onProgress: (p) => setProgress(id, p),
        shouldStop: () => isCancelRequested(id),
      },
      undefined,
      contextTerms,
    );
    // I4 (specs/meeting-transcription-v2.md §3.4): resolve the config
    // FIRST — a missing model or key fails before the diarizer runs.
    // Stamps provider/model on the row and fails fast before any STT call.
    const config = deps.resolveConfig();
    db.prepare(
      "UPDATE meetings SET stt_provider = ?, stt_model = ? WHERE id = ?",
    ).run(config.providerId, config.modelId, id);

    // Issue #170: repair a system track with a known sample-rate mismatch
    // before the diarizer and the segmenter read system.wav. A failure keeps
    // the track as it was, and the meeting page shows the warning.
    try {
      const repair = repairSystemTrack(audioDir);
      if (repair) {
        log.info(
          `meeting ${id}: repaired the system track (recorded at ${repair.toRate} Hz, read as ${repair.fromRate} Hz; original kept as system.original.wav)`,
        );
      }
    } catch (err) {
      log.warn(
        `meeting ${id}: system track repair failed: ${errorMessage(err)}`,
      );
    }

    // I4: diarize BEFORE transcription, so the system track can be cut at
    // speaker changes. Active only when the setting is on (default-on per
    // Decision 6, owner 2026-10-06) AND system.wav exists — a mic-only
    // meeting has nothing to diarize and skips the phase silently (no
    // "diarizing" phase, no log line). runDiarizer returns null on any
    // expected failure (missing binary/models) and the job keeps the old
    // behavior: no speaker cuts, no labels, never a failed job.
    let diarSegments: DiarizerSegment[] | null = null;
    if (
      getMeetingDiarizationEnabledSetting() &&
      existsSync(join(audioDir, SYSTEM_WAV))
    ) {
      setProgress(id, { done: 0, total: 0, failed: 0, phase: "diarizing" });
      const durationRow = db
        .prepare("SELECT duration_ms FROM meetings WHERE id = ?")
        .get(id) as { duration_ms: number | null } | undefined;
      // Brackets the binary's wall time for the measurement: the
      // "diarization labeled" line comes AFTER transcription in the new
      // order, so the previous-log-line heuristic can't span the binary.
      log.info(
        `meeting ${id}: diarization started (${durationRow?.duration_ms ?? 0} ms audio)`,
      );
      // §3.3 rule for the pre-chunk diarizer wait: yield to live
      // dictation only when the meeting's STT provider shares a local
      // resource with it (local-whisper, or a local-mlx model that differs
      // from the dictation model). Cloud meetings never waited before
      // phase 4 and must not start now.
      const yieldsToDictation =
        config.providerId === WHISPER_PROVIDER_ID ||
        (config.providerId === MLX_ASR_PROVIDER_ID &&
          config.differsFromDictation === true);
      diarSegments = await runDiarizer(
        audioDir,
        durationRow?.duration_ms ?? 0,
        testOverrides.diarizeDeps ?? createDefaultDiarizeDeps(),
        yieldsToDictation,
      ).catch((err) => {
        log.warn(
          `meeting ${id}: diarization failed, falling back to no speaker cuts: ${String(err)}`,
        );
        return null;
      });
      // Closes the wall-time bracket for the measurement (the "labeled"
      // line comes after transcription and would include the whole STT
      // run). The turn count is not private (speaker ids and times only).
      log.info(
        `meeting ${id}: diarization finished (${diarSegments?.length ?? 0} turns)`,
      );
      // Cancel right after the diarizer (spec §3.4): the expensive
      // on-device step is done — don't spend minutes of STT on a meeting
      // the user already cancelled. Same cancel exit as after
      // transcription: the row lands in 'failed'/"Cancelled by user", no
      // labels, no status flip, no auto Enhance.
      if (isCancelRequested(id)) {
        db.prepare(
          "UPDATE meetings SET status = ?, error = ? WHERE id = ?",
        ).run("failed", "Cancelled by user", id);
        writeTranscriptMarkdown(id, audioDir);
        log.info(
          `meeting ${id}: transcription cancelled by user after the diarization pass`,
        );
        return;
      }
    } else {
      log.info(`meeting ${id}: diarization skipped (setting is off)`);
    }

    // I4b (spec §3.6): the system track is segmented WITHOUT speaker cuts
    // when the aligner will split the mixed chunks; the language is
    // resolved first (it is one gate input) and the plan decided. When the
    // gate falls back (aligner not ready, language missing, ...), the
    // system track is re-segmented WITH the phase 4 cuts — the second
    // read is cheap compared to the STT run. The probe for the language
    // uses the uncut segments (a superset of the cut ones' early span —
    // the same early speech, never cut shorter).
    const micFound = segmentWavFile(join(audioDir, MIC_WAV));
    const systemUncut = segmentWavFile(join(audioDir, SYSTEM_WAV));
    if (!micFound && !systemUncut) {
      throw new Error(`No audio files found in ${audioDir}`);
    }
    let micSegments = micFound ?? [];
    let systemSegments = systemUncut ?? [];

    // VAD gate: Silero VAD speech spans per track, once per job. Runs also
    // when diarization is off. Null (helper or model missing, any failure)
    // keeps the old path. The spans are attached to the segments below,
    // after the final system segmentation.
    const micSpans =
      micSegments.length > 0
        ? await speechSpansFor(join(audioDir, MIC_WAV))
        : null;
    const systemSpans =
      systemSegments.length > 0
        ? await speechSpansFor(join(audioDir, SYSTEM_WAV))
        : null;

    // Phase A2 (specs/meeting-transcription-quality.md §3.2): resolve the
    // meeting-level language once (sticky across re-transcribe via
    // meetings.language) and wrap resolveConfig with the answer rather than
    // widening resolveConfig's signature — the object passed to
    // MeetingTranscriber below is what MeetingTranscriber.run() calls
    // this.deps.resolveConfig() on, so replacing the property here is what
    // makes the wrap take effect.
    const provider = deps.getProvider(config.providerId);
    const resolvedLanguage = provider
      ? await resolveMeetingLanguage({
          meetingId: id,
          audioDir,
          provider,
          config,
          micSegments,
          systemSegments,
          isDictationActive,
        }).catch((err) => {
          log.warn(
            `meeting ${id}: language resolution failed, using unpinned default: ${String(err)}`,
          );
          return config.language;
        })
      : config.language;

    // §3.6 gate: align (uncut segments + aligner split) vs cut (phase 4)
    // vs plain (no turns). The fallback reason is logged once, at info.
    // The gate and the cuts use only the long turns (issue #259).
    const cutTurns = diarSegments ? longTurns(diarSegments) : [];
    const plan = decideAlignPlan({
      hasTurns: cutTurns.length > 0,
      language: resolvedLanguage,
      appleSilicon: testOverrides.appleSilicon ?? isAppleSiliconMac(),
      canRun: testOverrides.canRunMlx ?? canRunMlxAsr(),
      alignerReady: testOverrides.alignerReady ?? isAlignerModelReady(),
    });
    if (plan.mode === "cut") {
      log.info(`meeting ${id}: speaker alignment fallback: ${plan.reason}`);
      systemSegments =
        segmentWavFile(join(audioDir, SYSTEM_WAV), cutTurns) ?? systemSegments;
    }

    micSegments = attachSpeechSpans(micSegments, micSpans);
    systemSegments = attachSpeechSpans(systemSegments, systemSpans);

    const total = micSegments.length + systemSegments.length;
    setProgress(id, { done: 0, total, failed: 0, phase: "transcribing" });
    const effectiveDeps: TranscriberDeps = {
      ...deps,
      resolveConfig: () => ({ ...config, language: resolvedLanguage }),
    };

    const results = await new MeetingTranscriber(effectiveDeps).run({
      meetingDir: audioDir,
      micSegments,
      systemSegments,
    });

    // Cancellation (T1-1, POST /:id/cancel-transcribe): the transcriber
    // stopped launching new chunks; whatever was in flight has finished and
    // persisted. Keep every written segment — the partial transcript
    // survives — land the row in 'failed' with the canonical cancel error
    // (so Retry failed / Re-transcribe are immediately available), and skip
    // the diarize/enhance passes and the 'transcribed' flip. `results` is
    // holey here (absent slots = chunks that never ran); filter skips the
    // holes, so the log reports completed chunks only. Rare benign race:
    // a cancel landing after the last chunk finished still takes this
    // branch — every chunk persisted, status reads 'failed'/"Cancelled by
    // user", which matches what the user asked for. (A cancel that LANDS
    // later — during the diarization pass below, after this check already
    // passed — is handled at the auto-run handoff: the pass is skipped
    // and the finished transcript stands.)
    if (isCancelRequested(id)) {
      const completed = results.filter((r) => r !== undefined).length;
      db.prepare("UPDATE meetings SET status = ?, error = ? WHERE id = ?").run(
        "failed",
        "Cancelled by user",
        id,
      );
      writeTranscriptMarkdown(id, audioDir);
      log.info(
        `meeting ${id}: transcription cancelled by user after ${completed} of ${results.length} chunks`,
      );
      return;
    }

    // I4/I4b: label the system segments with the turns the diarizer
    // ALREADY produced before segmentation — the binary ran once, never a
    // second time. Still before the status flip and
    // writeTranscriptMarkdown, so the markdown export renders final
    // labels. applyDiarization degrades in-function on a failed write
    // (NULL labels, "Them"); it never fails the job.
    // §3.6: the align plan labels inside runAlignPass (word-midpoint
    // labels, numbered against the same map as the unsplit chunks), so
    // applyDiarization must NOT re-label — it would overwrite the
    // midpoint labels with overlap winners. The turns are stored by the
    // align pass's storeDiarizerTurns (same table, same contract).
    if (plan.mode === "align" && diarSegments !== null) {
      const systemResults = results.filter(
        (r): r is ChunkResult => r !== undefined && r.source === "system",
      );
      await runAlignPass(id, audioDir, systemResults, diarSegments, plan);
      storeDiarizerTurns(id, cutTurns);
    } else if (diarSegments !== null) {
      applyDiarization(id, diarSegments);
    }

    const failed = results.filter((r) => r.status === "failed").length;
    db.prepare("UPDATE meetings SET status = ?, error = ? WHERE id = ?").run(
      "transcribed",
      failed > 0 ? `${failed} of ${results.length} chunks failed` : null,
      id,
    );
    writeTranscriptMarkdown(id, audioDir);
    log.info(
      `meeting ${id}: transcribed ${results.length} chunks (${failed} failed)`,
    );

    // Auto-run: one workflow run (Enhance, chained into Summarize) starts
    // AFTER the status flip, so a long run no longer hides a finished
    // transcript, and the user can cancel it (specs/meeting-enhance-agentic.md
    // 3.4.2, 3.6). Release the transcribe slot and start the run in the same
    // tick with no await in between, so no request can observe the slot free
    // or race the claim. `startRun` claims the slot before its first await.
    //
    // A cancel that landed during the diarization pass above already passed
    // the check at the top of this block: without this re-read it would be
    // LOST, because the release below clears the cancel flag. Skip the
    // auto-run when the flag is set: the transcription is finished (every
    // chunk persisted), so the transcript stands.
    const cancelled = isCancelRequested(id);
    if (cancelled) {
      log.info(
        `meeting ${id}: cancel requested after transcription finished, skipping auto Enhance`,
      );
    }
    // No default LLM: skip the auto-run, as dictation skips cleanup (#229).
    const autoRun = getMeetingEnhanceAutoRunSetting() && !cancelled;
    if (autoRun && !getDefaultModels().llm) {
      log.info(`meeting ${id}: no default LLM, skipping auto Enhance`);
    } else if (autoRun) {
      releaseJob(id);
      const started = startRun(
        { meetingId: id, stages: ["enhance", "summarize"], trigger: "auto" },
        testOverrides.workflowDeps,
      );
      if (started.ok) handedOff = true;
      else
        log.warn(
          `meeting ${id}: auto Enhance did not start (${started.reason})`,
        );
    }
  } catch (err) {
    const message = errorMessage(err);
    log.error(`meeting ${id}: transcription failed: ${message}`);
    try {
      db.prepare("UPDATE meetings SET status = ?, error = ? WHERE id = ?").run(
        "failed",
        message,
        id,
      );
    } catch {
      // DB unavailable — nothing left to record the failure on.
    }
  } finally {
    // Skipped when the slot was handed to the auto-run workflow run, which
    // releases it when it ends (3.4.6).
    if (!handedOff) releaseJob(id);
  }
}

export type { MeetingRow };

const startSchema = z.object({
  id: z.string().min(1).max(128),
  title: z.string().max(512).optional(),
  audio_dir: z.string().max(4096),
  started_at: z.number().int(),
  folder_id: meetingFolderIdSchema.nullable().optional(),
  // The event the app matched at start (specs/calendar-eventkit.md).
  calendar: calendarEventSchema.optional(),
});

/** SQL values for the six calendar columns. */
function calendarColumnValues(
  event: CalendarEvent | null,
): (string | number | null)[] {
  return [
    event?.id ?? null,
    event?.title ?? null,
    event?.start ?? null,
    event?.end ?? null,
    event?.url ?? null,
    event ? JSON.stringify(event.attendees) : null,
  ];
}

const renameSchema = z
  .object({
    title: z.string().trim().min(1).max(512).optional(),
    // Phase A2 (specs/meeting-transcription-quality.md §3.2.5): the
    // language chip's edit. `null` explicitly clears a resolved/user-set
    // language back to "not yet resolved" (falls back to per-chunk auto, or
    // triggers resolution on the next transcribe run).
    language: z.string().trim().min(2).max(8).nullable().optional(),
    // specs/meeting-speaker-naming.md §3.4/§6.4 (2026-08-27 sign-off point
    // 1): free-text context, feeds the naming prompt (§5.2) and the
    // summarize prompt (§9.3). Unlike title, empty string is meaningful
    // (explicitly clear the field) — trimmed but not `min(1)`-constrained.
    context: z.string().trim().max(2000).nullable().optional(),
    // true = the audio retention sweep never deletes this meeting's audio
    // (eval gold meetings). No UI sets it yet.
    retentionExempt: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.language !== undefined ||
      v.context !== undefined ||
      v.retentionExempt !== undefined,
    { message: "Provide title, language, context, or retentionExempt" },
  );

// specs/meeting-speaker-naming.md §6.2: same partial-update idiom as
// renameSchema — only the fields present in the body change. `null` on
// either field is meaningful (un-name / unmerge), so both stay
// `nullable().optional()` rather than `.optional()` alone.
const speakerPatchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80).nullable().optional(),
    mergedInto: z.string().trim().min(1).max(16).nullable().optional(),
  })
  .refine((v) => v.displayName !== undefined || v.mergedInto !== undefined, {
    message: "Provide displayName or mergedInto",
  });

const stopSchema = z.object({
  ended_at: z.number().int(),
  duration_ms: z.number().int().min(0),
  // 'recorded' for a clean stop, 'failed' when the recorder aborted.
  status: z.enum(["recorded", "failed"]).default("recorded"),
  error: z.string().max(4096).optional(),
});

/**
 * Start a workflow run for a button click and answer 202 with the run id
 * (specs/meeting-enhance-agentic.md 3.4.2). The route made its guards before.
 * `startRun` claims the job slot before its first await.
 */
function startRunResponse(
  c: Context,
  id: string,
  stages: ("enhance" | "summarize")[],
) {
  const started = startRun(
    { meetingId: id, stages, trigger: "button" },
    testOverrides.workflowDeps,
  );
  if (!started.ok) {
    if (started.reason === "job_running") {
      return c.json({ error: runningJobMessage(getJobKind(id)) }, 409);
    }
    if (started.reason === "no_meeting") {
      return c.json({ error: "Not found" }, 404);
    }
    return c.json({ error: "The run could not be started" }, 500);
  }
  return c.json(
    { ok: true, id, runId: started.runId } satisfies StartRunResponse,
    202,
  );
}

const meetings = new Hono()
  .route("/folders", meetingFolders)
  .route("/tags", meetingTagList)
  .route("/", meetingMoves)
  .route("/", meetingTagEdit)
  .get("/", zValidator("query", meetingFolderFilterSchema), (c) => {
    const db = getDb();
    const { folder_id } = c.req.valid("query");
    const where =
      folder_id === undefined
        ? ""
        : folder_id === "none"
          ? "WHERE folder_id IS NULL"
          : "WHERE folder_id = ?";
    const rows = db
      .prepare(
        `SELECT * FROM meetings ${where} ORDER BY created_at DESC, id DESC LIMIT 200`,
      )
      .all(
        ...(folder_id !== undefined && folder_id !== "none" ? [folder_id] : []),
      ) as unknown as MeetingRow[];
    return c.json(
      meetingListResponseSchema.parse({
        // A short form of the running job, so a list row can show it.
        items: rows.map((row) => {
          const job = getJob(row.id);
          return {
            ...omitCalendarColumns(row),
            display_status: meetingDisplayStatus(row),
            job: job && {
              kind: job.kind,
              phase: job.phase,
              done: job.done,
              total: job.total,
              queued: job.queued ?? null,
            },
          };
        }),
        total: rows.length,
      }),
    );
  })
  // Boot-time orphan sweep: rows a crash/force-quit left in 'recording'
  // (recorder died mid-session) or 'transcribing' (the in-process server
  // died mid-job — the job is gone with it). The Electron sweep branches on
  // `status`: 'recording' → /:id/interrupted (recorder semantics: finalize
  // WAV headers, keep the row recoverable), 'transcribing' →
  // /:id/transcribe-interrupted (the partial transcript survives but the
  // job can never resume — terminal 'failed' with a named cause).
  // Registered before "/:id" so "orphans" isn't swallowed by the id matcher.
  .get("/orphans", (c) => {
    const db = getDb();
    const rows = db
      .prepare(
        "SELECT * FROM meetings WHERE status IN ('recording', 'transcribing')",
      )
      .all() as unknown as MeetingRow[];
    // A meeting whose job is alive in *this* server process is not an
    // orphan, whatever its status column reads: the Electron boot sweep
    // (3s after launch) must not kill a live — or cancelling/winding-down —
    // job just because a client was still booting when the job started
    // (found by the renderer e2e: import → auto-transcribe raced the sweep
    // and the row flipped to "Interrupted" seconds before "Cancelled by
    // user" landed, stranding the renderer's poll on the wrong terminal
    // state). After a real quit/crash the job's process is gone, its
    // job-registry entry went with it, and the row sweeps exactly as before.
    const items = rows.filter((row) => !hasJob(row.id));
    return c.json({ items });
  })
  // Diarization model readiness (spec §8) — global, not per-meeting.
  // Registered before "/:id" for the same reason as "/orphans" above: a
  // literal segment must be matched before the ":id" param swallows it.
  // Models are pre-bundled (spec §4, amended 2026-08-25) — a plain probe,
  // no download orchestration or progress polling left here.
  .get("/diarization/status", async (c) => {
    const enabled = getMeetingDiarizationEnabledSetting();
    const { status, error } = await probeDiarizationModels();
    return c.json({ enabled, status, error });
  })
  .post("/start", zValidator("json", startSchema), (c) => {
    const {
      id,
      title,
      audio_dir,
      started_at,
      calendar,
      folder_id = null,
    } = c.req.valid("json");
    const db = getDb();
    if (!meetingFolderExists(folder_id)) {
      return c.json(
        meetingFolderErrorSchema.parse({
          error: "Folder not found",
          code: "folder_not_found",
        }),
        404,
      );
    }
    // An empty title takes the event title (owner decision 3).
    const finalTitle = title?.trim() ? title : calendar?.title.trim() || null;
    db.prepare(
      `INSERT INTO meetings (id, title, started_at, status, audio_dir, created_at,
         calendar_event_id, calendar_title, calendar_start, calendar_end,
         calendar_url, calendar_attendees, folder_id)
       VALUES (?, ?, ?, 'recording', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      finalTitle,
      started_at,
      audio_dir,
      Date.now(),
      ...calendarColumnValues(calendar ?? null),
      folder_id,
    );
    return c.json(
      meetingStartResponseSchema.parse({ ok: true, id, folder_id }),
    );
  })
  // Link or change the calendar event of a meeting. The title follows the
  // event only when it is empty or still holds the previous event's title.
  .put("/:id/calendar", zValidator("json", calendarEventSchema), (c) => {
    const id = c.req.param("id");
    const event = c.req.valid("json");
    const row = getMeetingRow(id);
    if (!row) return c.json({ error: "Not found" }, 404);
    const inherited = !row.title?.trim() || row.title === row.calendar_title;
    const title = inherited ? event.title.trim() || null : row.title;
    getDb()
      .prepare(
        `UPDATE meetings SET title = ?, calendar_event_id = ?, calendar_title = ?,
           calendar_start = ?, calendar_end = ?, calendar_url = ?,
           calendar_attendees = ?
         WHERE id = ?`,
      )
      .run(title, ...calendarColumnValues(event), id);
    notifyMeetingChanged(id);
    return c.json({ ok: true, title });
  })
  // Unlink. A title that only came from the event goes back to empty. A
  // title the user typed stays.
  .delete("/:id/calendar", (c) => {
    const id = c.req.param("id");
    const row = getMeetingRow(id);
    if (!row) return c.json({ error: "Not found" }, 404);
    const title =
      row.calendar_title !== null && row.title === row.calendar_title
        ? null
        : row.title;
    getDb()
      .prepare(
        `UPDATE meetings SET title = ?, calendar_event_id = NULL,
           calendar_title = NULL, calendar_start = NULL, calendar_end = NULL,
           calendar_url = NULL, calendar_attendees = NULL
         WHERE id = ?`,
      )
      .run(title, id);
    notifyMeetingChanged(id);
    return c.json({ ok: true, title });
  })
  // Rename a meeting and/or set its transcription language (Phase A2's
  // editable language chip). Runs whichever UPDATEs the body actually
  // supplied — re-transcribe/retry-failed always read whatever is
  // currently stored, so a language edit takes effect on the next run with
  // no other wiring.
  .patch("/:id", zValidator("json", renameSchema), (c) => {
    const id = c.req.param("id");
    const { title, language, context, retentionExempt } = c.req.valid("json");
    const db = getDb();
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    if (title !== undefined) {
      sets.push("title = ?");
      values.push(title);
    }
    if (language !== undefined) {
      sets.push("language = ?");
      values.push(language);
    }
    if (context !== undefined) {
      sets.push("context = ?");
      values.push(context);
    }
    if (retentionExempt !== undefined) {
      sets.push("retention_exempt = ?");
      values.push(retentionExempt ? 1 : 0);
    }
    const result = db
      .prepare(`UPDATE meetings SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values, id);
    if (result.changes === 0) return c.json({ error: "Not found" }, 404);
    // The title is in the meta chunk of the search index (spec 4.6).
    if (title !== undefined) notifyMeetingChanged(id);
    return c.json({ ok: true, title, language, context, retentionExempt });
  })
  .post("/:id/stop", zValidator("json", stopSchema), (c) => {
    const id = c.req.param("id");
    const { ended_at, duration_ms, status, error } = c.req.valid("json");
    const db = getDb();
    const result = db
      .prepare(
        `UPDATE meetings
         SET ended_at = ?, duration_ms = ?, status = ?, error = ?
         WHERE id = ?`,
      )
      .run(ended_at, duration_ms, status, error ?? null, id);
    if (result.changes === 0) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
  })
  // Orphan repair: mark a stuck 'recording' row 'interrupted' after the
  // recorder has finalized its WAV headers from the on-disk file sizes.
  .post(
    "/:id/interrupted",
    zValidator(
      "json",
      z.object({ duration_ms: z.number().int().min(0).optional() }),
    ),
    (c) => {
      const id = c.req.param("id");
      const { duration_ms } = c.req.valid("json");
      const db = getDb();
      const result = db
        .prepare(
          `UPDATE meetings
           SET status = 'interrupted',
               duration_ms = COALESCE(?, duration_ms)
           WHERE id = ? AND status = 'recording'`,
        )
        .run(duration_ms ?? null, id);
      if (result.changes === 0) return c.json({ error: "Not found" }, 404);
      return c.json({ ok: true });
    },
  )
  // Orphan repair for transcription jobs (T1-1 boot recovery): a quit or
  // crash mid-job leaves the row 'transcribing' forever — the job lived in
  // the process that died and nothing will ever flip the status. Boot
  // sweep marks it 'failed' with a named cause; the segments already
  // written survive (the partial transcript stays readable/retryable).
  // Deliberately NOT the 'interrupted' status — that means the *recorder*
  // was interrupted and carries recorder semantics (WAV finalization,
  // duration repair, recoverable-to-recorded). Strict transition guard:
  // only valid from 'transcribing', mirroring /:id/interrupted's
  // WHERE-status guard (0 changes → 404 covers unknown ids too).
  .post("/:id/transcribe-interrupted", (c) => {
    const id = c.req.param("id");
    const db = getDb();
    const result = db
      .prepare(
        `UPDATE meetings
         SET status = 'failed', error = 'Interrupted — app quit during transcription'
         WHERE id = ? AND status = 'transcribing'`,
      )
      .run(id);
    if (result.changes === 0) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
  })
  // Kick the async transcription job: 202 immediately, poll GET /:id.
  .post("/:id/transcribe", (c) => {
    const id = c.req.param("id");
    const db = getDb();
    const row = getMeetingRow(id);
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.status === "recording") {
      return c.json({ error: "Meeting is still recording" }, 409);
    }
    if (hasJob(id)) {
      return c.json({ error: runningJobMessage(getJobKind(id)) }, 409);
    }
    if (!row.audio_dir) {
      return c.json({ error: "Meeting has no audio directory" }, 409);
    }
    db.prepare(
      "UPDATE meetings SET status = 'transcribing', error = NULL WHERE id = ?",
    ).run(id);
    // A re-run replaces the previous transcript wholesale.
    db.prepare("DELETE FROM meeting_segments WHERE meeting_id = ?").run(id);
    // specs/meeting-speaker-naming.md §6.3: fresh segment ids and (if
    // diarization runs again) a fresh clustering means label "3" from the
    // old run has no guaranteed relationship to label "3" from the new one
    // — a stale name/merge mapping would silently misattribute a confirmed
    // name to a different, unrelated voice.
    db.prepare("DELETE FROM meeting_speakers WHERE meeting_id = ?").run(id);
    // Phase 4 (specs/meeting-transcription-v2.md §3.4): the old run's
    // diarizer turns go with the old segments — the new run re-diarizes
    // and re-writes them (or the measurement sees none, not stale ones).
    db.prepare("DELETE FROM meeting_diarizer_turns WHERE meeting_id = ?").run(
      id,
    );
    claimJob(id, "transcribe", { done: 0, total: 0, failed: 0 });
    void runTranscribeJob(id, row.audio_dir);
    return c.json({ ok: true, id }, 202);
  })
  // Cancel a running transcription job (T1-1). Asks the job to stop via a
  // per-meeting cancellation flag polled between chunk tasks; chunks already
  // in flight (≤2, or 1 for whisper-local) are allowed to finish, every
  // segment already written survives, and the row lands in 'failed' with
  // error "Cancelled by user" once the job winds down. The 202 returns
  // immediately — poll GET /:id for the terminal state, same contract as
  // POST /:id/transcribe. Idempotent while winding down: a second cancel
  // before the slot is freed is an acknowledged no-op (202); after the job
  // finished (slot freed) it's a 409 like any cancel with no active job.
  .post("/:id/cancel-transcribe", (c) => {
    const id = c.req.param("id");
    const db = getDb();
    const row = db.prepare("SELECT id FROM meetings WHERE id = ?").get(id);
    if (!row) return c.json({ error: "Not found" }, 404);
    // A diarize pass holds the slot without being cancellable — it's a
    // bounded in-request local-model run, not a chunked STT job. The
    // enhance passes (the in-request /enhance and the auto-run job behind
    // the status flip, specs/meeting-transcription-v2.md §3.2) ARE
    // cancellable: both poll this same flag between chunks via their
    // `shouldStop` seam, and finished chunks survive a cancel.
    if (!requestCancel(id)) {
      return c.json({ error: "No transcription job is running" }, 409);
    }
    return c.json({ ok: true, id }, 202);
  })
  // Re-transcribe only the chunks a previous run marked failed.
  .post("/:id/retry-failed", async (c) => {
    const id = c.req.param("id");
    const db = getDb();
    const row = getMeetingRow(id);
    if (!row) return c.json({ error: "Not found" }, 404);
    if (hasJob(id)) {
      return c.json({ error: runningJobMessage(getJobKind(id)) }, 409);
    }
    if (!row.audio_dir) {
      return c.json({ error: "Meeting has no audio directory" }, 409);
    }
    const failedRows = db
      .prepare(
        `SELECT source, start_ms, end_ms, text, status FROM meeting_segments
         WHERE meeting_id = ? AND status = 'failed' ORDER BY idx`,
      )
      .all(id) as unknown as SegmentRow[];
    if (failedRows.length === 0) return c.json({ ok: true, retried: 0 });

    const audioDir = row.audio_dir;
    const toSegments = (source: "mic" | "system") =>
      failedRows
        .filter((r) => r.source === source)
        .map((r) => ({ startMs: r.start_ms, endMs: r.end_ms }));
    const update = db.prepare(
      `UPDATE meeting_segments SET text = ?, status = ?
       WHERE meeting_id = ? AND source = ? AND start_ms = ? AND end_ms = ?`,
    );
    const vocabTerms = loadVocabularyTerms();
    // PR #39: the retry runs with the same context terms as the main
    // job (bias + leak check) — the row is already loaded here.
    const contextTerms = extractContextTerms(row.context ?? "");
    const meetingVocabTerms =
      contextTerms.length > 0
        ? mergeContextVocabTerms(contextTerms, vocabTerms)
        : vocabTerms;
    // Claim the concurrency slot (kind: retry-failed) so /transcribe,
    // /diarize, /enhance and a second /retry-failed can't race this run —
    // and so POST /:id/cancel-transcribe can cancel it. Same claim-before-
    // await reasoning as /diarize below: every early return and the catch
    // are covered by the try/finally.
    claimJob(id, "retry-failed", {
      done: 0,
      total: failedRows.length,
      failed: 0,
    });
    try {
      // I3 (specs/meeting-transcription-v2.md §3.3): retry-failed resolves
      // the model from the row's own stamp, so a retry uses the model the
      // failed chunks ran with — not whatever the default (or the meeting
      // model setting) is now. Migration 36 left old stamps behind (a gone
      // "omlx" provider, old "openai" override pairs), so the stamp is
      // trusted only while its provider still exists AND its
      // (provider, model) pair is still configured. Otherwise the normal
      // resolution (setting, then default voice) runs.
      const stamp =
        row.stt_provider &&
        row.stt_model &&
        getProvider(row.stt_provider) &&
        db
          .prepare(
            "SELECT 1 FROM model_configs WHERE provider = ? AND model_id = ?",
          )
          .get(row.stt_provider, row.stt_model)
          ? { provider: row.stt_provider, modelId: row.stt_model }
          : undefined;
      const baseDeps = await buildTranscriberDeps(
        {
          isDictationActive,
          shouldStop: () => isCancelRequested(id),
          // Chunk idx here is positional within the retry batch, so key the
          // update on (source, start, end) — stable across runs. Phase A1
          // leak check applies here too, via the same shared helper
          // persistChunk uses, so a leak surfacing on a retry is caught
          // exactly as it would be on the original pass.
          onChunk: (chunk) => {
            const { text, status } = leakCheckedTextAndStatus(
              chunk,
              meetingVocabTerms,
            );
            update.run(
              text,
              status,
              id,
              chunk.source,
              chunk.startMs,
              chunk.endMs,
            );
          },
          onProgress: (p) => setProgress(id, p),
        },
        stamp,
        contextTerms,
      );
      // Phase A2: reuse the meeting's already-resolved language with no
      // re-probe — retrying a handful of failed chunks doesn't warrant a
      // fresh language decision.
      const deps: TranscriberDeps = row.language
        ? {
            ...baseDeps,
            resolveConfig: () => ({
              ...baseDeps.resolveConfig(),
              language: row.language as string,
            }),
          }
        : baseDeps;
      const results = await new MeetingTranscriber(deps).run({
        meetingDir: audioDir,
        micSegments: toSegments("mic"),
        systemSegments: toSegments("system"),
        // Phase 3a (specs/meeting-transcription-v2.md §3.1): retry-failed
        // runs without lanes (old pool) — and, with it, without the
        // context and overlap phases that build on lanes.
        lanes: false,
      });
      // Cancelled mid-retry (T1-1): chunks already retried keep their new
      // text (persisted inline by onChunk above), the rest stay 'failed' —
      // the meeting row itself is untouched (retry-failed never owns
      // meetings.status; it stays whatever it was, typically 'transcribed'
      // with the previous run's error still readable).
      if (isCancelRequested(id)) {
        const completed = results.filter((r) => r !== undefined).length;
        log.info(
          `meeting ${id}: retry-failed cancelled by user after ${completed} of ${results.length} chunks`,
        );
        // Chunks retried before the cancel changed rendered text — refresh
        // transcript.md so the export never drifts from the DB (same
        // contract as every other segment-writing route).
        writeTranscriptMarkdown(id, audioDir);
        return c.json({ ok: true, cancelled: true, retried: completed });
      }
      const stillFailed = results.filter((r) => r.status === "failed").length;
      db.prepare("UPDATE meetings SET error = ? WHERE id = ?").run(
        stillFailed > 0 ? `${stillFailed} chunks failed` : null,
        id,
      );
      writeTranscriptMarkdown(id, audioDir);
      return c.json({ ok: true, retried: results.length, failed: stillFailed });
    } catch (err) {
      const message = errorMessage(err);
      return c.json({ error: message }, 500);
    } finally {
      releaseJob(id);
    }
  })
  // Standalone speaker-identification action: re-runs only the diarization
  // pass (no Whisper re-run) over a meeting's already-persisted system-
  // channel segments. Explicit user action — ignores the global
  // meeting_diarization_enabled flag entirely (that flag only gates the
  // automatic pass inside runTranscribeJob above). Runs in-request, like
  // /summarize and /retry-failed: one bounded local model pass, not a
  // multi-chunk STT job that needs progress polling.
  .post("/:id/diarize", async (c) => {
    const id = c.req.param("id");
    const db = getDb();
    const row = getMeetingRow(id);
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.status !== "transcribed" && row.status !== "summarized") {
      return c.json({ error: "Meeting has no transcript to diarize" }, 409);
    }
    // Reuse the transcription-job guard (spec §11's concurrency reasoning
    // extends here: the diarizer targets the same on-device ANE resource a
    // running transcribe job's whisper-local pass may also be using) —
    // same registry /transcribe and /retry-failed already check. Redundant with
    // but cheap alongside the status check above: a meeting can only reach
    // 'transcribing' status while the job registry already holds its id (set by
    // /transcribe before the status flip), so this registry check is the one
    // guard that actually fires; status is filtered to
    // transcribed/summarized above regardless.
    if (hasJob(id)) {
      return c.json({ error: runningJobMessage(getJobKind(id)) }, 409);
    }
    if (!row.audio_dir) {
      return c.json({ error: "Meeting has no audio directory" }, 409);
    }
    const wavPath = join(row.audio_dir, SYSTEM_WAV);
    if (!existsSync(wavPath)) {
      return c.json({ error: "System audio is no longer on disk" }, 409);
    }

    const audioDir = row.audio_dir;
    const deps = testOverrides.diarizeDeps ?? createDefaultDiarizeDeps();

    // Claim the concurrency slot *before* the pre-flight probe, not after.
    // probeDiarizationModels awaits a real spawn (up to PROBE_TIMEOUT_MS).
    // A /transcribe call or a second /diarize call can arrive in that window.
    // Without the claim, the new call sees hasJob(id) === false and races
    // this pass. Its runDiarizationPass then BEGINs a transaction on the
    // shared db connection that this pass already holds open. If it fails,
    // its ROLLBACK discards the labels that this pass just committed. Every
    // early return below is inside the try/finally, so the code always
    // releases the slot, also on the not-ready path.
    claimJob(id, "diarize", { done: 0, total: 0, failed: 0 });
    try {
      // Pre-flight probe (spec §4/§8's existing cheap, local, no-network
      // check): a build with no diarize binary or a missing/corrupt model
      // bundle must not report a false "ok" — that's exactly the gap this
      // action exists to close (investigation finding (a)/(b): silent
      // no-op reads as success).
      const readiness = await probeDiarizationModels(deps);
      if (readiness.status !== "ready") {
        return c.json(
          {
            error:
              readiness.status === "not-ready"
                ? "Speaker models are missing from this build"
                : "Speaker identification isn't available in this build",
          },
          409,
        );
      }

      // specs/meeting-speaker-naming.md §6.3: whether label "3" means the
      // same real person before and after a second diarizer run depends on
      // clustering stability nothing in this codebase guarantees — treat
      // this the same as re-transcribe for the naming layer. Checked
      // *before* the pass runs (not just deleted unconditionally after) so
      // the response can report whether there was actually something to
      // lose.
      const hadMapping =
        (
          db
            .prepare(
              "SELECT COUNT(*) AS c FROM meeting_speakers WHERE meeting_id = ?",
            )
            .get(id) as { c: number }
        ).c > 0;

      // Ignores getMeetingDiarizationEnabledSetting() by design: an
      // explicit "Identify speakers" click wins over the global toggle.
      // The pass only ever UPDATEs speaker_label on already-persisted
      // rows (never DELETEs/INSERTs), so a failure mid-pass can't corrupt
      // existing labels — same graceful-degrade contract as the automatic
      // pass in runTranscribeJob.
      await runDiarizationPass(id, audioDir, deps);
      db.prepare("DELETE FROM meeting_speakers WHERE meeting_id = ?").run(id);
      const counts = db
        .prepare(
          `SELECT speaker_label FROM meeting_segments
           WHERE meeting_id = ? AND source = 'system' AND speaker_label IS NOT NULL`,
        )
        .all(id) as unknown as { speaker_label: string }[];
      const labeledCount = counts.length;
      const speakerCount = new Set(counts.map((r) => r.speaker_label)).size;
      // The new speaker_label values just committed above must reach the
      // on-disk transcript.md (and transcript-enhanced.md if an Enhance
      // pass already ran) — same refresh /enhance does below. Without this
      // the standalone "Identify speakers" action leaves the DB and the
      // exported markdown disagreeing indefinitely, since nothing else
      // rewrites these files after this route returns.
      writeTranscriptMarkdown(id, audioDir);
      return c.json({
        ok: true,
        labeledCount,
        speakerCount,
        mappingReset: hadMapping,
      });
    } catch (err) {
      // Defense-in-depth, matching runTranscribeJob's call site: in normal
      // operation runDiarizationPass degrades in-function and never
      // throws.
      const message = errorMessage(err);
      log.error(`meeting ${id}: identify speakers failed: ${message}`);
      return c.json({ error: message }, 500);
    } finally {
      releaseJob(id);
    }
  })
  // Meeting speaker naming (specs/meeting-speaker-naming.md §6.1): one call
  // powers the whole naming/merge dialog — no per-row round-trip.
  .get("/:id/speakers", (c) => {
    const id = c.req.param("id");
    const db = getDb();
    const meeting = db.prepare("SELECT id FROM meetings WHERE id = ?").get(id);
    if (!meeting) return c.json({ error: "Not found" }, 404);

    const labelRows = db
      .prepare(
        `SELECT speaker_label AS label, COUNT(*) AS segmentCount,
                (SELECT COALESCE(enhanced_text, text) FROM meeting_segments s2
                 WHERE s2.meeting_id = meeting_segments.meeting_id
                   AND s2.source = 'system' AND s2.speaker_label = meeting_segments.speaker_label
                 ORDER BY LENGTH(COALESCE(enhanced_text, text)) DESC LIMIT 1) AS quote
         FROM meeting_segments
         WHERE meeting_id = ? AND source = 'system' AND speaker_label IS NOT NULL
         GROUP BY speaker_label`,
      )
      .all(id) as unknown as {
      label: string;
      segmentCount: number;
      quote: string | null;
    }[];
    const unlabeledCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM meeting_segments
           WHERE meeting_id = ? AND source = 'system' AND speaker_label IS NULL`,
        )
        .get(id) as { c: number }
    ).c;
    const speakerRows = db
      .prepare(
        `SELECT speaker_label, display_name, suggested_name, suggested_evidence, suggested_kind, merged_into, confirmed_at
         FROM meeting_speakers WHERE meeting_id = ?`,
      )
      .all(id) as unknown as {
      speaker_label: string;
      display_name: string | null;
      suggested_name: string | null;
      suggested_evidence: string | null;
      suggested_kind: string | null;
      merged_into: string | null;
      confirmed_at: number | null;
    }[];
    const byLabel = new Map(speakerRows.map((r) => [r.speaker_label, r]));

    const speakers = labelRows.map((r) => {
      const row = byLabel.get(r.label);
      return {
        label: r.label,
        segmentCount: r.segmentCount,
        quote: r.quote ? r.quote.slice(0, 140) : null,
        displayName: row?.display_name ?? null,
        suggestedName: row?.suggested_name ?? null,
        suggestedEvidence: row?.suggested_evidence ?? null,
        // NULL (pre-hardening row, or the LLM omitted the field) reads as
        // "name" — the pre-hardening contract's only kind
        // (specs/meeting-speaker-naming.md §5.2/§5.3). `as const` keeps the
        // literal union in the client's inferred response type.
        suggestedKind:
          row?.suggested_kind === "role"
            ? ("role" as const)
            : ("name" as const),
        mergedInto: row?.merged_into ?? null,
      };
    });
    // Powers the Summary tab's staleness hint (specs/meeting-speaker-
    // naming.md §9.2) without a second endpoint: the client compares this
    // against meeting_summaries.created_at, already available on GET /:id.
    // Real-E2E fix: reads MAX(confirmed_at), NOT MAX(updated_at) — the
    // latter is bumped by Enhance's own suggestion upserts, which are
    // evidence, never a user-confirmed change, and must never mark an
    // already-generated summary stale on their own.
    const confirmedUpdates = speakerRows
      .map((r) => r.confirmed_at)
      .filter((v): v is number => v != null);
    const latestSpeakerUpdate =
      confirmedUpdates.length > 0 ? Math.max(...confirmedUpdates) : null;
    return c.json({ speakers, unlabeledCount, latestSpeakerUpdate });
  })
  // specs/meeting-speaker-naming.md §6.2: partial update of one speaker's
  // confirmed name and/or merge target. Same partial-update idiom as
  // PATCH /:id — only the fields present in the body change.
  .patch(
    "/:id/speakers/:label",
    zValidator("json", speakerPatchSchema),
    (c) => {
      const id = c.req.param("id");
      const label = c.req.param("label");
      const { displayName, mergedInto } = c.req.valid("json");
      const db = getDb();

      const meeting = db
        .prepare("SELECT id FROM meetings WHERE id = ?")
        .get(id);
      if (!meeting) return c.json({ error: "Not found" }, 404);

      const realLabels = new Set(
        (
          db
            .prepare(
              `SELECT DISTINCT speaker_label FROM meeting_segments
               WHERE meeting_id = ? AND source = 'system' AND speaker_label IS NOT NULL`,
            )
            .all(id) as unknown as { speaker_label: string }[]
        ).map((r) => r.speaker_label),
      );
      if (!realLabels.has(label)) {
        return c.json({ error: "Unknown speaker label" }, 404);
      }

      const existing = db
        .prepare(
          "SELECT display_name, merged_into FROM meeting_speakers WHERE meeting_id = ? AND speaker_label = ?",
        )
        .get(id, label) as
        | { display_name: string | null; merged_into: string | null }
        | undefined;

      let newDisplayName = existing?.display_name ?? null;
      if (displayName !== undefined) newDisplayName = displayName;

      let newMergedInto = existing?.merged_into ?? null;
      let cascadeTarget: string | null = null;
      if (mergedInto !== undefined) {
        if (mergedInto === null) {
          // Explicit unmerge: clear this row's own outgoing edge. No
          // cascade needed — nothing pointed at this row changes.
          newMergedInto = null;
        } else {
          if (mergedInto === label) {
            return c.json({ error: "A speaker cannot merge into itself" }, 400);
          }
          if (!realLabels.has(mergedInto)) {
            return c.json({ error: "Unknown merge target" }, 404);
          }
          // Merge depth is always <= 1 hop (§3.2): resolve through the
          // target's own root when it's already merged, rather than
          // rejecting a deeper request — the end state ("this label's
          // segments render under the root's identity") is what the user
          // meant either way.
          const targetRow = db
            .prepare(
              "SELECT merged_into FROM meeting_speakers WHERE meeting_id = ? AND speaker_label = ?",
            )
            .get(id, mergedInto) as { merged_into: string | null } | undefined;
          const resolved = targetRow?.merged_into ?? mergedInto;
          // The target can already point back at this label (2 into 1, then
          // 1 into 2). That resolves to a self-merge, so reject it.
          if (resolved === label) {
            return c.json({ error: "A speaker cannot merge into itself" }, 400);
          }
          newMergedInto = resolved;
          cascadeTarget = resolved;
        }
      }

      const now = Date.now();
      withTransaction(db, () => {
        if (cascadeTarget) {
          // Any row currently pointing merged_into = label (this label had
          // other labels already merged into it) cascades to point at the
          // new resolved target directly, in the same transaction — keeps
          // "no chain longer than one hop" true for the whole table. This
          // is a user-driven state change (the cascaded rows' effective
          // identity just moved), so it counts toward `confirmed_at` too.
          db.prepare(
            "UPDATE meeting_speakers SET merged_into = ?, updated_at = ?, confirmed_at = ? WHERE meeting_id = ? AND merged_into = ?",
          ).run(cascadeTarget, now, now, id, label);
        }
        // `confirmed_at` is set unconditionally here: reaching this line
        // means the request supplied `displayName` and/or `mergedInto` (the
        // 400-on-empty-body check above already rejected a body with
        // neither), i.e. a human explicitly confirmed a name or a merge —
        // exactly the "confirmed change" `latestSpeakerUpdate` (§9.2) must
        // track, as opposed to Enhance's suggestion-only upsert
        // (the Enhance workflow), which never touches this column.
        db.prepare(
          `INSERT INTO meeting_speakers (meeting_id, speaker_label, display_name, merged_into, updated_at, confirmed_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(meeting_id, speaker_label) DO UPDATE SET
             display_name = excluded.display_name,
             merged_into = excluded.merged_into,
             updated_at = excluded.updated_at,
             confirmed_at = excluded.confirmed_at`,
        ).run(id, label, newDisplayName, newMergedInto, now, now);
      });

      const row = db
        .prepare("SELECT audio_dir FROM meetings WHERE id = ?")
        .get(id) as { audio_dir: string | null } | undefined;
      // Every route that changes what renders must refresh transcript.md /
      // transcript-enhanced.md so they never drift from the DB — best-effort,
      // never fails the PATCH itself (writeTranscriptMarkdown's own contract).
      if (row?.audio_dir) writeTranscriptMarkdown(id, row.audio_dir);

      return c.json({ ok: true });
    },
  )
  // Summarize the merged transcript. 202 + background run + poll: the run
  // takes the meeting's job slot before the first await, the renderer polls
  // GET /:id for `job` (progress, queued) and for the persisted `summary`, and
  // reads the run record for a failure (specs/meeting-enhance-agentic.md 3.4.2).
  .post("/:id/summarize", (c) => {
    const id = c.req.param("id");
    const row = getMeetingRow(id);
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.status !== "transcribed" && row.status !== "summarized") {
      return c.json({ error: "Meeting has no transcript to summarize" }, 409);
    }
    if (hasJob(id)) {
      return c.json({ error: "A job is already running" }, 409);
    }
    const merged = loadMergedTranscript(id, row.audio_dir);
    if (merged.length === 0) {
      return c.json({ error: "Transcript is empty" }, 409);
    }
    if (!getDefaultModels().llm) {
      return c.json(
        {
          error: "No AI model is set up. Add one in Settings > Models.",
          code: "no_llm",
        },
        409,
      );
    }
    return startRunResponse(c, id, ["summarize"]);
  })
  // LLM cleanup pass (Enhance) over the merged transcript. It starts one
  // run with the stages `enhance` and `summarize` (3.6). 202 + background run
  // + poll, like /summarize. Never destructive: only UPDATEs
  // meeting_segments.enhanced_text on existing rows.
  .post("/:id/enhance", (c) => {
    const id = c.req.param("id");
    const row = getMeetingRow(id);
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.status !== "transcribed" && row.status !== "summarized") {
      return c.json({ error: "Meeting has no transcript to enhance" }, 409);
    }
    // The shared job registry that /transcribe, /retry-failed and /diarize
    // check: an Enhance run reading meeting_segments mid-write from a running
    // transcribe job would see a half-written transcript.
    if (hasJob(id)) {
      return c.json({ error: runningJobMessage(getJobKind(id)) }, 409);
    }
    const merged = loadMergedTranscript(id, row.audio_dir);
    if (merged.length === 0) {
      return c.json({ error: "Transcript is empty" }, 409);
    }
    if (!getDefaultModels().llm) {
      return c.json(
        {
          error: "No AI model is set up. Add one in Settings > Models.",
          code: "no_llm",
        },
        409,
      );
    }
    return startRunResponse(c, id, ["enhance", "summarize"]);
  })
  // Merged, speaker-labeled ("Me"/"Them") transcript.
  .get("/:id/transcript", (c) => {
    const id = c.req.param("id");
    const row = getMeetingRow(id);
    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json({ segments: loadMergedTranscript(id, row.audio_dir) });
  })
  .get("/:id", (c) => {
    const db = getDb();
    const id = c.req.param("id");
    const row = getMeetingRow(id);
    if (!row) return c.json({ error: "Not found" }, 404);
    const counts = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM meeting_segments WHERE meeting_id = ?`,
      )
      .get(id) as unknown as { total: number; failed: number | null };
    const summary = db
      .prepare("SELECT * FROM meeting_summaries WHERE meeting_id = ?")
      .get(id) as
      | {
          meeting_id: string;
          markdown: string | null;
          llm_provider: string | null;
          llm_model: string | null;
          input_tokens: number | null;
          output_tokens: number | null;
          cost_usd: number | null;
          created_at: number | null;
          partial: number | null;
        }
      | undefined;
    return c.json(
      meetingDetailResponseSchema.parse({
        ...omitCalendarColumns(row),
        retention_exempt: row.retention_exempt === 1,
        display_status: meetingDisplayStatus(row),
        tags: getMeetingTags(id),
        calendar: toCalendarEvent(row),
        /** Live job progress, or null when no job is running. `kind` names the
         * holder so the renderer can tell a cancellable summarize job from a
         * non-cancellable diarize/enhance pass without a second round-trip. */
        job: getJob(id),
        segment_counts: { total: counts.total, failed: counts.failed ?? 0 },
        ...loadTrackState(row),
        // `partial`: repaired from a cut answer (PR #258). NULL is complete.
        summary: summary
          ? { ...summary, partial: summary.partial === 1 }
          : null,
      } satisfies MeetingDetail),
    );
  })
  .delete("/:id", (c) => {
    const db = getDb();
    const id = c.req.param("id");
    // Ask any running job to stop BEFORE the row goes away
    // (specs/meeting-transcription-v2.md §3.2): the cancellable kinds
    // (transcribe, retry-failed, summarize, enhance) poll this flag and
    // wind down between steps. Without it, an auto-run Enhance would keep
    // calling the LLM for a deleted meeting and then trip the
    // meeting_speakers foreign key on its end write. DELETE never 409s on
    // a running job — the row is deleted either way; the job just stops.
    if (hasJob(id)) requestCancel(id);
    const row = db
      .prepare("SELECT audio_dir FROM meetings WHERE id = ?")
      .get(id) as { audio_dir: string | null } | undefined;
    // Remove the audio directory alongside the row, but only when it lives
    // inside the meetings root under the app data dir (the recorder always
    // writes to <userData>/meetings/<id>/) — never follow an arbitrary path.
    if (row?.audio_dir) {
      const dir = resolve(row.audio_dir);
      const root = meetingsRootDir();
      if (root && dir.startsWith(root + sep)) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch (err) {
          log.warn(`Failed to remove audio dir for ${id}: ${String(err)}`);
        }
      }
    }
    db.prepare("DELETE FROM meetings WHERE id = ?").run(id);
    // The cascade filled meeting_chunk_gc. Wake the search indexer so it
    // deletes the vectors soon (specs/local-semantic-search.md 6.6).
    notifyMeetingChanged(id);
    return c.json({ ok: true });
  });

export default meetings;
