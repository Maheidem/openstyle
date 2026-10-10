// biome-ignore-all lint/correctness/useExhaustiveDependencies: refs, setters and callbacks come in through deps and keep one identity for the life of AppPage. The dependency lists stay as they were before the move.
import {
  getApiBase,
  getClient,
  isRemoteServer,
  refreshApiBase,
} from "@renderer/lib/api";
import { getNeedsAppContextForCleanup } from "@renderer/lib/cleanup-app-context";
import { RecorderSupersededError } from "@renderer/lib/recorder";
import type { Streamer } from "@renderer/lib/streamer";
import {
  BATCH_TRANSCRIBE_TIMEOUT_MS,
  postTranscribe,
} from "@renderer/lib/transcribe-client";
import { useCallback } from "react";
import { getAudioPlaybackMode, playTone } from "../pill-tones";
import {
  type BarMode,
  LOCAL_MODEL_TIMEOUT_MSG,
  type PillExit,
  type TranscribeResult,
} from "./constants";
import type { PillShared } from "./pill-shared";

export type UseDictationSessionDeps = Pick<
  PillShared,
  | "analyserNodeRef"
  | "appContextRef"
  | "audioSourceRef"
  | "drainingRef"
  | "duckingPromiseRef"
  | "exitingRef"
  | "exitTimerRef"
  | "failedTranscriptionErrorRef"
  | "freqDataRef"
  | "lastRecordingDurationRef"
  | "pendingCommitRef"
  | "pendingReRecordRef"
  | "pillActiveRef"
  | "pinnedLanguageRef"
  | "queueRef"
  | "recorderRef"
  | "recordingActiveRef"
  | "recordingLanguageRef"
  | "recordingSessionUsesTransportRef"
  | "startTimeRef"
  | "streamerRef"
  | "streamLanguageRef"
  | "streamResolverRef"
  | "streamSessionErrorRef"
  | "supportsSessionTransportRef"
  | "wantsMicRef"
  | "setCanRetry"
  | "setColdLocalModel"
  | "setElapsedLabel"
  | "setExiting"
  | "setMicSilent"
  | "setPendingCount"
  | "setPillLanguageLabel"
  | "setPillNotice"
  | "setPillState"
> & {
  startBarAnimation: (mode: BarMode) => void;
  startListening: (stream: MediaStream) => void;
  startHandover: () => void;
  hidePill: () => void;
  dismissPill: (kind: PillExit) => void;
  getStreamer: () => Streamer;
  drainQueue: () => Promise<void>;
  isTranscriptionIdle: () => boolean;
  enqueue: (p: Promise<TranscribeResult>, after?: () => void) => void;
  restFallbackTranscribe: (
    errorMsg: string,
    language: string | null,
  ) => Promise<TranscribeResult> | null;
};

export function useDictationSession(deps: UseDictationSessionDeps) {
  const {
    analyserNodeRef,
    appContextRef,
    audioSourceRef,
    drainingRef,
    duckingPromiseRef,
    exitingRef,
    exitTimerRef,
    failedTranscriptionErrorRef,
    freqDataRef,
    lastRecordingDurationRef,
    pendingCommitRef,
    pendingReRecordRef,
    pillActiveRef,
    pinnedLanguageRef,
    queueRef,
    recorderRef,
    recordingActiveRef,
    recordingLanguageRef,
    recordingSessionUsesTransportRef,
    startTimeRef,
    streamerRef,
    streamLanguageRef,
    streamResolverRef,
    streamSessionErrorRef,
    supportsSessionTransportRef,
    wantsMicRef,
    setCanRetry,
    setColdLocalModel,
    setElapsedLabel,
    setExiting,
    setMicSilent,
    setPendingCount,
    setPillLanguageLabel,
    setPillNotice,
    setPillState,
    startBarAnimation,
    startListening,
    startHandover,
    hidePill,
    dismissPill,
    getStreamer,
    drainQueue,
    isTranscriptionIdle,
    enqueue,
    restFallbackTranscribe,
  } = deps;

  const resumeTranscribingOrHide = useCallback(() => {
    if (isTranscriptionIdle()) {
      dismissPill("quiet");
    } else {
      setPillState("transcribing");
      startBarAnimation("speaking");
      void drainQueue();
    }
  }, [
    dismissPill,
    setPillState,
    startBarAnimation,
    drainQueue,
    isTranscriptionIdle,
  ]);

  // Restore the system volume, but only after any in-flight duck has settled
  // so the restore can't be a no-op that leaves the volume stuck low.
  const restoreSystemAudioSafely = useCallback(async (): Promise<void> => {
    try {
      await duckingPromiseRef.current;
      await window.api?.restoreSystemAudio();
    } catch {}
  }, []);

  // ---- Start recording ----
  const startRecording = useCallback(
    async (forReRecord = false) => {
      if (wantsMicRef.current) {
        return;
      }
      if (exitingRef.current) {
        if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
        exitingRef.current = null;
        setExiting(null);
      }
      wantsMicRef.current = true;
      pillActiveRef.current = true;
      pendingCommitRef.current = false;
      streamSessionErrorRef.current = null;
      lastRecordingDurationRef.current = 0;
      // Capture the pinned language once, here, into a value that travels
      // with this one recording — never re-read pinnedLanguageRef after this
      // point (see the ref's own comment for why: a delayed REST fallback
      // must not inherit a later dictation's pin).
      recordingLanguageRef.current = pinnedLanguageRef.current;
      setPillLanguageLabel(
        recordingLanguageRef.current
          ? recordingLanguageRef.current.toUpperCase()
          : null,
      );
      setPillNotice(null);
      setCanRetry(false);
      setElapsedLabel(null);
      setMicSilent(false);

      // Warm the pipeline while the user is speaking so submission doesn't pay
      // startup latency: the local ASR server (whisper/mlx) model load and the
      // cloud cleanup LLM connection (e.g. Groq TLS handshake). Fire-and-forget:
      // the server decides what needs warming (no-op where nothing applies), and
      // lazy start at submission remains the fallback if this doesn't land.
      // T1-3 (UX-01): the response also says whether a *cold* local server had
      // to be spawned — latched per recording so the pill can name the
      // post-handover wait as "warming" only when a model load is genuinely
      // in flight (never for an already-warm server, never for cloud).
      setColdLocalModel(false);
      void getClient()
        .api.transcribe["pre-warm"].$post()
        .then(async (res) => {
          const body = (await res.json().catch(() => null)) as {
            warming?: string | null;
            cold?: boolean;
          } | null;
          if (body?.warming && body.cold) setColdLocalModel(true);
        })
        .catch(() => {});

      appContextRef.current = null;
      // Streaming is always active — prime the streamer's context.
      try {
        getStreamer().setContext(null);
      } catch {}

      // Whether cleanup routing needs the frontmost app is read from the cache
      // primed at mount and kept fresh by the `cleanup-context-changed` IPC —
      // no per-recording GET /api/settings on this hot path.
      if (getNeedsAppContextForCleanup()) {
        void window.api
          ?.getFrontmostApp()
          .then((app) => {
            if (!wantsMicRef.current) return;
            appContextRef.current = app;
            try {
              getStreamer().setContext(app);
            } catch {}
          })
          .catch(() => {
            if (!wantsMicRef.current) return;
            appContextRef.current = null;
            try {
              getStreamer().setContext(null);
            } catch {}
          });
      }

      // Keep initializing as bookkeeping; the waveform starts at rest.
      setPillState("initializing");
      startBarAnimation("listening");

      // Play the start cue immediately, before ducking lowers the system
      // volume — otherwise the tone is attenuated to DUCKED_VOLUME and is
      // effectively inaudible.
      playTone("start");

      // Duck/pause system audio concurrently with mic acquisition. The pause
      // path can spawn a slow media-control subprocess; awaiting it before
      // getUserMedia is what made the "initializing" state drag on. Restores
      // go through restoreSystemAudioSafely(), which waits on this promise so a
      // cancel can't race the duck.
      const playbackMode = getAudioPlaybackMode();
      duckingPromiseRef.current =
        playbackMode !== "off"
          ? window.api?.prepareSystemAudio(playbackMode).catch(() => {})
          : undefined;

      try {
        recordingSessionUsesTransportRef.current =
          supportsSessionTransportRef.current;

        // When session transport is active the streamer handles audio capture
        // directly — we only need the raw mic stream for the analyser. When
        // it's not (batch path), start the MediaRecorder so we get a WAV.
        const rec = recorderRef.current;
        const acquirePromise = recordingSessionUsesTransportRef.current
          ? rec.acquireStream()
          : rec.start();
        const micGen = rec.generation();
        const stream = await acquirePromise;

        if (!wantsMicRef.current) {
          rec.discard(micGen);
          void restoreSystemAudioSafely();
          streamerRef.current?.cancel();
          if (forReRecord) {
            resumeTranscribingOrHide();
          }
          return;
        }
        if (pendingCommitRef.current) {
          pendingCommitRef.current = false;
          wantsMicRef.current = false;
          rec.discard(micGen);
          void restoreSystemAudioSafely();
          streamerRef.current?.cancel();
          if (forReRecord) {
            resumeTranscribingOrHide();
          } else {
            dismissPill("quiet");
          }
          return;
        }

        setPillState("recording");
        recordingActiveRef.current = true;
        startTimeRef.current = Date.now();

        startListening(stream);
        try {
          await getStreamer().startCapture(
            stream,
            recordingLanguageRef.current,
          );
        } catch {}
      } catch (err) {
        if (err instanceof RecorderSupersededError) return;
        pendingCommitRef.current = false;
        recorderRef.current.releaseStream();
        void restoreSystemAudioSafely();
        hidePill();
        window.api.showErrorDialog(
          "Recording Failed",
          err instanceof Error ? err.message : "Mic access denied",
        );
      }
    },
    [
      startBarAnimation,
      startListening,
      hidePill,
      dismissPill,
      getStreamer,
      setPillNotice,
      setPillState,
      resumeTranscribingOrHide,
      restoreSystemAudioSafely,
    ],
  );

  // Replay a re-record press that arrived while a commit was finalizing (see
  // the hotkey-down handler). Only when nothing else has already taken the mic.
  const replayPendingReRecord = useCallback((): void => {
    if (pendingReRecordRef.current && !wantsMicRef.current) {
      pendingReRecordRef.current = false;
      void startRecording(true);
    }
  }, [startRecording]);

  // ---- Commit recording ----
  const commitRecording = useCallback(async () => {
    // Read once, here, into a local that travels with every request this
    // commit can produce — recordingLanguageRef itself is only ever written
    // at the top of startRecording, so by the time a *later* recording could
    // overwrite it, this commit's requests must already have closed over
    // this local value (see recordingLanguageRef's own comment).
    const dictationLanguage = recordingLanguageRef.current;
    wantsMicRef.current = false;
    recordingActiveRef.current = false;

    // Restore the system volume first, then play the stop cue so it isn't
    // muted by ducking. Fire-and-forget so the transcription pipeline below
    // isn't blocked on the restore. This runs on every commit path, so the
    // branches below don't restore again. Gate on whether this session ducked
    // (not the current mode setting, which can change mid-recording) so a
    // toggle to "off" while recording can't strand the volume low.
    void (async () => {
      if (duckingPromiseRef.current) {
        await restoreSystemAudioSafely();
      }
      playTone("stop");
    })();

    try {
      audioSourceRef.current?.disconnect();
    } catch {}
    try {
      analyserNodeRef.current?.disconnect();
    } catch {}
    audioSourceRef.current = null;
    analyserNodeRef.current = null;
    freqDataRef.current = null;

    const recordingDuration = Date.now() - startTimeRef.current;
    lastRecordingDurationRef.current = recordingDuration;
    if (recordingDuration < 250) {
      recorderRef.current.discard();
      streamerRef.current?.cancel();
      resumeTranscribingOrHide();
      return;
    }

    setPillState("transcribing");
    startHandover();

    // Streaming session transport path: the streamer already has the audio —
    // commit it over the WebSocket and wait for the server's final message.
    if (recordingSessionUsesTransportRef.current && streamerRef.current) {
      recorderRef.current.discard();

      const streamError = streamSessionErrorRef.current;
      streamSessionErrorRef.current = null;

      const transportFailure =
        streamError?.message ??
        (!streamerRef.current.isConnected()
          ? "Connection interrupted while recording"
          : null);
      if (transportFailure) {
        streamerRef.current.cancel();
        setPillNotice("retrying");
        setPendingCount((count) => count + 1);
        const fallback =
          restFallbackTranscribe(transportFailure, dictationLanguage) ??
          Promise.resolve({
            raw: "",
            cleaned: "",
            error: transportFailure,
          });
        enqueue(fallback, replayPendingReRecord);
        return;
      }

      // A cold cloud session at commit time is just latency, not a fault: the
      // sweeping waveform already says the dictation is being worked on, and
      // the commit timeout below is what turns a genuinely stuck session into
      // something the user is told about.
      setPendingCount((c) => c + 1);
      const transcribePromise = new Promise<TranscribeResult>((resolve) => {
        streamResolverRef.current = resolve;
        streamLanguageRef.current = dictationLanguage;
        // Server-side commit timeouts fire at 12s; if no final arrived by
        // 15s the stream is dead — salvage via REST with the recorded WAV.
        setTimeout(() => {
          if (streamResolverRef.current === resolve) {
            streamResolverRef.current = null;
            streamLanguageRef.current = null;
            const fallback = restFallbackTranscribe(
              "Transcription timed out",
              dictationLanguage,
            );
            if (fallback) {
              void fallback.then(resolve);
            } else {
              resolve({
                raw: "",
                cleaned: "",
                error: "Transcription timed out",
              });
            }
          }
        }, 15_000);
      });
      streamerRef.current.commit();
      enqueue(transcribePromise, replayPendingReRecord);
      return;
    }

    // startCapture() also runs for the batch path so the analyser and a
    // retryable PCM copy stay available. Stop that auxiliary capture now;
    // otherwise it remains logically active until the next dictation.
    streamerRef.current?.cancel();
    const wavBlob = recorderRef.current.isRecording()
      ? await recorderRef.current.stop()
      : null;
    recorderRef.current.releaseStream();

    if (!pillActiveRef.current) {
      return;
    }

    if (!wavBlob) {
      if (isTranscriptionIdle()) {
        hidePill();
        window.api.showErrorDialog(
          "Recording Failed",
          "No audio captured. Try recording again.",
        );
      } else {
        resumeTranscribingOrHide();
      }
      return;
    }

    const isSubsequent = queueRef.current.length > 0 || drainingRef.current;
    // Read before the await below: the app context can change while
    // the server check runs.
    const appContext = appContextRef.current;

    const serverOk = await refreshApiBase();
    if (!serverOk) {
      failedTranscriptionErrorRef.current = isRemoteServer()
        ? `Cannot reach the server at ${getApiBase()}`
        : `Cannot reach Openstyle server at ${getApiBase()}`;
      setCanRetry(streamerRef.current?.hasCapturedAudio() ?? false);
      setPillNotice("unavailable");
      setPillState("error");
      return;
    }

    setPendingCount((c) => c + 1);
    const transcribePromise: Promise<TranscribeResult> = postTranscribe(
      wavBlob,
      {
        durationMs: recordingDuration,
        language: dictationLanguage,
        appContext,
        skipPostProcess: isSubsequent,
        // T1-4 / UX-02: bound the batch wait so a wedged local ASR server
        // can't keep the sweep up forever. Transcription is deliberately
        // outside the server's TIMEOUT_PREFIXES, so without this nothing
        // ever fails the request client-side. 360s minimum — see
        // BATCH_TRANSCRIBE_TIMEOUT_MS.
        timeoutMs: BATCH_TRANSCRIBE_TIMEOUT_MS,
      },
    )
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            error?: string;
            detail?: string;
          } | null;
          const msg =
            body?.detail ||
            body?.error ||
            `Transcription failed (${res.status})`;
          return { raw: "", cleaned: "", error: msg };
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
      .catch((err) => {
        // The bound fired: name the likely cause rather than surfacing a raw
        // TimeoutError. AbortSignal.timeout rejects with a DOMException
        // whose name is "TimeoutError" (an AbortError would mean something
        // else cancelled the fetch, which nothing on this path does).
        if (err instanceof Error && err.name === "TimeoutError") {
          return { raw: "", cleaned: "", error: LOCAL_MODEL_TIMEOUT_MSG };
        }
        const msg = err instanceof Error ? err.message : "Transcription failed";
        const hint =
          msg.includes("fetch") || msg.includes("Failed")
            ? isRemoteServer()
              ? ` (${getApiBase()} unreachable — check Settings → Network)`
              : ` (${getApiBase()} unreachable — quit and reopen the app)`
            : "";
        return { raw: "", cleaned: "", error: `${msg}${hint}` };
      });

    enqueue(transcribePromise);
  }, [
    hidePill,
    enqueue,
    startHandover,
    setPillState,
    resumeTranscribingOrHide,
    isTranscriptionIdle,
    restoreSystemAudioSafely,
    restFallbackTranscribe,
    replayPendingReRecord,
    setPillNotice,
  ]);

  // ---- Cancel ----
  const cancelRecording = useCallback(() => {
    recorderRef.current.discard();
    void restoreSystemAudioSafely();
    streamerRef.current?.cancel();
    dismissPill("cancelled");
  }, [dismissPill, restoreSystemAudioSafely]);

  return {
    restoreSystemAudioSafely,
    startRecording,
    commitRecording,
    cancelRecording,
  };
}
