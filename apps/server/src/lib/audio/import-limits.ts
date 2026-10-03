/**
 * Shared upload limits and filename helpers for the two file-import routes
 * (dictation: `routes/transcribe-file.ts`, meetings:
 * `routes/meetings-import.ts`). Dependency-free, same layer as
 * `lib/audio/wav.ts` — no Hono, no DB, no electron.
 *
 * Extracted verbatim from `routes/transcribe-file.ts`. Both routes answer
 * 413/415/422 with byte-identical payloads built from these values.
 */

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

/** Human-readable list for the 415 detail, in allowlist order. */
export const ACCEPTED_EXTENSIONS_DETAIL = `Accepted extensions: ${[
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
