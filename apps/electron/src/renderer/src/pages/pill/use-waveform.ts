// biome-ignore-all lint/correctness/useExhaustiveDependencies: refs, setters and callbacks come in through deps and keep one identity for the life of AppPage. The dependency lists stay as they were before the move.
import { useCallback, useRef } from "react";
import { SVG_HEIGHT } from "../pill-motion";
import {
  BAR_NOISE_FLOOR,
  barHeightFor,
  easeBars,
  nextJitter,
} from "../pill-waveform";
import {
  ANALYSER_SMOOTHING,
  BAR_WIDTH,
  BARS,
  type BarMode,
  CANCEL_EASE,
  CANCEL_HIDDEN_BARS,
  CANCEL_HIDDEN_SPAN,
  CANCEL_SLOT,
  FALL,
  FLAT_EASE,
  HANDOVER_BEAT_MS,
  LEVEL_FALL,
  LEVEL_RISE,
  RISE,
  SAMPLE_MS,
  SETTLE_EASE,
  SETTLE_MS,
  SILENCE_MS,
  SVG_WIDTH,
  VOICE_MAX_HZ,
  VOICE_MIN_HZ,
} from "./constants";
import type { PillShared } from "./pill-shared";

export type UseWaveformDeps = Pick<
  PillShared,
  | "analyserCtxRef"
  | "analyserNodeRef"
  | "audioSourceRef"
  | "barLinesRef"
  | "barModeRef"
  | "barsRef"
  | "cancelOpenRef"
  | "cancelSlotRef"
  | "cancelTargetRef"
  | "flatAmountRef"
  | "flatlineRef"
  | "flatTargetRef"
  | "freqDataRef"
  | "lastCancelWriteRef"
  | "lastIpcTimeRef"
  | "micSilentRef"
  | "modeStartRef"
  | "rafRef"
  | "sampleRef"
  | "silentSinceRef"
  | "targetsRef"
  | "voiceBandRef"
  | "waveClipRef"
  | "setMicSilent"
>;

export function useWaveform(deps: UseWaveformDeps) {
  const {
    analyserCtxRef,
    analyserNodeRef,
    audioSourceRef,
    barLinesRef,
    barModeRef,
    barsRef,
    cancelOpenRef,
    cancelSlotRef,
    cancelTargetRef,
    flatAmountRef,
    flatlineRef,
    flatTargetRef,
    freqDataRef,
    lastCancelWriteRef,
    lastIpcTimeRef,
    micSilentRef,
    modeStartRef,
    rafRef,
    sampleRef,
    silentSinceRef,
    targetsRef,
    voiceBandRef,
    waveClipRef,
    setMicSilent,
  } = deps;

  // ---- Bar animation loop ----
  // The bar elements are created once per mount and only ever have their
  // geometry rewritten, so grab them as the SVG mounts and let the draw loop
  // iterate a plain array instead of querying the DOM 60 times a second.
  // The flatline is not part of the bar buffer.
  const captureBarLines = useCallback((svg: SVGSVGElement | null) => {
    // Only ever *set* on attach, never cleared on detach. The waveform moves
    // between two surfaces — the capsule and the remix card — and a detach
    // that ran after the new element's attach would blank this and leave the
    // visible row frozen. Holding a detached element instead is harmless: the
    // draw loop writes attributes nobody renders until the next attach lands.
    // Scope to `[data-bars] line` so the sibling flatline is left out of the
    // buffer the draw loop iterates.
    if (svg)
      barLinesRef.current = Array.from(
        svg.querySelectorAll<SVGLineElement>("[data-bars] line"),
      );
  }, []);

  // One frame: work out what the bars should be aiming at, ease them toward
  // it, then draw. Runs at 60fps for the whole time the pill is up, so
  // everything here reuses buffers rather than allocating.
  const runBars = useCallback(() => {
    const mode = barModeRef.current;
    if (!mode) return;

    const now = performance.now();
    const targets = targetsRef.current;
    const bars = barsRef.current;
    // Only the live waveform eases symmetrically; the generated patterns keep
    // the snappier rise and gentler fall.
    let rise = RISE;
    let fall = FALL;

    if (mode === "settling") {
      // Let the last live sample settle before switching to the sweep.
      rise = SETTLE_EASE;
      fall = SETTLE_EASE;
    } else if (mode === "speaking") {
      // Transcribing: a single soft bump sweeping left to right on a loop,
      // with a pause between passes. Reads as progress rather than as audio.
      const t = (now - modeStartRef.current) / 1000;
      const SWEEP = 1.15; // seconds of travel
      const GAP = 0.35; // seconds of rest between passes
      const head = ((t % (SWEEP + GAP)) / SWEEP) * (BARS + 4) - 2;
      for (let i = 0; i < BARS; i++) {
        const d = i - head;
        targets[i] = 0.08 + 0.72 * Math.exp(-(d * d) / 3.2);
      }
    } else {
      const analyser = analyserNodeRef.current;
      const data = freqDataRef.current;
      // The analyser is torn down a frame or two before the mode switches off
      // "listening" on commit. Keep the loop running and the bars frozen
      // until it does — never bail out of the rAF chain here.
      if (!analyser || !data) {
        rafRef.current = requestAnimationFrame(runBars);
        return;
      }

      rise = LEVEL_RISE;
      fall = LEVEL_FALL;
      analyser.getByteFrequencyData(data);

      const { startBin, endBin, levelDivisor } = voiceBandRef.current;
      let sum = 0;
      for (let i = startBin; i < endBin; i++) sum += data[i];
      const voiceLevel = sum / levelDivisor;

      // The bars hold still; only their values travel. Every SAMPLE_MS each
      // sampled level hands off one slot to the left and the rightmost bar
      // takes the newest sample, so a loud moment reads as moving
      // right-to-left across a stationary row.
      const sample = sampleRef.current;
      // Peak-hold stays in raw level space; the response curve and this
      // sample's jitter are applied at hand-off, so both land once per sample
      // rather than being recomputed every frame. Note what this value is now
      // *not* used for: the newest bar. See below.
      sample.peak = Math.max(sample.peak, voiceLevel);

      let elapsed = now - sample.lastSampleAt;
      // A long stall (window occluded, GC pause) shouldn't replay every
      // missed hand-off — jump straight to the present instead.
      if (elapsed > SAMPLE_MS * BARS) {
        sample.lastSampleAt = now;
        elapsed = 0;
      }
      while (elapsed >= SAMPLE_MS) {
        // Shift left by hand rather than via shift()/push(), which would
        // reallocate the backing store on every hand-off.
        for (let i = 0; i < BARS - 1; i++) targets[i] = targets[i + 1];
        // The window that just closed is written as its *peak*, over the
        // second-newest slot — overwriting the live value the shift just moved
        // there. History is what peak-hold is for: once a bar has stopped
        // being the live one, it should show the loudest thing that happened
        // while it was, so a syllable can't fall between two frames.
        targets[BARS - 2] = barHeightFor(sample.peak, sample.jitter);
        sample.peak = voiceLevel;
        sample.jitter = nextJitter();
        sample.lastSampleAt += SAMPLE_MS;
        elapsed -= SAMPLE_MS;
      }

      // The newest slot, by contrast, tracks the live level and nothing else.
      // Drawing it from the peak-hold is what made both ends of a word feel
      // late: the bar could only fall at the next hand-off, up to a full
      // SAMPLE_MS after you had actually stopped. Now the right-hand bar is a
      // meter — it rises and falls with your voice, this frame — and only
      // becomes a peak once it hands off and joins the history.
      targets[BARS - 1] = barHeightFor(voiceLevel, sample.jitter);

      // A sustained floor means the mic may be muted or disconnected.
      if (voiceLevel > BAR_NOISE_FLOOR) {
        silentSinceRef.current = now;
        flatTargetRef.current = 0;
      } else if (
        silentSinceRef.current > 0 &&
        now - silentSinceRef.current > SILENCE_MS
      ) {
        flatTargetRef.current = 1;
      }
      const wantsSilent = flatTargetRef.current === 1;
      if (wantsSilent !== micSilentRef.current) {
        micSilentRef.current = wantsSilent;
        setMicSilent(wantsSilent);
      }

      // The dashboard's own visualisation is calibrated against the original
      // linear scale, so the level broadcast over IPC stays on it.
      if (now - lastIpcTimeRef.current >= 100) {
        lastIpcTimeRef.current = now;
        window.api?.sendAudioLevel(Math.min(1, voiceLevel * 2.8));
      }
    }

    // Ease toward the targets so a hand-off is a smooth morph between
    // neighbouring heights rather than a visible step.
    easeBars(bars, targets, rise, fall);

    // Advance the cancel button's open/close on the same clock as the bars.
    const open =
      cancelOpenRef.current +
      (cancelTargetRef.current - cancelOpenRef.current) * CANCEL_EASE;
    cancelOpenRef.current = open;

    // Ease the flatline on the same clock as the bars.
    const flat =
      flatAmountRef.current +
      (flatTargetRef.current - flatAmountRef.current) * FLAT_EASE;
    flatAmountRef.current = flat;
    const flatline = flatlineRef.current;
    if (flatline) {
      if (flat > 0.002) {
        const half = (SVG_WIDTH / 2 - 2) * flat;
        flatline.setAttribute("opacity", String(flat * 0.5));
        flatline.setAttribute("x1", String(SVG_WIDTH / 2 - half));
        flatline.setAttribute("x2", String(SVG_WIDTH / 2 + half));
      } else {
        flatline.setAttribute("opacity", "0");
      }
    }

    const lines = barLinesRef.current;
    for (let i = 0; i < lines.length; i++) {
      const val = bars[i] ?? 0;
      // A bar never fully collapses: at rest it is exactly as tall as it is
      // wide, so the round caps leave a row of evenly spaced dots.
      const h = Math.max(BAR_WIDTH, val * SVG_HEIGHT);
      const line = lines[i];
      line.setAttribute("y1", String((SVG_HEIGHT + h) / 2));
      line.setAttribute("y2", String((SVG_HEIGHT - h) / 2));
      // Fade the oldest bars for the cancel slot and the whole row for silence.
      const structural = i < CANCEL_HIDDEN_BARS && open > 0 ? 1 - open : 1;
      line.style.opacity = String(structural * (1 - 0.55 * flat));
    }

    // Writing these lays out the capsule, so only do it while the value is
    // actually moving — a settled button costs nothing.
    if (Math.abs(open - lastCancelWriteRef.current) > 0.002) {
      lastCancelWriteRef.current = open;
      const slot = cancelSlotRef.current;
      const clip = waveClipRef.current;
      if (slot) {
        slot.style.width = `${CANCEL_SLOT * open}px`;
        slot.style.opacity = String(open);
        slot.style.transform = `scale(${0.72 + 0.28 * open})`;
        // Don't let a disc that is still fading in swallow a click.
        slot.style.pointerEvents = open > 0.5 ? "auto" : "none";
      }
      if (clip) clip.style.width = `${SVG_WIDTH - CANCEL_HIDDEN_SPAN * open}px`;
    }

    rafRef.current = requestAnimationFrame(runBars);
  }, []);

  // ---- Visualization control ----
  const startBarAnimation = useCallback(
    (mode: BarMode) => {
      cancelAnimationFrame(rafRef.current);
      const now = performance.now();
      barModeRef.current = mode;
      modeStartRef.current = now;
      // Every mode now writes the shared target buffer, so clear it on the
      // way in. This also means a re-record starts from a flat row instead of
      // inheriting the previous dictation's waveform.
      targetsRef.current.fill(0);
      // The pill remounts each time it is shown, so start the button at its
      // resting state rather than animating it open, and force the first
      // style write against the fresh elements.
      cancelOpenRef.current = cancelTargetRef.current;
      lastCancelWriteRef.current = -1;
      // Silence only applies while the analyser is live.
      silentSinceRef.current = mode === "listening" ? now : 0;
      flatTargetRef.current = 0;
      if (mode !== "listening") flatAmountRef.current = 0;
      if (micSilentRef.current) {
        micSilentRef.current = false;
        setMicSilent(false);
      }
      sampleRef.current = {
        lastSampleAt: now,
        peak: 0,
        jitter: nextJitter(),
      };
      rafRef.current = requestAnimationFrame(runBars);
    },
    [runBars],
  );

  const startListening = useCallback(
    (stream: MediaStream) => {
      if (
        !analyserCtxRef.current ||
        analyserCtxRef.current.state === "closed"
      ) {
        analyserCtxRef.current = new AudioContext();
      }
      const ctx = analyserCtxRef.current;
      try {
        audioSourceRef.current?.disconnect();
      } catch {}
      try {
        analyserNodeRef.current?.disconnect();
      } catch {}

      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = ANALYSER_SMOOTHING;
      source.connect(analyser);
      audioSourceRef.current = source;
      analyserNodeRef.current = analyser;
      freqDataRef.current = new Uint8Array(analyser.frequencyBinCount);

      // Resolve the voice band to bin indices once, here, rather than on
      // every frame of the draw loop.
      const binWidth = ctx.sampleRate / analyser.fftSize;
      const startBin = Math.max(0, Math.floor(VOICE_MIN_HZ / binWidth));
      const endBin = Math.min(
        analyser.frequencyBinCount,
        Math.ceil(VOICE_MAX_HZ / binWidth),
      );
      voiceBandRef.current = {
        startBin,
        endBin,
        levelDivisor: Math.max(1, endBin - startBin) * 255,
      };

      startBarAnimation("listening");
    },
    [startBarAnimation],
  );

  /** Give the live waveform a short settle beat before the progress sweep. */
  const handoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startHandover = useCallback(() => {
    startBarAnimation("settling");
    if (handoverTimerRef.current) clearTimeout(handoverTimerRef.current);
    handoverTimerRef.current = setTimeout(() => {
      handoverTimerRef.current = null;
      if (barModeRef.current === "settling") startBarAnimation("speaking");
    }, SETTLE_MS + HANDOVER_BEAT_MS);
  }, [startBarAnimation]);

  const stopVisualization = useCallback(() => {
    if (handoverTimerRef.current) {
      clearTimeout(handoverTimerRef.current);
      handoverTimerRef.current = null;
    }
    cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    barModeRef.current = null;
    try {
      audioSourceRef.current?.disconnect();
    } catch {}
    try {
      analyserNodeRef.current?.disconnect();
    } catch {}
    audioSourceRef.current = null;
    analyserNodeRef.current = null;
    freqDataRef.current = null;
    barsRef.current.fill(0);
    targetsRef.current.fill(0);
    sampleRef.current = {
      lastSampleAt: 0,
      peak: 0,
      jitter: { scale: 1, trim: 0 },
    };
    silentSinceRef.current = 0;
    flatAmountRef.current = 0;
    flatTargetRef.current = 0;
    micSilentRef.current = false;
  }, []);

  return {
    captureBarLines,
    startBarAnimation,
    startListening,
    startHandover,
    stopVisualization,
  };
}
