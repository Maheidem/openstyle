/**
 * The single normalizer for an own-server URL. It reduces whatever the user
 * typed to the server ROOT.
 *
 * Every server URL is derived from this root ({@link omlxModelsUrl},
 * {@link omlxTranscribeUrl}), so the probe and the transcription request can
 * never disagree about where the server lives. `http://127.0.0.1:8123` and
 * `http://127.0.0.1:8123/v1` (and a pasted `.../v1/audio/transcriptions`) all
 * collapse to the same root.
 */
export function normalizeOmlxRoot(input: string): string {
  return input
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1(?:\/[^?#]*)?$/, "");
}

/** Model discovery endpoint for a server root. */
export function omlxModelsUrl(root: string): string {
  return `${root}/v1/models`;
}

/** Batch transcription endpoint for a server root. */
export function omlxTranscribeUrl(root: string): string {
  return `${root}/v1/audio/transcriptions`;
}
