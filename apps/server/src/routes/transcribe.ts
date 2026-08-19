import { sanitizeTranscriptText } from "@openstyle/stt";
import { createAppLogger } from "@openstyle/utils";
import { Hono } from "hono";
import { formatError } from "../lib/format-error.js";
import { saveProcessedHistory, saveRawHistory } from "../lib/history-store.js";
import { getLanguagesSetting } from "../lib/language.js";
import { MLX_ASR_PROVIDER_ID } from "../lib/mlx-asr/constants.js";
import { getMlxModelStatus } from "../lib/mlx-asr/models.js";
import { canRunMlxAsr, startMlxInBackground } from "../lib/mlx-asr/server.js";
import {
  FreestyleEventType,
  PipelineStage,
  parseAppContext,
  plugins,
} from "../lib/plugins/index.js";
import {
  createHookApi,
  dispositionFromControl,
  emitAbortEvent,
} from "../lib/plugins/pipeline.js";
import {
  postProcess,
  prewarmPostProcess,
  resolveAppContextForCleanup,
} from "../lib/post-process.js";
import { getDefaultModels } from "../lib/providers.js";
import { getProvider } from "../lib/streaming/registry.js";
import { stripProviderPrefix } from "../lib/streaming/types.js";
import { getApiKeyForProvider } from "../lib/streaming-stt.js";
import {
  buildAsrVocabularyBias,
  resolveAsrVocabularyBias,
} from "../lib/vocabulary-bias.js";
import { isServerBinaryAvailable } from "../lib/whisper/binary.js";
import { WHISPER_PROVIDER_ID } from "../lib/whisper/constants.js";
import { startInBackground } from "../lib/whisper/server.js";
import { prewarmModelCostRegistry } from "./models.js";

const log = createAppLogger("transcribe");

function routeVoiceProviderCategory(providerId: string): "local" | "byok" {
  if (providerId === "local-whisper" || providerId === "local-mlx")
    return "local";
  return "byok";
}

/**
 * The client percent-encodes the x-app-context header so non-Latin1
 * characters (e.g. a Cyrillic window title) survive transport. Decode it
 * back here, tolerating values that were sent unencoded by older clients.
 */
function decodeAppContext(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

const transcribeRoute = new Hono().post("/", async (c) => {
  const start = Date.now();

  const contentType = c.req.header("content-type") ?? "";
  let audioData: Uint8Array;

  if (contentType.includes("multipart/form-data")) {
    const form = await c.req.formData();
    const audioFile = form.get("audio");
    if (!(audioFile instanceof File)) {
      return c.json({ error: "audio field missing or not a file" }, 400);
    }
    audioData = new Uint8Array(await audioFile.arrayBuffer());
  } else {
    audioData = new Uint8Array(await c.req.arrayBuffer());
  }

  if (audioData.length === 0) {
    return c.json({ error: "Empty audio data" }, 400);
  }

  log.debug(
    `received audio: ${audioData.length} bytes, header=${String.fromCharCode(
      ...audioData.slice(0, 4),
    )} contentType=${contentType.slice(0, 40)}`,
  );

  const appContext = resolveAppContextForCleanup(
    decodeAppContext(c.req.header("x-app-context")),
  );
  const parsedCtx = parseAppContext(appContext);

  let audioDurationMs = 0;
  if (audioData.length > 44) {
    audioDurationMs = Math.round((audioData.length - 44) / 32);
  }
  if (!audioDurationMs) {
    const h = c.req.header("x-audio-duration-ms");
    if (h) audioDurationMs = Number(h) || 0;
  }

  const defaults = getDefaultModels();
  if (!defaults.voice) {
    return c.json(
      {
        error: "No voice model configured. Go to Settings > Models to add one.",
      },
      400,
    );
  }

  let rawText: string;
  let transcribeDurationInSeconds: number | undefined;
  const languages = getLanguagesSetting();
  const api = await createHookApi();

  // Plugin hook: preprocess the recorded audio, or override which provider,
  // model, language, or ASR vocabulary bias transcribes this dictation.
  // Runs before any provider/key resolution so overrides actually take
  // effect. `api.control.consume()` here skips STT entirely.
  const beforeTranscribeOutput = await plugins().run(
    "beforeTranscribe",
    {
      providerId: defaults.voice.provider,
      modelId: defaults.voice.model_id,
      audioDurationMs,
      ...(parsedCtx ? { appContext: parsedCtx } : {}),
    },
    {
      audio: audioData,
      providerId: defaults.voice.provider,
      modelId: defaults.voice.model_id,
    },
    api,
  );
  audioData = beforeTranscribeOutput.audio;
  const voiceProvider = beforeTranscribeOutput.providerId;
  const voiceModel = beforeTranscribeOutput.modelId;
  const languageOverride = beforeTranscribeOutput.language;
  // A plugin may override the language for this one dictation. It's a single
  // code, so it takes precedence as the sole language; otherwise use the user's
  // full language list. `languages[0]` is the primary for single-language
  // providers (batch Whisper, BYOK).
  const effectiveLanguages = languageOverride ? [languageOverride] : languages;
  const primaryLanguage = effectiveLanguages[0];

  // A plugin consumed/aborted the dictation in a server hook: return blank
  // output so any client suppresses delivery, carry the disposition/reason,
  // and (on abort) emit the documented `pipelineError` event exactly once.
  const suppressedResponse = () => {
    emitAbortEvent(api, PipelineStage.Transcribe);
    return c.json({
      raw: "",
      cleaned: "",
      model: voiceModel,
      durationMs: Date.now() - start,
      audioDurationMs,
      disposition: dispositionFromControl(api.control.state),
      ...(api.control.reason ? { reason: api.control.reason } : {}),
    });
  };

  if (api.control.state !== "running") {
    return suppressedResponse();
  }

  const provider = getProvider(voiceProvider);
  if (!provider) {
    return c.json(
      { error: `Unsupported transcription provider: ${voiceProvider}` },
      400,
    );
  }

  const apiKey = getApiKeyForProvider(voiceProvider);
  if (!apiKey) {
    return c.json(
      { error: `No API key configured for provider: ${voiceProvider}` },
      400,
    );
  }

  const skipPostProcess = c.req.header("x-skip-post-process") === "true";

  try {
    // A plugin-provided bias list is a set of raw terms — rebuild the
    // provider-specific structure from them rather than the DB vocabulary.
    const bias = beforeTranscribeOutput.bias
      ? buildAsrVocabularyBias(
          voiceProvider,
          voiceModel,
          beforeTranscribeOutput.bias,
        )
      : resolveAsrVocabularyBias(voiceProvider, voiceModel);
    log.debug(`bias=${JSON.stringify(bias)}`);
    const t0 = Date.now();
    const result = await provider.transcribe({
      audio: audioData,
      model: voiceModel,
      apiKey,
      ...(primaryLanguage ? { language: primaryLanguage } : {}),
      bias,
      appContext,
    });
    rawText = sanitizeTranscriptText(result.text);

    // Plugin hook: rewrite the raw transcript before cleanup.
    rawText = (
      await plugins().run(
        "afterTranscribe",
        {
          providerId: voiceProvider,
          modelId: voiceModel,
          appContext: parsedCtx,
        },
        { text: rawText },
        api,
      )
    ).text;
    transcribeDurationInSeconds = result.durationInSeconds;

    log.debug(
      `STT took ${Date.now() - t0}ms | rawText=${JSON.stringify(rawText).slice(0, 120)}`,
    );
  } catch (err) {
    log.error(
      `transcribe failed (${voiceProvider}/${voiceModel}): ${formatError(err)}`,
    );
    void plugins().emit({
      type: FreestyleEventType.PipelineError,
      stage: PipelineStage.Transcribe,
      message: err instanceof Error ? err.message : String(err),
    });
    return c.json(
      {
        error: "Transcription failed",
        detail: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }

  const durationMs = Date.now() - start;

  if (!rawText.trim() || api.control.state !== "running") {
    return suppressedResponse();
  }

  void plugins().emit({
    type: FreestyleEventType.Transcribed,
    text: rawText,
    ...(transcribeDurationInSeconds !== undefined
      ? { durationInSeconds: transcribeDurationInSeconds }
      : {}),
  });

  if (skipPostProcess) {
    try {
      saveRawHistory({
        rawText,
        voiceProvider,
        voiceModel,
        durationMs,
        audioDurationMs,
      });
    } catch (err) {
      log.error(`Failed to save history: ${err}`);
    }

    return c.json({
      raw: rawText,
      cleaned: rawText,
      model: voiceModel,
      provider_category: routeVoiceProviderCategory(voiceProvider),
      durationMs,
    });
  }

  const ppStart = Date.now();
  const pp = await postProcess(rawText, appContext, {
    languages: effectiveLanguages,
    source: "batch",
    api,
  });
  log.debug(
    `post-process took ${Date.now() - ppStart}ms | cleaned=${JSON.stringify(pp.cleaned).slice(0, 120)}`,
  );

  // STT and cleanup ran on separate models, so the user-perceived latency is
  // the full request → cleaned text. `durationMs` above is STT-only; recompute
  // now so history and the response both report the same total.
  const totalDurationMs = Date.now() - start;

  try {
    saveProcessedHistory({
      rawText,
      cleanedText: pp.cleaned !== rawText ? pp.cleaned : null,
      voiceProvider,
      voiceModel,
      llmProvider: pp.llmProvider,
      llmModel: pp.llmModel,
      durationMs: totalDurationMs,
      audioDurationMs,
      inputTokens: pp.inputTokens,
      outputTokens: pp.outputTokens,
      costUsd: pp.costUsd,
    });
  } catch (err) {
    log.error(`Failed to save history: ${err}`);
  }

  log.debug(`total ${totalDurationMs}ms`);

  // `beforeCleanup`/`afterCleanup` run inside postProcess, after the
  // raw-stage guard above — a consume/abort there still needs to suppress
  // delivery. Blank the output so any client drops it even if it ignores
  // `disposition`, and emit the abort event on that path too.
  const suppressed = api.control.state !== "running";
  emitAbortEvent(api, PipelineStage.Transcribe);
  return c.json({
    raw: suppressed ? "" : rawText,
    cleaned: suppressed ? "" : pp.cleaned,
    model: voiceModel,
    provider_category: routeVoiceProviderCategory(voiceProvider),
    durationMs: totalDurationMs,
    audioDurationMs,
    llmModel: pp.llmModel,
    inputTokens: pp.inputTokens,
    outputTokens: pp.outputTokens,
    costUsd: pp.costUsd,
    disposition: dispositionFromControl(api.control.state),
  });
});

export default transcribeRoute;

/**
 * Pre-warm the local ASR server for the currently-selected voice model so it
 * loads while the user is still speaking, instead of stalling at submission.
 *
 * The client fires this fire-and-forget on recording start. We dispatch on the
 * default voice provider: only local engines (whisper/mlx) need warming, and
 * each has its own availability gate. Cloud/BYOK providers are a cheap no-op.
 * The underlying `startInBackground` helpers are themselves fire-and-forget and
 * no-op when the server is already warm, so repeated calls are safe.
 *
 * Kept as a separate router (mounted alongside `transcribeRoute` at
 * `/transcribe`) so it can be added to the typed RPC surface without reindenting
 * the large batch-transcribe handler above.
 */
export const transcribePreWarmRoute = new Hono().post("/pre-warm", (c) => {
  try {
    // Warm the cleanup LLM connection while the user is still speaking, so the
    // post-transcription handoff reuses a hot socket. Independent of the voice
    // provider; a no-op unless cleanup is enabled and the configured provider
    // supports prewarming (e.g. Groq).
    prewarmPostProcess();

    // Warm the models.dev cost registry in the background so the per-dictation
    // cost lookup hits a warm cache and never blocks the response.
    prewarmModelCostRegistry();

    const defaults = getDefaultModels();
    const provider = defaults.voice?.provider;

    if (!defaults.voice || !provider) {
      return c.json({ ok: true, warming: null });
    }

    const modelId = stripProviderPrefix(defaults.voice.model_id);

    if (provider === WHISPER_PROVIDER_ID) {
      if (!isServerBinaryAvailable()) {
        return c.json({ ok: true, warming: null });
      }
      startInBackground(modelId);
      return c.json({ ok: true, warming: "whisper" });
    }

    if (provider === MLX_ASR_PROVIDER_ID) {
      if (!canRunMlxAsr()) return c.json({ ok: true, warming: null });
      if (getMlxModelStatus(modelId)?.status !== "ready") {
        return c.json({ ok: true, warming: null });
      }
      startMlxInBackground(modelId);
      return c.json({ ok: true, warming: "mlx" });
    }

    return c.json({ ok: true, warming: null });
  } catch {
    // Best-effort warmup — DB not ready or any other init issue is non-fatal;
    // the lazy start at submission time remains the fallback.
    return c.json({ ok: true, warming: null });
  }
});
