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

// ---------------------------------------------------------------------------
// Shared "yield to live dictation" primitive.
//
// Originally a private method on MeetingTranscriber (meetings/transcriber.ts)
// for whisper-local chunk transcription. Meeting diarization
// (meetings/diarize.ts) runs on the same physical resource (Apple Neural
// Engine, via CoreML) that whisper-local also targets, so it needs the
// identical yield behavior — lifted here (specs/meeting-diarization.md §11)
// as a standalone function both callers share, rather than duplicated.
//
// `lastActiveAt` is module-level (not per-caller) so the two call sites
// cooperate on one shared lease: if dictation was observed active by either
// caller, both honor the same idle-resume window from that same instant,
// matching MeetingTranscriber's original per-instance behavior exactly (it
// only ever had one caller before).
// ---------------------------------------------------------------------------

/** Wallclock of the most recent instant dictation was observed active. */
let lastActiveAt = Number.NEGATIVE_INFINITY;

/** Test-only: reset the shared idle-lease state between test cases. */
export function __resetDictationIdleStateForTests(): void {
  lastActiveAt = Number.NEGATIVE_INFINITY;
}

export interface WaitForDictationIdleOptions {
  /** Omit (or leave undefined) to skip the lease entirely — a no-op wait. */
  isDictationActive?: () => boolean;
  /** Resume after this much sustained idle time (ms). Default 15s. */
  idleMs?: number;
  /** Poll interval while waiting out active dictation (ms). Default 500ms. */
  pollMs?: number;
  /** Injected for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

/**
 * Dictation-priority lease: yield while dictation is active and only resume
 * after a sustained idle window, so a single whisper-local server instance
 * (or the ANE the diarizer also targets) isn't contended between live
 * dictation and background meeting work.
 */
export async function waitForDictationIdle(
  opts: WaitForDictationIdleOptions = {},
): Promise<void> {
  const isActive = opts.isDictationActive;
  if (!isActive) return;
  const idleMs = opts.idleMs ?? 15_000;
  const pollMs = opts.pollMs ?? 500;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;

  for (;;) {
    if (isActive()) {
      lastActiveAt = now();
      await sleep(pollMs);
      continue;
    }
    // Never observed active: no need to wait out the idle window.
    if (lastActiveAt === Number.NEGATIVE_INFINITY) return;
    const idleFor = now() - lastActiveAt;
    if (idleFor >= idleMs) return;
    await sleep(Math.min(pollMs, idleMs - idleFor));
  }
}
