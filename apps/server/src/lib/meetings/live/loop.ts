/**
 * The live loop (issue #375, specs/live-chat.md section 1).
 *
 * One loop runs for each recording while the setting `live_chat_enabled` is
 * "true". Every 2 s it reads the new PCM of each channel from the growing
 * WAV. A segment that ended at least 800 ms ago is final. The ASR model reads
 * it once, and the loop moves the cursor. The open tail is read again at each
 * tick as partial text. The cursor does not move for it.
 *
 * Two rules keep the text steady:
 * - The language is locked. The loop uses the language of the meeting when it
 *   is set. Else it detects the language once, on the first voiced audio, and
 *   passes it to every later read (`lockLanguage`).
 * - A segment with no speech is not read. The loop applies the same two gates
 *   as the full pass (`transcriber.ts`, `transcribeChunk`): the Silero speech
 *   spans, and the voiced time of the mic.
 *
 * There is one ASR worker. The loop never runs while a dictation runs, and the
 * stop of the recording waits for the loop before the final pass starts.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collapseAsrLineBreaks } from "@openstyle/stt";
import { createAppLogger, errorMessage } from "@openstyle/utils";
import { MIC_WAV, SETTINGS_KEYS, SYSTEM_WAV } from "@openstyle/validations";
import { wavHeader } from "../../audio/wav.js";
import { getDb, readSetting } from "../../db.js";
import { isDictationActive } from "../../dictation-activity.js";
import { getLanguagesSetting } from "../../language.js";
import { MLX_ASR_PROVIDER_ID } from "../../mlx-asr/constants.js";
import { resolveMlxLanguage } from "../../mlx-asr/language.js";
import { getMlxModelStatus } from "../../mlx-asr/models.js";
import { canRunMlxAsr, transcribeWithMlxAsr } from "../../mlx-asr/server.js";
import { getDefaultModels } from "../../providers.js";
import { stripProviderPrefix } from "../../streaming/types.js";
import { pickDeclaredLanguage, readMeetingLanguage } from "../language.js";
import { isHallucination } from "../merge.js";
import {
  MIN_MIC_VOICED_MS,
  type Segment,
  type SpeechSpan,
  totalSpeechMs,
} from "../segmenter.js";
import { createDefaultTranscriberDeps } from "../transcriber.js";
import { attachSpeechSpans, detectSpeechSpans } from "../vad.js";
import {
  addFinalLine,
  countSkippedTick,
  dropLive,
  getFinalLines,
  type LiveLine,
  type LiveSource,
  openLive,
  setFinalText,
  setLiveStatus,
  setPartialLine,
} from "./store.js";
import { LIVE_SAMPLE_RATE, planTail, readPcmFrom, slicePcm } from "./tail.js";

const log = createAppLogger("meeting-live");

const TICK_MS = 2000;
/** Stop never waits longer than this for a running tick. */
const STOP_WAIT_MS = 20_000;
/** At Stop the loop reads the rest of the audio. It stops after this time. */
const STOP_FLUSH_MS = 15_000;
/** The language lock waits for this much speech (the same as the full pass:
 * a probe of the early speech). */
export const LOCK_AFTER_SPEECH_MS = 20_000;
/** A window with no segment keeps this much audio, so a word that starts at
 * the end of the window is not cut. The rest is skipped. */
const KEEP_IDLE_MS = 2000;
const SOURCES: readonly LiveSource[] = ["mic", "system"];

/** What the live loop knows about the model and the language. */
export interface LiveModel {
  modelId: string;
  /** ISO code of the locked language. Undefined: not locked yet. */
  language?: string;
  /** The languages of the setting. Empty means auto. */
  declared: string[];
}

/** What the loop needs from the outside. Tests replace it. */
export interface LiveDeps {
  isEnabled: () => boolean;
  /** The ASR model of the meeting setting, or the reason it cannot be used. */
  resolveModel: (
    meetingId: string,
  ) => Promise<LiveModel | { unavailable: string }>;
  transcribe: (opts: {
    modelId: string;
    /** ISO code, or undefined for auto. */
    language?: string;
    pcm: Uint8Array;
  }) => Promise<string>;
  /**
   * Silero speech spans of one window of PCM, in ms from the start of the
   * window. Null means "no VAD data": the loop then uses the voiced gate only,
   * as the full pass does.
   */
  detectSpeech: (
    pcm: Int16Array,
    source: LiveSource,
  ) => Promise<SpeechSpan[] | null>;
  /**
   * The language of the early text: one of `declared`, or (declared is empty)
   * any language that the model supports. Null when the text does not decide.
   */
  detectLanguage: (opts: {
    text: string;
    declared: string[];
    modelId: string;
  }) => Promise<string | null>;
  /** Save the locked language of a meeting (like the full pass does). */
  persistLanguage: (meetingId: string, language: string) => void;
  isDictationActive: () => boolean;
  tickMs: number;
}

/**
 * Choose the ASR model of the live loop. The meeting model wins when it is
 * local MLX: the single ASR worker then holds one model for the live loop and
 * the final pass. A meeting model that is not local MLX (Whisper, an own
 * server, a cloud model) never loads the MLX worker. So the live loop can use
 * the dictation model when that one is local MLX, and no model reloads.
 * Else the reason is `provider_not_local`.
 */
export function pickLiveAsrModel(
  meeting: { provider: string; modelId: string } | null,
  dictation: { provider: string; model_id: string } | null,
): { modelId: string } | { unavailable: string } {
  if (meeting?.provider === MLX_ASR_PROVIDER_ID) {
    return { modelId: meeting.modelId };
  }
  if (dictation?.provider === MLX_ASR_PROVIDER_ID) {
    return { modelId: dictation.model_id };
  }
  return { unavailable: "provider_not_local" };
}

/**
 * The language that is known at the start: the language of the meeting
 * (`meetings.language`, set by the user or by an earlier run), else the only
 * language of the setting. With more than one language, or with auto, nothing
 * is known: the loop locks the language after the first speech.
 */
export function knownLanguage(
  meetingLanguage: string | undefined,
  declared: readonly string[],
): string | undefined {
  if (meetingLanguage) return meetingLanguage;
  return declared.length === 1 ? declared[0] : undefined;
}

/** A VAD helper that works on a file. The window goes to a temp WAV. */
async function speechSpansOfWindow(
  pcm: Int16Array,
  source: LiveSource,
): Promise<SpeechSpan[] | null> {
  const dir = mkdtempSync(join(tmpdir(), "openstyle-live-vad-"));
  try {
    const path = join(dir, `${source}.wav`);
    const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    writeFileSync(
      path,
      Buffer.concat([
        wavHeader(
          { sampleRate: LIVE_SAMPLE_RATE, channels: 1, bitsPerSample: 16 },
          data.length,
        ),
        data,
      ]),
    );
    return await detectSpeechSpans(
      path,
      (pcm.length / LIVE_SAMPLE_RATE) * 1000,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const defaultLiveDeps: LiveDeps = {
  isEnabled: () => readSetting(SETTINGS_KEYS.liveChatEnabled) === "true",
  resolveModel: async (meetingId) => {
    // The live loop uses the model of the meeting setting when it is local
    // MLX. Else it uses the dictation model when that one is local MLX
    // (see `pickLiveAsrModel`).
    const deps = await createDefaultTranscriberDeps();
    const dictation = getDefaultModels().voice;
    let meeting: { provider: string; modelId: string } | null = null;
    let configError: string | null = null;
    try {
      const config = deps.resolveConfig();
      meeting = { provider: config.providerId, modelId: config.modelId };
    } catch (err) {
      configError = errorMessage(err);
    }
    const picked = pickLiveAsrModel(meeting, dictation);
    if ("unavailable" in picked) {
      if (configError) log.info(`Live model: ${configError}`);
      return picked;
    }
    const modelId = stripProviderPrefix(picked.modelId);
    if (!canRunMlxAsr()) return { unavailable: "worker_missing" };
    if (getMlxModelStatus(modelId)?.status !== "ready") {
      return { unavailable: "model_missing" };
    }
    const declared = getLanguagesSetting();
    const language = knownLanguage(readMeetingLanguage(meetingId), declared);
    return { modelId, declared, ...(language ? { language } : {}) };
  },
  transcribe: async ({ modelId, language, pcm }) => {
    const text = await transcribeWithMlxAsr({
      modelId,
      audio: pcm,
      pcmSampleRate: LIVE_SAMPLE_RATE,
      language: resolveMlxLanguage(modelId, language),
      deferUnload: true,
    });
    return collapseAsrLineBreaks(text).trim();
  },
  detectSpeech: speechSpansOfWindow,
  detectLanguage: async ({ text, declared, modelId }) => {
    const { detectAll } = await import("tinyld");
    // Declared languages: the same choice as the full pass
    // (`pickDeclaredLanguage`, meetings/language.ts).
    if (declared.length > 0)
      return pickDeclaredLanguage(text, declared, detectAll);
    // Auto: the best candidate that the model can be told about.
    const hit = detectAll(text).find(
      (c) => resolveMlxLanguage(modelId, c.lang) !== undefined,
    );
    return hit?.lang ?? null;
  },
  persistLanguage: (meetingId, language) => {
    getDb()
      .prepare("UPDATE meetings SET language = ? WHERE id = ?")
      .run(language, meetingId);
  },
  isDictationActive,
  tickMs: TICK_MS,
};

/** A final line that the loop read before the language was locked. */
interface EarlyLine {
  source: LiveSource;
  startMs: number;
  endMs: number;
}

interface LoopState {
  meetingId: string;
  audioDir: string;
  deps: LiveDeps;
  model: LiveModel;
  /** The locked language (ISO). Undefined until it is known. */
  language: string | undefined;
  /** True when the loop must still decide the language after the first speech. */
  lockPending: boolean;
  /** Speech ms and lines that were read before the lock. */
  early: EarlyLine[];
  earlySpeechMs: number;
  committedMs: Record<LiveSource, number>;
  stopped: boolean;
  /** The loop must stop reading new segments after this time (ms epoch). */
  deadline: number | null;
  warm: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  running: Promise<void> | null;
}

const loops = new Map<string, LoopState>();

/** True while a loop runs for this meeting. */
export function isLiveRunning(meetingId: string): boolean {
  return loops.has(meetingId);
}

function wavPath(state: LoopState, source: LiveSource): string {
  return join(state.audioDir, source === "mic" ? MIC_WAV : SYSTEM_WAV);
}

/**
 * Skip a segment with no speech. The same two gates as the full pass
 * (`transcriber.ts`, `transcribeChunk`): a segment with VAD data and no speech
 * span is silence or noise, on both channels. A mic segment with too little
 * voiced time is the noise floor and clicks.
 */
function isSilent(source: LiveSource, seg: Segment): boolean {
  if (seg.speechSpans !== undefined && seg.speechSpans.length === 0) {
    return true;
  }
  return (
    source === "mic" &&
    seg.voicedMs !== undefined &&
    seg.voicedMs < MIN_MIC_VOICED_MS
  );
}

function speechMsOf(seg: Segment): number {
  return seg.speechSpans !== undefined
    ? totalSpeechMs(seg.speechSpans)
    : seg.endMs - seg.startMs;
}

/** Read one segment. Returns "" for silence phrases and failed reads. */
async function readText(
  state: LoopState,
  pcm: Int16Array,
  fromMs: number,
  seg: Pick<Segment, "startMs" | "endMs">,
): Promise<string> {
  const text = await state.deps.transcribe({
    modelId: state.model.modelId,
    language: state.language,
    pcm: slicePcm(pcm, fromMs, seg),
  });
  state.warm = true;
  if (isHallucination({ startMs: seg.startMs, endMs: seg.endMs, text })) {
    return "";
  }
  return text;
}

function pastDeadline(state: LoopState): boolean {
  return state.deadline !== null && Date.now() > state.deadline;
}

async function tickChannel(
  state: LoopState,
  source: LiveSource,
  closeAfterMs?: number,
): Promise<void> {
  const fromMs = state.committedMs[source];
  const pcm = readPcmFrom(wavPath(state, source), fromMs);
  if (!pcm || pcm.length === 0) return;
  const plan = planTail(pcm, fromMs, closeAfterMs);
  const candidates = [...plan.closed, ...(plan.open ? [plan.open] : [])];
  if (candidates.length === 0) {
    // Nothing to read. Skip the idle audio, so the next window stays short.
    const idleUntil = fromMs + plan.totalMs - KEEP_IDLE_MS;
    if (idleUntil > fromMs) state.committedMs[source] = Math.floor(idleUntil);
    setPartialLine(state.meetingId, source, null);
    return;
  }
  // Speech spans of the window (Silero). Null keeps the voiced gate only.
  const spans = await state.deps.detectSpeech(pcm, source).catch(() => null);
  const shifted =
    spans === null
      ? null
      : spans.map((s) => ({
          startMs: s.startMs + fromMs,
          endMs: s.endMs + fromMs,
        }));
  const withSpans = (segs: Segment[]): Segment[] =>
    attachSpeechSpans(segs, shifted);
  for (const seg of withSpans(plan.closed)) {
    if (state.stopped || pastDeadline(state)) return;
    if (!isSilent(source, seg)) {
      const text = await readText(state, pcm, fromMs, seg);
      if (text) {
        addFinalLine(state.meetingId, {
          source,
          startMs: seg.startMs,
          endMs: seg.endMs,
          text,
          final: true,
        });
        if (state.lockPending) {
          state.early.push({
            source,
            startMs: seg.startMs,
            endMs: seg.endMs,
          });
          state.earlySpeechMs += speechMsOf(seg);
        }
      }
    }
    state.committedMs[source] = seg.endMs;
  }
  if (state.stopped || pastDeadline(state)) return;
  const open = plan.open ? withSpans([plan.open])[0] : null;
  if (!open || isSilent(source, open)) {
    setPartialLine(state.meetingId, source, null);
    return;
  }
  const text = await readText(state, pcm, fromMs, open);
  if (state.stopped) return;
  setPartialLine(
    state.meetingId,
    source,
    text ? { source, startMs: open.startMs, endMs: open.endMs, text } : null,
  );
}

/**
 * Lock the language once the loop has read enough speech. The lines read
 * before the lock came from a model that ran with auto language. Read them
 * again with the locked language, so the first lines match the rest.
 * Returns when the language is locked or the loop must wait for more speech.
 */
async function lockLanguage(state: LoopState): Promise<void> {
  if (!state.lockPending || state.earlySpeechMs < LOCK_AFTER_SPEECH_MS) return;
  const text = getFinalLines(state.meetingId)
    .map((l) => l.text)
    .join(" ");
  const picked = await state.deps
    .detectLanguage({
      text,
      declared: state.model.declared,
      modelId: state.model.modelId,
    })
    .catch(() => null);
  // With a declared list, the first language wins when the text does not
  // decide, like the full pass (`resolveMeetingLanguage`).
  const language = picked ?? state.model.declared[0];
  if (!language) return; // Auto, and no language yet: wait for more speech.
  state.language = language;
  state.lockPending = false;
  if (state.model.declared.length > 0) {
    // The full pass reuses it (meetings.language, sticky until the user edits).
    try {
      state.deps.persistLanguage(state.meetingId, language);
    } catch (err) {
      log.warn(`Live language not saved: ${errorMessage(err)}`);
    }
  }
  log.info(`Live language locked for ${state.meetingId}: ${language}`);
  const early = state.early;
  state.early = [];
  for (const line of early) {
    if (state.stopped || pastDeadline(state)) return;
    const pcm = readPcmFrom(
      wavPath(state, line.source),
      line.startMs,
      line.endMs,
    );
    if (!pcm || pcm.length === 0) continue;
    const again = await readText(state, pcm, line.startMs, line);
    setFinalText(state.meetingId, line.source, line.startMs, again);
  }
}

async function tick(state: LoopState, closeAfterMs?: number): Promise<void> {
  // The single ASR worker serves dictation first.
  if (state.deps.isDictationActive()) {
    countSkippedTick(state.meetingId);
    return;
  }
  setLiveStatus(state.meetingId, state.warm ? "ready" : "warming");
  for (const source of SOURCES) {
    if (state.stopped || pastDeadline(state)) return;
    try {
      await tickChannel(state, source, closeAfterMs);
    } catch (err) {
      log.warn(`Live tick failed (${source}): ${errorMessage(err)}`);
    }
  }
  try {
    await lockLanguage(state);
  } catch (err) {
    log.warn(`Live language lock failed: ${errorMessage(err)}`);
  }
  if (!state.stopped) setLiveStatus(state.meetingId, "ready");
}

function schedule(state: LoopState): void {
  if (state.stopped) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    state.running = tick(state).finally(() => {
      state.running = null;
      schedule(state);
    });
  }, state.deps.tickMs);
  state.timer.unref?.();
}

/**
 * Start the loop for a recording. It does nothing when the setting is off.
 * It never throws: a problem makes the live state "unavailable".
 */
export async function startLive(
  meetingId: string,
  audioDir: string,
  deps: LiveDeps = defaultLiveDeps,
): Promise<void> {
  if (loops.has(meetingId) || !deps.isEnabled()) return;
  openLive(meetingId);
  const model = await deps.resolveModel(meetingId).catch((err) => ({
    unavailable: errorMessage(err),
  }));
  if ("unavailable" in model) {
    setLiveStatus(meetingId, "unavailable", model.unavailable);
    log.info(`Live chat unavailable for ${meetingId}: ${model.unavailable}`);
    return;
  }
  const state: LoopState = {
    meetingId,
    audioDir,
    deps,
    model,
    language: model.language,
    lockPending: model.language === undefined,
    early: [],
    earlySpeechMs: 0,
    committedMs: { mic: 0, system: 0 },
    stopped: false,
    deadline: null,
    warm: false,
    timer: null,
    running: null,
  };
  loops.set(meetingId, state);
  log.info(
    `Live loop started for ${meetingId} (model ${model.modelId}, language ${model.language ?? "auto, locks after the first speech"})`,
  );
  schedule(state);
}

/** What `stopLive` gives back to the route. */
export interface StoppedLive {
  /** The final lines in time order. Empty when no loop ran. */
  lines: LiveLine[];
  modelId: string | null;
}

/**
 * Stop the loop and drop the live entry. It waits for a running tick, so the
 * single ASR worker is free when the final pass starts. With `flush`, the loop
 * first reads the rest of the audio (the open tail too), for at most
 * STOP_FLUSH_MS, and the route saves the lines as the transcript.
 */
export async function stopLive(
  meetingId: string,
  opts: { flush?: boolean } = {},
): Promise<StoppedLive> {
  const state = loops.get(meetingId);
  let lines: LiveLine[] = [];
  let modelId: string | null = null;
  if (state) {
    state.stopped = true;
    if (state.timer) clearTimeout(state.timer);
    if (state.running) {
      await Promise.race([
        state.running,
        new Promise<void>((resolve) => {
          setTimeout(resolve, STOP_WAIT_MS).unref?.();
        }),
      ]);
    }
    if (opts.flush && !state.running) {
      state.stopped = false;
      state.deadline = Date.now() + STOP_FLUSH_MS;
      try {
        await tick(state, 0);
      } finally {
        state.stopped = true;
      }
    }
    lines = getFinalLines(meetingId);
    modelId = state.model.modelId;
    loops.delete(meetingId);
    log.info(`Live loop stopped for ${meetingId}`);
  }
  dropLive(meetingId);
  return { lines, modelId };
}
