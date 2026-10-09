import { REMIX_CHAT_STRIP } from "@renderer/components/remix-chat-surface";
import { useLatchedValue } from "@renderer/hooks/use-latched-value";
import { getClient, refreshApiBase } from "@renderer/lib/api";
import {
  applyNeedsAppContextForCleanup,
  refreshNeedsAppContextForCleanup,
} from "@renderer/lib/cleanup-app-context";
import { Recorder } from "@renderer/lib/recorder";
import type { Streamer } from "@renderer/lib/streamer";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  normalizeAudioPlaybackMode,
  resolveAudioPlaybackMode,
} from "../../../shared/audio-playback";
import {
  normalizePillCancelMode,
  type PillCancelMode,
} from "../../../shared/pill-cancel";
import type { RemixSelectionPayload } from "../../../shared/remix";
import { SETTINGS_KEYS } from "../../../shared/settings-keys";
import {
  BAR_CENTER,
  BAR_COLOR,
  BAR_WIDTH,
  BAR_X_POSITIONS,
  BARS,
  type BarMode,
  BLUR,
  CLOSE_STEP_MS,
  type Deferred,
  ELAPSED_AFTER_MS,
  FAILURE_CARD_MS,
  LIVE,
  PILL_CARD_WIDTH,
  type PillExit,
  type PillNotice,
  type PillState,
  REMIX_WARNING_MS,
  type RemixSession,
  SURFACE,
  SURFACE_BORDER,
  SVG_WIDTH,
  type TranscribeResult,
  VIEW_LATCH_MS,
  WARMING_AFTER_MS,
  WARMING_LABEL,
} from "./pill/constants";
import type { PillShared } from "./pill/pill-shared";
import { PillView } from "./pill/pill-view";
import { useDictationSession } from "./pill/use-dictation-session";
import { usePillDismiss } from "./pill/use-pill-dismiss";
import { useRemixHotkeys, useRemixSession } from "./pill/use-remix-session";
import { useStreamer } from "./pill/use-streamer";
import { useTranscriptionQueue } from "./pill/use-transcription-queue";
import { useWaveform } from "./pill/use-waveform";
import { SVG_HEIGHT } from "./pill-motion";
import {
  setAudioPlaybackMode,
  setOutputMode,
  setSoundEnabled,
} from "./pill-tones";
import type { BarJitter } from "./pill-waveform";

export default function AppPage(): React.JSX.Element {
  const [state, setState] = useState<PillState>("idle");
  const stateRef = useRef<PillState>("idle");
  const setPillState = useCallback((next: PillState) => {
    stateRef.current = next;
    setState(next);
  }, []);
  const [pillAlign, setPillAlign] = useState<"start" | "end">("end");
  const [pillSide, setPillSide] = useState<"center" | "right">("center");
  const [cancelMode, setCancelMode] = useState<PillCancelMode>("hover");
  const [pillNotice, setPillNoticeState] = useState<PillNotice>(null);
  const pillNoticeRef = useRef<PillNotice>(null);
  const setPillNotice = useCallback((notice: PillNotice) => {
    pillNoticeRef.current = notice;
    setPillNoticeState(notice);
  }, []);
  const [canRetry, setCanRetry] = useState(false);
  // Pinned-language badge shown on the pill while a language-hotkey
  // dictation is active (§6, specs/dictation-language-hotkeys.md). Set once
  // at startRecording (uppercased ISO code, e.g. "PT"), cleared in
  // resetDictation — not derived per-render from a ref, so it can't flicker
  // off mid-session and doesn't need to be read again after commit.
  const [pillLanguageLabel, setPillLanguageLabel] = useState<string | null>(
    null,
  );

  const supportsSessionTransportRef = useRef(false);
  const recordingSessionUsesTransportRef = useRef(false);
  const providerCategoryRef = useRef<string | null>(null);
  const streamSessionErrorRef = useRef<{
    message: string;
    code?: string;
  } | null>(null);
  const failedTranscriptionErrorRef = useRef("Transcription failed");
  const lastRecordingDurationRef = useRef(0);

  // ---- Per-language dictation hotkeys (specs/dictation-language-hotkeys.md) ----
  // Set from the hotkey-down IPC payload the instant it arrives — before any
  // state-machine branching decides whether to start a new recording.
  const pinnedLanguageRef = useRef<string | null>(null);
  // Captured once, at the top of startRecording, into a value that travels
  // with that one recording. Must not be re-read from pinnedLanguageRef at
  // request-build time: a REST fallback can fire well after a *later*
  // recording has already overwritten pinnedLanguageRef (see startRecording).
  const recordingLanguageRef = useRef<string | null>(null);
  // Paired with streamResolverRef's lifecycle (set/read/nulled together) so
  // the three Streamer-callback call sites that resolve a pending commit —
  // outside commitRecording's own closure — can still recover the language
  // that commit was pinned to.
  const streamLanguageRef = useRef<string | null>(null);

  const [pendingCount, setPendingCount] = useState(0);

  // ---- Remix ----
  const [remix, setRemixState] = useState<RemixSession | null>(null);
  const remixRef = useRef<RemixSession | null>(null);
  const setRemix = useCallback((next: RemixSession | null) => {
    remixRef.current = next;
    setRemixState(next);
  }, []);
  /** Patch the live session, ignoring the call if it has since been torn down. */
  const patchRemix = useCallback((patch: Partial<RemixSession>) => {
    const current = remixRef.current;
    if (!current) return;
    const next = { ...current, ...patch };
    remixRef.current = next;
    setRemixState(next);
  }, []);
  const remixDownAtRef = useRef(0);
  const remixSeqRef = useRef(0);
  const remixMicGenRef = useRef<number | null>(null);
  /** Resolved by the `remix:selection` IPC, awaited by whatever runs. */
  const remixSelectionRef = useRef<Deferred<string | null> | null>(null);
  /** The full capture — selection plus the anchor the edit belongs to. */
  const remixContextRef = useRef<RemixSelectionPayload | null>(null);
  /** Guards against a second run being kicked off from the same session. */
  const remixRunningRef = useRef(false);
  /** Flips the card from "capturing" to "listening" once a press is a hold. */
  const remixHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remixStreamerRef = useRef<Streamer | null>(null);
  const remixTransportRef = useRef(false);
  const remixFinalRef = useRef<Deferred<string> | null>(null);

  const recorderRef = useRef(new Recorder());
  const streamerRef = useRef<Streamer | null>(null);
  const analyserCtxRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserNodeRef = useRef<AnalyserNode | null>(null);
  /** Heights actually drawn; eased toward `targetsRef` every frame. */
  const barsRef = useRef<number[]>(new Array(BARS).fill(0));
  /**
   * The bar elements, captured when the SVG mounts. The draw step runs every
   * frame, so it reads this rather than re-querying the DOM each time.
   */
  const barLinesRef = useRef<SVGLineElement[]>([]);
  /**
   * How far the cancel button is open, 0 (hidden, full waveform) to 1 (shown,
   * two bars given up). Eased in the draw loop rather than by CSS so the
   * layout, the button's fade and the outgoing bars' fade all advance on the
   * same clock. `lastCancelWrite` keeps a settled value from re-writing
   * styles — and so from laying out — every frame.
   */
  const cancelOpenRef = useRef(0);
  const cancelTargetRef = useRef(0);
  const lastCancelWriteRef = useRef(-1);
  const cancelSlotRef = useRef<HTMLSpanElement>(null);
  const waveClipRef = useRef<HTMLSpanElement>(null);
  const flatlineRef = useRef<SVGLineElement>(null);
  /** Silence state is rendered through the live region and flatline. */
  const silentSinceRef = useRef(0);
  const flatAmountRef = useRef(0);
  const flatTargetRef = useRef(0);
  const [micSilent, setMicSilent] = useState(false);
  const micSilentRef = useRef(false);
  const [elapsedLabel, setElapsedLabel] = useState<string | null>(null);

  // ---- Warming (T1-3 / UX-01) ----
  /** Latched per recording by the pre-warm call in `startRecording`: true
   * only when the local ASR server was cold at hotkey-down, so a spawn +
   * model load is genuinely what the post-handover wait is paying for.
   * State, not a ref, so a pre-warm response that lands during the wait
   * re-triggers the effect below (short utterances can hand over before the
   * response arrives). */
  const [coldLocalModel, setColdLocalModel] = useState(false);
  /** Whether the warming mark is currently up in the status slot. */
  const [warming, setWarming] = useState(false);
  const [exiting, setExiting] = useState<PillExit | null>(null);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ref guard prevents generic queue cleanup from replacing a specific exit.
  const exitingRef = useRef<PillExit | null>(null);
  const hoveredRef = useRef(false);
  const cancelModeRef = useRef<PillCancelMode>("hover");
  /**
   * What the bars are easing toward. Every mode writes this; while recording
   * it doubles as a shift register, each slot handing its value to its
   * left-hand neighbour once per SAMPLE_MS. `peak` holds the loudest level
   * seen since the last hand-off, so a brief transient isn't missed.
   */
  const targetsRef = useRef<number[]>(new Array(BARS).fill(0));
  const sampleRef = useRef<{
    lastSampleAt: number;
    peak: number;
    jitter: BarJitter;
  }>({ lastSampleAt: 0, peak: 0, jitter: { scale: 1, trim: 0 } });
  const rafRef = useRef<number>(0);
  const startTimeRef = useRef(0);
  const wantsMicRef = useRef(false);
  /** True only while state is "recording" — used by the queue drain wait loop. */
  const recordingActiveRef = useRef(false);
  const appContextRef = useRef<string | null>(null);
  const pendingCommitRef = useRef(false);
  const pillActiveRef = useRef(false);
  // Tracks the in-flight prepareSystemAudio() (ducking) call. Ducking runs
  // concurrently with mic acquisition, so every restore must wait for this
  // to settle — otherwise a restore that lands before the duck applies is a
  // no-op and leaves the system volume stuck low.
  const duckingPromiseRef = useRef<Promise<unknown> | undefined>(undefined);
  const barModeRef = useRef<BarMode | null>(null);
  const modeStartRef = useRef(0);
  const lastIpcTimeRef = useRef(0);
  const freqDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  /**
   * The voice band (80-4000Hz) as analyser bin indices, plus the divisor that
   * turns a bin sum into a 0..1 level. Derived once when the analyser is
   * built — sample rate and fftSize are fixed for the life of the node, so
   * there's no reason to recompute this every frame.
   */
  const voiceBandRef = useRef({ startBin: 0, endBin: 0, levelDivisor: 1 });

  const queueRef = useRef<Promise<TranscribeResult>[]>([]);
  const drainingRef = useRef(false);
  const streamResolverRef = useRef<((r: TranscribeResult) => void) | null>(
    null,
  );
  const drainAgainRef = useRef(false);
  // Set when the user presses the hotkey to start a new dictation while a
  // streaming commit is still finalizing. The single WebSocket/PCM buffer can't
  // host two streaming sessions at once, so instead of dropping the press we
  // replay it once the pending commit resolves.
  const pendingReRecordRef = useRef(false);

  const shared: PillShared = {
    setPillState,
    setPillNotice,
    setCanRetry,
    setPillLanguageLabel,
    setPendingCount,
    setMicSilent,
    setElapsedLabel,
    setColdLocalModel,
    setExiting,
    setRemix,
    patchRemix,
    stateRef,
    pillNoticeRef,
    supportsSessionTransportRef,
    recordingSessionUsesTransportRef,
    providerCategoryRef,
    streamSessionErrorRef,
    failedTranscriptionErrorRef,
    lastRecordingDurationRef,
    pinnedLanguageRef,
    recordingLanguageRef,
    streamLanguageRef,
    remixRef,
    remixDownAtRef,
    remixSeqRef,
    remixMicGenRef,
    remixSelectionRef,
    remixContextRef,
    remixRunningRef,
    remixHoldTimerRef,
    remixStreamerRef,
    remixTransportRef,
    remixFinalRef,
    recorderRef,
    streamerRef,
    analyserCtxRef,
    audioSourceRef,
    analyserNodeRef,
    barsRef,
    barLinesRef,
    cancelOpenRef,
    cancelTargetRef,
    lastCancelWriteRef,
    cancelSlotRef,
    waveClipRef,
    flatlineRef,
    silentSinceRef,
    flatAmountRef,
    flatTargetRef,
    micSilentRef,
    exitTimerRef,
    exitingRef,
    hoveredRef,
    cancelModeRef,
    targetsRef,
    sampleRef,
    rafRef,
    startTimeRef,
    wantsMicRef,
    recordingActiveRef,
    appContextRef,
    pendingCommitRef,
    pillActiveRef,
    duckingPromiseRef,
    barModeRef,
    modeStartRef,
    lastIpcTimeRef,
    freqDataRef,
    voiceBandRef,
    queueRef,
    drainingRef,
    streamResolverRef,
    drainAgainRef,
    pendingReRecordRef,
  };

  const {
    captureBarLines,
    startBarAnimation,
    startListening,
    startHandover,
    stopVisualization,
  } = useWaveform(shared);
  const { resetDictation, hidePill, dismissPill } = usePillDismiss({
    ...shared,
    stopVisualization,
  });
  const {
    isTranscriptionIdle,
    drainQueue,
    enqueue,
    restFallbackTranscribe,
    resolveStreamingWithFallback,
    retryFailedTranscription,
  } = useTranscriptionQueue({ ...shared, dismissPill, startBarAnimation });
  const { getStreamer } = useStreamer({
    ...shared,
    resolveStreamingWithFallback,
    restFallbackTranscribe,
  });
  const {
    restoreSystemAudioSafely,
    startRecording,
    commitRecording,
    cancelRecording,
  } = useDictationSession({
    ...shared,
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
  });
  const {
    releaseRemixMic,
    destroyRemixStreamer,
    endRemix,
    closeRemix,
    expandRemixChat,
    minimizeRemixChat,
    runRemix,
    beginRemix,
    finishRemixPress,
  } = useRemixSession({
    ...shared,
    stopVisualization,
    startBarAnimation,
    startListening,
  });

  // ---- Preferences ----
  const applyPillPosition = useCallback((pos: string | null | undefined) => {
    const isTop =
      pos === "top-center" || pos === "top-right" || pos === "custom-top";
    setPillAlign(isTop ? "start" : "end");
    setPillSide(pos?.endsWith("right") ? "right" : "center");
  }, []);

  useEffect(() => {
    // Read every persisted preference in a single request instead of one GET
    // per key. Missing keys are simply absent from the map (no 404s), and the
    // legacy audio-playback fallbacks read from the same snapshot.
    getClient()
      .api.settings.$get()
      .then((r) => (r.ok ? r.json() : null))
      .then((settings) => {
        if (!settings) return;

        setSoundEnabled(settings[SETTINGS_KEYS.soundEnabled] !== "false");

        setAudioPlaybackMode(resolveAudioPlaybackMode(settings));

        const outputMode = settings[SETTINGS_KEYS.outputMode];
        if (outputMode) setOutputMode(outputMode);

        setCancelMode(
          normalizePillCancelMode(settings[SETTINGS_KEYS.pillCancelButton]),
        );

        // Warm the cleanup-context cache from the same snapshot instead of
        // firing a second GET /api/settings.
        applyNeedsAppContextForCleanup(settings);
      })
      .catch(() => {});

    // Streaming is always active. Eagerly create the Streamer so the WebSocket
    // connects and the onConfig callback (which sets supportsSessionTransportRef)
    // fires before the first recording. Session-transport support is negotiated
    // per provider — non-streaming providers fall back to the batch path.
    getStreamer();
    window.api
      ?.getPillPosition()
      .then(applyPillPosition)
      .catch(() => {});

    // Listen for live changes from the settings UI
    const removePillPos = window.api?.onPillPositionChanged(applyPillPosition);
    const removeOutputMode = window.api?.onOutputModeChanged((mode) => {
      setOutputMode(mode);
    });
    const removeSoundEnabled = window.api?.onSoundEnabledChanged((enabled) => {
      setSoundEnabled(enabled);
    });
    const removeCancelMode = window.api?.onPillCancelModeChanged((mode) => {
      setCancelMode(normalizePillCancelMode(mode));
    });
    const removeAudioPlaybackMode = window.api?.onAudioPlaybackModeChanged(
      (mode) => {
        setAudioPlaybackMode(normalizeAudioPlaybackMode(mode));
      },
    );
    // A cleanup-relevant setting (llm_cleanup / a cleanup tone) changed in the
    // dashboard. Refresh the cached routing decision once here so startRecording
    // reads it synchronously instead of fetching /api/settings every press.
    const removeCleanupContext = window.api?.onCleanupContextChanged(() => {
      void refreshNeedsAppContextForCleanup();
    });
    // The server target (URL/token) changed in Settings. Re-point this window's
    // API client and tear down the streamer so its next connection uses the new
    // server — no app restart needed. A fresh streamer is created immediately so
    // session-transport support is renegotiated before the next recording.
    const removeServerChanged = window.api?.onServerChanged(() => {
      void refreshApiBase().finally(() => {
        streamerRef.current?.destroy();
        streamerRef.current = null;
        supportsSessionTransportRef.current = false;
        getStreamer();
        destroyRemixStreamer();
      });
    });
    return () => {
      removePillPos?.();
      removeOutputMode?.();
      removeSoundEnabled?.();
      removeCancelMode?.();
      removeAudioPlaybackMode?.();
      removeCleanupContext?.();
      removeServerChanged?.();
    };
  }, [applyPillPosition, getStreamer, destroyRemixStreamer]);

  // "always" pins the button open; "hover" lets the pointer drive it.
  useEffect(() => {
    cancelModeRef.current = cancelMode;
    cancelTargetRef.current =
      cancelMode === "always" || hoveredRef.current ? 1 : 0;
  }, [cancelMode]);

  const handlePillEnter = useCallback(() => {
    hoveredRef.current = true;
    cancelTargetRef.current = 1;
  }, []);

  const handlePillLeave = useCallback(() => {
    hoveredRef.current = false;
    if (cancelModeRef.current !== "always") cancelTargetRef.current = 0;
  }, []);

  // ---- Hotkey handlers ----
  useEffect(() => {
    const removeDown = window.api.onHotkeyDown((payload) => {
      pinnedLanguageRef.current = payload?.language ?? null;
      // Dictation is the primary use of this pill; a remix card sitting in
      // front of it (most likely one the user has already read and moved on
      // from) gets out of the way rather than blocking the press.
      if (remixRef.current) endRemix({ hide: false });
      // hidePill() clears pillActiveRef before React re-renders idle state.
      if (!pillActiveRef.current) {
        stateRef.current = "idle";
      }
      const s = stateRef.current;
      if (s === "idle") {
        startRecording(false);
      } else if (s === "error") {
        // A fresh hotkey press means "start a new dictation". The failed
        // capture remains retryable from the visible Retry button until then.
        setPillNotice(null);
        setCanRetry(false);
        void startRecording(false);
      } else if (s === "transcribing" && !wantsMicRef.current) {
        if (isTranscriptionIdle()) {
          dismissPill("quiet");
          return;
        }
        // A pending streaming commit owns the single WebSocket + PCM buffer,
        // so a second streaming session can't run alongside it. Defer the
        // re-record until the commit resolves rather than dropping the press.
        if (streamResolverRef.current !== null) {
          pendingReRecordRef.current = true;
          return;
        }
        // A previous batch transcription is still in flight; start a new
        // recording alongside it. Its result is queued and drained normally.
        void startRecording(true);
      }
    });
    const removeUp = window.api.onHotkeyUp(() => {
      if (!pillActiveRef.current) return;
      if (stateRef.current === "recording") {
        commitRecording();
      } else if (stateRef.current === "initializing") {
        pendingCommitRef.current = true;
      } else if (
        stateRef.current === "transcribing" &&
        !wantsMicRef.current &&
        isTranscriptionIdle()
      ) {
        dismissPill("quiet");
      }
    });
    const removeCancel = window.api.onPillCancel(() => {
      // Escape reaches whichever surface is up. A remix owns the pill only
      // when there is no dictation, so there is never a question of which.
      if (remixRef.current) {
        endRemix();
        return;
      }
      if (stateRef.current !== "idle") cancelRecording();
    });
    return () => {
      removeDown();
      removeUp();
      removeCancel();
    };
  }, [
    startRecording,
    commitRecording,
    cancelRecording,
    endRemix,
    dismissPill,
    isTranscriptionIdle,
    setPillNotice,
  ]);

  useRemixHotkeys({
    ...shared,
    beginRemix,
    finishRemixPress,
    runRemix,
    releaseRemixMic,
    resetDictation,
    restoreSystemAudioSafely,
  });

  // ---- Warnings see themselves out ----
  // A warning has said everything it has to say the moment it is read. Leaving
  // it up turns the pill into something the user has to go and clear, on top
  // of whatever they were doing — so both cards time out. The remix warning
  // carries no action and goes sooner; the dictation failure can offer a Retry,
  // so it waits long enough for that to be a real choice.
  useEffect(() => {
    if (remix?.phase !== "error") return;
    const timer = setTimeout(() => endRemix(), REMIX_WARNING_MS);
    return () => clearTimeout(timer);
  }, [remix?.phase, endRemix]);

  useEffect(() => {
    if (state !== "error") return;
    const timer = setTimeout(hidePill, FAILURE_CARD_MS);
    return () => clearTimeout(timer);
  }, [state, hidePill]);

  // ---- Cleanup on unmount ----
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      setTimeout(() => {
        if (!mountedRef.current) {
          cancelRecording();
          recorderRef.current.destroy();
          streamerRef.current?.destroy();
          streamerRef.current = null;
          destroyRemixStreamer();
        }
      }, 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cancelRecording, destroyRemixStreamer]);

  // ---- Render ----
  // Two surfaces share one anchor: the capsule, which is the whole UI on the
  // happy path, and — only when a dictation has actually failed — a card that
  // takes over to say what happened and offer the way out. Anything short of
  // a failure (a slow connect, a retry in flight) stays in the capsule as a
  // single mark at its right-hand end. Prose belongs in the card; the capsule
  // sits over whatever the user is actually doing, so it only ever earns a
  // glyph, and the words behind it are in the tooltip and to screen readers.
  const showErrorCard = state === "error";
  // A remix replaces the capsule outright: its own card carries the waveform,
  // so there is nothing left for the capsule to say while one is up.
  const showRemixCard = remix !== null;
  const showRemixChat = remix?.phase === "chat";
  const remixChatMini = showRemixChat && remix?.minimized === true;
  const showCard = showErrorCard || showRemixCard;
  const active = state !== "idle" || showRemixCard;

  // The minimized chat strip's current height: the one-line default while the
  // agent narrates, grown by RemixChat to fit the final message once a run
  // settles. The surface below sizes the strip from this.
  const [remixMiniHeight, setRemixMiniHeight] = useState<number>(
    REMIX_CHAT_STRIP.height,
  );
  useEffect(() => {
    if (!showRemixChat) setRemixMiniHeight(REMIX_CHAT_STRIP.height);
  }, [showRemixChat]);

  // Hold the initial hidden state for one frame so the enter transition runs.
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (!active) {
      setEntered(false);
      return;
    }
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, [active]);

  // ---- Elapsed ----
  // Nothing is said about duration until a dictation is genuinely long, and
  // then it uses the status slot that already exists for growing the capsule
  // by exactly one mark — the waveform doesn't move.
  //
  // Gated on "recording" alone, and never on `initializing`: the clock only
  // starts when the mic is actually open, so during initialization
  // `startTimeRef` still holds 0 (first session) or the previous session's
  // start. Reading it then measures the age of the epoch — which is how the
  // very first press of a fresh process ended up opening the slot on a
  // 29-million-minute readout.
  useEffect(() => {
    if (state !== "recording" || startTimeRef.current === 0) {
      setElapsedLabel(null);
      return;
    }
    const tick = (): void => {
      const ms = Date.now() - startTimeRef.current;
      if (ms < ELAPSED_AFTER_MS) {
        setElapsedLabel(null);
        return;
      }
      const secs = Math.floor(ms / 1000);
      setElapsedLabel(
        `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`,
      );
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [state]);

  // ---- Warming ----
  // Names the post-handover wait when a cold local model is loading. The
  // mark opens only after WARMING_AFTER_MS of transcribing with a latched
  // cold-model flag, and comes down the moment the state leaves
  // "transcribing" (result landed, error card, or the pill exiting) — the
  // result arriving *is* the "server ready" signal from the client's side.
  // Gated on the latch, not a bare elapsed heuristic, so a merely-slow cloud
  // cleanup never gets a warming mark (the PillNotice doc comment's
  // crying-wolf bar).
  useEffect(() => {
    if (state !== "transcribing" || !coldLocalModel) {
      setWarming(false);
      return;
    }
    const timer = setTimeout(() => setWarming(true), WARMING_AFTER_MS);
    return () => {
      clearTimeout(timer);
      setWarming(false);
    };
  }, [state, coldLocalModel]);

  // What that mark means. Errors are the card's job, so a "working" notice
  // here is a spinner and a stalled one is the alert mark. Warming rides the
  // same slot as a "working" mark — the words live in the tooltip and the
  // live region (exactly how "Retrying" is carried): the pill window is
  // 160px wide (APP_WIDTH in main/index.ts) and the capsule's fixed core + a
  // language chip leave no room for a visible sentence, and the motion spec
  // (§2, principle 3) keeps prose out of the capsule anyway.
  const statusLabel = showCard
    ? null
    : pillNotice === "reconnecting"
      ? "Reconnecting"
      : pillNotice === "retrying"
        ? "Retrying"
        : pillNotice === "unavailable"
          ? "Unavailable"
          : warming
            ? WARMING_LABEL
            : null;
  const statusIsAlert = pillNotice === "unavailable";

  // Only worth showing when more than one dictation is stacked up; a single
  // in-flight transcription is already implied by the sweeping waveform. A
  // queue outranks the clock — a backlog is the more actionable fact, and the
  // slot holds one mark.
  const statusCount = statusLabel
    ? null
    : pendingCount > 1
      ? String(pendingCount)
      : elapsedLabel;
  const wantsStatus = !showCard && !exiting && !!(statusLabel || statusCount);

  const cardTitle = "Transcription failed";
  const cardBody = failedTranscriptionErrorRef.current;

  const status = {
    label: statusLabel,
    count: statusCount,
    isAlert: statusIsAlert,
  };
  const card = { title: cardTitle, body: cardBody, canRetry };

  const remixStatus = !remix
    ? null
    : remix.phase === "error"
      ? `${remix.title}. ${remix.body}`
      : remix.phase === "running"
        ? `Applying ${remix.label ?? "remix"}`
        : remix.phase === "listening" || remix.phase === "capturing"
          ? "Listening for a remix"
          : remix?.phase === "chat"
            ? "Remix chat"
            : "Remix";

  const accessibleStatus = remixStatus
    ? remixStatus
    : showErrorCard
      ? `${cardTitle}. ${cardBody}`
      : exiting === "delivered"
        ? "Dictation delivered"
        : (statusLabel ??
          (micSilent
            ? "No audio from your microphone"
            : state === "initializing"
              ? "Preparing microphone"
              : state === "recording"
                ? "Listening"
                : state === "transcribing"
                  ? "Transcribing"
                  : ""));

  // ---- Room for the card ----
  // The capsule, status mark and all, fits the pill window as it is; only the
  // card needs the window grown around it first, so that it animates into
  // space that already exists instead of being clipped for a frame or two.
  // `roomReady` is that handshake; giving the room back waits for the card to
  // finish leaving.
  const [roomReady, setRoomReady] = useState(false);
  const chatSurfaceRef = useRef<HTMLDivElement | null>(null);
  const cardSurfaceRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!showCard) {
      setRoomReady(false);
      const timer = setTimeout(() => window.api?.setPillExpanded(false), 300);
      return () => clearTimeout(timer);
    }
    // A remix session takes the full chat-sized room for its whole life and
    // gives it back only once everything has animated away. Resizing the
    // window mid-session (card to chat, chat to strip) paints at least one
    // stale compositor frame at the new origin — a visible blink — so every
    // in-session size change is DOM animation inside room that already
    // exists, and the two resizes that remain happen while the surfaces are
    // invisible.
    window.api?.setPillExpanded(true, showRemixCard ? "remix-chat" : "card");
    // Two frames: one for the resize to land, one for the browser to lay the
    // card out at its start values so the transition has something to run
    // from. Setting both in the same frame would jump straight to the end.
    //
    // Both ids are held, because a dismiss (or an unmount) landing in the
    // ~16ms between them would otherwise leave the inner frame uncancelled
    // and still writing state. The timer backstops a throttled window whose
    // rAF callbacks never fire.
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setRoomReady(true));
    });
    const fallback = window.setTimeout(() => setRoomReady(true), 120);
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
      clearTimeout(fallback);
    };
  }, [showCard, showRemixCard]);

  const cardOpen = showCard && roomReady;
  const errorCardOpen = showErrorCard && roomReady;

  // The failure card can sit there for as long as the user takes to answer it,
  // and the waveform underneath is neither visible nor meaningful by then —
  // park the draw loop once the capsule has finished fading out. The remix
  // card is the opposite case: the bars move *into* it, so leave them running.
  useEffect(() => {
    if (!showErrorCard || showRemixCard) return;
    const timer = setTimeout(stopVisualization, 260);
    return () => clearTimeout(timer);
  }, [showErrorCard, showRemixCard, stopVisualization]);

  // Grow the card out of the capsule it replaces, not out of thin air.
  const transformOrigin = `${pillSide === "right" ? "right" : "center"} ${
    pillAlign === "start" ? "top" : "bottom"
  }`;

  // The viewport the waveform is seen through. It narrows from the left as the
  // button opens; the SVG inside is pinned to its right edge, so the newest
  // samples hold their place and only the oldest slide out of view.
  // Cream in every state except actively recording, where the waveform
  // switches to the live-coral accent — the capsule's one glance-able
  // "this is really listening" signal. Gated on "recording" specifically
  // (not "transcribing" or "initializing"), matching the mockup's
  // `.dict-card.live` treatment of the equivalent dashboard control.
  const waveColor = state === "recording" ? LIVE : BAR_COLOR;

  const waveform = (
    <span
      ref={waveClipRef}
      style={{
        position: "relative",
        display: "block",
        width: SVG_WIDTH,
        height: SVG_HEIGHT,
        overflow: "hidden",
        flexShrink: 0,
      }}
    >
      <svg
        ref={captureBarLines}
        width={SVG_WIDTH}
        height={SVG_HEIGHT}
        viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
        style={
          {
            display: "block",
            position: "absolute",
            right: 0,
            top: 0,
            WebkitAppRegion: "no-drag",
          } as React.CSSProperties
        }
        aria-hidden="true"
      >
        {/* Flatline is drawn under the bars when the mic is silent. */}
        <line
          ref={flatlineRef}
          x1={SVG_WIDTH / 2}
          y1={SVG_HEIGHT / 2}
          x2={SVG_WIDTH / 2}
          y2={SVG_HEIGHT / 2}
          stroke={waveColor}
          strokeWidth={1}
          strokeLinecap="round"
          opacity={0}
        />
        <g data-bars="">
          {BAR_X_POSITIONS.map((x, index) => {
            const closeDelay = Math.round(
              (BAR_CENTER - Math.abs(index - BAR_CENTER)) * CLOSE_STEP_MS,
            );
            return (
              <line
                key={x}
                x1={x}
                y1={SVG_HEIGHT / 2 + BAR_WIDTH / 2}
                x2={x}
                y2={SVG_HEIGHT / 2 - BAR_WIDTH / 2}
                stroke={waveColor}
                strokeWidth={BAR_WIDTH}
                strokeLinecap="round"
                style={
                  {
                    "--close-delay": `${closeDelay}ms`,
                  } as React.CSSProperties
                }
              />
            );
          })}
        </g>
      </svg>
    </span>
  );

  const layerClass = `pill-layer absolute inset-0 flex ${
    pillAlign === "start" ? "items-start" : "items-end"
  } ${pillSide === "right" ? "justify-end pr-3" : "justify-center"}`;

  // Surfaces rise off the edge they are anchored to, so the motion always
  // reads as coming from the screen edge rather than from an arbitrary
  // direction: negative (downward) when the pill lives at the top.
  const riseBy = (distance: number): React.CSSProperties =>
    ({
      "--pill-rise": `${pillAlign === "start" ? -distance : distance}px`,
    }) as React.CSSProperties;

  // The card surface both the failure and the remix card are cut from.
  //
  // Note what is deliberately *not* here: `WebkitAppRegion`. Both cards stay
  // mounted while hidden so they have something to animate out of, and a
  // draggable region is carved out of the window by the compositor from the
  // element geometry alone — `pointer-events: none` and `opacity: 0` do not
  // exempt it. A hidden card is laid out directly over the capsule, so
  // declaring the region here made it swallow every mouse event the pill
  // should have seen: no hover to reveal the cancel button, and no click
  // landing on it. Each card claims the region only while it is really up.
  const cardSurfaceStyle: React.CSSProperties = {
    // The card travels a little further than the capsule, being bigger.
    ...riseBy(14),
    width: PILL_CARD_WIDTH,
    borderRadius: 20,
    background: SURFACE,
    border: SURFACE_BORDER,
    backdropFilter: BLUR,
    WebkitBackdropFilter: BLUR,
    transformOrigin,
    marginBottom: pillAlign === "end" ? 8 : 0,
    marginTop: pillAlign === "start" ? 8 : 0,
    cursor: "grab",
  } as React.CSSProperties;

  // ---- Remix card content ----
  // Latched for the same reason the failure card's is: the session is cleared
  // the instant a remix lands, and re-rendering an empty card would blank it
  // a beat before it has finished animating away.
  const remixView = useLatchedValue(remix, VIEW_LATCH_MS);
  const remixOpen = showRemixCard && roomReady;

  const viewIsChat = remixView?.phase === "chat";

  // The dictation card and the chat are separate surface layers, each
  // latching the last content it showed: a phase flip animates the old
  // surface out underneath the new one rising — a handover, never an
  // instant restyle of one box.
  const liveCardView =
    remixView && remixView.phase !== "chat" ? remixView : null;
  const cardView = useLatchedValue(liveCardView, VIEW_LATCH_MS);

  const liveChatView = remixView?.phase === "chat" ? remixView : null;
  const chatView = useLatchedValue(liveChatView, VIEW_LATCH_MS);

  const [chatMiniVisual, setChatMiniVisual] = useState(true);
  const chatWasLiveRef = useRef(false);
  useEffect(() => {
    const wasLive = chatWasLiveRef.current;
    chatWasLiveRef.current = showRemixChat;
    if (!viewIsChat) {
      setChatMiniVisual(true);
      return;
    }
    if (!showRemixChat) return;
    if (!wasLive || remixChatMini) {
      setChatMiniVisual(remixChatMini);
      return;
    }
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setChatMiniVisual(false));
    });
    // rAF only fires while the compositor produces frames; a throttled or
    // occluded window would otherwise never finish the morph.
    const fallback = window.setTimeout(() => setChatMiniVisual(false), 120);
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
      clearTimeout(fallback);
    };
  }, [viewIsChat, showRemixChat, remixChatMini]);

  const remixTranscript = cardView?.transcript?.trim() ?? "";
  const remixHint =
    cardView?.phase === "running"
      ? (cardView.label ?? "Working…")
      : "Listening…";

  // ---- Hot-rect pass-through ----
  // The held remix room is mostly empty when only the strip or the dictation
  // card is showing; report the surface the pointer can land on, and main
  // keeps the rest of the window click-through. The fully open chat owns the
  // whole window, matching the old chat-sized window exactly.
  const chatFullyOpen = remixOpen && viewIsChat && !chatMiniVisual;
  const reportHotRectRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!showRemixCard) return;
    if (chatFullyOpen) {
      reportHotRectRef.current = () => {};
      window.api?.setPillHotRect?.(null);
      return;
    }
    const el = viewIsChat ? chatSurfaceRef.current : cardSurfaceRef.current;
    if (!el) return;
    const report = (): void => {
      const rect = el.getBoundingClientRect();
      // A little forgiveness around the edges so a pointer aiming for the
      // surface doesn't fall through just short of it.
      window.api?.setPillHotRect?.({
        x: Math.floor(rect.x) - 8,
        y: Math.floor(rect.y) - 8,
        width: Math.ceil(rect.width) + 16,
        height: Math.ceil(rect.height) + 16,
      });
    };
    reportHotRectRef.current = report;
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [showRemixCard, chatFullyOpen, viewIsChat]);

  // The pointer arriving flips the window interactive (forwarded events on
  // macOS/Windows, the main-process cursor poll everywhere); leaving hands
  // the empty room back to whatever is underneath.
  const disarmHotRect = useCallback(
    () => window.api?.setPillHotRect?.(null),
    [],
  );
  const rearmHotRect = useCallback(() => reportHotRectRef.current(), []);
  useEffect(() => {
    return window.api?.onPillHotEnter?.(() => {
      if (remixRef.current?.phase === "chat" && remixRef.current.minimized) {
        expandRemixChat();
      }
    });
  }, [expandRemixChat]);

  return (
    <PillView
      state={state}
      showRemixCard={showRemixCard}
      accessibleStatus={accessibleStatus}
      layerClass={layerClass}
      cardOpen={cardOpen}
      showCard={showCard}
      entered={entered}
      exiting={exiting}
      handlePillEnter={handlePillEnter}
      handlePillLeave={handlePillLeave}
      riseBy={riseBy}
      transformOrigin={transformOrigin}
      pillAlign={pillAlign}
      pillSide={pillSide}
      cancelSlotRef={cancelSlotRef}
      cancelRecording={cancelRecording}
      pillLanguageLabel={pillLanguageLabel}
      waveColor={waveColor}
      waveform={waveform}
      wantsStatus={wantsStatus}
      status={status}
      errorCardOpen={errorCardOpen}
      cardSurfaceStyle={cardSurfaceStyle}
      card={card}
      dismissPill={dismissPill}
      retryFailedTranscription={retryFailedTranscription}
      remixOpen={remixOpen}
      viewIsChat={viewIsChat}
      cardSurfaceRef={cardSurfaceRef}
      chatSurfaceRef={chatSurfaceRef}
      disarmHotRect={disarmHotRect}
      rearmHotRect={rearmHotRect}
      cardView={cardView}
      endRemix={endRemix}
      remixTranscript={remixTranscript}
      remixHint={remixHint}
      chatMiniVisual={chatMiniVisual}
      remixMiniHeight={remixMiniHeight}
      chatView={chatView}
      remixContextRef={remixContextRef}
      expandRemixChat={expandRemixChat}
      minimizeRemixChat={minimizeRemixChat}
      closeRemix={closeRemix}
      setRemixMiniHeight={setRemixMiniHeight}
    />
  );
}
