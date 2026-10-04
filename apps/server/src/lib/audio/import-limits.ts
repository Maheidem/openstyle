/**
 * Shared upload limits and filename helpers for the two file-import routes
 * (dictation: `routes/transcribe-file.ts`, meetings:
 * `routes/meetings-import.ts`). Same layer as
 * `lib/audio/wav.ts`: no Hono, no DB, no electron.
 *
 * Extracted verbatim from `routes/transcribe-file.ts`. Both routes answer
 * 413/415/422 with byte-identical payloads built from these values. The
 * extension list, the size limit and their helpers come from
 * `@openstyle/validations`.
 */

import { formatLimit, IMPORT_EXTENSIONS } from "@openstyle/validations";

export {
  formatLimit,
  importFileExtension,
  MAX_IMPORT_BYTES,
} from "@openstyle/validations";

/** Accepted file extensions, lowercase, without the dot (`br_56f64592`). */
export const ACCEPTED_IMPORT_EXTENSIONS: ReadonlySet<string> = new Set(
  IMPORT_EXTENSIONS,
);

/** Human-readable list for the 415 detail, in allowlist order. */
export const ACCEPTED_EXTENSIONS_DETAIL = `Accepted extensions: ${[
  ...ACCEPTED_IMPORT_EXTENSIONS,
].join(", ")}`;

/** Body of the 413 answer. Both import routes send it unchanged. */
export function tooLargeBody(maxBytes: number) {
  return {
    error: "File too large",
    detail: `Maximum upload size is ${formatLimit(maxBytes)}`,
    code: "PAYLOAD_TOO_LARGE",
  } as const;
}

/** Body of the 415 answer for a missing or unaccepted file extension. */
export function unsupportedTypeBody() {
  return {
    error: "Unsupported file type",
    detail: ACCEPTED_EXTENSIONS_DETAIL,
    code: "UNSUPPORTED_MEDIA_TYPE",
  } as const;
}

/**
 * Body of the 422 answer when the audio cannot be decoded. The detail is a
 * fixed string, so no server-side text reaches the client.
 */
export function decodeFailedBody(code: string, reason: string) {
  return {
    error: "Audio decode failed",
    detail: "ffmpeg could not decode the file",
    code,
    reason,
  } as const;
}
