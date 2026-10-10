// biome-ignore-all lint/correctness/useExhaustiveDependencies: refs, setters and callbacks come in through deps and keep one identity for the life of AppPage. The dependency lists stay as they were before the move.
import { getClient } from "@renderer/lib/api";
import {
  BATCH_TRANSCRIBE_TIMEOUT_MS,
  postTranscribe,
} from "@renderer/lib/transcribe-client";
import { useCallback } from "react";
import { getOutputMode } from "../pill-tones";
import type { BarMode, PillExit, TranscribeResult } from "./constants";
import type { PillShared } from "./pill-shared";

export type UseTranscriptionQueueDeps = Pick<
  PillShared,
  | "appContextRef"
  | "drainAgainRef"
  | "drainingRef"
  | "failedTranscriptionErrorRef"
  | "lastRecordingDurationRef"
  | "pillActiveRef"
  | "queueRef"
  | "recordingActiveRef"
  | "recordingLanguageRef"
  | "stateRef"
  | "streamerRef"
  | "streamLanguageRef"
  | "streamResolverRef"
  | "wantsMicRef"
  | "setCanRetry"
  | "setPendingCount"
  | "setPillNotice"
  | "setPillState"
> & {
  dismissPill: (kind: PillExit) => void;
  startBarAnimation: (mode: BarMode) => void;
};

export function useTranscriptionQueue(deps: UseTranscriptionQueueDeps) {
  const {
    appContextRef,
    drainAgainRef,
    drainingRef,
    failedTranscriptionErrorRef,
    lastRecordingDurationRef,
    pillActiveRef,
    queueRef,
    recordingActiveRef,
    recordingLanguageRef,
    stateRef,
    streamerRef,
    streamLanguageRef,
    streamResolverRef,
    wantsMicRef,
    setCanRetry,
    setPendingCount,
    setPillNotice,
    setPillState,
    dismissPill,
    startBarAnimation,
  } = deps;

  const isTranscriptionIdle = useCallback(
    (): boolean =>
      queueRef.current.length === 0 &&
      !drainingRef.current &&
      streamResolverRef.current === null,
    [],
  );

  // ---- Queue drain ----
  const drainQueue = useCallback(async () => {
    if (drainingRef.current) {
      drainAgainRef.current = true;
      return;
    }
    drainingRef.current = true;

    try {
      while (recordingActiveRef.current && pillActiveRef.current) {
        await new Promise((r) => setTimeout(r, 100));
      }

      if (!pillActiveRef.current || queueRef.current.length === 0) {
        return;
      }

      const batch = [...queueRef.current];
      queueRef.current = [];

      const results = await Promise.all(batch);

      if (!pillActiveRef.current) {
        return;
      }

      // A dictation is deliverable only when it has text.
      const isDeliverable = (r: TranscribeResult): boolean => !!r.raw.trim();

      if (
        recordingActiveRef.current ||
        wantsMicRef.current ||
        queueRef.current.length > 0
      ) {
        const resolved = results
          .filter(isDeliverable)
          .map((r) => Promise.resolve(r));
        queueRef.current = [...resolved, ...queueRef.current];
        return;
      }

      const nonEmpty = results.filter(isDeliverable);
      if (nonEmpty.length === 0) {
        const errMsg = results.find((r) => r.error)?.error;
        if (errMsg) {
          failedTranscriptionErrorRef.current = errMsg;
          setCanRetry(streamerRef.current?.hasCapturedAudio() ?? false);
          setPillNotice("unavailable");
          setPillState("error");
        } else if (wantsMicRef.current) {
          // Re-record may have resolved the in-flight stream with an empty
          // result; a new recording is starting — keep the pill visible.
          return;
        } else {
          dismissPill("quiet");
        }
        return;
      }

      let finalText: string;

      if (nonEmpty.length === 1) {
        finalText = nonEmpty[0].cleaned.trim() || nonEmpty[0].raw.trim();
      } else {
        const combined = nonEmpty.map((r) => r.raw).join(" ");
        try {
          const res = await getClient().api["post-process"].$post({
            json: {
              text: combined,
              appContext: appContextRef.current,
            },
          });
          if (!pillActiveRef.current) {
            return;
          }
          if (res.ok) {
            const data = await res.json();
            finalText = data.cleaned || combined;
          } else {
            finalText = combined;
          }
        } catch {
          finalText = combined;
        }
      }

      if (!pillActiveRef.current) {
        return;
      }

      if (recordingActiveRef.current || queueRef.current.length > 0) {
        queueRef.current = [
          Promise.resolve({ raw: finalText, cleaned: finalText }),
          ...queueRef.current,
        ];
        return;
      }

      let delivered = false;

      try {
        if (finalText.trim()) {
          const delivery =
            getOutputMode() === "clipboard"
              ? window.api.copyText(finalText)
              : window.api.pasteText(finalText);

          // Start the exit when delivery is dispatched; pasteText resolves later.
          delivered = true;
          dismissPill("delivered");

          await delivery;
        }
      } catch (err) {
        console.error("[pill] paste/copy failed:", err);
      }
      window.api.sendTranscriptionDone();

      if (
        !recordingActiveRef.current &&
        queueRef.current.length === 0 &&
        pillActiveRef.current
      ) {
        dismissPill(delivered ? "delivered" : "quiet");
      }
    } finally {
      drainingRef.current = false;
      if (drainAgainRef.current) {
        drainAgainRef.current = false;
        void drainQueue();
      } else if (
        pillActiveRef.current &&
        stateRef.current === "transcribing" &&
        !wantsMicRef.current &&
        !recordingActiveRef.current &&
        isTranscriptionIdle()
      ) {
        dismissPill("quiet");
      }
    }
  }, []);

  // Queue one transcription and start the drain. The caller increments
  // pendingCount before it builds `p`. The decrement must run in `finally` so
  // that it runs on every path. If a path skips the decrement, the badge
  // count grows and never returns to 0. `after` runs when `p` has settled.
  const enqueue = useCallback(
    (p: Promise<TranscribeResult>, after?: () => void): void => {
      queueRef.current.push(
        p.finally(() => {
          setPendingCount((count) => Math.max(0, count - 1));
          after?.();
        }),
      );
      void drainQueue();
    },
    [drainQueue],
  );

  // ---- REST fallback (full recorded WAV kept by the streamer) ----
  const restFallbackTranscribe = useCallback(
    (
      errorMsg: string,
      language: string | null,
    ): Promise<TranscribeResult> | null => {
      const wavBlob = streamerRef.current?.getWavBlob() ?? null;
      if (!wavBlob) return null;
      return postTranscribe(wavBlob, {
        durationMs: lastRecordingDurationRef.current,
        language,
        appContext: appContextRef.current,
        skipPostProcess: queueRef.current.length > 0 || drainingRef.current,
        // Same 360s bound as the batch path in commitRecording — this is
        // also what the failure card's Retry re-posts through, so a wedged
        // local server can't turn Retry back into an infinite sweep.
        timeoutMs: BATCH_TRANSCRIBE_TIMEOUT_MS,
      })
        .then(async (res) => {
          if (!res.ok) {
            return { raw: "", cleaned: "", error: errorMsg };
          }
          const data = (await res.json()) as {
            raw?: string;
            cleaned?: string;
            provider_category?: string;
          };
          return {
            raw: (data.raw || "").trim(),
            cleaned: (data.cleaned || data.raw || "").trim(),
            providerCategory: data.provider_category,
          };
        })
        .catch(() => ({ raw: "", cleaned: "", error: errorMsg }));
    },
    [],
  );

  const resolveStreamingWithFallback = useCallback(
    (message: string): boolean => {
      const resolver = streamResolverRef.current;
      if (!resolver) return false;
      streamResolverRef.current = null;
      const language = streamLanguageRef.current;
      streamLanguageRef.current = null;
      setPillNotice("retrying");
      const fallback = restFallbackTranscribe(message, language);
      if (fallback) {
        void fallback.then(resolver);
      } else {
        resolver({ raw: "", cleaned: "", error: message });
      }
      return true;
    },
    [restFallbackTranscribe, setPillNotice],
  );

  const retryFailedTranscription = useCallback(() => {
    if (stateRef.current !== "error") return;
    // Not one of the four call sites §6 of the spec threads dictationLanguage
    // through — this is a manual "Retry" click on the error card, reached only
    // while `state === "error"`, i.e. no `startRecording` has run since the
    // failed attempt (a fresh hotkey press from "error" starts a new recording
    // and leaves this state entirely, taking the Retry button with it). So
    // recordingLanguageRef.current is still exactly the language that failed
    // attempt was pinned to.
    const retry = restFallbackTranscribe(
      failedTranscriptionErrorRef.current || "Transcription failed",
      recordingLanguageRef.current,
    );
    if (!retry) {
      setCanRetry(false);
      return;
    }
    setCanRetry(false);
    setPillNotice("retrying");
    setPillState("transcribing");
    // The draw loop is parked while the card is up (see the card effect), so
    // the capsule needs its sweep started again rather than resumed.
    startBarAnimation("speaking");
    setPendingCount((count) => count + 1);
    enqueue(retry);
  }, [
    enqueue,
    restFallbackTranscribe,
    setPillNotice,
    setPillState,
    startBarAnimation,
  ]);

  return {
    isTranscriptionIdle,
    drainQueue,
    enqueue,
    restFallbackTranscribe,
    resolveStreamingWithFallback,
    retryFailedTranscription,
  };
}
