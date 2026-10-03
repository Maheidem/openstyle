import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { zValidator } from "@hono/zod-validator";
import { isVocabLeak } from "@openstyle/stt";
import { createAppLogger, errorMessage } from "@openstyle/utils";
import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../lib/db.js";
import { isDictationActive } from "../lib/dictation-activity.js";
import {
  createDefaultDiarizeDeps,
  type DiarizeDeps,
  getMeetingDiarizationEnabledSetting,
  probeDiarizationModels,
  runDiarizationPass,
} from "../lib/meetings/diarize.js";
import {
  enhanceMeetingTranscript,
  getMeetingEnhanceAutoRunSetting,
} from "../lib/meetings/enhance.js";
import {
  claimJob,
  clearJobFailure,
  getJob,
  getJobFailure,
  hasJob,
  isCancelRequested,
  releaseJob,
  requestCancel,
  setJobFailure,
  setProgress,
  updateProgress,
} from "../lib/meetings/job-registry.js";
import { resolveMeetingLanguage } from "../lib/meetings/language.js";
import {
  formatTranscriptMarkdown,
  type MergedSegment,
  mergeTranscript,
  type SyncData,
  type TranscriptSegment,
} from "../lib/meetings/merge.js";
import { segmentWavFile } from "../lib/meetings/segmenter.js";
import { resolveSpeakerNames } from "../lib/meetings/speaker-names.js";
import { getMeetingRow, type MeetingRow } from "../lib/meetings/store.js";
import {
  summarizeJobPlan,
  summarizeMeeting,
} from "../lib/meetings/summarize.js";
import {
  type ChunkResult,
  createDefaultTranscriberDeps,
  MeetingTranscriber,
  type TranscriberDeps,
} from "../lib/meetings/transcriber.js";
import { loadVocabularyTerms } from "../lib/vocabulary.js";

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
  return resolve(join(dirname(dbPath), "meetings"));
}

/**
 * Test seam: the transcriber's dependency factory and the summarizer are
 * swappable so route tests never touch real STT/LLM providers.
 */
interface MeetingsTestOverrides {
  createTranscriberDeps?: typeof createDefaultTranscriberDeps;
  summarize?: typeof summarizeMeeting;
  /** Injected into both the pre-flight probe and the real diarization pass
   * on POST /:id/diarize, mirroring how `meeting-diarize-pipeline.test.ts`
   * drives `runDiarizationPass` directly — a single fake deps object
   * exercises the route's pre-flight check, the real run, and the
   * follow-up count query together. */
  diarizeDeps?: DiarizeDeps;
  /** Injected LLM-call dependency for POST /:id/enhance and the auto-run call
   * site inside runTranscribeJob, so route tests never touch a real LLM
   * provider. */
  enhance?: typeof enhanceMeetingTranscript;
}
let testOverrides: MeetingsTestOverrides = {};
export function __setMeetingsTestOverrides(
  overrides: MeetingsTestOverrides = {},
): void {
  testOverrides = overrides;
}

// ---------------------------------------------------------------------------
// Audio + sync helpers
// ---------------------------------------------------------------------------

/**
 * Map the recorder's `sync.json` journal (meeting-recorder.ts SyncJournal)
 * onto the merge helper's SyncData: per-channel t0 epochs plus the system
 * helper's wallclock/sample markers.
 */
function loadSyncData(audioDir: string): SyncData | undefined {
  try {
    const j = JSON.parse(readFileSync(join(audioDir, "sync.json"), "utf8")) as {
      sampleRate?: number;
      micT0?: number | null;
      systemT0?: number | null;
      syncMarkers?: Array<{ wallclockMs?: number; totalSamples?: number }>;
    };
    if (!Number.isFinite(j.sampleRate)) return undefined;
    const sync: SyncData = {
      sampleRate: j.sampleRate as number,
      epochs: [],
      syncMarkers: [],
    };
    if (typeof j.micT0 === "number") {
      sync.epochs?.push({ channel: "mic", t0WallclockMs: j.micT0 });
    }
    if (typeof j.systemT0 === "number") {
      sync.epochs?.push({ channel: "system", t0WallclockMs: j.systemT0 });
    }
    for (const m of j.syncMarkers ?? []) {
      if (
        typeof m.wallclockMs === "number" &&
        typeof m.totalSamples === "number"
      ) {
        // Markers come from the system-audio helper only.
        sync.syncMarkers?.push({
          channel: "system",
          wallclockMs: m.wallclockMs,
          totalSamples: m.totalSamples,
        });
      }
    }
    return sync;
  } catch {
    return undefined;
  }
}

interface SegmentRow {
  id?: string;
  source: "mic" | "system";
  start_ms: number;
  end_ms: number;
  text: string | null;
  status: string | null;
  /** Diarization label (system channel only, spec §6). Optional: the
   * retry-failed handler's SELECT doesn't fetch it, and mic rows never have
   * one. */
  speaker_label?: string | null;
  /** LLM-corrected text, Phase C §6.1. Optional: the retry-failed handler's
   * SELECT doesn't fetch it. */
  enhanced_text?: string | null;
}

/** Rebuild the merged Me/Them transcript from persisted segments + sync.json. */
function loadMergedTranscript(
  meetingId: string,
  audioDir: string | null,
): MergedSegment[] {
  const rows = getDb()
    .prepare(
      `SELECT id, source, start_ms, end_ms, text, status, speaker_label, enhanced_text
       FROM meeting_segments WHERE meeting_id = ? ORDER BY idx`,
    )
    .all(meetingId) as unknown as SegmentRow[];
  const channel = (source: "mic" | "system"): TranscriptSegment[] =>
    rows
      .filter((r) => r.source === source && r.status === "ok" && r.text)
      .map((r) => ({
        startMs: r.start_ms,
        endMs: r.end_ms,
        text: r.text as string,
        ...(r.speaker_label ? { speakerLabel: r.speaker_label } : {}),
        ...(r.id ? { id: r.id } : {}),
        ...(r.enhanced_text ? { enhancedText: r.enhanced_text } : {}),
      }));
  const sync = audioDir ? loadSyncData(audioDir) : undefined;
  // Phase A1 backstop (specs/meeting-transcription-quality.md §3.1): checks
  // against the *current* vocabulary, not whatever it was at transcription
  // time — best-effort for rows persisted before persistChunk's own leak
  // check existed, or whose leak check false-negatived at persist time.
  const merged = mergeTranscript(
    channel("mic"),
    channel("system"),
    sync,
    loadVocabularyTerms(),
  );
  // Meeting speaker naming (specs/meeting-speaker-naming.md §4): a
  // post-process pass over the already-built merged transcript, never a
  // change to mergeTranscript's own pure contract. Every consumer of this
  // function — transcript UI, Enhance input, Summarize input, markdown
  // export — goes through here, so this one call covers all of them.
  const speakerRows = getDb()
    .prepare(
      "SELECT speaker_label, display_name, merged_into FROM meeting_speakers WHERE meeting_id = ?",
    )
    .all(meetingId) as unknown as {
    speaker_label: string;
    display_name: string | null;
    merged_into: string | null;
  }[];
  resolveSpeakerNames(
    merged,
    speakerRows.map((r) => ({
      speakerLabel: r.speaker_label,
      displayName: r.display_name,
      mergedInto: r.merged_into,
    })),
  );
  return merged;
}

/**
 * Write the merged transcript as `transcript.md` into the meeting's audio
 * dir so the folder is self-contained. Best-effort: a write failure (e.g.
 * the dir was purged mid-job) never fails the surrounding job.
 *
 * Phase C (specs/meeting-transcription-quality.md §6.8, amended
 * 2026-08-27): `transcript.md` is always the RAW transcript — Enhance must
 * never touch it, regardless of which route triggers this write. When any
 * segment carries `enhancedText`, a second sibling file,
 * `transcript-enhanced.md`, is written (or overwritten) alongside it; it
 * does not exist until the first successful Enhance run.
 */
function writeTranscriptMarkdown(meetingId: string, audioDir: string): void {
  try {
    const merged = loadMergedTranscript(meetingId, audioDir);
    writeFileSync(
      join(audioDir, "transcript.md"),
      formatTranscriptMarkdown(merged),
      "utf8",
    );
    if (merged.some((s) => s.enhancedText !== undefined)) {
      writeFileSync(
        join(audioDir, "transcript-enhanced.md"),
        formatTranscriptMarkdown(merged, true),
        "utf8",
      );
    }
  } catch (err) {
    log.warn(
      `meeting ${meetingId}: failed to write transcript.md: ${String(err)}`,
    );
  }
}

/**
 * Phase A1 persist-time leak check (specs/meeting-transcription-quality.md
 * §3.1): a chunk whose text is overwhelmingly drawn from the vocabulary list
 * is stored as `status='filtered'`, `text=NULL` instead of the model's fake
 * echo. Shared by both write paths (the main job's persistChunk and
 * retry-failed's inline UPDATE) so the check can't drift between them.
 */
function leakCheckedTextAndStatus(
  chunk: Pick<ChunkResult, "status" | "text">,
  vocabTerms: string[],
): { text: string | null; status: string } {
  const leaked =
    chunk.status === "ok" && chunk.text && isVocabLeak(chunk.text, vocabTerms);
  return leaked
    ? { text: null, status: "filtered" }
    : { text: chunk.text, status: chunk.status };
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
): Promise<TranscriberDeps> {
  const factory =
    testOverrides.createTranscriberDeps ?? createDefaultTranscriberDeps;
  return factory(extras);
}

/** The background transcription job for one meeting. Never throws. */
async function runTranscribeJob(id: string, audioDir: string): Promise<void> {
  const db = getDb();
  try {
    const micFound = segmentWavFile(join(audioDir, "mic.wav"));
    const systemFound = segmentWavFile(join(audioDir, "system.wav"));
    if (!micFound && !systemFound) {
      throw new Error(`No audio files found in ${audioDir}`);
    }
    // Phase B (specs/meeting-transcription-quality.md §5): merge VAD output
    // toward a ~20-25s target per channel before transcription — pure
    // post-processing over segmentPcm's already-detected boundaries, mic
    // and system merged independently (never bridged across channels).
    const micSegments = micFound ?? [];
    const systemSegments = systemFound ?? [];
    const total = micSegments.length + systemSegments.length;
    setProgress(id, { done: 0, total, failed: 0 });

    // Loaded once per job, not per chunk — vocabulary rarely changes
    // mid-meeting and loadVocabularyTerms() hits the DB.
    const vocabTerms = loadVocabularyTerms();
    const deps = await buildTranscriberDeps({
      isDictationActive,
      onChunk: (chunk) => persistChunk(id, chunk, vocabTerms),
      onProgress: (p) => setProgress(id, p),
      shouldStop: () => isCancelRequested(id),
    });
    // Resolve once up front: stamps provider/model on the row and fails fast
    // (before any STT call) when no voice model or key is configured.
    const config = deps.resolveConfig();
    db.prepare(
      "UPDATE meetings SET stt_provider = ?, stt_model = ? WHERE id = ?",
    ).run(config.providerId, config.modelId, id);

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
    // user", which matches what the user asked for.
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

    // Diarization Phase 1 (specs/meeting-diarization.md §9): after
    // transcription resolves, before status flips to 'transcribed' and
    // before writeTranscriptMarkdown, so the markdown export always renders
    // final labels, never an intermediate undiarized state. Fails closed —
    // every failure inside runDiarizationPass degrades in-function; this
    // .catch is defense-in-depth for anything unanticipated, never the
    // primary error path, and never fails the transcribe job itself.
    if (getMeetingDiarizationEnabledSetting()) {
      await runDiarizationPass(id, audioDir).catch((err) => {
        log.warn(
          `meeting ${id}: diarization failed, falling back to "Them": ${String(err)}`,
        );
      });
    } else {
      log.info(`meeting ${id}: diarization skipped (setting is off)`);
    }

    // Phase C auto-run (specs/meeting-transcription-quality.md §6.5): same
    // placement rationale as diarization above — after the diarization
    // pass (so Enhance sees final speaker labels, though it doesn't use
    // them) and before the status flip, so the UI never observes an
    // intermediate un-enhanced state when the setting is on. Default off;
    // same fail-closed .catch that never fails the job.
    if (getMeetingEnhanceAutoRunSetting()) {
      const enhance = testOverrides.enhance ?? enhanceMeetingTranscript;
      const meetingRow = getMeetingRow(id);
      await enhance(
        id,
        loadMergedTranscript(id, audioDir),
        resolvedLanguage,
        vocabTerms,
        meetingRow?.title ?? undefined,
        meetingRow?.context ?? undefined,
      )
        .then((autoResult) => {
          // There is no route response here, so a wholly-failed auto-run is
          // reported in the log only — deliberately NOT in `meetings.error`,
          // which is the transcription chunk-failure banner and must keep
          // naming chunks, not an enhance pass.
          if (
            autoResult.chunksAttempted > 0 &&
            autoResult.chunksSucceeded === 0 &&
            !autoResult.stoppedEarly
          ) {
            log.warn(
              `meeting ${id}: enhance auto-run corrected nothing — all ${autoResult.chunksAttempted} chunks failed (${autoResult.firstFailure?.reason ?? "provider"}: ${autoResult.firstFailure?.detail ?? ""})`,
            );
          }
        })
        .catch((err) => {
          log.warn(`meeting ${id}: enhance auto-run failed: ${String(err)}`);
        });
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
    releaseJob(id);
  }
}

/**
 * The background Summarize job for one meeting (specs/meeting-llm-queue.md
 * §5.6). Modelled directly on `runTranscribeJob` above — same shape: never
 * throws, owns its job-registry blob, releases the slot (and its kind and its
 * cancellation flag) in a `finally`.
 *
 * Failures go to `job.error` and the out-of-band job failure store, NEVER to
 * `meetings.error` (spec §6 constraint 3): that column is the chunk-failure /
 * cancel banner the renderer renders as a transcript-integrity warning, and a
 * summarize failure would overwrite it. The `INSERT OR REPLACE` below stays
 * after the calls succeed, so a failed or cancelled run writes no summary and
 * leaves the transcript and every already-persisted segment untouched — there
 * is no partial/echo summary to fail open into (`llm-call.ts` keeps
 * `result.model === null -> throw`).
 */
async function runSummarizeJob(
  id: string,
  merged: MergedSegment[],
  meetingContext?: string,
): Promise<void> {
  const db = getDb();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  // Set when the ceiling fires. The `finally` clears the shared cancel flag,
  // so the summarizer needs its own flag to see that it must stop.
  let deadlineHit = false;
  try {
    // §5.8 ceiling, derived before the first call so the bound is in force
    // for the whole run:
    //   plannedCalls = min(N + 1, MAX_SUMMARIZE_CALLS)   // N map + 1 reduce
    //   deadlineMs   = clamp(perCallMs x plannedCalls x slack(1),
    //                        2 x perCallMs, 4 h)
    // with perCallMs the `meeting_summary_timeout_seconds` value the calls
    // themselves will use (default 600 s -> 1,200 s single-pass floor, 14,400
    // s = the 4 h clamp at the 24-call worst case). Per-call timeouts bound
    // one generation; nothing else here bounds a run.
    const plan = await summarizeJobPlan(merged);
    setProgress(id, { done: 0, total: plan.plannedCalls, failed: 0 });

    const summarize = testOverrides.summarize ?? summarizeMeeting;
    // Race the run against its own ceiling rather than threading a signal
    // through the summarizer: the summarizer's per-call timeouts do the
    // aborting, this only guarantees the job cannot outlive its budget and
    // hold the lane's slot (and the UI's hope) forever.
    const summary = await Promise.race([
      summarize(merged, {
        ...(meetingContext !== undefined ? { meetingContext } : {}),
        // §5.7: polled between map chunks, and honoured inside
        // `acquireLlmLane` — a call still QUEUED when the user cancels never
        // goes on the wire.
        shouldStop: () => deadlineHit || isCancelRequested(id),
        onQueued: (info) =>
          updateProgress(id, {
            queued: { ahead: info.ahead, sinceMs: info.waitedMs },
          }),
        onProgress: (p) => updateProgress(id, { done: p.done, total: p.total }),
      }),
      new Promise<never>((_, reject) => {
        deadlineTimer = setTimeout(() => {
          deadlineHit = true;
          reject(
            new Error(
              `Summarize exceeded its ${Math.round(plan.deadlineMs / 1000)}s job ceiling`,
            ),
          );
        }, plan.deadlineMs);
      }),
    ]);
    if (deadlineTimer) clearTimeout(deadlineTimer);

    db.prepare(
      `INSERT OR REPLACE INTO meeting_summaries
         (meeting_id, markdown, llm_provider, llm_model, input_tokens,
          output_tokens, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      summary.markdown,
      summary.llmProvider,
      summary.llmModel,
      summary.inputTokens,
      summary.outputTokens,
      summary.costUsd,
      Date.now(),
    );
    db.prepare("UPDATE meetings SET status = 'summarized' WHERE id = ?").run(
      id,
    );
    clearJobFailure(id);
    log.info(
      `meeting ${id}: summarized (${summary.llmProvider ?? "?"}/${summary.llmModel ?? "?"}, ${summary.inputTokens} in / ${summary.outputTokens} out)`,
    );
  } catch (err) {
    const message = errorMessage(err);
    // A cancel that landed mid-run reads as a cancellation, not a failure of
    // the model — same canonical wording as the transcribe job's.
    const text = isCancelRequested(id) ? "Cancelled by user" : message;
    setJobFailure(id, text);
    if (isCancelRequested(id)) {
      log.info(`meeting ${id}: summarize cancelled by user`);
    } else {
      log.error(`meeting ${id}: summarize failed: ${text}`);
    }
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    releaseJob(id);
  }
}

export type { MeetingRow };

const startSchema = z.object({
  id: z.string().min(1).max(128),
  title: z.string().max(512).optional(),
  audio_dir: z.string().max(4096),
  started_at: z.number().int(),
});

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
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.language !== undefined ||
      v.context !== undefined,
    { message: "Provide title, language, or context" },
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

const meetings = new Hono()
  .get("/", (c) => {
    const db = getDb();
    const rows = db
      .prepare(
        "SELECT * FROM meetings ORDER BY created_at DESC, id DESC LIMIT 200",
      )
      .all() as unknown as MeetingRow[];
    return c.json({ items: rows, total: rows.length });
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
    const { id, title, audio_dir, started_at } = c.req.valid("json");
    const db = getDb();
    db.prepare(
      `INSERT INTO meetings (id, title, started_at, status, audio_dir, created_at)
       VALUES (?, ?, ?, 'recording', ?, ?)`,
    ).run(id, title ?? null, started_at, audio_dir, Date.now());
    return c.json({ ok: true, id });
  })
  // Rename a meeting and/or set its transcription language (Phase A2's
  // editable language chip). Runs whichever UPDATEs the body actually
  // supplied — re-transcribe/retry-failed always read whatever is
  // currently stored, so a language edit takes effect on the next run with
  // no other wiring.
  .patch("/:id", zValidator("json", renameSchema), (c) => {
    const id = c.req.param("id");
    const { title, language, context } = c.req.valid("json");
    const db = getDb();
    const sets: string[] = [];
    const values: (string | null)[] = [];
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
    const result = db
      .prepare(`UPDATE meetings SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values, id);
    if (result.changes === 0) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true, title, language, context });
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
      return c.json({ error: "Transcription already running" }, 409);
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
    claimJob(id, "transcribe", { done: 0, total: 0, failed: 0 });
    // A full re-transcribe supersedes any earlier background-job failure —
    // without this, a stale "Summary failed" note would keep rendering next to
    // a brand-new transcription run.
    clearJobFailure(id);
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
    // bounded in-request local-model run, not a chunked STT job. Same for an
    // in-request /enhance (no stop seam of its own). The async summarize job
    // IS cancellable: its `shouldStop` seam is the same flag (§5.7).
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
      return c.json({ error: "Transcription already running" }, 409);
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
      const baseDeps = await buildTranscriberDeps({
        isDictationActive,
        shouldStop: () => isCancelRequested(id),
        // Chunk idx here is positional within the retry batch, so key the
        // update on (source, start, end) — stable across runs. Phase A1
        // leak check applies here too, via the same shared helper
        // persistChunk uses, so a leak surfacing on a retry is caught
        // exactly as it would be on the original pass.
        onChunk: (chunk) => {
          const { text, status } = leakCheckedTextAndStatus(chunk, vocabTerms);
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
      });
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
      return c.json({ error: "Transcription already running" }, 409);
    }
    if (!row.audio_dir) {
      return c.json({ error: "Meeting has no audio directory" }, 409);
    }
    const wavPath = join(row.audio_dir, "system.wav");
    if (!existsSync(wavPath)) {
      return c.json({ error: "System audio is no longer on disk" }, 409);
    }

    const audioDir = row.audio_dir;
    const deps = testOverrides.diarizeDeps ?? createDefaultDiarizeDeps();

    // Claim the concurrency slot *before* the pre-flight probe, not after:
    // probeDiarizationModels awaits a real spawn (up to PROBE_TIMEOUT_MS),
    // and a /transcribe or a second /diarize landing in that window would
    // otherwise see hasJob(id) === false and race this pass — the
    // second one's runDiarizationPass BEGINs a transaction on the same
    // shared db connection this one already holds open, and its ROLLBACK
    // on failure would discard labels this pass just committed. Every
    // early return below is inside the try/finally so the slot is always
    // released, including on the not-ready path.
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
        // (specs/meeting-speaker-naming.md §5.2/§5.3).
        suggestedKind: row?.suggested_kind === "role" ? "role" : "name",
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
      db.exec("BEGIN");
      try {
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
        // (enhance.ts), which never touches this column.
        db.prepare(
          `INSERT INTO meeting_speakers (meeting_id, speaker_label, display_name, merged_into, updated_at, confirmed_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(meeting_id, speaker_label) DO UPDATE SET
             display_name = excluded.display_name,
             merged_into = excluded.merged_into,
             updated_at = excluded.updated_at,
             confirmed_at = excluded.confirmed_at`,
        ).run(id, label, newDisplayName, newMergedInto, now, now);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }

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
  // Summarize the merged transcript. 202 + background job + poll (spec
  // §5.6): the call used to run in-request, which held an HTTP connection —
  // and the renderer's whole click — open for up to `calls x 600 s` of local
  // inference. Same contract as POST /:id/transcribe: claim the shared
  // concurrency slot before the first await, kick the job, poll GET /:id for
  // `job` (progress/queued) and for the persisted `summary`.
  .post("/:id/summarize", (c) => {
    const id = c.req.param("id");
    const row = getMeetingRow(id);
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.status !== "transcribed" && row.status !== "summarized") {
      return c.json({ error: "Meeting has no transcript to summarize" }, 409);
    }
    // Same shared job registry /transcribe, /retry-failed, /diarize and
    // /enhance check — and the guard that closes spec §2.4: this route used to
    // check nothing, so two double-clicks ran two map/reduce runs and the
    // second one's INSERT OR REPLACE clobbered the first.
    if (hasJob(id)) {
      return c.json({ error: "A job is already running" }, 409);
    }
    const merged = loadMergedTranscript(id, row.audio_dir);
    if (merged.length === 0) {
      return c.json({ error: "Transcript is empty" }, 409);
    }
    // Claim before the first await (the diarize rationale at the same spot in
    // POST /:id/diarize applies verbatim): `loadMergedTranscript` and every
    // guard above are synchronous, so nothing can slip between the check above
    // and this set. Everything the job does afterwards is inside its own
    // try/finally.
    claimJob(id, "summarize", { done: 0, total: 0, failed: 0 });
    clearJobFailure(id);
    void runSummarizeJob(id, merged, row.context ?? undefined);
    return c.json({ ok: true, id }, 202);
  })
  // Phase C (specs/meeting-transcription-quality.md §6.4): LLM cleanup pass
  // over the merged transcript, in-request like /summarize and /diarize —
  // one bounded LLM call (or a handful, chunked) per meeting, not a
  // multi-chunk job that needs progress polling. Never destructive: only
  // ever UPDATEs meeting_segments.enhanced_text on existing rows.
  .post("/:id/enhance", async (c) => {
    const id = c.req.param("id");
    const row = getMeetingRow(id);
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.status !== "transcribed" && row.status !== "summarized") {
      return c.json({ error: "Meeting has no transcript to enhance" }, 409);
    }
    // Same shared job registry /transcribe, /retry-failed and /diarize
    // already check — an enhance pass reading meeting_segments mid-write
    // from a running transcribe job would see a half-written transcript.
    if (hasJob(id)) {
      return c.json({ error: "Transcription already running" }, 409);
    }
    const merged = loadMergedTranscript(id, row.audio_dir);
    if (merged.length === 0) {
      return c.json({ error: "Transcript is empty" }, 409);
    }
    // Claim the shared concurrency slot before the first await, exactly like
    // /diarize above (the claim-before-await discipline documented there is
    // what makes the `hasJob(id)` check real): without it, spec §2.3,
    // two concurrent POST /:id/enhance both passed the check and both wrote
    // enhanced_text — and an Enhance reading meeting_segments while a
    // /transcribe job is mid-write sees a half-written transcript.
    claimJob(id, "enhance", { done: 0, total: 0, failed: 0 });
    try {
      const enhance = testOverrides.enhance ?? enhanceMeetingTranscript;
      const result = await enhance(
        id,
        merged,
        row.language ?? undefined,
        loadVocabularyTerms(),
        row.title ?? undefined,
        row.context ?? undefined,
      );
      // A pass in which EVERY chunk failed is not a success. Fail-closed per
      // chunk stays (one bad chunk must never kill a meeting), but until now
      // its only visible output was `correctedCount: 0` — which the renderer
      // reads as "No segments needed correction." On the user's machine that
      // meant a slow local engine that timed out all three chunks was reported
      // as a clean transcript. Non-2xx with a machine-readable `reason` is the
      // honest answer; nothing is written, so there is no partial/echo
      // `enhanced_text` to undo (a failed chunk never reaches the UPDATE).
      if (
        result.chunksAttempted > 0 &&
        result.chunksSucceeded === 0 &&
        !result.stoppedEarly
      ) {
        const reason = result.firstFailure?.reason ?? "provider";
        const detail =
          result.firstFailure?.detail ?? "no chunk produced a usable response";
        log.error(
          `meeting ${id}: enhance failed — all ${result.chunksAttempted} chunks failed (${reason}: ${detail})`,
        );
        return c.json(
          {
            ok: false,
            error: `Enhance failed: ${reason}`,
            reason,
            detail,
            correctedCount: 0,
            chunksAttempted: result.chunksAttempted,
            chunksSucceeded: 0,
            chunksFailed: result.chunksFailed,
            partial: false,
          },
          502,
        );
      }
      if (row.audio_dir) writeTranscriptMarkdown(id, row.audio_dir);
      // `partial` is the second honest state: some chunks corrected, some did
      // not. The pass is a success but must not read as a complete one.
      // `stopped_early` distinguishes "the user cancelled it" from "chunks
      // failed on their own" — the renderer must not call a cancel a failure.
      return c.json({
        ok: true,
        correctedCount: result.correctedCount,
        speakerSuggestions: result.speakerSuggestions,
        chunksAttempted: result.chunksAttempted,
        chunksSucceeded: result.chunksSucceeded,
        chunksFailed: result.chunksFailed,
        partial: result.chunksFailed > 0,
        stopped_early: result.stoppedEarly,
      });
    } catch (err) {
      const message = errorMessage(err);
      log.error(`meeting ${id}: enhance failed: ${message}`);
      return c.json({ error: message }, 500);
    } finally {
      // Every exit path — success, throw, and any early return added hereafter
      // — releases the slot. A leaked slot means this meeting can never
      // transcribe, diarize, summarize or enhance again until the app quits.
      releaseJob(id);
    }
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
        }
      | undefined;
    return c.json({
      ...row,
      /** Live job progress, or null when no job is running. `kind` names the
       * holder so the renderer can tell a cancellable summarize job from a
       * non-cancellable diarize/enhance pass without a second round-trip. */
      job: getJob(id),
      /** Canonical failure of the last background job whose slot this meeting
       * had (currently only Summarize), or null. Kept out of `meetings.error`
       * on purpose — see `job-registry.ts`. */
      job_error: getJobFailure(id) ?? null,
      segment_counts: { total: counts.total, failed: counts.failed ?? 0 },
      summary: summary ?? null,
    });
  })
  .delete("/:id", (c) => {
    const db = getDb();
    const id = c.req.param("id");
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
    clearJobFailure(id);
    return c.json({ ok: true });
  });

export default meetings;
