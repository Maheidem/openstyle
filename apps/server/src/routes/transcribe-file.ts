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
 * Memory: the upload streams to a temp file and ffmpeg decodes file → file
 * (specs/import-streaming.md), so the only full-size allocation is the single
 * `readFile` of the decoded WAV the pipeline consumes — ≈1× decoded size, not
 * the 2–3× upload the old `formData()`/`arrayBuffer()` buffering held. The
 * byte bound is enforced while streaming (`lib/audio/multipart-stream.ts`,
 * replacing `hono/body-limit`, which itself buffered chunked bodies). The
 * dictation lease is still held across decode + STT (single whisper server).
 *
 * Never log the client filename: it is untrusted and may carry personal data.
 */

import {
  closeSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  streamMultipartForm,
} from "../lib/audio/multipart-stream.js";
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

export function createTranscribeFileRoute(opts: { maxBytes?: number } = {}) {
  const maxBytes = opts.maxBytes ?? MAX_IMPORT_BYTES;

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
      .post("/file", async (c) => {
        const start = Date.now();

        // Known-size over-limit uploads are rejected on the header alone —
        // the same fast path `bodyLimit` provided. Chunked bodies are bounded
        // while streaming, inside the multipart parser.
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
          let files: Map<
            string,
            { path: string; filename: string; bytes: number }
          >;
          try {
            ({ files } = await streamMultipartForm(
              c.req.raw.body,
              extractBoundary(contentType),
              {
                maxTotalBytes: maxBytes,
                tempDir,
              },
            ));
          } catch (err) {
            if (err instanceof MultipartStreamError) {
              if (err.kind === "too_large") {
                return c.json(tooLargeBody(maxBytes), 413);
              }
              // Same envelope the `formData()` failure path produced.
              return c.json(
                { error: "audio field missing or not a file" },
                400,
              );
            }
            throw err;
          }

          const audio = files.get("audio");
          if (!audio) {
            return c.json({ error: "audio field missing or not a file" }, 400);
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

          if (audio.bytes === 0) {
            return c.json({ error: "Empty audio data" }, 400);
          }

          log.debug(
            `received file: ${audio.bytes} bytes, ext=${ext} header=${firstFourHex(
              audio.path,
            )}`,
          );

          let wavPath = audio.path;
          try {
            const needed = needsDecodeFile(audio.path);
            if (needed) {
              wavPath = join(tempDir, "decoded.wav");
              await decodeFileToWav16kMono(audio.path, wavPath);
            }
            log.debug(
              `decode=${needed} (${audio.bytes} -> ${statSync(wavPath).size} bytes)`,
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
          const audioDurationMs = Math.round(wavDurationMs(wavInfoAt(wavPath)));

          // The one full-size allocation on this path: the pipeline consumes
          // the decoded WAV exactly once. (`readFile` returns a Buffer,
          // which *is* the Uint8Array the pipeline takes — no second copy.)
          const wav = await readFile(wavPath);

          const r = await runTranscriptionPipeline({
            audio: wav,
            audioDurationMs,
            appContext: decodeAppContext(c.req.header("x-app-context")),
            languageOverride: c.req.header("x-dictation-language"),
            skipPostProcess: false,
            start,
          });
          return c.json(r.body, r.status);
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
              `[transcribe-file] failed to remove temp dir ${tempDir}: ${(err as Error).message}`,
            );
          }
        }
      })
  );
}

/** First four bytes of a file as hex, for the debug log line. */
function firstFourHex(path: string): string {
  const fd = openSync(path, "r");
  try {
    const b = Buffer.alloc(4);
    const n = readSync(fd, b, 0, 4, 0);
    return b.subarray(0, n).toString("hex");
  } finally {
    closeSync(fd);
  }
}

const transcribeFileRoute = createTranscribeFileRoute();

export default transcribeFileRoute;
