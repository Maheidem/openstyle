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
import { createAppLogger } from "@openstyle/utils";
import { parseWavHeader, sliceWav, type WavInfo } from "../audio/wav.js";
import { waitForDictationIdle } from "../dictation-activity.js";
import type {
  TranscribeResult,
  TranscriptionProvider,
} from "../streaming/types.js";
import type { AsrVocabularyBias } from "../vocabulary-bias.js";
import { WHISPER_PROVIDER_ID } from "../whisper/constants.js";
import type { Segment } from "./segmenter.js";

const log = createAppLogger("meeting-transcriber");

export { parseWavHeader, sliceWav, type WavInfo };

export type ChunkSource = "mic" | "system";

export interface ChunkResult {
  source: ChunkSource;
  /** Index within the source channel's segment list. */
  idx: number;
  startMs: number;
  endMs: number;
  text: string;
  status: "ok" | "failed" | "empty";
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
}

export interface TranscriberDeps {
  getProvider: (providerId: string) => TranscriptionProvider | null;
  /** Resolve provider/model/key/bias, as `routes/transcribe.ts` does. */
  resolveConfig: () => SttConfig;
  /** Dictation-priority lease: meeting chunks yield to active dictation. */
  isDictationActive?: () => boolean;
  onChunk?: (chunk: ChunkResult) => void;
  onProgress?: (progress: TranscriberProgress) => void;
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
}

interface RetryInfo {
  retryable: boolean;
  /** Explicit server-requested delay (Retry-After), if surfaced. */
  retryAfterMs?: number;
}

/**
 * Inspect a provider error for HTTP 429 / Retry-After hints. Providers
 * surface these loosely (error.status, error.retryAfterMs, or message text),
 * so probe pragmatically.
 */
function classifyError(err: unknown): RetryInfo {
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

  return {
    retryable: true,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

const defaultSleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

export class MeetingTranscriber {
  private readonly deps: TranscriberDeps;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(deps: TranscriberDeps) {
    this.deps = deps;
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Transcribe every segment of both channels. Individual chunk failures are
   * marked `failed` and never abort the run. Results are returned in
   * (source, idx) order regardless of completion order.
   */
  async run(input: MeetingChannels): Promise<ChunkResult[]> {
    const config = this.deps.resolveConfig();
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
      { source: "mic", name: "mic.wav", segments: input.micSegments },
      { source: "system", name: "system.wav", segments: input.systemSegments },
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
      let cursor = 0;
      let done = 0;
      let failed = 0;

      const worker = async (): Promise<void> => {
        for (;;) {
          const i = cursor++;
          if (i >= tasks.length) return;
          const t = tasks[i];
          const result = await this.transcribeChunk(
            provider,
            config,
            t.fd,
            t.info,
            t.source,
            t.idx,
            t.seg,
          );
          results[i] = result;
          done++;
          if (result.status === "failed") failed++;
          this.deps.onChunk?.(result);
          this.deps.onProgress?.({ done, total: tasks.length, failed });
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(concurrency, tasks.length) }, () =>
          worker(),
        ),
      );
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
  ): Promise<ChunkResult> {
    const maxAttempts = this.deps.maxAttempts ?? 3;
    const backoffBase = this.deps.backoffBaseMs ?? 1000;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (config.providerId === WHISPER_PROVIDER_ID) {
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
        const durationMs = seg.endMs - seg.startMs;
        const bias = durationMs < MIN_BIAS_DURATION_MS ? null : config.bias;
        const result: TranscribeResult = await provider.transcribe({
          audio,
          model: config.modelId,
          apiKey: config.apiKey,
          ...(config.language ? { language: config.language } : {}),
          bias,
        });
        const text = result.text.trim();
        return {
          source,
          idx,
          startMs: seg.startMs,
          endMs: seg.endMs,
          text,
          // Phase A4: an empty result is legitimate silence, not a failure —
          // distinguishing it from a real "ok" transcription keeps
          // retry-failed's WHERE status = 'failed' from re-attempting
          // silence forever (specs/meeting-transcription-quality.md §3.4).
          status: text.length === 0 ? "empty" : "ok",
        };
      } catch (err) {
        const retry = classifyError(err);
        log.warn(
          `chunk ${source}[${idx}] attempt ${attempt + 1}/${maxAttempts} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (attempt + 1 >= maxAttempts) break;
        const delay = retry.retryAfterMs ?? backoffBase * 2 ** attempt;
        await this.sleep(delay);
      }
    }

    return {
      source,
      idx,
      startMs: seg.startMs,
      endMs: seg.endMs,
      text: "",
      status: "failed",
    };
  }
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
): Promise<TranscriberDeps> {
  const [
    { getProvider },
    { getDefaultModels },
    { getApiKeyForProvider },
    { getLanguagesSetting },
    { resolveAsrVocabularyBias },
  ] = await Promise.all([
    import("../streaming/registry.js"),
    import("../providers.js"),
    import("../streaming-stt.js"),
    import("../language.js"),
    import("../vocabulary-bias.js"),
  ]);

  return {
    getProvider,
    resolveConfig: () => {
      const defaults = getDefaultModels();
      if (!defaults.voice) {
        throw new Error(
          "No voice model configured. Go to Settings > Models to add one.",
        );
      }
      const providerId = defaults.voice.provider;
      const modelId = defaults.voice.model_id;
      const apiKey = getApiKeyForProvider(providerId);
      if (!apiKey) {
        throw new Error(`No API key configured for provider: ${providerId}`);
      }
      const language = getLanguagesSetting()[0];
      return {
        providerId,
        modelId,
        apiKey,
        ...(language ? { language } : {}),
        bias: resolveAsrVocabularyBias(providerId, modelId),
      };
    },
    ...extras,
  };
}
