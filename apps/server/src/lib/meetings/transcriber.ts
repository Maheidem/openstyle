/**
 * Meeting transcription worker.
 *
 * Walks the per-channel segment lists produced by the segmenter, slices each
 * segment out of the meeting's `mic.wav` / `system.wav` via streamed reads
 * (never loading a whole file), wraps the slice as an in-memory WAV, and
 * feeds it to the configured STT provider exactly the way dictation does
 * (same model resolution and vocabulary-bias prompt as
 * `routes/transcribe.ts`).
 *
 * All external dependencies (provider lookup, config resolution, dictation
 * activity, clock/sleep) are injected so the worker is unit-testable without
 * real providers or a database.
 */

import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { isContextEcho, isVocabLeak, TERMS_MARKER } from "@openstyle/stt";
import { createAppLogger } from "@openstyle/utils";
import {
  MIC_WAV,
  parseMeetingSttModel,
  SYSTEM_WAV,
} from "@openstyle/validations";
import { parseWavHeader, sliceWav, type WavInfo } from "../audio/wav.js";
import { readSetting } from "../db.js";
import { waitForDictationIdle } from "../dictation-activity.js";
import { MLX_ASR_PROVIDER_ID } from "../mlx-asr/constants.js";
import type {
  TranscribeResult,
  TranscriptionProvider,
} from "../streaming/types.js";
import {
  type AsrVocabularyBias,
  combinePrompt,
  contextTail,
  providerTakesPrompt,
  vocabularyBiasTerms,
} from "../vocabulary-bias.js";
import { WHISPER_PROVIDER_ID } from "../whisper/constants.js";
import type { DetectAllFn } from "./language.js";
import { isHallucination } from "./merge.js";
import { MIN_MIC_VOICED_MS, type Segment } from "./segmenter.js";

const log = createAppLogger("meeting-transcriber");

export { parseWavHeader, sliceWav, type WavInfo };

export type ChunkSource = "mic" | "system";

/**
 * PR #38: channels whose noise-floor-only chunks are skipped BEFORE the
 * ASR call (`seg.voicedMs` under MIN_MIC_VOICED_MS → status `empty`, no
 * provider call). Mic only, for now: the proof data (meeting ca70f895)
 * shows the owner's mic at the noise floor producing "Okay." rows while
 * the system channel's pattern was checked separately.
 */
const SILENT_SKIP_SOURCES: readonly ChunkSource[] = ["mic"];

export interface ChunkResult {
  source: ChunkSource;
  /** Index within the source channel's segment list. */
  idx: number;
  startMs: number;
  endMs: number;
  text: string;
  status: "ok" | "failed" | "empty";
  /**
   * I1 (phase 3b): the previous-chunk context sent in this chunk's bias
   * prompt, when one was sent. Persist widens the leak check to
   * terms+context for exactly this chunk, so a full-prompt echo (label +
   * terms + context) is caught even though the context words dilute the
   * terms-only leak ratio. Undefined on the old pool (lanes: false,
   * retry-failed) — no context is sent there.
   */
  context?: string;
}

/**
 * Below this chunk duration, the vocabulary-bias prompt is withheld
 * entirely (Phase A3, specs/meeting-transcription-quality.md §3.3). A
 * short, low-signal clip has too little real audio for the 900-char bias
 * prompt to compete with as "context" — the model echoes the prompt back as
 * fake speech instead (finding #1). A 1.7s clip never gets a bias prompt at
 * all under this threshold.
 */
export const MIN_BIAS_DURATION_MS = 3000;

/**
 * I1 (specs/meeting-transcription-v2.md §3.1, phase 3b): context never
 * crosses a silence longer than this between the two chunks.
 */
export const CONTEXT_GAP_MAX_MS = 30_000;

/** Lazy import so tinyld only loads when the context guard actually runs. */
async function defaultDetectAll(): Promise<DetectAllFn> {
  const { detectAll } = await import("tinyld");
  return detectAll;
}

/**
 * I1 (phase 3b): per-lane context state. A lane runs its chunks in order,
 * so "the previous chunk in this lane" is simply the one just finished.
 */
interface LaneState {
  /** Cleaned text of the previous chunk in this lane (null: no context). */
  prevCleanText: string | null;
  /** endMs of the previous chunk in this lane (null: no chunk yet). */
  prevEndMs: number | null;
}

/** I1 (phase 3b): run-level counts, for the summary log line. */
interface ContextCounters {
  contextApplied: number;
  echoRetries: number;
  /** PR #38: chunks marked `empty` by the pre-ASR silence gate. */
  silentSkipped: number;
}

export interface TranscriberProgress {
  done: number;
  total: number;
  failed: number;
}

/** Resolved STT configuration, mirroring what dictation uses per request. */
export interface SttConfig {
  providerId: string;
  modelId: string;
  apiKey: string;
  /** Primary language hint; omitted lets the model auto-detect. */
  language?: string;
  bias: AsrVocabularyBias | null;
  /**
   * I3 (specs/meeting-transcription-v2.md §3.3): true when this model pair
   * is not the default voice (dictation) pair. The transcriber then yields
   * to active dictation also for `local-mlx` (a different local model
   * reloads in the single MLX worker and would stall a live dictation).
   */
  differsFromDictation?: boolean;
}

export interface TranscriberDeps {
  getProvider: (providerId: string) => TranscriptionProvider | null;
  /** Resolve provider/model/key/bias, as `routes/transcribe.ts` does. */
  resolveConfig: () => SttConfig;
  /** Dictation-priority lease: meeting chunks yield to active dictation. */
  isDictationActive?: () => boolean;
  onChunk?: (chunk: ChunkResult) => void;
  onProgress?: (progress: TranscriberProgress) => void;
  /** Cancellation seam (POST /api/meetings/:id/cancel-transcribe): polled
   * *between* chunk tasks — true stops new chunks from launching while any
   * in-flight chunk (≤2, or 1 for whisper-local) finishes normally. `run()`
   * then returns early with a holey results array: completed indices hold
   * their ChunkResult, never-started indices are absent. Callers that pass
   * shouldStop must treat holes as "not transcribed". */
  shouldStop?: () => boolean;
  /**
   * I1 (phase 3b): text-based language ID for the context language-change
   * guard. Injected for tests; defaults to tinyld's `detectAll` (lazy-
   * imported, as `language.ts` uses it).
   */
  detectAll?: DetectAllFn;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Retry backoff base delay (ms); doubles per attempt. */
  backoffBaseMs?: number;
  /** Max transcribe attempts per chunk (including the first). */
  maxAttempts?: number;
  /** Resume meeting work after this much dictation-idle time (ms). */
  dictationIdleResumeMs?: number;
  /** Poll interval while waiting out active dictation (ms). */
  dictationPollMs?: number;
}

export interface MeetingChannels {
  /** Absolute meeting directory containing `mic.wav` and `system.wav`. */
  meetingDir: string;
  micSegments: Segment[];
  systemSegments: Segment[];
  /**
   * I1 (specs/meeting-transcription-v2.md §3.1, phase 3a): one lane per
   * channel. A lane runs its chunks in order, one at a time; the two
   * lanes run in parallel. `local-whisper` keeps the pool at 1 — the mic
   * lane runs first, then the system lane (same order as the old single
   * pool). Default true. When false the transcriber keeps the old shared
   * cursor and pool (retry-failed passes false, which also keeps the
   * later context and overlap phases off).
   */
  lanes?: boolean;
}

/**
 * Inspect a provider error for HTTP 429 / Retry-After hints. Return the
 * server-requested delay in ms, or `undefined` if there is none. Providers
 * surface these loosely (error.status, error.retryAfterMs, or message text),
 * so probe pragmatically.
 */
function retryAfterMsOf(err: unknown): number | undefined {
  const e = err as {
    status?: number;
    statusCode?: number;
    retryAfterMs?: number;
    retryAfter?: number | string;
    message?: string;
  };
  const status = e?.status ?? e?.statusCode;
  const msg = typeof e?.message === "string" ? e.message : "";
  const is429 = status === 429 || /\b429\b|rate.?limit/i.test(msg);

  let retryAfterMs: number | undefined;
  if (typeof e?.retryAfterMs === "number") retryAfterMs = e.retryAfterMs;
  else if (e?.retryAfter !== undefined) {
    const s = Number(e.retryAfter);
    if (Number.isFinite(s)) retryAfterMs = s * 1000;
  } else if (is429) {
    const m = msg.match(/retry-after[:=\s]+(\d+(?:\.\d+)?)/i);
    if (m) retryAfterMs = Number(m[1]) * 1000;
  }

  return retryAfterMs;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

export class MeetingTranscriber {
  private readonly deps: TranscriberDeps;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  /** I1 (phase 3b): resolved once, shared by every context guard call. */
  private detectAllFn: DetectAllFn | null = null;

  constructor(deps: TranscriberDeps) {
    this.deps = deps;
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? Date.now;
  }

  private async resolveDetectAll(): Promise<DetectAllFn> {
    if (this.deps.detectAll) return this.deps.detectAll;
    if (!this.detectAllFn) this.detectAllFn = await defaultDetectAll();
    return this.detectAllFn;
  }

  /**
   * I1 (specs/meeting-transcription-v2.md §3.1, phase 3b): the context of
   * this chunk — the tail of the previous chunk's cleaned text in this
   * lane — or null under any of the guards: the provider does not take a
   * prompt (term-list providers); the meeting language is not declared;
   * the chunk is shorter than MIN_BIAS_DURATION_MS (the same constant
   * guards bias and context); the previous chunk had no cleaned text
   * (empty, failed or filtered — the lane never reaches back further);
   * the gap from the previous chunk's end exceeds CONTEXT_GAP_MAX_MS;
   * tinyld (as `language.ts` uses it) finds no candidate, or a candidate
   * other than `config.language`, on the tail. Decision (owner,
   * 2026-10-06): a no-detected-language tail is not trusted as the
   * meeting's speech, so it gives the next chunk NO context.
   */
  private async contextFor(
    lane: LaneState,
    config: SttConfig,
    seg: Segment,
  ): Promise<string | null> {
    if (!providerTakesPrompt(config.providerId)) return null;
    if (config.language === undefined) return null;
    if (seg.endMs - seg.startMs < MIN_BIAS_DURATION_MS) return null;
    if (lane.prevCleanText === null || lane.prevEndMs === null) return null;
    if (seg.startMs - lane.prevEndMs > CONTEXT_GAP_MAX_MS) return null;
    const tail = contextTail(lane.prevCleanText);
    if (!tail) return null;
    const detectAll = await this.resolveDetectAll();
    const top = detectAll(tail)[0]?.lang;
    // Owner decision (2026-10-06, §3.1): no detected language at all
    // drops the context (not a fail-open keep).
    if (top !== config.language) return null;
    return tail;
  }

  /**
   * I1 (phase 3b): the per-chunk bias when context applies — terms first,
   * context last, under the 900-char budget. Only the five prompt
   * providers reach here (providerTakesPrompt); their bias is the
   * `prompt` kind, or null when the user has no vocabulary — then the
   * prompt is the context only.
   */
  private biasWithContext(
    config: SttConfig,
    context: string,
  ): { kind: "prompt"; text: string } {
    const biasText = config.bias?.kind === "prompt" ? config.bias.text : "";
    // combinePrompt handles the no-terms case (returns the context alone).
    return { kind: "prompt", text: combinePrompt(biasText, context) };
  }

  /**
   * Transcribe every segment of both channels. Individual chunk failures are
   * marked `failed` and never abort the run. Results are returned in
   * (source, idx) order regardless of completion order.
   */
  async run(input: MeetingChannels): Promise<ChunkResult[]> {
    // Early-return note: when shouldStop fires, the results array keeps
    // absent (hole) slots for chunks that never ran — see shouldStop.
    const config = this.deps.resolveConfig();
    // Decision (owner, 2026-10-07, §3.1): the previous-chunk context ships
    // OFF BY DEFAULT behind the flat `meeting_asr_context` setting — only
    // the value "true" turns it on; a missing row means off. Read once per
    // run, next to the config. The lanes from phase 3a stay on either way;
    // this gate only decides whether a lane may send context. retry-failed
    // (lanes: false) has no lane state, so it stays without context even
    // when the setting is on.
    const contextEnabled = readSetting("meeting_asr_context") === "true";
    const provider = this.deps.getProvider(config.providerId);
    if (!provider) {
      throw new Error(
        `Unsupported transcription provider: ${config.providerId}`,
      );
    }

    // whisper-local runs one server instance loading one model at a time —
    // parallel requests just queue (or thrash), so keep it serial. Cloud
    // providers take 2 in flight.
    const concurrency = config.providerId === WHISPER_PROVIDER_ID ? 1 : 2;

    interface Task {
      source: ChunkSource;
      idx: number;
      seg: Segment;
      fd: number;
      info: WavInfo;
    }

    const files: Array<{
      source: ChunkSource;
      name: string;
      segments: Segment[];
    }> = [
      { source: "mic", name: MIC_WAV, segments: input.micSegments },
      { source: "system", name: SYSTEM_WAV, segments: input.systemSegments },
    ];

    const opened: number[] = [];
    const tasks: Task[] = [];
    try {
      for (const f of files) {
        if (f.segments.length === 0) continue;
        const fd = openSync(join(input.meetingDir, f.name), "r");
        opened.push(fd);
        const info = parseWavHeader(fd);
        for (const [idx, seg] of f.segments.entries()) {
          tasks.push({ source: f.source, idx, seg, fd, info });
        }
      }

      const results: ChunkResult[] = new Array(tasks.length);
      let done = 0;
      let failed = 0;
      const counters: ContextCounters = {
        contextApplied: 0,
        echoRetries: 0,
        silentSkipped: 0,
      };

      const runTask = async (
        i: number,
        lane: LaneState | null,
      ): Promise<void> => {
        const t = tasks[i];
        const result = await this.transcribeChunk(
          provider,
          config,
          t.fd,
          t.info,
          t.source,
          t.idx,
          t.seg,
          lane,
          contextEnabled,
          counters,
        );
        results[i] = result;
        done++;
        if (result.status === "failed") failed++;
        this.deps.onChunk?.(result);
        this.deps.onProgress?.({ done, total: tasks.length, failed });
      };

      if (input.lanes ?? true) {
        // Phase 3a (specs/meeting-transcription-v2.md §3.1): one lane per
        // channel. Tasks were pushed mic-first, so the mic lane is the
        // first `micSegments.length` tasks and the system lane the rest.
        const lanes: Array<{ start: number; count: number }> = [];
        if (input.micSegments.length > 0)
          lanes.push({ start: 0, count: input.micSegments.length });
        if (input.systemSegments.length > 0)
          lanes.push({
            start: input.micSegments.length,
            count: input.systemSegments.length,
          });

        // Phase 3b: one context state per lane — the previous chunk's
        // cleaned text travels with the lane, never across channels.
        const laneStates: LaneState[] = lanes.map(() => ({
          prevCleanText: null,
          prevEndMs: null,
        }));

        const laneWorker = async (
          lane: { start: number; count: number },
          state: LaneState,
        ) => {
          for (let i = lane.start; i < lane.start + lane.count; i++) {
            // Between chunk tasks: a cancellation stops this lane from
            // claiming anything further; chunks already in flight finish
            // normally (their results are persisted via onChunk as usual).
            if (this.deps.shouldStop?.()) return;
            await runTask(i, state);
          }
        };

        // local-whisper keeps the pool at 1: the lanes run one after
        // another, mic first — the same order as the old single pool.
        if (concurrency === 1) {
          for (let l = 0; l < lanes.length; l++) {
            await laneWorker(lanes[l]!, laneStates[l]!);
          }
        } else {
          await Promise.all(
            lanes.map((lane, l) => laneWorker(lane, laneStates[l]!)),
          );
        }
      } else {
        // Old behavior (lanes: false, used by retry-failed): one shared
        // cursor, a pool of workers.
        let cursor = 0;
        const worker = async (): Promise<void> => {
          for (;;) {
            // Between chunk tasks: a cancellation stops this worker from
            // claiming anything further; chunks already in flight finish
            // normally (their results are persisted via onChunk as usual).
            if (this.deps.shouldStop?.()) return;
            const i = cursor++;
            if (i >= tasks.length) return;
            // lanes: false — no lanes, so no lane state and no context
            // (retry-failed runs without context, decision 8).
            await runTask(i, null);
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(concurrency, tasks.length) }, () =>
            worker(),
          ),
        );
      }
      // Phase 3b / PR #38 proof report (counts only — never text).
      if (
        counters.contextApplied > 0 ||
        counters.echoRetries > 0 ||
        counters.silentSkipped > 0
      ) {
        log.info(
          `transcribe: context applied to ${counters.contextApplied} chunk(s), echo retries ${counters.echoRetries}, silent skipped ${counters.silentSkipped}`,
        );
      }
      return results;
    } finally {
      for (const fd of opened) {
        try {
          closeSync(fd);
        } catch {
          // best effort
        }
      }
    }
  }

  private async transcribeChunk(
    provider: TranscriptionProvider,
    config: SttConfig,
    fd: number,
    info: WavInfo,
    source: ChunkSource,
    idx: number,
    seg: Segment,
    lane: LaneState | null,
    contextEnabled: boolean,
    counters: ContextCounters,
  ): Promise<ChunkResult> {
    // PR #38: pre-ASR silence gate. A chunk whose speech evidence
    // (voicedMs, set by the segmenter) is under MIN_MIC_VOICED_MS is
    // noise floor plus clicks — the model transcribes that as "Okay."
    // or echoes the bias prompt. Mark it `empty` and skip the provider
    // call entirely. `voicedMs === undefined` (retry-failed rebuilds the
    // segments from the DB) keeps the old behavior: the chunk is sent.
    if (
      SILENT_SKIP_SOURCES.includes(source) &&
      seg.voicedMs !== undefined &&
      seg.voicedMs < MIN_MIC_VOICED_MS
    ) {
      const skipped: ChunkResult = {
        source,
        idx,
        startMs: seg.startMs,
        endMs: seg.endMs,
        text: "",
        status: "empty",
      };
      counters.silentSkipped++;
      // The lane sees a gap here: the NEXT chunk gets no context across
      // this skipped chunk (same rule as any non-`ok` result).
      this.updateLaneState(lane, skipped, config, seg);
      return skipped;
    }

    const maxAttempts = this.deps.maxAttempts ?? 3;
    const backoffBase = this.deps.backoffBaseMs ?? 1000;
    const durationMs = seg.endMs - seg.startMs;
    // The same constant guards both: below this, neither the vocabulary
    // bias prompt nor the context is sent (phase 3b, §3.1).
    const baseBias = durationMs < MIN_BIAS_DURATION_MS ? null : config.bias;
    // Previous-chunk context (phase 3b): lanes only, and only when the
    // `meeting_asr_context` setting is on (owner decision 2026-10-07: off
    // by default). The old pool (lanes: false, retry-failed) has no lane
    // state, so no context either way.
    const context =
      lane && contextEnabled ? await this.contextFor(lane, config, seg) : null;
    const withContext =
      context !== null ? this.biasWithContext(config, context) : null;
    const bias = withContext ?? baseBias;
    if (context) counters.contextApplied++;
    // Echo reference (phase 3b): the prompt REALLY sent, terms label
    // removed. The context alone would miss a FULL-prompt echo — the
    // model returns "Technical terms: A, B, C <context words>", whose
    // context words dilute the terms-only leak ratio and whose label
    // prefix breaks the context-only echo match. Measured against the
    // whole sent prompt, every echo shape is a contiguous run (or a
    // close paraphrase) of it.
    const echoReference = withContext
      ? withContext.text.replace(TERMS_MARKER, "")
      : null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // whisper-local runs one shared server for dictation and meetings.
      // A DIFFERENT local-mlx model reloads the single MLX worker, so it
      // must not load mid-dictation either (I3, §3.3). A local-mlx model
      // that IS the dictation model needs no yield — it is already loaded.
      const yieldsToDictation =
        config.providerId === WHISPER_PROVIDER_ID ||
        (config.providerId === MLX_ASR_PROVIDER_ID &&
          config.differsFromDictation === true);
      if (yieldsToDictation) {
        await waitForDictationIdle({
          isDictationActive: this.deps.isDictationActive,
          idleMs: this.deps.dictationIdleResumeMs,
          pollMs: this.deps.dictationPollMs,
          now: this.now,
          sleep: this.sleep,
        });
      }
      try {
        const audio = sliceWav(fd, info, seg.startMs, seg.endMs);
        const result: TranscribeResult = await provider.transcribe({
          audio,
          model: config.modelId,
          apiKey: config.apiKey,
          ...(config.language ? { language: config.language } : {}),
          bias,
        });
        let text = result.text.trim();
        if (
          context &&
          echoReference !== null &&
          isContextEcho(text, echoReference)
        ) {
          // Echo guard (phase 3b, §3.1): one extra call for the same
          // chunk with NO context, and its result wins. It does not count
          // against maxAttempts; if it throws, the normal attempt retry
          // below handles it. Call-count worst case for this chunk:
          // 2 x maxAttempts (one echo retry per attempt) + the retry's
          // own failure falls into the next attempt — with the defaults
          // (maxAttempts 3) that is at most 6 calls, versus 3 without the
          // guard.
          counters.echoRetries++;
          const retry = await provider.transcribe({
            audio,
            model: config.modelId,
            apiKey: config.apiKey,
            ...(config.language ? { language: config.language } : {}),
            bias: baseBias,
          });
          text = retry.text.trim();
        }
        const chunk: ChunkResult = {
          source,
          idx,
          startMs: seg.startMs,
          endMs: seg.endMs,
          text,
          // The context travels with the result: persist widens this
          // chunk's leak check to terms+context (see ChunkResult).
          ...(context ? { context } : {}),
          // Phase A4: an empty result is legitimate silence, not a failure —
          // distinguishing it from a real "ok" transcription keeps
          // retry-failed's WHERE status = 'failed' from re-attempting
          // silence forever (specs/meeting-transcription-quality.md §3.4).
          // Phase 3b: this also covers the text that is empty AFTER the
          // echo retry (or the persist-time dedupe, which sets its own).
          status: text.length === 0 ? "empty" : "ok",
        };
        this.updateLaneState(lane, chunk, config, seg);
        return chunk;
      } catch (err) {
        const retryAfterMs = retryAfterMsOf(err);
        log.warn(
          `chunk ${source}[${idx}] attempt ${attempt + 1}/${maxAttempts} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (attempt + 1 >= maxAttempts) break;
        const delay = retryAfterMs ?? backoffBase * 2 ** attempt;
        await this.sleep(delay);
      }
    }

    const failed: ChunkResult = {
      source,
      idx,
      startMs: seg.startMs,
      endMs: seg.endMs,
      text: "",
      status: "failed",
    };
    this.updateLaneState(lane, failed, config, seg);
    return failed;
  }

  /**
   * I1 (phase 3b, §3.1): record this chunk for the NEXT one's context.
   * "Cleaned" means status `ok`, not a silence hallucination and not a
   * vocabulary leak (the persist-time filters, applied here at lane
   * scope). Anything else — empty, failed, would-be-filtered — leaves
   * the lane with no context: it never reaches back further.
   */
  private updateLaneState(
    lane: LaneState | null,
    result: ChunkResult,
    config: SttConfig,
    seg: Segment,
  ): void {
    if (!lane) return;
    lane.prevEndMs = seg.endMs;
    lane.prevCleanText =
      result.status === "ok" &&
      !isHallucination({
        startMs: seg.startMs,
        endMs: seg.endMs,
        text: result.text,
      }) &&
      // A result carrying the prompt label is boilerplate, never speech
      // (phase 3b feedback loop: a full-prompt echo must never become
      // the next chunk's context).
      !TERMS_MARKER.test(result.text) &&
      !isVocabLeak(
        result.text,
        // Widen to terms+context for exactly the chunk that got context:
        // a label-less full-prompt echo (the echo guard's retry returned
        // the echo again) dilutes the terms-only ratio. Deliberately
        // STRONGER than the persist check (marker AND ratio): a false
        // positive here only costs the next chunk its context, while at
        // persist a false positive would filter real speech.
        result.context
          ? [...vocabularyBiasTerms(config.bias), result.context]
          : vocabularyBiasTerms(config.bias),
      )
        ? result.text
        : null;
  }
}

/**
 * I3 (specs/meeting-transcription-v2.md §3.3): explicit model pair for one
 * job. retry-failed passes the meeting row's `stt_provider`/`stt_model` so
 * a retry uses the model the failed chunks ran with. When present it wins
 * over the `meeting_stt_model` setting and the default voice model. No
 * existence check runs here — a gone provider or model fails the provider
 * call with its own message.
 */
export interface MeetingSttModelOverride {
  provider: string;
  modelId: string;
}

/**
 * Production dependency wiring: resolves provider/model/key/language/bias
 * from the live configuration exactly as `routes/transcribe.ts` does for
 * dictation. Kept as a factory (with lazy imports at call time already
 * bound) so tests never touch the database.
 */
export async function createDefaultTranscriberDeps(
  extras: Pick<
    TranscriberDeps,
    "isDictationActive" | "onChunk" | "onProgress"
  > = {},
  modelOverride?: MeetingSttModelOverride,
  /**
   * PR #39: terms extracted from the meeting's free-text context
   * (the calendar invitee list). Prepended to this meeting's
   * vocabulary bias — dictation and meetings without a context are
   * untouched.
   */
  contextTerms: string[] = [],
): Promise<TranscriberDeps> {
  const [
    { getProvider },
    { getDefaultModels },
    { getApiKey },
    { getLanguagesSetting },
    { resolveAsrVocabularyBias, resolveMeetingAsrVocabularyBias },
  ] = await Promise.all([
    import("../streaming/registry.js"),
    import("../providers.js"),
    import("../api-keys.js"),
    import("../language.js"),
    import("../vocabulary-bias.js"),
  ]);

  const resolveFor = (
    providerId: string,
    modelId: string,
    differsFromDictation: boolean,
  ): SttConfig => {
    const apiKey = getApiKey(providerId);
    if (!apiKey) {
      throw new Error(`No API key configured for provider: ${providerId}`);
    }
    const language = getLanguagesSetting()[0];
    return {
      providerId,
      modelId,
      apiKey,
      ...(language ? { language } : {}),
      // PR #39: a meeting with a free-text context (the calendar
      // invitee list) gets its extracted terms PREPENDED to the global
      // vocabulary, so they win the per-provider caps (the 900-char
      // prompt budget in particular). No context = today's behavior.
      bias:
        contextTerms.length > 0
          ? resolveMeetingAsrVocabularyBias(providerId, modelId, contextTerms)
          : resolveAsrVocabularyBias(providerId, modelId),
      differsFromDictation,
    };
  };

  return {
    getProvider,
    resolveConfig: () => {
      const defaults = getDefaultModels();
      // I3 (specs/meeting-transcription-v2.md §3.3): an explicit row
      // override (retry-failed) wins over the `meeting_stt_model` setting,
      // which wins over the default voice (dictation) model. A missing,
      // empty or unparseable setting falls back to the dictation model —
      // today's behaviour.
      const stored = modelOverride
        ? {
            provider: modelOverride.provider,
            modelId: modelOverride.modelId,
          }
        : parseMeetingSttModel(readSetting("meeting_stt_model"));
      if (stored) {
        const differsFromDictation =
          !defaults.voice ||
          defaults.voice.provider !== stored.provider ||
          defaults.voice.model_id !== stored.modelId;
        return resolveFor(
          stored.provider,
          stored.modelId,
          differsFromDictation,
        );
      }
      if (!defaults.voice) {
        throw new Error(
          "No voice model configured. Go to Settings > Models to add one.",
        );
      }
      return resolveFor(
        defaults.voice.provider,
        defaults.voice.model_id,
        false,
      );
    },
    ...extras,
  };
}
