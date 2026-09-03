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
 * Memory note: same ~3–4× worst case as `transcribe-file.ts` — `formData()`
 * buffers the body, `arrayBuffer()` copies it, and the decode helper
 * collects ffmpeg stdout (capped at 1 GiB). Never log the client filename:
 * it is untrusted and may carry personal data.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { createAppLogger } from "@openstyle/utils";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  AudioDecodeError,
  decodeToWav16kMono,
  needsDecode,
} from "../lib/audio/decode.js";
import {
  ACCEPTED_EXTENSIONS_DETAIL,
  ACCEPTED_IMPORT_EXTENSIONS,
  formatLimit,
  importFileExtension,
  MAX_IMPORT_BYTES,
} from "../lib/audio/import-limits.js";
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

export function createMeetingsImportRoute(opts: { maxBytes?: number } = {}) {
  const maxBytes = opts.maxBytes ?? MAX_IMPORT_BYTES;
  const tooLargeDetail = `Maximum upload size is ${formatLimit(maxBytes)}`;

  return new Hono().post(
    "/import",
    bodyLimit({
      maxSize: maxBytes,
      onError: (c) =>
        c.json(
          {
            error: "File too large",
            detail: tooLargeDetail,
            code: "PAYLOAD_TOO_LARGE",
          },
          413,
        ),
    }),
    async (c) => {
      const contentType = c.req.header("content-type") ?? "";
      if (!contentType.includes("multipart/form-data")) {
        return c.json({ error: "Expected multipart/form-data" }, 400);
      }
      let form: FormData;
      try {
        form = await c.req.formData();
      } catch {
        return c.json({ error: "Malformed multipart form data" }, 400);
      }

      const audioFile = form.get("audio");
      if (!(audioFile instanceof File)) {
        return c.json({ error: "audio field missing or not a file" }, 400);
      }

      const id = form.get("id");
      if (typeof id !== "string" || !UUID_RE.test(id)) {
        return c.json({ error: "id must be a UUID" }, 400);
      }

      const audioDirRaw = form.get("audio_dir");
      if (
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

      const titleRaw = form.get("title");
      if (titleRaw !== null && typeof titleRaw !== "string") {
        return c.json({ error: "title must be a string" }, 400);
      }
      const title = (titleRaw ?? "").trim();
      if (title.length > MAX_TITLE_CHARS) {
        return c.json(
          { error: `title must be at most ${MAX_TITLE_CHARS} characters` },
          400,
        );
      }

      const startedAtRaw = form.get("started_at");
      let startedAt: number | undefined;
      if (startedAtRaw !== null) {
        const n = Number(startedAtRaw);
        if (typeof startedAtRaw !== "string" || !Number.isSafeInteger(n)) {
          return c.json(
            { error: "started_at must be an integer (ms since epoch)" },
            400,
          );
        }
        startedAt = n;
      }

      const ext = importFileExtension(audioFile.name);
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

      const bytes = new Uint8Array(await audioFile.arrayBuffer());
      if (bytes.length === 0) {
        return c.json({ error: "Empty audio data" }, 400);
      }
      log.debug(
        `meeting ${id}: received file: ${bytes.length} bytes, ext=${ext} header=${Buffer.from(
          bytes.subarray(0, 4),
        ).toString("hex")}`,
      );

      let wav: Uint8Array;
      try {
        const needed = needsDecode(bytes);
        wav = needed ? await decodeToWav16kMono(bytes) : bytes;
        log.debug(
          `meeting ${id}: decode=${needed} (${bytes.length} -> ${wav.length} bytes)`,
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

      // Duration in memory, before anything touches disk: an unparseable
      // WAV must fail without leaving a half-open meeting behind. A valid
      // but zero-duration WAV imports as a 0 ms meeting (the row is still
      // well-formed; the transcribe job simply finds no segments).
      let durationMs: number;
      try {
        durationMs = Math.round(wavDurationMs(parseWavHeader(wav)));
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
      // Only after decode + validation: create the dir, write the file,
      // insert the row. On any failure, best-effort remove the dir so a
      // retry isn't 409-blocked (it was empty or ours; nothing to lose).
      try {
        mkdirSync(audioDir, { recursive: true });
        writeFileSync(join(audioDir, "system.wav"), wav);
        db.prepare(
          `INSERT INTO meetings (id, title, started_at, ended_at, duration_ms,
                                status, audio_dir, created_at)
           VALUES (?, ?, ?, ?, ?, 'recorded', ?, ?)`,
        ).run(
          id,
          title || stem(audioFile.name, ext) || null,
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
        `meeting ${id}: imported ${bytes.length} -> ${wav.length} bytes, ${durationMs} ms`,
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
    },
  );
}

/** Filename minus its extension: "memo.m4a" → "memo" ("" for a bare ".wav"). */
function stem(name: string, ext: string): string {
  return name.slice(0, name.length - ext.length - 1);
}

const meetingsImportRoute = createMeetingsImportRoute();

export default meetingsImportRoute;
