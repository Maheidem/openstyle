// biome-ignore-all lint/correctness/useExhaustiveDependencies: refs, setters and callbacks come in through deps and keep one identity for the life of AppPage. The dependency lists stay as they were before the move.
import { getApiBase, getServerToken } from "@renderer/lib/api";
import { Streamer, type StreamerConnectionState } from "@renderer/lib/streamer";
import { useCallback } from "react";
import type { TranscribeResult } from "./constants";
import type { PillShared } from "./pill-shared";

export type UseStreamerDeps = Pick<
  PillShared,
  | "failedTranscriptionErrorRef"
  | "pillActiveRef"
  | "pillNoticeRef"
  | "providerCategoryRef"
  | "recordingSessionUsesTransportRef"
  | "streamerRef"
  | "streamLanguageRef"
  | "streamResolverRef"
  | "streamSessionErrorRef"
  | "supportsSessionTransportRef"
  | "wantsMicRef"
  | "setCanRetry"
  | "setPillNotice"
  | "setPillState"
> & {
  resolveStreamingWithFallback: (message: string) => boolean;
  restFallbackTranscribe: (
    errorMsg: string,
    language: string | null,
  ) => Promise<TranscribeResult> | null;
};

export function useStreamer(deps: UseStreamerDeps) {
  const {
    failedTranscriptionErrorRef,
    pillActiveRef,
    pillNoticeRef,
    providerCategoryRef,
    recordingSessionUsesTransportRef,
    streamerRef,
    streamLanguageRef,
    streamResolverRef,
    streamSessionErrorRef,
    supportsSessionTransportRef,
    wantsMicRef,
    setCanRetry,
    setPillNotice,
    setPillState,
    resolveStreamingWithFallback,
    restFallbackTranscribe,
  } = deps;

  // ---- Streamer (lazy singleton, only created when streaming is enabled) ----
  const getStreamer = useCallback((): Streamer => {
    if (!streamerRef.current) {
      streamerRef.current = new Streamer(getApiBase(), getServerToken(), {
        onConfig: (config) => {
          // Only update support for *future* sessions. The per-session decision
          // (recordingSessionUsesTransportRef) is latched once in startRecording
          // and must never be mutated mid-session: a config arriving after the
          // first recording has already committed to the batch path would flip
          // commit to the streaming path, which captured no audio → "No audio
          // captured". This is the first-dictation-after-restart failure.
          supportsSessionTransportRef.current = config.sessionTransport;
          if (config.providerCategory) {
            providerCategoryRef.current = config.providerCategory;
          }
        },
        onReady: () => {
          if (pillNoticeRef.current === "reconnecting") {
            setPillNotice(null);
          }
        },
        onConnectionState: (connectionState: StreamerConnectionState) => {
          if (
            connectionState === "reconnecting" ||
            connectionState === "disconnected"
          ) {
            if (
              resolveStreamingWithFallback(
                "Connection interrupted while transcribing",
              )
            ) {
              return;
            }
            if (
              pillActiveRef.current &&
              recordingSessionUsesTransportRef.current
            ) {
              setPillNotice("reconnecting");
            }
          }
          // A reconnected socket is not yet a working session — the notice
          // stays up until `onReady` says the session is live again, so the
          // mark doesn't blink off and on in the middle of one recovery.
        },
        onFinal: (text) => {
          setPillNotice(null);
          const resolver = streamResolverRef.current;
          if (!resolver) return;
          streamResolverRef.current = null;
          const language = streamLanguageRef.current;
          streamLanguageRef.current = null;
          // A short clip can stream to a live provider that finalizes before it
          // has recognized any words (a cold Soniox session, say), so
          // the streaming final comes back empty even though audio was captured.
          // Salvage via the batch REST path with the recorded WAV the streamer
          // still has buffered — the same clip transcribes fine one-shot. If no
          // WAV exists (genuine silence) the empty result stands.
          if (!text.trim()) {
            const fallback = restFallbackTranscribe("", language);
            if (fallback) {
              void fallback.then(resolver);
              return;
            }
          }
          resolver({ raw: text, cleaned: text });
        },
        onError: (msg, code) => {
          const resolver = streamResolverRef.current;
          if (resolver) {
            resolveStreamingWithFallback(msg);
            return;
          }
          if (wantsMicRef.current && recordingSessionUsesTransportRef.current) {
            streamSessionErrorRef.current = { message: msg, code };
            return;
          }
          if (!pillActiveRef.current) return;
          failedTranscriptionErrorRef.current = msg;
          setCanRetry(streamerRef.current?.hasCapturedAudio() ?? false);
          setPillNotice("unavailable");
          setPillState("error");
        },
      });
    }
    return streamerRef.current;
  }, []);

  return { getStreamer };
}
