import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { zValidator } from "@hono/zod-validator";
import { createAppLogger } from "@openstyle/utils";
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
import { resolveMeetingLanguage } from "../lib/meetings/language.js";
import {
  formatTranscriptMarkdown,
  isVocabLeak,
  type MergedSegment,
  mergeTranscript,
  type SyncData,
  type TranscriptSegment,
} from "../lib/meetings/merge.js";
import { mergeSegmentsToward, segmentPcm } from "../lib/meetings/segmenter.js";
import { summarizeMeeting } from "../lib/meetings/summarize.js";
import {
  type ChunkResult,
  createDefaultTranscriberDeps,
  MeetingTranscriber,
  parseWavHeader,
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

// ---------------------------------------------------------------------------
// Async transcription jobs
//
// Same shape as the whisper model-download precedent
// (lib/whisper/models.ts `activeDownloads`): an in-memory map keyed by
// meeting id, the job kicked fire-and-forget from the route, progress polled
// via GET /:id. One job per meeting at a time.
// ---------------------------------------------------------------------------

export interface MeetingJobProgress {
  done: number;
  total: number;
  failed: number;
}

const activeJobs = new Map<string, MeetingJobProgress>();

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
  /** Phase C (specs/meeting-transcription-quality.md §6): injected LLM-call
   * dependency for POST /:id/enhance and the auto-run call site inside
   * runTranscribeJob, so route tests never touch a real LLM provider. */
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

/** Read a whole WAV channel into PCM16 samples. Returns null when missing. */
function readWavChannel(
  path: string,
): { pcm: Int16Array; sampleRate: number } | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const info = parseWavHeader(fd);
    const data = Buffer.alloc(info.dataLength);
    let read = 0;
    while (read < info.dataLength) {
      const n = readSync(
        fd,
        data,
        read,
        Math.min(1024 * 1024, info.dataLength - read),
        info.dataOffset + read,
      );
      if (n <= 0) break;
      read += n;
    }
    return {
      pcm: new Int16Array(data.buffer, data.byteOffset, Math.floor(read / 2)),
      sampleRate: info.sampleRate,
    };
  } finally {
    closeSync(fd);
  }
}

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
  return mergeTranscript(
    channel("mic"),
    channel("system"),
    sync,
    loadVocabularyTerms(),
  );
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
  extras: Pick<TranscriberDeps, "isDictationActive" | "onChunk" | "onProgress">,
): Promise<TranscriberDeps> {
  const factory =
    testOverrides.createTranscriberDeps ?? createDefaultTranscriberDeps;
  return factory(extras);
}

/** The background transcription job for one meeting. Never throws. */
async function runTranscribeJob(id: string, audioDir: string): Promise<void> {
  const db = getDb();
  try {
    const mic = readWavChannel(join(audioDir, "mic.wav"));
    const system = readWavChannel(join(audioDir, "system.wav"));
    if (!mic && !system) {
      throw new Error(`No audio files found in ${audioDir}`);
    }
    // Phase B (specs/meeting-transcription-quality.md §5): merge VAD output
    // toward a ~20-25s target per channel before transcription — pure
    // post-processing over segmentPcm's already-detected boundaries, mic
    // and system merged independently (never bridged across channels).
    const micSegments = mic
      ? mergeSegmentsToward(segmentPcm(mic.pcm, mic.sampleRate))
      : [];
    const systemSegments = system
      ? mergeSegmentsToward(segmentPcm(system.pcm, system.sampleRate))
      : [];
    const total = micSegments.length + systemSegments.length;
    activeJobs.set(id, { done: 0, total, failed: 0 });

    // Loaded once per job, not per chunk — vocabulary rarely changes
    // mid-meeting and loadVocabularyTerms() hits the DB.
    const vocabTerms = loadVocabularyTerms();
    const deps = await buildTranscriberDeps({
      isDictationActive,
      onChunk: (chunk) => persistChunk(id, chunk, vocabTerms),
      onProgress: (p) => activeJobs.set(id, p),
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
      await enhance(
        id,
        loadMergedTranscript(id, audioDir),
        resolvedLanguage,
        vocabTerms,
      ).catch((err) => {
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
    const message = err instanceof Error ? err.message : String(err);
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
    activeJobs.delete(id);
  }
}

export interface MeetingRow {
  id: string;
  title: string | null;
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number | null;
  status: string;
  audio_dir: string | null;
  stt_provider: string | null;
  stt_model: string | null;
  /** Resolved (or user-set) transcription language, Phase A2. NULL means
   * "not yet resolved" — falls back to per-chunk auto or triggers
   * resolution on the next transcribe run. */
  language: string | null;
  error: string | null;
  created_at: number | null;
}

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
  })
  .refine((v) => v.title !== undefined || v.language !== undefined, {
    message: "Provide title or language",
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
  // Boot-time orphan sweep: rows a crash/force-quit left in 'recording'.
  // Registered before "/:id" so "orphans" isn't swallowed by the id matcher.
  .get("/orphans", (c) => {
    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM meetings WHERE status = 'recording'")
      .all() as unknown as MeetingRow[];
    return c.json({ items: rows });
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
    const { title, language } = c.req.valid("json");
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
    const result = db
      .prepare(`UPDATE meetings SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values, id);
    if (result.changes === 0) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true, title, language });
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
  // Kick the async transcription job: 202 immediately, poll GET /:id.
  .post("/:id/transcribe", (c) => {
    const id = c.req.param("id");
    const db = getDb();
    const row = db.prepare("SELECT * FROM meetings WHERE id = ?").get(id) as
      | MeetingRow
      | undefined;
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.status === "recording") {
      return c.json({ error: "Meeting is still recording" }, 409);
    }
    if (activeJobs.has(id)) {
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
    activeJobs.set(id, { done: 0, total: 0, failed: 0 });
    void runTranscribeJob(id, row.audio_dir);
    return c.json({ ok: true, id }, 202);
  })
  // Re-transcribe only the chunks a previous run marked failed.
  .post("/:id/retry-failed", async (c) => {
    const id = c.req.param("id");
    const db = getDb();
    const row = db.prepare("SELECT * FROM meetings WHERE id = ?").get(id) as
      | MeetingRow
      | undefined;
    if (!row) return c.json({ error: "Not found" }, 404);
    if (activeJobs.has(id)) {
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
    try {
      const baseDeps = await buildTranscriberDeps({
        isDictationActive,
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
      const stillFailed = results.filter((r) => r.status === "failed").length;
      db.prepare("UPDATE meetings SET error = ? WHERE id = ?").run(
        stillFailed > 0 ? `${stillFailed} chunks failed` : null,
        id,
      );
      writeTranscriptMarkdown(id, audioDir);
      return c.json({ ok: true, retried: results.length, failed: stillFailed });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
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
    const row = db.prepare("SELECT * FROM meetings WHERE id = ?").get(id) as
      | MeetingRow
      | undefined;
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.status !== "transcribed" && row.status !== "summarized") {
      return c.json({ error: "Meeting has no transcript to diarize" }, 409);
    }
    // Reuse the transcription-job guard (spec §11's concurrency reasoning
    // extends here: the diarizer targets the same on-device ANE resource a
    // running transcribe job's whisper-local pass may also be using) —
    // same map /transcribe and /retry-failed already check. Redundant with
    // but cheap alongside the status check above: a meeting can only reach
    // 'transcribing' status while activeJobs already holds its id (set by
    // /transcribe before the status flip), so this map check is the one
    // guard that actually fires; status is filtered to
    // transcribed/summarized above regardless.
    if (activeJobs.has(id)) {
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
    // otherwise see activeJobs.has(id) === false and race this pass — the
    // second one's runDiarizationPass BEGINs a transaction on the same
    // shared db connection this one already holds open, and its ROLLBACK
    // on failure would discard labels this pass just committed. Every
    // early return below is inside the try/finally so the slot is always
    // released, including on the not-ready path.
    activeJobs.set(id, { done: 0, total: 0, failed: 0 });
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

      // Ignores getMeetingDiarizationEnabledSetting() by design: an
      // explicit "Identify speakers" click wins over the global toggle.
      // The pass only ever UPDATEs speaker_label on already-persisted
      // rows (never DELETEs/INSERTs), so a failure mid-pass can't corrupt
      // existing labels — same graceful-degrade contract as the automatic
      // pass in runTranscribeJob.
      await runDiarizationPass(id, audioDir, deps);
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
      return c.json({ ok: true, labeledCount, speakerCount });
    } catch (err) {
      // Defense-in-depth, matching runTranscribeJob's call site: in normal
      // operation runDiarizationPass degrades in-function and never
      // throws.
      const message = err instanceof Error ? err.message : String(err);
      log.error(`meeting ${id}: identify speakers failed: ${message}`);
      return c.json({ error: message }, 500);
    } finally {
      activeJobs.delete(id);
    }
  })
  // Summarize the merged transcript and persist it. Runs in-request: the
  // renderer awaits the call (retries are cheap and progress is one LLM call
  // for typical meetings).
  .post("/:id/summarize", async (c) => {
    const id = c.req.param("id");
    const db = getDb();
    const row = db.prepare("SELECT * FROM meetings WHERE id = ?").get(id) as
      | MeetingRow
      | undefined;
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.status !== "transcribed" && row.status !== "summarized") {
      return c.json({ error: "Meeting has no transcript to summarize" }, 409);
    }
    const merged = loadMergedTranscript(id, row.audio_dir);
    if (merged.length === 0) {
      return c.json({ error: "Transcript is empty" }, 409);
    }
    try {
      const summarize = testOverrides.summarize ?? summarizeMeeting;
      const result = await summarize(merged);
      db.prepare(
        `INSERT OR REPLACE INTO meeting_summaries
           (meeting_id, markdown, llm_provider, llm_model, input_tokens,
            output_tokens, cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        result.markdown,
        result.llmProvider,
        result.llmModel,
        result.inputTokens,
        result.outputTokens,
        result.costUsd,
        Date.now(),
      );
      db.prepare("UPDATE meetings SET status = 'summarized' WHERE id = ?").run(
        id,
      );
      return c.json({ ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`meeting ${id}: summarize failed: ${message}`);
      return c.json({ error: message }, 500);
    }
  })
  // Phase C (specs/meeting-transcription-quality.md §6.4): LLM cleanup pass
  // over the merged transcript, in-request like /summarize and /diarize —
  // one bounded LLM call (or a handful, chunked) per meeting, not a
  // multi-chunk job that needs progress polling. Never destructive: only
  // ever UPDATEs meeting_segments.enhanced_text on existing rows.
  .post("/:id/enhance", async (c) => {
    const id = c.req.param("id");
    const db = getDb();
    const row = db.prepare("SELECT * FROM meetings WHERE id = ?").get(id) as
      | MeetingRow
      | undefined;
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.status !== "transcribed" && row.status !== "summarized") {
      return c.json({ error: "Meeting has no transcript to enhance" }, 409);
    }
    // Same shared concurrency map /transcribe, /retry-failed and /diarize
    // already check — an enhance pass reading meeting_segments mid-write
    // from a running transcribe job would see a half-written transcript.
    if (activeJobs.has(id)) {
      return c.json({ error: "Transcription already running" }, 409);
    }
    const merged = loadMergedTranscript(id, row.audio_dir);
    if (merged.length === 0) {
      return c.json({ error: "Transcript is empty" }, 409);
    }
    try {
      const enhance = testOverrides.enhance ?? enhanceMeetingTranscript;
      const result = await enhance(
        id,
        merged,
        row.language ?? undefined,
        loadVocabularyTerms(),
      );
      if (row.audio_dir) writeTranscriptMarkdown(id, row.audio_dir);
      return c.json({ ok: true, correctedCount: result.correctedCount });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`meeting ${id}: enhance failed: ${message}`);
      return c.json({ error: message }, 500);
    }
  })
  // Merged, speaker-labeled ("Me"/"Them") transcript.
  .get("/:id/transcript", (c) => {
    const id = c.req.param("id");
    const db = getDb();
    const row = db.prepare("SELECT * FROM meetings WHERE id = ?").get(id) as
      | MeetingRow
      | undefined;
    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json({ segments: loadMergedTranscript(id, row.audio_dir) });
  })
  .get("/:id", (c) => {
    const db = getDb();
    const id = c.req.param("id");
    const row = db.prepare("SELECT * FROM meetings WHERE id = ?").get(id) as
      | MeetingRow
      | undefined;
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
      /** Live transcription progress, or null when no job is running. */
      job: activeJobs.get(id) ?? null,
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
    return c.json({ ok: true });
  });

export default meetings;
