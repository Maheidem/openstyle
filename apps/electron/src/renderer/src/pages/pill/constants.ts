import { CANCEL_SIZE } from "../pill-motion";
export const BARS = 10;
export const RISE = 0.55;
export const FALL = 0.22;
/** Bar thickness; also the height of a bar at rest (drawn as a round dot). */
export const BAR_WIDTH = 2.5;
/**
 * Horizontal pitch between bars — fixed, so the row's density never changes.
 * The waveform's width follows from it and from BARS, and the difference
 * against PILL_CORE_WIDTH is the margin the row sits in: dropping a bar makes
 * the row narrower and the capsule's edges roomier, rather than spreading the
 * remaining bars further apart.
 */
export const BAR_PITCH = 6;
export const SVG_WIDTH = BARS * BAR_PITCH;
export const BAR_X_POSITIONS = Array.from(
  { length: BARS },
  (_, index) => BAR_PITCH * (index + 0.5),
);
export const BAR_CENTER = (BARS - 1) / 2;
/**
 * How long each bar represents while recording. Every interval the sampled
 * levels hand off one slot to the left; the bars themselves never move.
 */
export const SAMPLE_MS = 75;
/** Frequency band summed to get the voice level, in Hz. */
export const VOICE_MIN_HZ = 80;
export const VOICE_MAX_HZ = 4000;
/**
 * Per-frame easing for the live recording waveform. Both are deliberately
 * close to 1: this row is a level meter, and the eye reads any lag between a
 * syllable and the bar answering it as the app being slow. What smoothing is
 * left is only there to keep single-frame FFT noise from flickering the row —
 * everything below ~0.6 starts to feel like the waveform is trailing you.
 */
export const LEVEL_RISE = 0.8;
export const LEVEL_FALL = 0.78;
/**
 * The analyser's own exponential smoothing across FFT frames. This one is
 * upstream of everything else, so its lag is paid twice over — once on the way
 * up and once on the way down. Low enough to stay out of the way; not zero,
 * which would put raw bin noise straight into the bars.
 */
export const ANALYSER_SMOOTHING = 0.15;

export type PillState =
  | "idle"
  | "initializing"
  | "recording"
  | "transcribing"
  | "error";

/**
 * Every notice here is something having gone wrong, which is the whole bar for
 * showing one: a cold cloud session that is merely slow gets no mark at all,
 * because the pill appears on every single dictation and a spinner that cries
 * wolf on the happy path is just noise over the user's work. The first two are
 * recoveries in progress (a turning ring); the rest are stalled (an alert
 * ring).
 */
export type PillNotice = "reconnecting" | "retrying" | "unavailable" | null;

/** The waveform is either live, settling, or showing transcription progress. */
export type BarMode = "listening" | "settling" | "speaking";

/** Visual treatment for a completed, cancelled, or empty session. */
export type PillExit = "delivered" | "cancelled" | "quiet";

/** Easing of the settle phase — slower than the meter, symmetric. */
export const SETTLE_EASE = 0.24;
/** How long the row takes to come to rest before the sweep starts. */
export const SETTLE_MS = 180;
/** Stillness between your voice ending and the machine starting. */
export const HANDOVER_BEAT_MS = 120;

export const CHECK_SIZE = 16;

export const CLOSE_STEP_MS = 18;

export const SILENCE_MS = 1600;
export const FLAT_EASE = 0.14;
export const ELAPSED_AFTER_MS = 60_000;

/**
 * T1-3 / UX-01 (specs/lean-audit-2026-09.md §3): after handover, a cold local
 * model pays spawn + model-load before the first result — 5–90 s where
 * "working" is indistinguishable from "hung". The status slot names that
 * wait, but only once it has actually been long enough to be worth a mark
 * (the handover sweep itself is the "working" signal for the first moments).
 */
export const WARMING_AFTER_MS = 3_000;
/** Carried by the status slot's word channels (tooltip + live region) — the
 * same treatment "Retrying" gets; see the warming effect below for why it is
 * not rendered as visible capsule text. */
export const WARMING_LABEL = "Warming up local model…";

/** Names the cause instead of surfacing a raw TimeoutError (UX-A5: this is
 * the one error string this change adds — the rest of the batch error copy
 * stays as is). */
export const LOCAL_MODEL_TIMEOUT_MSG =
  "Local model didn't respond — it may still be starting. Try again.";

/** How long a closing card keeps its last content, in ms. */
export const VIEW_LATCH_MS = 320;

export const PILL_HEIGHT = 30;
/**
 * The capsule's fixed core — the cancel slot and the waveform. Status that has
 * to be disclosed (the aside) is appended *outside* this, and grows the capsule
 * by exactly its own width, so the waveform never shifts or shrinks to make
 * room for a label.
 *
 * Wide enough to hold the waveform with an even margin either side at rest,
 * and to still contain it once the cancel button has opened (which costs the
 * row a net BAR_PITCH * CANCEL_HIDDEN_BARS less than the slot it takes).
 */
export const PILL_CORE_WIDTH = 96;
/** The expanded card, in the space `window.api.setPillExpanded` opens up. */
export const PILL_CARD_WIDTH = 300;
/**
 * How long a warning stays up before dismissing itself. The remix warning
 * is a dead end — nothing to do but read it — so it leaves quickly. The
 * dictation failure card can carry a Retry, and a button that vanishes while
 * you are deciding is worse than one that lingers.
 */
export const REMIX_WARNING_MS = 4500;
export const FAILURE_CARD_MS = 9000;
/**
 * The cancel button lives at the left end of the capsule, and its space is
 * only taken while it's on screen. Opening it widens its slot to CANCEL_SLOT
 * (the disc plus a gap) and narrows the waveform's viewport by exactly
 * CANCEL_HIDDEN_BARS bars' worth, so the capsule's width never changes — the
 * two oldest samples make way and the rest of the row slides across.
 */
export const CANCEL_SLOT = 23;
export const CANCEL_HIDDEN_BARS = 2;
export const CANCEL_HIDDEN_SPAN = CANCEL_HIDDEN_BARS * BAR_PITCH;
/** Per-frame easing of the open/close amount; ~95% of the way in ~230ms. */
export const CANCEL_EASE = 0.2;

/** The status mark is the same size as the cancel mark. */
export const STATUS_SIZE = CANCEL_SIZE;

/**
 * The pill floats over arbitrary application windows, so it commits to a
 * single dark treatment in both themes rather than following the app theme —
 * a light pill reads as a blown-out blob over dark editors.
 */
export const SURFACE = "rgba(25, 24, 26, 0.98)";
export const SURFACE_BORDER = "1px solid rgba(255, 255, 255, 0.10)";
export const BLUR = "blur(20px) saturate(120%)";
/** Error/warning glyph only — kept off the live-coral token so a failure
 * never reads as "recording" (the same fence `--destructive` observes
 * app-wide). Dark-mode destructive red, for contrast on the always-dark
 * surface. */
export const ALERT = "#F87171";
/** Live/recording accent — bars and dot while actively capturing audio. */
export const LIVE = "#E4574D";
/**
 * The waveform is solid at full opacity in every state — level is expressed
 * by bar height alone, so nothing here is dimmed to encode it. Color is the
 * one channel that *does* vary: cream normally, live coral while actively
 * recording, so the capsule's one "is this really listening" signal reads at
 * a glance.
 */
export const BAR_COLOR = "#FFFFFF";

export const pillInnerStyle: React.CSSProperties = {
  height: PILL_HEIGHT,
  borderRadius: PILL_HEIGHT / 2,
  background: SURFACE,
  border: SURFACE_BORDER,
  backdropFilter: BLUR,
  WebkitBackdropFilter: BLUR,
  cursor: "grab",
  WebkitAppRegion: "drag",
} as React.CSSProperties;

export interface TranscribeResult {
  raw: string;
  cleaned: string;
  error?: string;
  providerCategory?: string;
}

// ---------------------------------------------------------------------------
// Remix
// ---------------------------------------------------------------------------

/**
 * Where a remix run has got to.
 *
 * The two ways in share a single hotkey and therefore a single opening state:
 * the moment it goes down we don't yet know whether this is a tap (show the
 * list) or a hold (record an instruction), so `capturing` optimistically does
 * both — the card is up and the mic is running — and the key going up decides
 * which of the two the user meant.
 */
export type RemixPhase =
  | "capturing"
  | "listening"
  | "running"
  | "chat"
  | "error";

export interface RemixSession {
  id: number;
  phase: RemixPhase;
  /** The captured selection; null until the copy comes back. */
  selection: string | null;
  /** What is being applied, shown while `running`. */
  label?: string;
  transcript?: string;
  title?: string;
  body?: string;
  /** A spoken or typed instruction the chat card sends on open. */
  initialInstruction?: string | null;
  /**
   * The chat collapsed to its one-line activity strip. Voice runs start here
   * — the user asked for something to happen, not for a chat window — and
   * hovering the strip is what opens the full conversation.
   */
  minimized?: boolean;
}

/** A promise that something else resolves. Used to await the selection. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
