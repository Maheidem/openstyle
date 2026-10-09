// biome-ignore-all lint/correctness/useExhaustiveDependencies: refs, setters and callbacks come in through deps and keep one identity for the life of AppPage. The dependency lists stay as they were before the move.
import { REMIX_PRESETS } from "@openstyle/validations";
import { apiFetch, getApiBase, getServerToken } from "@renderer/lib/api";
import { RecorderSupersededError } from "@renderer/lib/recorder";
import { Streamer } from "@renderer/lib/streamer";
import { postTranscribe } from "@renderer/lib/transcribe-client";
import { useCallback, useEffect } from "react";
import { REMIX_HOLD_THRESHOLD_MS } from "../../../../shared/remix";
import { playTone } from "../pill-tones";
import { type BarMode, type Deferred, deferred } from "./constants";
import type { PillShared } from "./pill-shared";

export type UseRemixSessionDeps = Pick<
  PillShared,
  | "pillActiveRef"
  | "recorderRef"
  | "remixContextRef"
  | "remixDownAtRef"
  | "remixFinalRef"
  | "remixHoldTimerRef"
  | "remixMicGenRef"
  | "remixRef"
  | "remixRunningRef"
  | "remixSelectionRef"
  | "remixSeqRef"
  | "remixStreamerRef"
  | "remixTransportRef"
  | "stateRef"
  | "setRemix"
  | "patchRemix"
> & {
  stopVisualization: () => void;
  startBarAnimation: (mode: BarMode) => void;
  startListening: (stream: MediaStream) => void;
};

export type UseRemixHotkeysDeps = Pick<
  PillShared,
  | "pillActiveRef"
  | "recorderRef"
  | "remixContextRef"
  | "remixRef"
  | "remixSelectionRef"
  | "remixSeqRef"
  | "stateRef"
  | "streamerRef"
  | "setRemix"
  | "patchRemix"
> & {
  beginRemix: () => void;
  finishRemixPress: () => void;
  runRemix: (options: {
    remixId?: string;
    instruction?: string;
    label: string;
  }) => Promise<void>;
  releaseRemixMic: () => void;
  resetDictation: () => void;
  restoreSystemAudioSafely: () => Promise<void>;
};

export function useRemixSession(deps: UseRemixSessionDeps) {
  const {
    pillActiveRef,
    recorderRef,
    remixContextRef,
    remixDownAtRef,
    remixFinalRef,
    remixHoldTimerRef,
    remixMicGenRef,
    remixRef,
    remixRunningRef,
    remixSelectionRef,
    remixSeqRef,
    remixStreamerRef,
    remixTransportRef,
    stateRef,
    setRemix,
    patchRemix,
    stopVisualization,
    startBarAnimation,
    startListening,
  } = deps;

  // ---- Remix ----
  // A remix is not a dictation: it never enters the transcription queue,
  // and its result replaces a selection rather than being inserted at a
  // cursor. What it does share is the
  // pill — the surface, the waveform, and the mic behind it.

  const clearRemixHoldTimer = useCallback(() => {
    if (remixHoldTimerRef.current) {
      clearTimeout(remixHoldTimerRef.current);
      remixHoldTimerRef.current = null;
    }
  }, []);

  /** Stop the remix mic capture and release its stream, if one is open. */
  const releaseRemixMic = useCallback(() => {
    if (remixMicGenRef.current !== null) {
      recorderRef.current.discard(remixMicGenRef.current);
      remixMicGenRef.current = null;
    }
  }, []);

  /** Tear the session down. `hide` is false only when an error card stays up. */
  const getRemixStreamer = useCallback((): Streamer => {
    if (!remixStreamerRef.current) {
      remixStreamerRef.current = new Streamer(getApiBase(), getServerToken(), {
        onConfig: (config) => {
          remixTransportRef.current = config.sessionTransport;
        },
        onPartial: (text) => {
          if (remixRef.current && text) patchRemix({ transcript: text });
        },
        onFinal: (text) => {
          if (remixRef.current && text.trim()) {
            patchRemix({ transcript: text });
          }
          remixFinalRef.current?.resolve(text);
          remixFinalRef.current = null;
        },
        onError: () => {
          remixFinalRef.current?.resolve("");
          remixFinalRef.current = null;
        },
      });
    }
    return remixStreamerRef.current;
  }, []);

  /** Destroy the remix streamer. The next remix creates a new one. */
  const destroyRemixStreamer = useCallback(() => {
    remixStreamerRef.current?.destroy();
    remixStreamerRef.current = null;
    remixTransportRef.current = false;
  }, []);

  const endRemix = useCallback(
    (options: { hide?: boolean } = {}) => {
      if (!remixRef.current) return;
      clearRemixHoldTimer();
      remixRunningRef.current = false;
      // Resolve any pending await so a run blocked on the selection unwinds
      // instead of hanging on a session that no longer exists.
      remixSelectionRef.current?.resolve(null);
      remixSelectionRef.current = null;
      remixFinalRef.current?.resolve("");
      remixFinalRef.current = null;
      remixContextRef.current = null;
      releaseRemixMic();
      remixStreamerRef.current?.cancel();
      window.api?.setRemixRouteKeys(false);
      setRemix(null);
      stopVisualization();
      if (options.hide !== false) window.api?.hidePill();
    },
    [clearRemixHoldTimer, setRemix, stopVisualization, releaseRemixMic],
  );

  const closeRemix = useCallback(() => endRemix(), [endRemix]);
  const expandRemixChat = useCallback(() => {
    if (remixRef.current?.minimized !== false) {
      patchRemix({ minimized: false });
    }
  }, [patchRemix]);
  const minimizeRemixChat = useCallback(() => {
    if (remixRef.current && remixRef.current.minimized !== true) {
      patchRemix({ minimized: true });
    }
  }, [patchRemix]);

  /**
   * Show a failure and leave the card up. Unlike the phases above this one
   * outlives the keypress: it waits for Escape, the Dismiss button, another
   * press of the hotkey — or the REMIX_WARNING_MS timeout, whichever lands
   * first.
   */
  const failRemix = useCallback(
    (title: string, body: string) => {
      clearRemixHoldTimer();
      remixRunningRef.current = false;
      releaseRemixMic();
      remixStreamerRef.current?.cancel();
      window.api?.setRemixRouteKeys(false);
      stopVisualization();
      setRemix({
        id: remixRef.current?.id ?? ++remixSeqRef.current,
        phase: "error",
        selection: null,
        title,
        body,
      });
    },
    [clearRemixHoldTimer, setRemix, stopVisualization, releaseRemixMic],
  );

  /**
   * Send the edited text back to the app the selection came from.
   *
   * The paste is the commit point: main hides the pill from inside it, so the
   * card is gone by the time the text lands and the user never sees the pill
   * sitting over their own document mid-replace.
   */
  const deliverRemixResult = useCallback(
    async (text: string) => {
      const sessionId = remixRef.current?.id;
      const pasted = await window.api.pasteRemixResult(text);
      if (remixRef.current?.id !== sessionId) return;
      if (!pasted) {
        failRemix(
          "Couldn't replace the text",
          "The edit is on your clipboard — paste it yourself.",
        );
        return;
      }
      endRemix({ hide: false });
    },
    [endRemix, failRemix],
  );

  /**
   * Run one remix over the captured selection.
   *
   * Waits on the selection rather than requiring it: the copy is still in
   * flight for the first ~100ms of every session, which is well inside the
   * time it takes to tap a number key.
   */
  /**
   * The selection, once the copy has answered — or null, having already put
   * the refusal on screen.
   *
   * Every path into a remix goes through here, because a remix without a
   * selection has no subject: there is nothing to edit, nothing to paste over,
   * and nothing worth spending a transcription or a model call on. Waiting
   * rather than requiring is deliberate — the copy is still in flight for the
   * first fraction of a second of every session.
   */
  const requireSelection = useCallback(
    async (sessionId: number): Promise<string | null> => {
      const selection = await (remixSelectionRef.current?.promise ??
        Promise.resolve(remixRef.current?.selection ?? null));
      if (remixRef.current?.id !== sessionId) return null;
      if (!selection) {
        failRemix(
          "Nothing selected",
          "Highlight some text in any app first, then press the hotkey.",
        );
        return null;
      }
      return selection;
    },
    [failRemix],
  );

  const runRemix = useCallback(
    async (options: {
      remixId?: string;
      instruction?: string;
      label: string;
    }) => {
      if (remixRunningRef.current) return;
      const session = remixRef.current;
      if (!session) return;
      remixRunningRef.current = true;
      patchRemix({ phase: "running", label: options.label });
      startBarAnimation("speaking");

      const selection = await requireSelection(session.id);
      if (!selection) return;

      try {
        const res = await apiFetch("/api/remix/transform", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: selection,
            remixId: options.remixId,
            instruction: options.instruction,
            appName: remixContextRef.current?.appName ?? null,
          }),
        });
        if (remixRef.current?.id !== session.id) return;

        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            error?: string;
            detail?: string;
          } | null;
          failRemix(
            "Remix failed",
            body?.detail || `The model couldn't run that (${res.status}).`,
          );
          return;
        }

        const data = (await res.json()) as { text?: string };
        const edited = (data.text ?? "").trim();
        if (remixRef.current?.id !== session.id) return;
        if (!edited) {
          failRemix("Remix failed", "The model returned nothing.");
          return;
        }
        await deliverRemixResult(edited);
      } catch (err) {
        if (remixRef.current?.id !== session.id) return;
        failRemix(
          "Remix failed",
          err instanceof Error ? err.message : "Something went wrong.",
        );
      }
    },
    [
      deliverRemixResult,
      failRemix,
      patchRemix,
      requireSelection,
      startBarAnimation,
    ],
  );

  /**
   * Hand the session over to the chat card (the agent lane). Everything the
   * glanceable card was doing stops — mic, waveform, idle timers, the claimed
   * route digits — because the card is now a conversation, not a prompt.
   */
  const openRemixChat = useCallback(
    (instruction: string | null, options: { minimized?: boolean } = {}) => {
      clearRemixHoldTimer();
      remixRunningRef.current = false;
      releaseRemixMic();
      stopVisualization();
      window.api?.setRemixRouteKeys(false);
      patchRemix({
        phase: "chat",
        initialInstruction: instruction,
        minimized: options.minimized === true,
      });
    },
    [clearRemixHoldTimer, patchRemix, stopVisualization, releaseRemixMic],
  );

  /**
   * Transcribe the held instruction, then hand it to the agent lane.
   *
   * This goes through the one-shot REST path rather than the streaming session
   * the dictation flow uses. An instruction is a second or two of speech whose
   * text is never pasted anywhere — partials buy nothing, and the streaming
   * session belongs to dictation, which may well have one in flight.
   *
   * Unlike a preset, a spoken instruction does not require a selection: with
   * nothing highlighted the agent writes at the cursor, answers in chat, or
   * uses the clipboard.
   */
  const runSpokenRemix = useCallback(async () => {
    const session = remixRef.current;
    if (!session) return;
    const micGen = remixMicGenRef.current;
    const durationMs = Math.round(performance.now() - remixDownAtRef.current);
    patchRemix({ phase: "running", label: "Transcribing…" });
    startBarAnimation("speaking");
    // The dictation stop cue, at the same moment: the held instruction has
    // been committed. Remix never ducks system audio, so no restore first.
    void playTone("stop");

    const streamer = remixStreamerRef.current;
    let finalPromise: Promise<string> | null = null;
    let final: Deferred<string> | null = null;
    if (streamer?.isConnected() && remixTransportRef.current) {
      final = deferred<string>();
      remixFinalRef.current = final;
      streamer.commit();
      finalPromise = Promise.race([
        final.promise,
        new Promise<string>((resolve) => setTimeout(() => resolve(""), 8000)),
      ]);
    } else {
      streamer?.cancel();
    }

    // Wait for the capture to land — the chat card needs the anchor even
    // when the selection itself comes back empty.
    await (remixSelectionRef.current?.promise ?? Promise.resolve(null));
    if (remixRef.current?.id !== session.id) return;

    let wav: Blob | null = null;
    try {
      wav = recorderRef.current.isRecording()
        ? await recorderRef.current.stop(micGen ?? undefined)
        : null;
    } catch {
      wav = null;
    }
    recorderRef.current.releaseStream(micGen ?? undefined);
    if (remixRef.current?.id !== session.id) return;

    let instruction = "";
    if (finalPromise) {
      instruction = (await finalPromise).trim();
      if (remixFinalRef.current === final) remixFinalRef.current = null;
      if (remixRef.current?.id !== session.id) return;
    }

    if (!instruction && wav) {
      try {
        const res = await postTranscribe(wav, {
          durationMs,
          skipPostProcess: true,
        });
        if (remixRef.current?.id !== session.id) return;
        if (res.ok) {
          const data = (await res.json()) as { raw?: string; cleaned?: string };
          instruction = (data.raw || data.cleaned || "").trim();
        }
      } catch {
        instruction = "";
      }
    }

    if (remixRef.current?.id !== session.id) return;
    if (!instruction) {
      failRemix(
        "Didn't catch that",
        "Nothing came through — hold the hotkey and say what to do.",
      );
      return;
    }
    // A spoken run opens minimized: the user asked for something to be done,
    // not for a window. The strip narrates the run; hovering it opens the
    // full conversation.
    openRemixChat(instruction, { minimized: true });
  }, [failRemix, openRemixChat, patchRemix, startBarAnimation]);

  const beginRemix = useCallback(() => {
    // A dictation owns the pill while it is up. Rather than fight over it,
    // remix stands down — the user can press again a moment later.
    if (stateRef.current !== "idle" || pillActiveRef.current) {
      window.api?.setRemixRouteKeys(false);
      return;
    }
    // A second press while an error card is up means "try again", so tear the
    // old session down first rather than merging into it.
    if (remixRef.current) endRemix({ hide: false });

    remixDownAtRef.current = performance.now();
    remixSelectionRef.current = deferred<string | null>();
    setRemix({
      id: ++remixSeqRef.current,
      phase: "capturing",
      selection: null,
    });

    // Once the press has outlived the tap threshold it can only be a hold, so
    // the card commits to that reading rather than waiting for the release —
    // the user is already talking by then and should be able to see it.
    clearRemixHoldTimer();
    remixHoldTimerRef.current = setTimeout(() => {
      remixHoldTimerRef.current = null;
      if (remixRef.current?.phase === "capturing") {
        patchRemix({ phase: "listening" });
        // The same audio cue dictation gives on recording start — played at
        // the hold threshold so a tap (which opens the chat) stays silent.
        void playTone("start");
      }
    }, REMIX_HOLD_THRESHOLD_MS);

    // The mic starts now, before we know this is a hold: a recording that only
    // began once the threshold had passed would clip the first syllable off
    // every spoken remix.
    const rec = recorderRef.current;
    const startPromise = rec.start();
    const micGen = rec.generation();
    remixMicGenRef.current = micGen;
    void startPromise
      .then((stream) => {
        const session = remixRef.current;
        const owned =
          session &&
          remixMicGenRef.current === micGen &&
          micGen === rec.generation();
        if (!owned) {
          rec.discard(micGen);
          if (remixMicGenRef.current === micGen) remixMicGenRef.current = null;
          return;
        }
        if (session.phase === "capturing" || session.phase === "listening") {
          startListening(stream);
          void getRemixStreamer().startCapture(stream);
        }
      })
      .catch((err) => {
        if (err instanceof RecorderSupersededError) return;
        // No mic is survivable — the preset list doesn't need one. Show the
        // idle bars so the card doesn't look broken, and let the footer's own
        // copy be the only thing that mentions speaking.
        if (remixRef.current) startBarAnimation("listening");
      });
  }, [
    clearRemixHoldTimer,
    endRemix,
    getRemixStreamer,
    patchRemix,
    setRemix,
    startBarAnimation,
    startListening,
  ]);

  const finishRemixPress = useCallback(() => {
    clearRemixHoldTimer();
    const session = remixRef.current;
    if (!session) return;
    if (session.phase !== "capturing" && session.phase !== "listening") return;

    const heldMs = performance.now() - remixDownAtRef.current;
    if (heldMs < REMIX_HOLD_THRESHOLD_MS) {
      // A tap. Throw the fragment of audio away and open the chat card — the
      // ChatGPT-style input, with the presets as chips inside it.
      remixStreamerRef.current?.cancel();
      openRemixChat(null);
      return;
    }
    void runSpokenRemix();
  }, [clearRemixHoldTimer, openRemixChat, runSpokenRemix]);

  return {
    releaseRemixMic,
    destroyRemixStreamer,
    endRemix,
    closeRemix,
    expandRemixChat,
    minimizeRemixChat,
    runRemix,
    beginRemix,
    finishRemixPress,
  };
}

export function useRemixHotkeys(deps: UseRemixHotkeysDeps): void {
  const {
    pillActiveRef,
    recorderRef,
    remixContextRef,
    remixRef,
    remixSelectionRef,
    remixSeqRef,
    stateRef,
    streamerRef,
    setRemix,
    patchRemix,
    beginRemix,
    finishRemixPress,
    runRemix,
    releaseRemixMic,
    resetDictation,
    restoreSystemAudioSafely,
  } = deps;

  // ---- Remix hotkey handlers ----
  useEffect(() => {
    const removeDown = window.api.onRemixDown(beginRemix);
    const removeUp = window.api.onRemixUp(finishRemixPress);
    const removeSelection = window.api.onRemixSelection((payload) => {
      if (!remixRef.current) return;
      remixContextRef.current = payload;
      remixSelectionRef.current?.resolve(payload.text);
      // A null selection is no longer a dead end: presets still require one
      // (and say so when picked), but a spoken or typed request goes to the
      // agent, which can write at the cursor or answer in chat instead.
      patchRemix({ selection: payload.text });
    });
    // A route shortcut: the chord plus a digit. It answers the question the
    // microphone was open to ask, so the recording is dropped on the spot.
    // The selection may still be in flight — the copy waits for the chord to
    // be released — and `runRemix` waits for it, which is why pressing a
    // digit mid-hold works without the card having to say anything.
    const removeRoute = window.api.onRemixRoute((index) => {
      const preset = REMIX_PRESETS[index];
      const phase = remixRef.current?.phase;
      if (
        !preset ||
        !phase ||
        phase === "running" ||
        phase === "chat" ||
        phase === "error"
      ) {
        return;
      }
      releaseRemixMic();
      void runRemix({ remixId: preset.id, label: preset.label });
    });

    // The persistent bar was hovered: open the chat card fresh. The capture
    // is already in flight (main kicked it off before sending this).
    const removeOpenChat = window.api.onRemixOpenChat(() => {
      if (stateRef.current !== "idle" || pillActiveRef.current) return;
      if (remixRef.current) {
        patchRemix({ phase: "chat", minimized: false });
        return;
      }
      remixSelectionRef.current = deferred<string | null>();
      setRemix({
        id: ++remixSeqRef.current,
        phase: "chat",
        selection: null,
        initialInstruction: null,
        minimized: false,
      });
    });

    // A dictation began on the shared home key and this chord is taking over.
    const removeSupersede = window.api.onRemixSupersede(() => {
      if (stateRef.current === "idle" && !pillActiveRef.current) return;
      recorderRef.current.discard();
      void restoreSystemAudioSafely();
      streamerRef.current?.cancel();
      resetDictation();
    });
    return () => {
      removeDown();
      removeUp();
      removeSelection();
      removeRoute();
      removeOpenChat();
      removeSupersede();
    };
  }, [
    beginRemix,
    finishRemixPress,
    patchRemix,
    resetDictation,
    restoreSystemAudioSafely,
    runRemix,
    setRemix,
    releaseRemixMic,
  ]);
}
