/**
 * Meeting mic capture — entry for the hidden BrowserWindow the
 * MeetingRecorder owns (meeting-capture.html, show:false).
 *
 * Mirrors the dictation capture path: getUserMedia -> AudioWorklet
 * (getPCMProcessorUrl) -> 16 kHz mono PCM16 chunks (~80 ms), except chunks go
 * to the main process over IPC (window.api.meetingSendMicChunk) instead of a
 * transcription websocket. Capture starts immediately on load; the recorder
 * simply destroys the window to stop.
 *
 * The mic device id is passed via the `?device=` query param so this page
 * needs no settings round-trip.
 */

import { getPCMProcessorUrl } from "./lib/pcm-processor";

async function startCapture(): Promise<void> {
  const deviceId = new URLSearchParams(window.location.search).get("device");

  const processing = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId
        ? { deviceId: { exact: deviceId }, ...processing }
        : processing,
    });
  } catch (e) {
    // A stale configured device id must not kill the recording — retry with
    // the default mic (same fallback as the dictation Recorder).
    const name = e instanceof Error ? e.name : "";
    if (
      deviceId &&
      (name === "OverconstrainedError" || name === "NotFoundError")
    ) {
      stream = await navigator.mediaDevices.getUserMedia({ audio: processing });
    } else {
      throw e;
    }
  }

  const audioContext = new AudioContext();
  await audioContext.audioWorklet.addModule(getPCMProcessorUrl());
  const source = audioContext.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(audioContext, "pcm-processor");

  worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
    window.api.meetingSendMicChunk(event.data);
  };

  source.connect(worklet);
  // No connection to destination — capture only, nothing audible.
}

startCapture().catch((err) => {
  window.api.meetingCaptureError(
    err instanceof Error ? `${err.name}: ${err.message}` : String(err),
  );
});
