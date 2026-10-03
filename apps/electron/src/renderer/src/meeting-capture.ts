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

import { openMicStream } from "./lib/mic-stream";
import { getPCMProcessorUrl } from "./lib/pcm-processor";

async function startCapture(): Promise<void> {
  const deviceId = new URLSearchParams(window.location.search).get("device");

  const stream = await openMicStream(deviceId);

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
