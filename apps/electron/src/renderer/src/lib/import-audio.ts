import { IMPORT_EXTENSIONS, importFileExtension } from "@openstyle/validations";

export const importExtensionOf = importFileExtension;

export function isImportableFile(name: string): boolean {
  const ext = importExtensionOf(name);
  return ext !== null && (IMPORT_EXTENSIONS as readonly string[]).includes(ext);
}

export type ImportErrorKind =
  | "unsupported_format"
  | "too_large"
  | "decode"
  | "config"
  | "transcription"
  | "network"
  | "not_found"
  | "unknown";

export function classifyImportError(r: {
  status?: number;
  code?: string;
  reason?: string;
  error?: string;
  detail?: string;
}): ImportErrorKind {
  if (r.status === undefined) return "network";
  if (r.status === 404 || r.code === "FILE_NOT_FOUND") return "not_found";
  if (r.status === 415 || r.code === "UNSUPPORTED_MEDIA_TYPE")
    return "unsupported_format";
  if (r.status === 413 || r.code === "PAYLOAD_TOO_LARGE") return "too_large";
  if (r.status === 422 || r.code === "AUDIO_DECODE_FAILED") return "decode";
  if (r.status === 400) return "config";
  if (r.status === 500) return "transcription";
  return "unknown";
}
