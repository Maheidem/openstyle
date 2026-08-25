import { closeSync, openSync, readFileSync, readSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { zValidator } from "@hono/zod-validator";
import { createAppLogger } from "@openstyle/utils";
import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../lib/db.js";
import { isDictationActive } from "../lib/dictation-activity.js";
import {
  type MergedSegment,
  mergeTranscript,
  type SyncData,
  type TranscriptSegment,
} from "../lib/meetings/merge.js";
import { segmentPcm } from "../lib/meetings/segmenter.js";
import { summarizeMeeting } from "../lib/meetings/summarize.js";
import {
  type ChunkResult,
  createDefaultTranscriberDeps,
  MeetingTranscriber,
  parseWavHeader,
  type TranscriberDeps,
} from "../lib/meetings/transcriber.js";

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
  source: "mic" | "system";
  start_ms: number;
  end_ms: number;
  text: string | null;
  status: string | null;
}

/** Rebuild the merged Me/Them transcript from persisted segments + sync.json. */
function loadMergedTranscript(
  meetingId: string,
  audioDir: string | null,
): MergedSegment[] {
  const rows = getDb()
    .prepare(
      `SELECT source, start_ms, end_ms, text, status FROM meeting_segments
       WHERE meeting_id = ? ORDER BY idx`,
    )
    .all(meetingId) as unknown as SegmentRow[];
  const channel = (source: "mic" | "system"): TranscriptSegment[] =>
    rows
      .filter((r) => r.source === source && r.status === "ok" && r.text)
      .map((r) => ({
        startMs: r.start_ms,
        endMs: r.end_ms,
        text: r.text as string,
      }));
  const sync = audioDir ? loadSyncData(audioDir) : undefined;
  return mergeTranscript(channel("mic"), channel("system"), sync);
}

function persistChunk(meetingId: string, chunk: ChunkResult): void {
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
      chunk.text,
      chunk.status,
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
    const micSegments = mic ? segmentPcm(mic.pcm, mic.sampleRate) : [];
    const systemSegments = system
      ? segmentPcm(system.pcm, system.sampleRate)
      : [];
    const total = micSegments.length + systemSegments.length;
    activeJobs.set(id, { done: 0, total, failed: 0 });

    const deps = await buildTranscriberDeps({
      isDictationActive,
      onChunk: (chunk) => persistChunk(id, chunk),
      onProgress: (p) => activeJobs.set(id, p),
    });
    // Resolve once up front: stamps provider/model on the row and fails fast
    // (before any STT call) when no voice model or key is configured.
    const config = deps.resolveConfig();
    db.prepare(
      "UPDATE meetings SET stt_provider = ?, stt_model = ? WHERE id = ?",
    ).run(config.providerId, config.modelId, id);

    const results = await new MeetingTranscriber(deps).run({
      meetingDir: audioDir,
      micSegments,
      systemSegments,
    });
    const failed = results.filter((r) => r.status === "failed").length;
    db.prepare("UPDATE meetings SET status = ?, error = ? WHERE id = ?").run(
      "transcribed",
      failed > 0 ? `${failed} of ${results.length} chunks failed` : null,
      id,
    );
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
  error: string | null;
  created_at: number | null;
}

const startSchema = z.object({
  id: z.string().min(1).max(128),
  title: z.string().max(512).optional(),
  audio_dir: z.string().max(4096),
  started_at: z.number().int(),
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
  .post("/start", zValidator("json", startSchema), (c) => {
    const { id, title, audio_dir, started_at } = c.req.valid("json");
    const db = getDb();
    db.prepare(
      `INSERT INTO meetings (id, title, started_at, status, audio_dir, created_at)
       VALUES (?, ?, ?, 'recording', ?, ?)`,
    ).run(id, title ?? null, started_at, audio_dir, Date.now());
    return c.json({ ok: true, id });
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
    try {
      const deps = await buildTranscriberDeps({
        isDictationActive,
        // Chunk idx here is positional within the retry batch, so key the
        // update on (source, start, end) — stable across runs.
        onChunk: (chunk) =>
          update.run(
            chunk.text,
            chunk.status,
            id,
            chunk.source,
            chunk.startMs,
            chunk.endMs,
          ),
      });
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
      return c.json({ ok: true, retried: results.length, failed: stillFailed });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
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
