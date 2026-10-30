/**
 * The live loop (issue #375, specs/live-chat.md section 1).
 *
 * One loop runs for each recording while the setting `live_chat_enabled` is
 * "true". Every 2 s it reads the new PCM of each channel from the growing
 * WAV. A segment that ended at least 800 ms ago is final. The ASR model reads
 * it once, and the loop moves the cursor. The open tail is read again at each
 * tick as partial text. The cursor does not move for it.
 *
 * There is one ASR worker. The loop never runs while a dictation runs, and the
 * stop of the recording waits for the loop before the final pass starts.
 */
import { join } from "node:path";
import { collapseAsrLineBreaks } from "@openstyle/stt";
import { createAppLogger, errorMessage } from "@openstyle/utils";
import { MIC_WAV, SETTINGS_KEYS, SYSTEM_WAV } from "@openstyle/validations";
import { readSetting } from "../../db.js";
import { isDictationActive } from "../../dictation-activity.js";
import { getLanguagesSetting } from "../../language.js";
import { MLX_ASR_PROVIDER_ID } from "../../mlx-asr/constants.js";
import { resolveMlxLanguage } from "../../mlx-asr/language.js";
import { getMlxModelStatus } from "../../mlx-asr/models.js";
import { canRunMlxAsr, transcribeWithMlxAsr } from "../../mlx-asr/server.js";
import { stripProviderPrefix } from "../../streaming/types.js";
import { isHallucination } from "../merge.js";
import { MIN_MIC_VOICED_MS, type Segment } from "../segmenter.js";
import { createDefaultTranscriberDeps } from "../transcriber.js";
import {
  addFinalLine,
  countSkippedTick,
  dropLive,
  type LiveSource,
  openLive,
  setLiveStatus,
  setPartialLine,
} from "./store.js";
import { LIVE_SAMPLE_RATE, planTail, readPcmFrom, slicePcm } from "./tail.js";

const log = createAppLogger("meeting-live");

const TICK_MS = 2000;
/** Stop never waits longer than this for a running tick. */
const STOP_WAIT_MS = 20_000;
const SOURCES: readonly LiveSource[] = ["mic", "system"];

/** What the loop needs from the outside. Tests replace it. */
export interface LiveDeps {
  isEnabled: () => boolean;
  /** The ASR model of the meeting setting, or the reason it cannot be used. */
  resolveModel: () => Promise<
    { modelId: string; language?: string } | { unavailable: string }
  >;
  transcribe: (opts: {
    modelId: string;
    language?: string;
    pcm: Uint8Array;
  }) => Promise<string>;
  isDictationActive: () => boolean;
  tickMs: number;
}

export const defaultLiveDeps: LiveDeps = {
  isEnabled: () => readSetting(SETTINGS_KEYS.liveChatEnabled) === "true",
  resolveModel: async () => {
    // The live loop uses the SAME model as the meeting setting. A second
    // model would reload the single ASR worker at each tick.
    const deps = await createDefaultTranscriberDeps();
    let config: ReturnType<typeof deps.resolveConfig>;
    try {
      config = deps.resolveConfig();
    } catch (err) {
      return { unavailable: errorMessage(err) };
    }
    if (config.providerId !== MLX_ASR_PROVIDER_ID) {
      return { unavailable: "provider_not_local" };
    }
    const modelId = stripProviderPrefix(config.modelId);
    if (!canRunMlxAsr()) return { unavailable: "worker_missing" };
    if (getMlxModelStatus(modelId)?.status !== "ready") {
      return { unavailable: "model_missing" };
    }
    const language = resolveMlxLanguage(modelId, getLanguagesSetting()[0]);
    return { modelId, ...(language ? { language } : {}) };
  },
  transcribe: async ({ modelId, language, pcm }) => {
    const text = await transcribeWithMlxAsr({
      modelId,
      audio: pcm,
      pcmSampleRate: LIVE_SAMPLE_RATE,
      language,
      deferUnload: true,
    });
    return collapseAsrLineBreaks(text).trim();
  },
  isDictationActive,
  tickMs: TICK_MS,
};

interface LoopState {
  meetingId: string;
  audioDir: string;
  deps: LiveDeps;
  model: { modelId: string; language?: string };
  committedMs: Record<LiveSource, number>;
  stopped: boolean;
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

/** Skip a segment with no speech. Only the mic has this gate. */
function isSilent(source: LiveSource, seg: Segment): boolean {
  return (
    source === "mic" &&
    seg.voicedMs !== undefined &&
    seg.voicedMs < MIN_MIC_VOICED_MS
  );
}

async function readText(
  state: LoopState,
  pcm: Int16Array,
  fromMs: number,
  seg: Segment,
): Promise<string> {
  const text = await state.deps.transcribe({
    ...state.model,
    pcm: slicePcm(pcm, fromMs, seg),
  });
  state.warm = true;
  if (isHallucination({ startMs: seg.startMs, endMs: seg.endMs, text })) {
    return "";
  }
  return text;
}

async function tickChannel(
  state: LoopState,
  source: LiveSource,
): Promise<void> {
  const fromMs = state.committedMs[source];
  const pcm = readPcmFrom(wavPath(state, source), fromMs);
  if (!pcm || pcm.length === 0) return;
  const plan = planTail(pcm, fromMs);
  for (const seg of plan.closed) {
    if (state.stopped) return;
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
      }
    }
    state.committedMs[source] = seg.endMs;
  }
  if (state.stopped) return;
  const open = plan.open;
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

async function tick(state: LoopState): Promise<void> {
  // The single ASR worker serves dictation first.
  if (state.deps.isDictationActive()) {
    countSkippedTick(state.meetingId);
    return;
  }
  setLiveStatus(state.meetingId, state.warm ? "ready" : "warming");
  for (const source of SOURCES) {
    if (state.stopped) return;
    try {
      await tickChannel(state, source);
    } catch (err) {
      log.warn(`Live tick failed (${source}): ${errorMessage(err)}`);
    }
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
  const model = await deps.resolveModel().catch((err) => ({
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
    committedMs: { mic: 0, system: 0 },
    stopped: false,
    warm: false,
    timer: null,
    running: null,
  };
  loops.set(meetingId, state);
  log.info(`Live loop started for ${meetingId} (model ${model.modelId})`);
  schedule(state);
}

/**
 * Stop the loop and drop the live entry. It waits for a running tick, so the
 * single ASR worker is free when the final pass starts.
 */
export async function stopLive(meetingId: string): Promise<void> {
  const state = loops.get(meetingId);
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
    loops.delete(meetingId);
    log.info(`Live loop stopped for ${meetingId}`);
  }
  dropLive(meetingId);
}
