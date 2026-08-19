import {
  postProcess as cleanupWithModel,
  sanitizeTranscriptText,
} from "@freestyle-voice/stt";
import { createAppLogger } from "@freestyle-voice/utils";
import type {
  CleanupAppAssignment,
  CleanupEmailTone,
  CleanupIntensity,
  CleanupOverallTone,
  CleanupPersonalTone,
  CleanupWorkTone,
} from "@freestyle-voice/validations";
import {
  areAllCleanupTonesOff,
  parseCleanupAppAssignments,
  parseCleanupEmailTone,
  parseCleanupIntensity,
  parseCleanupOverallTone,
  parseCleanupPersonalTone,
  parseCleanupWorkTone,
} from "@freestyle-voice/validations";
import type { HookApi } from "freestyle-voice";
import {
  getModelCostCached,
  isCleanupModelSupported,
} from "../routes/models.js";
import { getDb, readSetting, readSettings } from "./db.js";
import { applyDictionaryReplacements } from "./dictionary-replacements.js";
import { buildRewritePrompt } from "./editor/prompts.js";
import { getRewritePromptContext } from "./editor/rewrite-context.js";
import { getLlmProvider } from "./llm/registry.js";
import {
  FreestyleEventType,
  PipelineStage,
  parseAppContext,
  plugins,
} from "./plugins/index.js";
import { createHookApi } from "./plugins/pipeline.js";
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
  /**
   * Reuse a {@link HookApi} built earlier in this dictation's pipeline (e.g. by
   * `/api/transcribe`, so `api.control` carries state from `afterTranscribe`
   * into `beforeCleanup`/`afterCleanup`). A fresh one is built when omitted.
   */
  api?: HookApi;
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
 * whether cleanup ran. Applies the user's dictionary replacements, then runs
 * the `afterCleanup` plugin hook (each plugin sees the previous plugin's
 * output).
 *
 * Kept separate from {@link postProcess} so callers can apply it to text that
 * is already cleaned.
 *
 * Dictionary replacement is skipped for empty text (nothing to replace), but
 * the `afterCleanup` hook always fires so plugins observe a consistent
 * lifecycle. When `rawForCleanedEvent` is provided, a single `Cleaned` event is
 * emitted whenever the final text differs from it.
 */
export async function applyFinalRewrites(
  text: string,
  appContext: string | null,
  rawForCleanedEvent?: string,
  api?: HookApi,
): Promise<string> {
  const effectiveAppContext = resolveAppContextForCleanup(appContext);
  const hookApi = api ?? (await createHookApi());
  let out = text;
  if (out.trim()) {
    out = applyDictionaryReplacements(out, getDb());
  }

  out = (
    await plugins().run(
      "afterCleanup",
      { appContext: parseAppContext(effectiveAppContext) },
      { text: out },
      hookApi,
    )
  ).text;

  if (rawForCleanedEvent !== undefined && out !== rawForCleanedEvent) {
    void plugins().emit({
      type: FreestyleEventType.Cleaned,
      before: rawForCleanedEvent,
      after: out,
    });
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
  const parsedContext = parseAppContext(effectiveAppContext);
  const defaults = getDefaultModels();
  const api = options.api ?? (await createHookApi());
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

  // A plugin already consumed/aborted the pipeline in an earlier stage (e.g.
  // `afterTranscribe`) — skip cleanup entirely rather than spending an LLM
  // call on text the pipeline has already decided not to deliver.
  if (api.control.state !== "running") {
    cleanedText = normalizedRawText;
  } else if (llm && isLlmCleanupEnabled()) {
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

      // Plugin hook: let plugins override the inferred destination, append
      // extra system-prompt fragments, replace the prompt outright, or skip
      // cleanup entirely. Runs before prompt assembly so overrides actually
      // feed into buildRewritePrompt.
      const promptHook = await plugins().run(
        "beforeCleanup",
        {
          text: normalizedRawText,
          appContext: parsedContext,
          destination: resolvedDestination,
        },
        { system: [] as string[], destination: resolvedDestination },
        api,
      );

      if (promptHook.skip || api.control.state !== "running") {
        // `skip` bypasses cleanup deliberately; a `consume()`/`abort()` in the
        // `beforeCleanup` hook does too — the dictation is already terminal, so
        // spending an LLM call on text the pipeline has decided not to deliver
        // would be wasted (mirrors the cloud branch's early-out above and the
        // documented consume/abort semantics of skipping every later stage).
        cleanedText = normalizedRawText;
      } else {
        const { system, prompt } = buildRewritePrompt(normalizedRawText, {
          languages: options.languages,
          intensity,
          customPrompt,
          destination: promptHook.destination ?? resolvedDestination,
          personalTone,
          personalSurface:
            (promptHook.destination ?? resolvedDestination) === "personal"
              ? personalSurface
              : null,
          workTone,
          emailTone,
          overallTone,
        });
        const pluginSystem =
          promptHook.system.length > 0
            ? system + promptHook.system.map((s) => `\n\n${s}`).join("")
            : system;
        // A plugin can replace the assembled prompt outright while still
        // contributing `system` fragments.
        const finalPrompt = promptHook.prompt ?? prompt;

        handoffMs = Date.now() - handoffStart;

        const chatModel = await createChatModel(llm.provider, llm.model_id);
        let cleanupError: unknown;
        const result = await cleanupWithModel({
          model: chatModel,
          text: normalizedRawText,
          system: pluginSystem,
          prompt: finalPrompt,
          // The empty/filler-only case is already handled above for the whole
          // function (both the cloud and local-model branches), so this call
          // is guaranteed non-empty text — disable the package's own internal
          // check rather than relying on two independently-maintained filler
          // regexes staying in sync.
          skipEmptyText: false,
          providerOptions: getLlmProvider(llm.provider)?.providerOptions?.(
            llm.model_id,
          ),
          onError: (err) => {
            cleanupError = err;
          },
        });

        if (result.model) {
          inputTokens = result.inputTokens;
          outputTokens = result.outputTokens;
          llmProvider = llm.provider;
          // Record the configured model id (e.g. `groq/qwen/qwen3-32b`), not
          // the AI SDK's prefix-stripped `result.model` (`qwen/qwen3-32b`), so
          // the persisted history label stays consistent with pre-migration
          // rows.
          llmModel = llm.model_id;
          cleanedText = result.cleaned;
        } else {
          const err = cleanupError;
          void plugins().emit({
            type: FreestyleEventType.PipelineError,
            stage: PipelineStage.Cleanup,
            message: err instanceof Error ? err.message : String(err),
          });
          log.error(`LLM cleanup failed: ${err}`);
          cleanedText = result.cleaned;
        }
      }
    }
  }

  const llmMs = Date.now() - llmStart;
  // Dictionary replacement + `afterCleanup` plugin hook + `Cleaned` event. Runs
  // on the full raw -> final transformation for this dictation.
  cleanedText = await applyFinalRewrites(
    cleanedText,
    appContext,
    normalizedRawText,
    api,
  );

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
