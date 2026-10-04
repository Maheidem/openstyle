/**
 * Upload limits for the file-import features. The server routes, the Electron
 * main process and the renderer all use these values, so the list and the
 * limit exist in one place only.
 */

/** Accepted file extensions, lowercase, without the dot. */
export const IMPORT_EXTENSIONS = [
  "wav",
  "mp3",
  "m4a",
  "aac",
  "ogg",
  "mp4",
] as const;

/** 1 GiB (1,073,741,824 B) upload ceiling. */
export const MAX_IMPORT_BYTES = 1_073_741_824;

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
