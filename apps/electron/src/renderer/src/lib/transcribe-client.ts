import { apiFetch } from "./api";

/**
 * T1-4 / UX-02: client-side bound on the batch dictation wait, so a wedged
 * local ASR server turns into a named failure instead of an infinite sweep.
 * Never lower than this (audit trap 5): whisper spawn waits up to 90 s and a
 * legitimate MLX transcription can run to 300 s — a false "failed" on a real
 * long local dictation is worse than the rare hang this cures.
 */
export const BATCH_TRANSCRIBE_TIMEOUT_MS = 360_000;

export interface TranscribeRequestOptions {
  durationMs: number;
  language?: string | null;
  appContext?: string | null;
  skipPostProcess?: boolean;
  /** Abort the request after this many ms. Omit for no bound. */
  timeoutMs?: number;
}

/**
 * The app context (process name + window title) can contain characters
 * outside ISO-8859-1 — e.g. a Cyrillic file path in the Notepad++ title
 * bar. HTTP header values only allow Latin-1, so passing the raw JSON
 * makes fetch() throw "Failed to execute 'fetch'". Percent-encode it so
 * the header is always byte-safe; the server decodes it back.
 */
function encodeAppContext(context: string): string {
  return encodeURIComponent(context);
}

/** Build the request headers for POST /api/transcribe. */
export function buildTranscribeHeaders(
  opts: Omit<TranscribeRequestOptions, "timeoutMs">,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "audio/wav",
    "x-audio-duration-ms": String(opts.durationMs),
  };
  if (opts.language) headers["x-dictation-language"] = opts.language;
  if (opts.appContext)
    headers["x-app-context"] = encodeAppContext(opts.appContext);
  if (opts.skipPostProcess) headers["x-skip-post-process"] = "true";
  return headers;
}

/**
 * POST a recorded WAV to /api/transcribe. Each caller keeps its own response
 * parsing and error copy.
 */
export function postTranscribe(
  wav: Blob,
  opts: TranscribeRequestOptions,
): Promise<Response> {
  return apiFetch("/api/transcribe", {
    method: "POST",
    body: wav,
    headers: buildTranscribeHeaders(opts),
    signal:
      opts.timeoutMs === undefined
        ? undefined
        : AbortSignal.timeout(opts.timeoutMs),
  });
}
