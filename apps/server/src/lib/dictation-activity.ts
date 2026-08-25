/**
 * Module-level counter of in-flight dictation transcriptions.
 *
 * The meeting transcriber's dictation-priority lease (`isDictationActive` in
 * `meetings/transcriber.ts`) needs to know when a dictation request is being
 * served so meeting chunks yield the local whisper server to it. The
 * `/api/transcribe` route increments around each request via middleware.
 */

let inFlight = 0;

export function beginDictation(): void {
  inFlight++;
}

export function endDictation(): void {
  inFlight = Math.max(0, inFlight - 1);
}

/** True while at least one dictation transcription request is in flight. */
export function isDictationActive(): boolean {
  return inFlight > 0;
}
