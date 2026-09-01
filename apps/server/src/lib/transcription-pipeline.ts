/**
 * Shared dictation transcription pipeline: provider/model/language resolution
 * → STT → vocabulary-leak guard → LLM cleanup → history.
 *
 * Extracted verbatim from the `POST /api/transcribe` handler so the import
 * route (`POST /api/transcribe/file`) can run *exactly* the same sequence on a
 * decoded file instead of forking it. Input-specific concerns (body parsing,
 * duration derivation, the `x-skip-post-process` header) stay in the routes;
 * everything from "which voice model" onward lives here. Response bodies and
 * status codes are returned to the caller unchanged so the dictation route
 * stays byte-identical to its pre-extraction behavior.
 *
 * No history row is ever written on failure: both `save*History` calls sit
 * after a successful `provider.transcribe`, and STT failures return before
 * them.
 */

import { sanitizeTranscriptText, stripVocabLeak } from "@openstyle/stt";
import { createAppLogger } from "@openstyle/utils";
import { formatError } from "./format-error.js";
import { saveProcessedHistory, saveRawHistory } from "./history-store.js";
import { getLanguagesSetting, resolveLanguageOverride } from "./language.js";
import { postProcess, resolveAppContextForCleanup } from "./post-process.js";
import { getDefaultModels } from "./providers.js";
import { getProvider } from "./streaming/registry.js";
import {
  getApiKeyForProvider,
  voiceProviderCategory,
} from "./streaming-stt.js";
import {
  resolveAsrVocabularyBias,
  vocabularyBiasTerms,
} from "./vocabulary-bias.js";

const log = createAppLogger("transcribe");

/**
 * The client percent-encodes the x-app-context header so non-Latin1
 * characters (e.g. a Cyrillic window title) survive transport. Decode it
 * back here, tolerating values that were sent unencoded by older clients.
 */
export function decodeAppContext(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export interface TranscriptionPipelineInput {
  /** 16 kHz mono PCM16 WAV (dictation: as received; import: post-decode). */
  audio: Uint8Array;
  audioDurationMs: number;
  /** Percent-decoded `x-app-context` (see `decodeAppContext`). */
  appContext: string | null;
  /** Raw `x-dictation-language` header value. */
  languageOverride: string | undefined;
  /** Dictation honors the header; import always passes `false`. */
  skipPostProcess: boolean;
  /** `Date.now()` at request start, so `durationMs` matches today's route. */
  start: number;
}

export interface TranscribeSuccessBody {
  raw: string;
  cleaned: string;
  model: string;
  provider_category?: ReturnType<typeof voiceProviderCategory>;
  durationMs: number;
  audioDurationMs?: number;
  llmModel?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
}

export type TranscriptionPipelineResult =
  | { ok: true; status: 200; body: TranscribeSuccessBody }
  | {
      ok: false;
      status: 400 | 500;
      body: { error: string; detail?: string };
    };

export async function runTranscriptionPipeline(
  input: TranscriptionPipelineInput,
): Promise<TranscriptionPipelineResult> {
  const { audio: audioData, audioDurationMs, skipPostProcess, start } = input;

  const appContext = resolveAppContextForCleanup(input.appContext);

  const defaults = getDefaultModels();
  if (!defaults.voice) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "No voice model configured. Go to Settings > Models to add one.",
      },
    };
  }

  let rawText: string;
  const languages = getLanguagesSetting();

  const voiceProvider = defaults.voice.provider;
  const voiceModel = defaults.voice.model_id;

  // A language-hotkey dictation pins the request to one language, overriding
  // languages[0] and auto-detect alike. `languages` is already normalized
  // lowercase (normalizeLanguageList, cloud-config.ts), so match case here
  // rather than assuming the header arrives pre-normalized.
  const languageOverride = input.languageOverride?.trim().toLowerCase();
  const effectiveLanguages = resolveLanguageOverride(
    languageOverride,
    languages,
  );
  const primaryLanguage = effectiveLanguages[0];

  const provider = getProvider(voiceProvider);
  if (!provider) {
    return {
      ok: false,
      status: 400,
      body: { error: `Unsupported transcription provider: ${voiceProvider}` },
    };
  }

  const apiKey = getApiKeyForProvider(voiceProvider);
  if (!apiKey) {
    return {
      ok: false,
      status: 400,
      body: { error: `No API key configured for provider: ${voiceProvider}` },
    };
  }

  try {
    const bias = resolveAsrVocabularyBias(voiceProvider, voiceModel);
    log.debug(`bias=${JSON.stringify(bias)}`);
    log.debug(
      `languages=${JSON.stringify(languages)} override=${languageOverride ?? "none"} effective=${JSON.stringify(effectiveLanguages)}`,
    );
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

    // The same vocabulary bias prompt sent above can come back echoed as
    // fake speech instead of a real transcription (specs/meeting-
    // transcription-quality.md Phase A, extended here to dictation — the
    // meeting pipeline already had this guard, dictation didn't). Compare
    // against the terms actually sent for *this* bias, not a fresh DB read.
    const strippedRawText = stripVocabLeak(rawText, vocabularyBiasTerms(bias));
    if (strippedRawText !== rawText) {
      log.info(
        strippedRawText.trim()
          ? "stripped a vocabulary-prompt echo from dictation output (partial leak)"
          : "dropped dictation output — entirely a vocabulary-prompt echo",
      );
      rawText = strippedRawText;
    }

    log.debug(
      `STT took ${Date.now() - t0}ms | rawText=${JSON.stringify(rawText).slice(0, 120)}`,
    );
  } catch (err) {
    log.error(
      `transcribe failed (${voiceProvider}/${voiceModel}): ${formatError(err)}`,
    );
    return {
      ok: false,
      status: 500,
      body: {
        error: "Transcription failed",
        detail: err instanceof Error ? err.message : String(err),
      },
    };
  }

  const durationMs = Date.now() - start;

  if (!rawText.trim()) {
    return {
      ok: true,
      status: 200,
      body: {
        raw: "",
        cleaned: "",
        model: voiceModel,
        durationMs,
        audioDurationMs,
      },
    };
  }

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

    return {
      ok: true,
      status: 200,
      body: {
        raw: rawText,
        cleaned: rawText,
        model: voiceModel,
        provider_category: voiceProviderCategory(voiceProvider),
        durationMs,
      },
    };
  }

  const ppStart = Date.now();
  const pp = await postProcess(rawText, appContext, {
    languages: effectiveLanguages,
    source: "batch",
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

  return {
    ok: true,
    status: 200,
    body: {
      raw: rawText,
      cleaned: pp.cleaned,
      model: voiceModel,
      provider_category: voiceProviderCategory(voiceProvider),
      durationMs: totalDurationMs,
      audioDurationMs,
      llmModel: pp.llmModel,
      inputTokens: pp.inputTokens,
      outputTokens: pp.outputTokens,
      costUsd: pp.costUsd,
    },
  };
}
