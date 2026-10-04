import { Buffer } from "node:buffer";
import { errorMessage } from "@openstyle/utils";
import WebSocket from "ws";
import { createPendingAudio } from "../pending-audio.js";
import { mergeFinalSegment, previewText } from "../segments.js";
import { appendDeepgramBiasToParams } from "../transcribe-bias.js";
import type {
  StreamingSessionOptions,
  StreamSession,
  TranscribeOptions,
  TranscribeResult,
  TranscriptionProvider,
} from "../types.js";
import { CLOUD_TRANSCRIBE_TIMEOUT_MS, stripProviderPrefix } from "../types.js";

const DEEPGRAM_LISTEN_URL = "wss://api.deepgram.com/v1/listen";
const COMMIT_TIMEOUT_MS = 12_000;
// Deepgram closes streaming sockets after ~10s without audio (NET-0001);
// KeepAlive holds the connection open between recordings.
const KEEPALIVE_INTERVAL_MS = 5_000;

/** Pre-recorded Deepgram /v1/listen (client sends WAV from the electron app). */
async function transcribeDeepgramListen(
  opts: TranscribeOptions,
): Promise<TranscribeResult> {
  const short = stripProviderPrefix(opts.model);
  const params = new URLSearchParams({
    model: short,
    punctuate: "true",
    smart_format: "true",
  });
  params.set("language", opts.language ?? "multi");

  appendDeepgramBiasToParams(params, opts.bias);

  const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${opts.apiKey}`,
      "Content-Type": "audio/wav",
    },
    body: Buffer.from(opts.audio),
    signal: AbortSignal.timeout(CLOUD_TRANSCRIBE_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || `Deepgram transcription failed (${res.status})`);
  }

  const data = (await res.json()) as {
    results?: {
      channels?: Array<{
        alternatives?: Array<{ transcript?: string }>;
      }>;
    };
    metadata?: { duration?: number };
  };

  const text =
    data.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "";

  return {
    text,
    durationInSeconds: data.metadata?.duration,
  };
}

export class DeepgramTranscriptionProvider implements TranscriptionProvider {
  readonly providerId = "deepgram";

  async transcribe(opts: TranscribeOptions): Promise<TranscribeResult> {
    return transcribeDeepgramListen(opts);
  }

  supportsStreaming(_modelId: string): boolean {
    return true;
  }

  openStreamingSession(opts: StreamingSessionOptions): StreamSession {
    const { apiKey, model, languages, bias, callbacks } = opts;
    // Deepgram takes a single language code (or "multi") — use the primary.
    const language = languages?.[0];

    let accumulatedText = "";
    let partialText = "";
    let commitRequested = false;
    let finalizeSent = false;
    let finalDelivered = false;
    let commitTimeout: ReturnType<typeof setTimeout> | null = null;
    let keepAlive: ReturnType<typeof setInterval> | null = null;

    function clearCommitTimeout(): void {
      if (commitTimeout) {
        clearTimeout(commitTimeout);
        commitTimeout = null;
      }
    }

    function stopKeepAlive(): void {
      if (keepAlive) {
        clearInterval(keepAlive);
        keepAlive = null;
      }
    }

    const short = stripProviderPrefix(model);

    const params = new URLSearchParams({
      model: short,
      encoding: "linear16",
      sample_rate: "16000",
      channels: "1",
      interim_results: "true",
      punctuate: "true",
      endpointing: "false",
      vad_events: "false",
    });
    params.set("language", language ?? "multi");
    appendDeepgramBiasToParams(params, bias);

    const ws = new WebSocket(`${DEEPGRAM_LISTEN_URL}?${params}`, {
      headers: { Authorization: `Token ${apiKey}` },
    });
    const pending = createPendingAudio();

    function deliverFinal(): void {
      if (finalDelivered) return;
      finalDelivered = true;
      commitRequested = false;
      finalizeSent = false;
      clearCommitTimeout();
      const text = (accumulatedText || partialText).trim();
      accumulatedText = "";
      partialText = "";
      callbacks.onFinal(text);
    }

    function sendFinalize(): void {
      if (finalizeSent || ws.readyState !== WebSocket.OPEN) return;
      finalizeSent = true;
      ws.send(JSON.stringify({ type: "Finalize" }));
    }

    ws.on("open", () => {
      pending.flush((chunk) => ws.send(chunk));
      if (commitRequested) {
        sendFinalize();
      }
      keepAlive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "KeepAlive" }));
        }
      }, KEEPALIVE_INTERVAL_MS);
      callbacks.onReady(short);
    });

    ws.on("message", (raw) => {
      let msg: {
        type?: string;
        is_final?: boolean;
        channel?: {
          alternatives?: Array<{ transcript?: string }>;
        };
      };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type !== "Results") return;

      const transcript = msg.channel?.alternatives?.[0]?.transcript ?? "";
      if (!transcript) return;

      if (msg.is_final) {
        accumulatedText = mergeFinalSegment(accumulatedText, transcript);
        partialText = "";

        if (commitRequested) {
          deliverFinal();
        } else {
          callbacks.onPartial(accumulatedText);
        }
      } else {
        partialText = transcript;
        callbacks.onPartial(previewText(accumulatedText, partialText));
      }
    });

    ws.on("error", (err) => {
      stopKeepAlive();
      callbacks.onError(errorMessage(err));
    });

    ws.on("close", () => {
      stopKeepAlive();
      callbacks.onClose();
    });

    // Deepgram is kept warm across recordings, so a cancel must NOT send
    // CloseStream — that closes the socket server-side and makes the route
    // reconnect. Just drop the in-flight transcript and leave the socket
    // open for the next recording. close() is used for real teardown.
    function clearRecording(): void {
      pending.clear();
      clearCommitTimeout();
      accumulatedText = "";
      partialText = "";
      commitRequested = false;
      finalizeSent = false;
      finalDelivered = false;
    }

    return {
      sendAudio(chunk: ArrayBuffer): void {
        if (ws.readyState === WebSocket.CONNECTING) {
          pending.hold(chunk);
          return;
        }
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(chunk);
      },
      reset: clearRecording,
      commit(): void {
        commitRequested = true;
        clearCommitTimeout();
        commitTimeout = setTimeout(() => {
          deliverFinal();
        }, COMMIT_TIMEOUT_MS);
        if (ws.readyState === WebSocket.CONNECTING) return;
        if (ws.readyState !== WebSocket.OPEN) {
          deliverFinal();
          return;
        }
        sendFinalize();
      },
      cancel: clearRecording,
      close(): void {
        clearCommitTimeout();
        stopKeepAlive();
        if (ws.readyState <= WebSocket.OPEN) ws.close();
      },
    };
  }
}
