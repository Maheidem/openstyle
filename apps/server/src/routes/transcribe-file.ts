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
import { parseWavHeader, wavDurationMs } from "../lib/audio/wav.js";
import { beginDictation, endDictation } from "../lib/dictation-activity.js";
import {
  decodeAppContext,
  runTranscriptionPipeline,
} from "../lib/transcription-pipeline.js";

const log = createAppLogger("transcribe-file");

/** 1 GiB (1,073,741,824 B) upload ceiling (`tr_e4522000`). */
export const MAX_IMPORT_BYTES = 1_073_741_824;

/** Accepted file extensions, lowercase, without the dot (`br_56f64592`). */
export const ACCEPTED_IMPORT_EXTENSIONS: ReadonlySet<string> = new Set([
  "wav",
  "mp3",
  "m4a",
  "aac",
  "ogg",
  "mp4",
]);

const ACCEPTED_EXTENSIONS_DETAIL = `Accepted extensions: ${[
  ...ACCEPTED_IMPORT_EXTENSIONS,
].join(", ")}`;

/** Lowercase extension after the last `.`, or null when there is none. */
export function importFileExtension(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

/** Human-readable byte limit for the 413 detail: "1 GiB", "1 KiB", else "N bytes". */
export function formatLimit(bytes: number): string {
  const gib = 1024 ** 3;
  const kib = 1024;
  if (bytes % gib === 0) return `${bytes / gib} GiB`;
  if (bytes % kib === 0) return `${bytes / kib} KiB`;
  return `${bytes} bytes`;
}

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
