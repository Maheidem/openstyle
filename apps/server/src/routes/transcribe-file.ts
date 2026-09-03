/**
 * `POST /api/transcribe/file` — import an audio/video file for transcription.
 *
 * Accepts a `multipart/form-data` upload (`audio` part; the filename carries
 * the extension), normalizes it to 16 kHz mono PCM16 WAV with the bundled
 * ffmpeg when needed, then runs *exactly* the dictation pipeline
 * (`lib/transcription-pipeline.ts`): same provider/model/language resolution,
 * same LLM cleanup, same history row. Sibling of `routes/transcribe.ts`, not
 * a fork of it.
 *
 * Memory note: this handler holds up to ~3–4× the upload in memory for a
 * worst-case input — `formData()` buffers the body (~1×), `arrayBuffer()`
 * copies it (~1×), and the decode helper writes a temp file and collects
 * ffmpeg stdout (capped at 1 GiB). The upload itself is bounded by
 * `bodyLimit` (`MAX_IMPORT_BYTES`). Streaming the upload to disk instead is
 * follow-up card `19fcec19`. The dictation lease is also held across
 * decode + STT (single whisper server) — accepted, tracked on the same card.
 *
 * Never log the client filename: it is untrusted and may carry personal data.
 */

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
import { beginDictation, endDictation } from "../lib/dictation-activity.js";
import {
  decodeAppContext,
  runTranscriptionPipeline,
} from "../lib/transcription-pipeline.js";

const log = createAppLogger("transcribe-file");

// Upload limits live in `lib/audio/import-limits.ts` (shared with
// `routes/meetings-import.ts`); re-exported here so this module's public
// surface is unchanged.
export {
  ACCEPTED_IMPORT_EXTENSIONS,
  formatLimit,
  importFileExtension,
  MAX_IMPORT_BYTES,
} from "../lib/audio/import-limits.js";

export function createTranscribeFileRoute(opts: { maxBytes?: number } = {}) {
  const maxBytes = opts.maxBytes ?? MAX_IMPORT_BYTES;
  const tooLargeDetail = `Maximum upload size is ${formatLimit(maxBytes)}`;

  return (
    new Hono()
      // Dictation-activity lease, same as `routes/transcribe.ts`. Hono's
      // `.use("/")` there is an exact-path match and does not cover `/file`,
      // so this router takes its own lease.
      .use("/file", async (_c, next) => {
        beginDictation();
        try {
          await next();
        } finally {
          endDictation();
        }
      })
      .post(
        "/file",
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
          const start = Date.now();

          const contentType = c.req.header("content-type") ?? "";
          if (!contentType.includes("multipart/form-data")) {
            return c.json({ error: "Expected multipart/form-data" }, 400);
          }
          let form: FormData;
          try {
            form = await c.req.formData();
          } catch {
            return c.json({ error: "audio field missing or not a file" }, 400);
          }

          const audioFile = form.get("audio");
          if (!(audioFile instanceof File)) {
            return c.json({ error: "audio field missing or not a file" }, 400);
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

          const bytes = new Uint8Array(await audioFile.arrayBuffer());
          if (bytes.length === 0) {
            return c.json({ error: "Empty audio data" }, 400);
          }

          log.debug(
            `received file: ${bytes.length} bytes, ext=${ext} header=${Buffer.from(
              bytes.subarray(0, 4),
            ).toString("hex")}`,
          );

          let wav: Uint8Array;
          try {
            const needed = needsDecode(bytes);
            wav = needed ? await decodeToWav16kMono(bytes) : bytes;
            log.debug(
              `decode=${needed} (${bytes.length} -> ${wav.length} bytes)`,
            );
          } catch (err) {
            if (err instanceof AudioDecodeError) {
              // Full message (stderr tail) goes to the log only; the client
              // gets a fixed string so no server-side detail leaks.
              log.error(`decode failed (${err.reason}): ${err.message}`);
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

          // Duration from the post-transcode WAV (`fr_f86c5c0f`), rounded to an
          // integer like the dictation route's `(len-44)/32`.
          const audioDurationMs = Math.round(
            wavDurationMs(parseWavHeader(wav)),
          );

          const r = await runTranscriptionPipeline({
            audio: wav,
            audioDurationMs,
            appContext: decodeAppContext(c.req.header("x-app-context")),
            languageOverride: c.req.header("x-dictation-language"),
            skipPostProcess: false,
            start,
          });
          return c.json(r.body, r.status);
        },
      )
  );
}

const transcribeFileRoute = createTranscribeFileRoute();

export default transcribeFileRoute;
