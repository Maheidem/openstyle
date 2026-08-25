/**
 * System Audio TCC Probe
 *
 * macOS has no preflight API for the "Screen & System Audio Recording"
 * permission that Core Audio process taps need: a denied helper still starts
 * successfully and simply delivers zero-filled buffers. The only reliable
 * detection is to run the real pipeline briefly and look at the samples.
 *
 * Probe: spawn the helper via SystemAudioCapture, wait for READY, sample the
 * PCM/LEVEL stream for a few seconds, tear down.
 *
 * Results:
 *   'ok'          non-zero samples seen — permission granted and audio playing
 *   'silent'      READY but every sample was zero — denied OR simply nothing
 *                 playing (indeterminate; callers should hint, not block)
 *   'unsupported' macOS < 14.4 (ERR_UNSUPPORTED_OS / support check)
 *   'error'       any other helper fault (spawn failure, ERR_*, no READY)
 */

import { shell } from "electron";
import {
  isSystemAudioCaptureSupported,
  SystemAudioCapture,
} from "./system-audio-capture";

export type SystemAudioProbeResult = "ok" | "silent" | "unsupported" | "error";

/** How long to sample after READY before concluding 'silent'. */
const SAMPLE_WINDOW_MS = 3000;
/** Give up on the helper entirely if READY never arrives. */
const READY_TIMEOUT_MS = 8000;

/**
 * Deep link to the System Settings "Screen & System Audio Recording" pane.
 * Same URL scheme as ACCESSIBILITY_SETTINGS_URL / MICROPHONE_SETTINGS_URL in
 * index.ts.
 */
export const AUDIO_CAPTURE_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AudioCapture";

export function openAudioCaptureSettings(): void {
  if (process.platform !== "darwin") return;
  void shell.openExternal(AUDIO_CAPTURE_SETTINGS_URL);
}

/** True when any PCM16 sample in the buffer is non-zero. */
function hasNonZeroSample(chunk: Buffer): boolean {
  const samples = Math.floor(chunk.length / 2);
  for (let i = 0; i < samples; i++) {
    if (chunk.readInt16LE(i * 2) !== 0) return true;
  }
  return false;
}

export function probeSystemAudio(
  sampleWindowMs = SAMPLE_WINDOW_MS,
): Promise<SystemAudioProbeResult> {
  if (!isSystemAudioCaptureSupported()) {
    return Promise.resolve("unsupported");
  }

  return new Promise((resolve) => {
    let settled = false;
    let sampleTimer: ReturnType<typeof setTimeout> | null = null;
    let readyTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: SystemAudioProbeResult): void => {
      if (settled) return;
      settled = true;
      if (sampleTimer) clearTimeout(sampleTimer);
      if (readyTimer) clearTimeout(readyTimer);
      capture.stop();
      resolve(result);
    };

    const capture = new SystemAudioCapture({
      onData: (chunk) => {
        if (hasNonZeroSample(chunk)) finish("ok");
      },
      onLevel: (rms) => {
        if (rms > 0) finish("ok");
      },
      onReady: () => {
        if (readyTimer) clearTimeout(readyTimer);
        readyTimer = null;
        sampleTimer = setTimeout(() => finish("silent"), sampleWindowMs);
      },
      onError: (error) => {
        finish(error === "ERR_UNSUPPORTED_OS" ? "unsupported" : "error");
      },
    });

    if (!capture.start()) {
      // start() already routed the reason through onError when possible.
      finish("error");
      return;
    }
    readyTimer = setTimeout(() => finish("error"), READY_TIMEOUT_MS);
  });
}
