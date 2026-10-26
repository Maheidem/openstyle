import {
  postProcess as cleanupWithModel,
  MAX_CLEANUP_OUTPUT_TOKENS,
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
  SETTINGS_KEYS,
} from "@openstyle/validations";
import { getDb, readSetting, readSettings } from "./db.js";
import { applyDictionaryReplacements } from "./dictionary-replacements.js";
import { buildRewritePrompt } from "./editor/prompts.js";
import { getRewritePromptContext } from "./editor/rewrite-context.js";
import { isInputOverflow } from "./llm/gateway-errors.js";
import { withLlmLane } from "./llm/lane.js";
import { getLlmProvider } from "./llm/registry.js";
import { type ResolvedTaskCall, resolveTaskCall } from "./llm/task-profiles.js";
import {
  contextWindowFor,
  estimateCallTokens,
  estimatePromptTokens,
  fitsWindow,
  splitTextToFit,
} from "./llm/token-budget.js";
import {
  getModelCostCached,
  isCleanupModelSupported,
} from "./model-registry.js";
import { createChatModel, getDefaultModels } from "./providers.js";

const log = createAppLogger("post-process");

/** The result of one cleanup call, or of the pieces of one dictation. */
interface CleanupOutcome {
  cleaned: string;
  /** null: no piece was cleaned (every call failed). */
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  /** The last fault, for the log. */
  error: unknown;
}

/**
 * Join the cleaned pieces of one dictation in order. Each raw piece ends with
 * the separator of the cut (`splitTextToFit`). A separator with a line break
 * stays as it is. Other white space becomes one space. A cut with no white
 * space (CJK text) adds nothing. A piece whose call failed gives its raw text.
 */
export function joinCleanedPieces(
  pieces: readonly string[],
  results: readonly CleanupOutcome[],
): CleanupOutcome {
  let cleaned = "";
  let model: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let error: unknown = null;
  pieces.forEach((piece, i) => {
    const r = results[i];
    const text = (r?.cleaned ?? piece).trim();
    const sep = /\s+$/.exec(piece)?.[0] ?? "";
    const glue =
      i === pieces.length - 1 || text === ""
        ? ""
        : sep.includes("\n")
          ? sep
          : sep
            ? " "
            : "";
    cleaned += text + glue;
    if (r?.model) model = r.model;
    inputTokens += r?.inputTokens ?? 0;
    outputTokens += r?.outputTokens ?? 0;
    if (r?.error) error = r.error;
  });
  return { cleaned, model, inputTokens, outputTokens, error };
}

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
    SETTINGS_KEYS.cleanupIntensity,
    SETTINGS_KEYS.cleanupCustomPrompt,
    SETTINGS_KEYS.cleanupPersonalTone,
    SETTINGS_KEYS.cleanupWorkTone,
    SETTINGS_KEYS.cleanupEmailTone,
    SETTINGS_KEYS.cleanupOverallTone,
  ]);
  return {
    intensity: parseCleanupIntensity(s.get(SETTINGS_KEYS.cleanupIntensity)),
    customPrompt: s.get(SETTINGS_KEYS.cleanupCustomPrompt),
    personalTone: parseCleanupPersonalTone(
      s.get(SETTINGS_KEYS.cleanupPersonalTone),
    ),
    workTone: parseCleanupWorkTone(s.get(SETTINGS_KEYS.cleanupWorkTone)),
    emailTone: parseCleanupEmailTone(s.get(SETTINGS_KEYS.cleanupEmailTone)),
    overallTone: parseCleanupOverallTone(
      s.get(SETTINGS_KEYS.cleanupOverallTone),
    ),
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
  // Resolve the tone-routing destination once for the whole call.
  const { destination: resolvedDestination, personalSurface } =
    getRewritePromptContext(effectiveAppContext, getCleanupAppAssignments());

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
      const promptOptions = {
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
      };
      const { system, prompt } = buildRewritePrompt(
        normalizedRawText,
        promptOptions,
      );

      handoffMs = Date.now() - handoffStart;

      const resolved = await resolveTaskCall("cleanup", {
        autoMaxOutputTokens: maxOutputTokensForCleanup(normalizedRawText),
      });
      const chatModel = await createChatModel(
        resolved.provider,
        resolved.modelId,
        { task: "cleanup", sampling: resolved.samplingParams },
      );

      /** One cleanup call. It never throws: a fault gives the raw text. */
      const cleanOne = async (
        text: string,
        call: { system: string; prompt: string; resolved: ResolvedTaskCall },
      ): Promise<CleanupOutcome> => {
        let error: unknown;
        // Dictation cleanup is the `interactive` class (§5.4) — the single most
        // latency-sensitive LLM call in the app, and the reason the lane
        // exists. Acquired per call around the one `generateText` inside
        // `cleanupWithModel`; `withLlmLane` releases it before the
        // `result.model` bookkeeping, so a failed cleanup never leaves the
        // lane occupied. Spec §6 constraint 5: if this ever measurably adds
        // time to the commit -> delivered-text path, the lane is wrong.
        const result = await withLlmLane(
          call.resolved.provider,
          call.resolved.modelId,
          { cls: "interactive", taskId: "cleanup" },
          () =>
            cleanupWithModel({
              model: chatModel,
              text,
              system: call.system,
              prompt: call.prompt,
              temperature: call.resolved.temperature,
              topP: call.resolved.topP,
              maxOutputTokens: call.resolved.maxOutputTokens,
              // The empty/filler-only case is already handled above for the whole
              // function (both the cloud and local-model branches), so this call
              // is guaranteed non-empty text — disable the package's own internal
              // check rather than relying on two independently-maintained filler
              // regexes staying in sync.
              skipEmptyText: false,
              providerOptions: getLlmProvider(
                call.resolved.provider,
              )?.providerOptions?.(
                call.resolved.modelId,
                call.resolved.reasoningEnabled,
              ),
              signal: AbortSignal.timeout(call.resolved.timeoutMs),
              onError: (err) => {
                error = err;
              },
            }),
        );
        return { ...result, error };
      };

      /** Clean each piece with its own prompt and answer budget, in order. */
      const cleanPieces = async (pieces: string[]): Promise<CleanupOutcome> => {
        const out: CleanupOutcome[] = [];
        for (const piece of pieces) {
          const call = buildRewritePrompt(piece, promptOptions);
          const pieceResolved = await resolveTaskCall("cleanup", {
            autoMaxOutputTokens: maxOutputTokensForCleanup(piece),
          });
          out.push(await cleanOne(piece, { ...call, resolved: pieceResolved }));
        }
        return joinCleanedPieces(pieces, out);
      };

      // The context guard (specs/llm-runtime-tuning.md 9 item 5). A text that
      // fits is sent as one call, as before. A longer text is cut into pieces
      // that fit the window and whose answer budget is under the cap, so each
      // answer can end. The person gets cleaned text, never an error.
      const contextWindow = contextWindowFor(
        resolved.provider,
        resolved.modelId,
      );
      const fitsCall = (
        callSystem: string,
        callPrompt: string,
        maxOutputTokens: number,
      ) =>
        fitsWindow(
          estimateCallTokens({
            instructions: callSystem,
            messages: [{ content: callPrompt }],
          }),
          maxOutputTokens,
          contextWindow,
        );
      let result: CleanupOutcome;
      if (fitsCall(system, prompt, resolved.maxOutputTokens)) {
        result = await cleanOne(normalizedRawText, {
          system,
          prompt,
          resolved,
        });
        if (!result.model && isInputOverflow(result.error)) {
          // The model refused the call: the estimate was too low. Cut the
          // text in two near the middle and try once more.
          const limit = Math.ceil(
            estimatePromptTokens(normalizedRawText) * 0.55,
          );
          const pieces = splitTextToFit(
            normalizedRawText,
            (p) => estimatePromptTokens(p) <= limit,
          );
          log.error(
            `context exceeded: the model refused the cleanup (${normalizedRawText.length} chars); one more try in ${pieces.length} pieces`,
          );
          result = await cleanPieces(pieces);
        }
      } else {
        // The answer budget of a piece: the "auto" value of the cleanup task
        // for the piece, and at least the preset floor (task-profiles.ts).
        const floor = (
          await resolveTaskCall("cleanup", { autoMaxOutputTokens: 1 })
        ).maxOutputTokens;
        const pieceFits = (p: string) => {
          const call = buildRewritePrompt(p, promptOptions);
          return (
            maxOutputTokensForCleanup(p) < MAX_CLEANUP_OUTPUT_TOKENS &&
            fitsCall(
              call.system,
              call.prompt,
              Math.max(floor, maxOutputTokensForCleanup(p)),
            )
          );
        };
        if (pieceFits("")) {
          const pieces = splitTextToFit(normalizedRawText, pieceFits);
          log.warn(
            `context guard: cleanup of ${normalizedRawText.length} chars does not fit the window (${contextWindow} tokens); split into ${pieces.length} pieces`,
          );
          result = await cleanPieces(pieces);
        } else {
          // Even an empty text does not fit: the system prompt and the
          // answer floor fill the window. A split cannot help. Send the text
          // as one call; a refusal gives the raw text.
          log.error(
            `context guard: the cleanup prompt alone does not fit the window (${contextWindow} tokens); sent as one call`,
          );
          result = await cleanOne(normalizedRawText, {
            system,
            prompt,
            resolved,
          });
        }
      }

      if (result.model) {
        inputTokens = result.inputTokens;
        outputTokens = result.outputTokens;
        llmProvider = resolved.provider;
        // Record the resolved model id (e.g. `groq/qwen/qwen3-32b`), not
        // the AI SDK's prefix-stripped `result.model` (`qwen/qwen3-32b`), so
        // the persisted history label stays consistent with pre-migration
        // rows.
        llmModel = resolved.modelId;
      } else {
        log.error(`LLM cleanup failed: ${result.error}`);
      }
      cleanedText = result.cleaned;
    }
  }

  const llmMs = Date.now() - llmStart;
  // Dictionary replacement. Runs on the full raw -> final transformation for
  // this dictation, whether or not cleanup ran. Empty text has nothing to
  // replace.
  if (cleanedText.trim()) {
    cleanedText = applyDictionaryReplacements(cleanedText, getDb());
  }

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
  };
}
