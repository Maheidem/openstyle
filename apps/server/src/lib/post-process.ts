import {
  postProcess as cleanupWithModel,
  maxOutputTokensForCleanup,
  sanitizeTranscriptText,
} from "@openstyle/stt";
import { createAppLogger } from "@openstyle/utils";
import type {
  CleanupAppAssignment,
  CleanupEmailTone,
  CleanupIntensity,
  CleanupOverallTone,
  CleanupPersonalTone,
  CleanupWorkTone,
} from "@openstyle/validations";
import {
  areAllCleanupTonesOff,
  parseCleanupAppAssignments,
  parseCleanupEmailTone,
  parseCleanupIntensity,
  parseCleanupOverallTone,
  parseCleanupPersonalTone,
  parseCleanupWorkTone,
} from "@openstyle/validations";
import {
  getModelCostCached,
  isCleanupModelSupported,
} from "../routes/models.js";
import { getDb, readSetting, readSettings } from "./db.js";
import { applyDictionaryReplacements } from "./dictionary-replacements.js";
import { buildRewritePrompt } from "./editor/prompts.js";
import { getRewritePromptContext } from "./editor/rewrite-context.js";
import { getLlmProvider } from "./llm/registry.js";
import { resolveTaskCall } from "./llm/task-profiles.js";
import { createChatModel, getDefaultModels } from "./providers.js";

const log = createAppLogger("post-process");

export interface PostProcessTimings {
  handoffMs: number;
  llmMs: number;
}

export interface PostProcessResult {
  cleaned: string;
  llmProvider: string | null;
  llmModel: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  timings?: PostProcessTimings;
  /** The resolved tone routing destination. */
  destination?: string;
}

export type PostProcessSource =
  | "batch"
  | "multi_segment"
  | "streaming"
  | "streaming_handoff";

export interface PostProcessOptions {
  source?: PostProcessSource;
  languages?: string[];
  /** Return handoff/llm timing breakdown for pipeline logs. */
  includeTimings?: boolean;
}

export function isLlmCleanupEnabled(): boolean {
  return readSetting("llm_cleanup") === "true";
}

export function getCleanupAppAssignments(): CleanupAppAssignment[] {
  return parseCleanupAppAssignments(readSetting("cleanup_app_assignments"));
}

export interface EffectiveCleanupTones {
  intensity: CleanupIntensity;
  customPrompt: string | undefined;
  personalTone: CleanupPersonalTone;
  workTone: CleanupWorkTone;
  emailTone: CleanupEmailTone;
  overallTone: CleanupOverallTone;
}

/**
 * Resolve the cleanup strength + per-sector tones applied to a dictation.
 */
export function getEffectiveCleanupTones(): EffectiveCleanupTones {
  // Single batched read instead of six separate point-queries — this runs on
  // the transcription/streaming hot path (both `/api/transcribe` and the
  // streaming config-key build call it per dictation).
  const s = readSettings([
    "cleanup_intensity",
    "cleanup_custom_prompt",
    "cleanup_personal_tone",
    "cleanup_work_tone",
    "cleanup_email_tone",
    "cleanup_overall_tone",
  ]);
  return {
    intensity: parseCleanupIntensity(s.get("cleanup_intensity")),
    customPrompt: s.get("cleanup_custom_prompt"),
    personalTone: parseCleanupPersonalTone(s.get("cleanup_personal_tone")),
    workTone: parseCleanupWorkTone(s.get("cleanup_work_tone")),
    emailTone: parseCleanupEmailTone(s.get("cleanup_email_tone")),
    overallTone: parseCleanupOverallTone(s.get("cleanup_overall_tone")),
  };
}

/** App context is only needed when cleanup is on and at least one sector tone is active. */
export function needsAppContextForCleanup(): boolean {
  if (!isLlmCleanupEnabled()) return false;
  return !areAllCleanupTonesOff(getEffectiveCleanupTones());
}

export function resolveAppContextForCleanup(
  appContext: string | null,
): string | null {
  return needsAppContextForCleanup() ? appContext : null;
}

/** Warm the default cleanup model while the user is still speaking. */
export function prewarmPostProcess(): void {
  const defaults = getDefaultModels();
  const llm = defaults.llm;
  if (!llm || !isLlmCleanupEnabled()) return;

  getLlmProvider(llm.provider)?.prewarm?.(llm.model_id);
}

/**
 * Final text-rewrite stage that must run on every dictation regardless of
 * whether cleanup ran. Applies the user's dictionary replacements.
 *
 * Kept separate from {@link postProcess} so callers can apply it to text that
 * is already cleaned. Dictionary replacement is skipped for empty text
 * (nothing to replace).
 */
export async function applyFinalRewrites(
  text: string,
  _appContext: string | null,
): Promise<string> {
  let out = text;
  if (out.trim()) {
    out = applyDictionaryReplacements(out, getDb());
  }
  return out;
}

/**
 * Run LLM cleanup and dictionary replacements on transcribed text.
 * Returns the cleaned text plus metadata for history tracking.
 */
export async function postProcess(
  rawText: string,
  appContext: string | null,
  options: PostProcessOptions = {},
): Promise<PostProcessResult> {
  const normalizedRawText = sanitizeTranscriptText(rawText);
  const effectiveAppContext = resolveAppContextForCleanup(appContext);
  const defaults = getDefaultModels();
  let inputTokens = 0;
  let outputTokens = 0;
  let llmProvider: string | null = null;
  let llmModel: string | null = null;
  let costUsd = 0;
  // Resolve tone-routing destination once here so every branch (local-LLM,
  // no-cleanup) can report it.
  const { destination: resolvedDestination } = getRewritePromptContext(
    effectiveAppContext,
    getCleanupAppAssignments(),
  );

  const stripped = normalizedRawText
    .replace(/\b(um+|uh+|ah+|er+|hm+|hmm+|mm+|mhm+|you know|i mean)\b/gi, "")
    .replace(/[.…,!?\-–—\s]+/g, "");
  if (!stripped) {
    return {
      cleaned: "",
      llmProvider: null,
      llmModel: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
  }

  let cleanedText = normalizedRawText;
  const handoffStart = Date.now();
  const llm = defaults.llm;
  const llmStart = Date.now();
  let handoffMs = 0;

  if (llm && isLlmCleanupEnabled()) {
    // Resolved cleanup config for the cleanup-model path.
    const {
      intensity,
      customPrompt,
      personalTone,
      workTone,
      emailTone,
      overallTone,
    } = getEffectiveCleanupTones();

    if (!(await isCleanupModelSupported(llm.provider, llm.model_id))) {
      log.warn(
        `Skipping LLM cleanup: unsupported cleanup model ${llm.provider}/${llm.model_id}`,
      );
    } else {
      const { personalSurface } = getRewritePromptContext(
        effectiveAppContext,
        getCleanupAppAssignments(),
      );

      const { system, prompt } = buildRewritePrompt(normalizedRawText, {
        languages: options.languages,
        intensity,
        customPrompt,
        destination: resolvedDestination,
        personalTone,
        personalSurface:
          resolvedDestination === "personal" ? personalSurface : null,
        workTone,
        emailTone,
        overallTone,
      });

      handoffMs = Date.now() - handoffStart;

      const resolved = await resolveTaskCall("cleanup", {
        autoMaxOutputTokens: maxOutputTokensForCleanup(normalizedRawText),
      });
      const chatModel = await createChatModel(
        resolved.provider,
        resolved.modelId,
        { task: "cleanup", sampling: resolved.samplingParams },
      );
      let cleanupError: unknown;
      const result = await cleanupWithModel({
        model: chatModel,
        text: normalizedRawText,
        system,
        prompt,
        temperature: resolved.temperature,
        maxOutputTokens: resolved.maxOutputTokens,
        // The empty/filler-only case is already handled above for the whole
        // function (both the cloud and local-model branches), so this call
        // is guaranteed non-empty text — disable the package's own internal
        // check rather than relying on two independently-maintained filler
        // regexes staying in sync.
        skipEmptyText: false,
        providerOptions: getLlmProvider(resolved.provider)?.providerOptions?.(
          resolved.modelId,
          resolved.reasoningEnabled,
        ),
        signal: AbortSignal.timeout(resolved.timeoutMs),
        onError: (err) => {
          cleanupError = err;
        },
      });

      if (result.model) {
        inputTokens = result.inputTokens;
        outputTokens = result.outputTokens;
        llmProvider = resolved.provider;
        // Record the resolved model id (e.g. `groq/qwen/qwen3-32b`), not
        // the AI SDK's prefix-stripped `result.model` (`qwen/qwen3-32b`), so
        // the persisted history label stays consistent with pre-migration
        // rows.
        llmModel = resolved.modelId;
        cleanedText = result.cleaned;
      } else {
        log.error(`LLM cleanup failed: ${cleanupError}`);
        cleanedText = result.cleaned;
      }
    }
  }

  const llmMs = Date.now() - llmStart;
  // Dictionary replacement. Runs on the full raw -> final transformation for
  // this dictation.
  cleanedText = await applyFinalRewrites(cleanedText, appContext);

  if (inputTokens > 0 || outputTokens > 0) {
    if (llmProvider && llmModel) {
      // Cache-only lookup — never blocks the response on a models.dev fetch.
      // The registry is warmed off the hot path by the transcribe pre-warm
      // route; a cold-cache miss simply records cost 0.
      const pricing = getModelCostCached(llmProvider, llmModel);
      if (pricing) {
        costUsd = inputTokens * pricing.input + outputTokens * pricing.output;
      }
    }
  }

  return {
    cleaned: cleanedText,
    llmProvider,
    llmModel,
    inputTokens,
    outputTokens,
    costUsd,
    ...(options.includeTimings ? { timings: { handoffMs, llmMs } } : {}),
    destination: resolvedDestination,
  };
}
