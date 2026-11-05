// The pure rules of the first run (specs/onboarding.md). No React and no
// network here, so the rules have unit tests.

import type { LocalLlmItem, MlxLlmFit, VoiceItem } from "./models";

export const GIB = 1024 ** 3;

/** The voice model that fits a Mac with Apple silicon and 8 GiB of RAM or more. */
export const VOICE_QWEN = { engine: "mlx", defId: "qwen3-0.6b-8bit" } as const;
/** The voice model for every other case. It covers 99 languages. */
export const VOICE_WHISPER = {
  engine: "whisper",
  defId: "small-q5_1",
} as const;
/** The smallest RAM that the Qwen3 pick needs. */
export const QWEN_MIN_RAM_BYTES = 8 * GIB;
/** Free disk space needed, as a factor of the download size. */
export const DISK_HEADROOM = 1.5;

/** The voice models of "Choose another", in the order of the list. */
export const ONBOARDING_VOICE_MODELS: ReadonlyArray<{
  engine: "mlx" | "whisper";
  defId: string;
}> = [
  VOICE_QWEN,
  { engine: "mlx", defId: "qwen3-1.7b-8bit" },
  VOICE_WHISPER,
  { engine: "whisper", defId: "large" },
];

export interface SystemProfile {
  appleSilicon: boolean;
  chip: string | null;
  ramBytes: number;
  freeDiskBytes: number | null;
  /** Bytes of the MLX worker that the first MLX download installs. 0 when it is there. */
  mlxWorkerBytes: number;
  voiceFit: Record<string, MlxLlmFit["label"]>;
}

export type VoicePick = { engine: "mlx" | "whisper"; defId: string };

/**
 * The voice model rule. Qwen3 Fast when the Mac has Apple silicon and 8 GiB of
 * RAM or more, and every picked language is one that Qwen3 covers. Whisper
 * Balanced in every other case, also for auto-detect (an empty list).
 * `qwenLanguages` comes from the status of the server. It is null when the
 * server does not list the model (no Apple silicon).
 */
export function recommendVoice(input: {
  languages: readonly string[];
  appleSilicon: boolean;
  ramBytes: number | null;
  qwenLanguages: readonly string[] | null;
}): VoicePick {
  const { languages, appleSilicon, ramBytes, qwenLanguages } = input;
  const covered =
    languages.length > 0 &&
    !!qwenLanguages &&
    languages.every((code) => qwenLanguages.includes(code));
  if (
    appleSilicon &&
    ramBytes != null &&
    ramBytes >= QWEN_MIN_RAM_BYTES &&
    covered
  ) {
    return VOICE_QWEN;
  }
  return VOICE_WHISPER;
}

/** True when the voice model is a Qwen3 model and a picked language is outside its set. */
export function languageOutsideQwen(input: {
  pick: VoicePick | null;
  languages: readonly string[];
  qwenLanguages: readonly string[] | null;
}): boolean {
  const { pick, languages, qwenLanguages } = input;
  if (pick?.engine !== "mlx" || !pick.defId.startsWith("qwen3")) return false;
  if (!qwenLanguages) return false;
  return (
    languages.length === 0 || languages.some((c) => !qwenLanguages.includes(c))
  );
}

/**
 * The text model that the first run suggests: the model that the catalog marks
 * as recommended, when the fit check allows it. Otherwise the first model of
 * the catalog that fits. Null when no model fits or the Mac cannot run MLX.
 * The owner rule of the fit check keeps the recommended model out of
 * "Won't fit", so on a Mac with Apple silicon this is the recommended model.
 */
export function recommendText(
  items: readonly LocalLlmItem[],
): LocalLlmItem | null {
  const fits = (i: LocalLlmItem) => i.fit.label !== "wont_fit";
  const rec = items.find((i) => i.recommended && fits(i));
  return rec ?? items.find(fits) ?? null;
}

export interface DownloadPlan {
  voiceBytes: number;
  workerBytes: number;
  textBytes: number;
  total: number;
}

/**
 * The bytes that the download button names. Only a model on this Mac counts.
 * The worker counts once, when any chosen model needs it and it is not there.
 */
export function planDownload(input: {
  voice: {
    engine: "mlx" | "whisper";
    sizeBytes: number;
    ready: boolean;
  } | null;
  text: { sizeBytes: number; ready: boolean } | null;
  mlxWorkerBytes: number;
}): DownloadPlan {
  const voiceBytes =
    input.voice && !input.voice.ready ? input.voice.sizeBytes : 0;
  const textBytes = input.text && !input.text.ready ? input.text.sizeBytes : 0;
  const needsWorker =
    (input.voice?.engine === "mlx" && !input.voice.ready) || textBytes > 0;
  const workerBytes = needsWorker ? input.mlxWorkerBytes : 0;
  return {
    voiceBytes,
    workerBytes,
    textBytes,
    total: voiceBytes + workerBytes + textBytes,
  };
}

/** True when the free disk space is below the headroom for the download. */
export function lowDisk(
  plan: DownloadPlan,
  freeDiskBytes: number | null,
): { need: number; have: number } | null {
  if (freeDiskBytes == null || plan.total <= 0) return null;
  const need = plan.total * DISK_HEADROOM;
  return freeDiskBytes < need ? { need, have: freeDiskBytes } : null;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export const STEP = {
  welcome: 0,
  language: 1,
  model: 2,
  permissions: 3,
  tryIt: 4,
  name: 5,
  enhance: 6,
  ready: 7,
} as const;

export interface FlowOptions {
  /** The meetings flag: Name and Enhance show only when it is on. */
  meetings: boolean;
  /** The user chose "Decide later" for the voice model: Try it has nothing to test. */
  voiceLater: boolean;
}

function stepVisible(step: number, opts: FlowOptions): boolean {
  if (step === STEP.tryIt) return !opts.voiceLater;
  if (step === STEP.name || step === STEP.enhance) return opts.meetings;
  return true;
}

export function nextStep(step: number, opts: FlowOptions): number {
  let next = step + 1;
  while (next < STEP.ready && !stepVisible(next, opts)) next += 1;
  return Math.min(next, STEP.ready);
}

export function prevStep(step: number, opts: FlowOptions): number {
  let prev = step - 1;
  while (prev > STEP.welcome && !stepVisible(prev, opts)) prev -= 1;
  return Math.max(prev, STEP.welcome);
}

/** "Step n of m" for a counted step (Language to Enhance). Null for the first and last screen. */
export function stepCounter(
  step: number,
  opts: FlowOptions,
): { index: number; total: number } | null {
  if (step <= STEP.welcome || step >= STEP.ready) return null;
  const counted: number[] = [];
  for (let s = STEP.language; s < STEP.ready; s += 1) {
    if (stepVisible(s, opts)) counted.push(s);
  }
  const at = counted.indexOf(step);
  return at < 0 ? null : { index: at + 1, total: counted.length };
}

/** The step to open at start. A saved step that Try it or Enhance hides moves on. */
export function resumeStep(saved: number, opts: FlowOptions): number {
  if (saved <= STEP.welcome) return STEP.welcome;
  if (saved >= STEP.ready) return STEP.ready;
  return stepVisible(saved, opts) ? saved : nextStep(saved, opts);
}

// ---------------------------------------------------------------------------
// Download progress
// ---------------------------------------------------------------------------

export interface DownloadLine {
  /** What the line names: the voice model or the text model. */
  kind: "voice" | "text";
  name: string;
  status: "not_downloaded" | "downloading" | "verifying" | "ready" | "error";
  /** "building_binary" is the install of the MLX worker, before the weights. */
  phase?: "building_binary" | "downloading_model";
  bytesDownloaded: number;
  bytesTotal: number;
  speedBps: number;
  error?: string;
}

export interface DownloadSummary {
  state: "idle" | "running" | "done" | "failed";
  /** The line that runs now, or the line that stopped. */
  current: DownloadLine | null;
  /** Progress of the current line, 0 to 100. */
  percent: number;
  secondsLeft: number | null;
  error: string | null;
}

const IDLE: DownloadSummary = {
  state: "idle",
  current: null,
  percent: 0,
  secondsLeft: null,
  error: null,
};

function linePercent(line: DownloadLine): number {
  return line.bytesTotal > 0
    ? Math.min(100, Math.round((line.bytesDownloaded / line.bytesTotal) * 100))
    : 0;
}

/**
 * One state for the footer of the steps. `lines` are the local models that the
 * user chose. A line that is not running and not ready, after the user pressed
 * the button, counts as stopped (a quit or a lost connection).
 */
export function summarizeDownloads(
  lines: readonly DownloadLine[],
  started: boolean,
): DownloadSummary {
  if (lines.length === 0) return IDLE;
  if (lines.every((l) => l.status === "ready")) {
    return { ...IDLE, state: "done", current: lines[0], percent: 100 };
  }
  const failed = lines.find((l) => l.status === "error");
  const running = lines.filter(
    (l) => l.status === "downloading" || l.status === "verifying",
  );
  if (failed) {
    return {
      ...IDLE,
      state: "failed",
      current: failed,
      percent: linePercent(failed),
      error: failed.error ?? null,
    };
  }
  if (running.length === 0) {
    const stopped = lines.find((l) => l.status !== "ready") ?? null;
    return started && stopped
      ? {
          ...IDLE,
          state: "failed",
          current: stopped,
          percent: linePercent(stopped),
        }
      : IDLE;
  }
  const current = running[0];
  const speed = current.speedBps;
  const left = current.bytesTotal - current.bytesDownloaded;
  return {
    ...IDLE,
    state: "running",
    current,
    percent: linePercent(current),
    secondsLeft: speed > 0 && left > 0 ? Math.ceil(left / speed) : null,
  };
}

/** Minutes, rounded up, for "about N min left". */
export function minutesLeft(seconds: number | null): number | null {
  return seconds == null ? null : Math.max(1, Math.ceil(seconds / 60));
}

/** Map a VoiceItem to the line of the footer. */
export function voiceLine(
  item: VoiceItem,
  kind: "voice" = "voice",
): DownloadLine {
  const p = item.state?.downloadProgress;
  return {
    kind,
    name: item.name,
    status: item.status ?? "not_downloaded",
    phase: item.state?.phase,
    bytesDownloaded: p?.bytesDownloaded ?? 0,
    bytesTotal: p?.bytesTotal ?? item.sizeBytes ?? 0,
    speedBps: p?.speedBps ?? 0,
    error: item.state?.error,
  };
}

/** Map a built-in LLM row to the line of the footer. */
export function textLine(item: LocalLlmItem): DownloadLine {
  const p = item.state.downloadProgress;
  return {
    kind: "text",
    name: item.name,
    status: item.status,
    phase: item.state.phase,
    bytesDownloaded: p?.bytesDownloaded ?? 0,
    bytesTotal: p?.bytesTotal ?? item.sizeBytes,
    speedBps: p?.speedBps ?? 0,
    error: item.state.error,
  };
}
