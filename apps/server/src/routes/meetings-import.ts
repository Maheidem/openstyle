/**
 * `POST /api/meetings/import` — import an existing audio/video file as a
 * full meeting record (specs/meeting-import.md).
 *
 * Accepts a `multipart/form-data` upload (`audio` file + `id` + `audio_dir`
 * + optional `title`/`started_at`), normalizes it to 16 kHz mono PCM16 WAV
 * with the bundled ffmpeg when needed, writes it to
 * `<audio_dir>/system.wav` and inserts a `meetings` row in `recorded`
 * status — the exact state a `/start` → `/stop` recording leaves behind — so
 * the whole downstream machinery (transcribe → diarize → name → summarize,
 * retention, delete, export) applies unchanged. Deliberately **no**
 * `mic.wav`/`sync.json`: the pipeline already tolerates a missing mic
 * channel, and the diarizer only reads the system channel, so an imported
 * mixed recording gets `Them 1..N` labels the user can rename.
 *
 * Mounted as a sibling router at the same `/meetings` prefix
 * (`routes/index.ts`), internal path `/import` — mirroring how
 * `transcribe-file.ts` hangs off `/transcribe`. A separate router means no
 * `/:id` ordering hazard.
 *
 * Deviations from `transcribe-file.ts`, both deliberate: no
 * dictation-activity lease (import only decodes and writes one file; it
 * contends with nothing the lease guards), and a 409 guard before any
 * decode work (row id collision, or a non-empty target directory — the
 * load-bearing protection for a live recording's folder).
 *
 * Memory: the upload streams to a temp file, ffmpeg decodes file → file, and
 * `system.wav` is placed by rename — the audio is never held in memory on the
 * happy path at all (specs/import-streaming.md). The byte bound is enforced
 * while streaming (`lib/audio/multipart-stream.ts`, replacing
 * `hono/body-limit`, which itself buffered chunked bodies).
 *
 * Never log the client filename: it is untrusted and may carry personal data.
 */

import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { createAppLogger } from "@openstyle/utils";
import { Hono } from "hono";
import {
  AudioDecodeError,
  decodeFileToWav16kMono,
  needsDecodeFile,
} from "../lib/audio/decode.js";
import {
  ACCEPTED_EXTENSIONS_DETAIL,
  ACCEPTED_IMPORT_EXTENSIONS,
  formatLimit,
  importFileExtension,
  MAX_IMPORT_BYTES,
} from "../lib/audio/import-limits.js";
import {
  extractBoundary,
  MultipartStreamError,
  requestBodyTooLarge,
  type StreamedFilePart,
  streamMultipartForm,
} from "../lib/audio/multipart-stream.js";
import { parseWavHeader, wavDurationMs } from "../lib/audio/wav.js";
import { getDb } from "../lib/db.js";

const log = createAppLogger("meetings-import");

/**
 * Any UUID version, not just v4: the only client (`crypto.randomUUID()`)
 * always sends v4, but the shape check — not the version nibble — is what
 * keeps `basename(audio_dir) === id` from smuggling a path separator.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_TITLE_CHARS = 512; // mirrors startSchema's z.string().max(512)

function tooLargeBody(maxBytes: number) {
  return {
    error: "File too large",
    detail: `Maximum upload size is ${formatLimit(maxBytes)}`,
    code: "PAYLOAD_TOO_LARGE",
  } as const;
}

/** Header info of an on-disk WAV (`parseWavHeader` accepts an open fd). */
function wavInfoAt(path: string) {
  const fd = openSync(path, "r");
  try {
    return parseWavHeader(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Move `src` to `dst` without ever holding it in memory: rename when the two
 * paths share a filesystem, else a kernel-side copy (then drop the source).
 */
function placeWavFile(src: string, dst: string): void {
  try {
    renameSync(src, dst);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    copyFileSync(src, dst);
    unlinkSync(src);
  }
}

export function createMeetingsImportRoute(opts: { maxBytes?: number } = {}) {
  const maxBytes = opts.maxBytes ?? MAX_IMPORT_BYTES;

  return new Hono().post("/import", async (c) => {
    // Known-size over-limit uploads are rejected on the header alone — the
    // same fast path `bodyLimit` provided. Chunked bodies are bounded while
    // streaming, inside the multipart parser.
    if (
      requestBodyTooLarge(
        c.req.header("content-length"),
        c.req.header("transfer-encoding"),
        maxBytes,
      )
    ) {
      return c.json(tooLargeBody(maxBytes), 413);
    }

    const contentType = c.req.header("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      return c.json({ error: "Expected multipart/form-data" }, 400);
    }

    const tempDir = mkdtempSync(join(tmpdir(), "openstyle-import-"));
    try {
      let files: Map<string, StreamedFilePart>;
      let fields: Map<string, string>;
      try {
        ({ files, fields } = await streamMultipartForm(
          c.req.raw.body,
          extractBoundary(contentType),
          { maxTotalBytes: maxBytes, tempDir },
        ));
      } catch (err) {
        if (err instanceof MultipartStreamError) {
          if (err.kind === "too_large") {
            return c.json(tooLargeBody(maxBytes), 413);
          }
          // Same envelope the `formData()` failure path produced.
          return c.json({ error: "Malformed multipart form data" }, 400);
        }
        throw err;
      }

      const audio = files.get("audio");
      if (!audio) {
        return c.json({ error: "audio field missing or not a file" }, 400);
      }

      // A file part where a text part is expected must land in today's
      // type-check branches, not silently pass as a field value.
      const id = fields.get("id");
      if (files.has("id") || typeof id !== "string" || !UUID_RE.test(id)) {
        return c.json({ error: "id must be a UUID" }, 400);
      }

      const audioDirRaw = fields.get("audio_dir");
      if (
        files.has("audio_dir") ||
        typeof audioDirRaw !== "string" ||
        !isAbsolute(audioDirRaw) ||
        basename(audioDirRaw) !== id
      ) {
        return c.json(
          {
            error:
              "audio_dir must be an absolute path whose basename equals id",
          },
          400,
        );
      }
      const audioDir = audioDirRaw;

      const titleRaw = fields.get("title");
      if (files.has("title")) {
        return c.json({ error: "title must be a string" }, 400);
      }
      const title = (titleRaw ?? "").trim();
      if (title.length > MAX_TITLE_CHARS) {
        return c.json(
          { error: `title must be at most ${MAX_TITLE_CHARS} characters` },
          400,
        );
      }

      const startedAtRaw = fields.get("started_at");
      let startedAt: number | undefined;
      if (startedAtRaw !== undefined || files.has("started_at")) {
        const n = Number(startedAtRaw);
        if (
          files.has("started_at") ||
          typeof startedAtRaw !== "string" ||
          !Number.isSafeInteger(n)
        ) {
          return c.json(
            { error: "started_at must be an integer (ms since epoch)" },
            400,
          );
        }
        startedAt = n;
      }

      const ext = importFileExtension(audio.filename);
      if (!ext || !ACCEPTED_IMPORT_EXTENSIONS.has(ext)) {
        return c.json(
          {
            error: "Unsupported file type",
            detail: ACCEPTED_EXTENSIONS_DETAIL,
            code: "UNSUPPORTED_MEDIA_TYPE",
          },
          415,
        );
      }

      const db = getDb();
      const existing = db
        .prepare("SELECT 1 FROM meetings WHERE id = ?")
        .get(id);
      if (existing) {
        return c.json({ error: "A meeting with this id already exists" }, 409);
      }
      // The load-bearing guard: never write into a live recording's
      // directory. An existing *empty* dir is fine (nothing to clobber).
      if (existsSync(audioDir) && readdirSync(audioDir).length > 0) {
        return c.json(
          { error: "Audio directory already exists and is not empty" },
          409,
        );
      }

      if (audio.bytes === 0) {
        return c.json({ error: "Empty audio data" }, 400);
      }
      log.debug(
        `meeting ${id}: received file: ${audio.bytes} bytes, ext=${ext}`,
      );

      let wavPath = audio.path;
      try {
        const needed = needsDecodeFile(audio.path);
        if (needed) {
          wavPath = join(tempDir, "decoded.wav");
          await decodeFileToWav16kMono(audio.path, wavPath);
        }
        log.debug(
          `meeting ${id}: decode=${needed} (${audio.bytes} -> ${statSync(wavPath).size} bytes)`,
        );
      } catch (err) {
        if (err instanceof AudioDecodeError) {
          // Full message (stderr tail) goes to the log only; the client
          // gets a fixed string so no server-side detail leaks.
          log.error(
            `meeting ${id}: decode failed (${err.reason}): ${err.message}`,
          );
          return c.json(
            {
              error: "Audio decode failed",
              detail: "ffmpeg could not decode the file",
              code: err.code,
              reason: err.reason,
            },
            422,
          );
        }
        throw err;
      }

      // Duration from the on-disk WAV, before anything touches the target
      // dir: an unparseable WAV must fail without leaving a half-open
      // meeting behind. A valid but zero-duration WAV imports as a 0 ms
      // meeting (the row is still well-formed; the transcribe job simply
      // finds no segments).
      let durationMs: number;
      try {
        durationMs = Math.round(wavDurationMs(wavInfoAt(wavPath)));
      } catch (err) {
        log.error(`meeting ${id}: WAV not parseable: ${String(err)}`);
        return c.json(
          {
            error: "Audio decode failed",
            detail: "ffmpeg could not decode the file",
            code: "AUDIO_DECODE_FAILED",
            reason: "decode_failed",
          },
          422,
        );
      }

      const startedAtValue = startedAt ?? Date.now();
      // Only after decode + validation: create the dir, place the WAV,
      // insert the row. On any failure, best-effort remove the dir so a
      // retry isn't 409-blocked (it was empty or ours; nothing to lose).
      try {
        mkdirSync(audioDir, { recursive: true });
        placeWavFile(wavPath, join(audioDir, "system.wav"));
        db.prepare(
          `INSERT INTO meetings (id, title, started_at, ended_at, duration_ms,
                                status, audio_dir, created_at)
           VALUES (?, ?, ?, ?, ?, 'recorded', ?, ?)`,
        ).run(
          id,
          title || stem(audio.filename, ext) || null,
          startedAtValue,
          startedAtValue + durationMs,
          durationMs,
          audioDir,
          Date.now(),
        );
      } catch (err) {
        log.error(`meeting ${id}: import failed: ${String(err)}`);
        try {
          rmSync(audioDir, { recursive: true, force: true });
        } catch {
          // Cleanup is best-effort; the original error is the real failure.
        }
        throw err;
      }

      const row = db
        .prepare("SELECT * FROM meetings WHERE id = ?")
        .get(id) as Record<string, unknown>;
      log.info(
        `meeting ${id}: imported ${audio.bytes} -> ${
          statSync(join(audioDir, "system.wav")).size
        } bytes, ${durationMs} ms`,
      );
      // Fresh-import response in the exact GET /:id shape so the renderer
      // drops it into its MeetingDetail type with no second fetch. job/
      // segment_counts/summary are definitionally empty for a new row —
      // the DB row alone doesn't carry them, so construct them here.
      return c.json(
        {
          ...row,
          job: null,
          segment_counts: { total: 0, failed: 0 },
          summary: null,
        },
        201,
      );
    } finally {
      // Never let cleanup mask the real error: on Windows files can stay
      // locked (EBUSY) briefly after a SIGKILL.
      try {
        rmSync(tempDir, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch (err) {
        console.warn(
          `[meetings-import] failed to remove temp dir ${tempDir}: ${(err as Error).message}`,
        );
      }
    }
  });
}

/** Filename minus its extension: "memo.m4a" → "memo" ("" for a bare ".wav"). */
function stem(name: string, ext: string): string {
  return name.slice(0, name.length - ext.length - 1);
}

const meetingsImportRoute = createMeetingsImportRoute();

export default meetingsImportRoute;
