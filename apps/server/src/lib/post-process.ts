import {
  postProcess as cleanupWithModel,
  maxOutputTokensForCleanup,
  sanitizeTranscriptText,
} from "@openstyle/stt";
import { createAppLogger, errorMessage } from "@openstyle/utils";
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
import type { LanguageModel } from "ai";
import { getDb, readSetting, readSettings } from "./db.js";
import {
  type LlmStage,
  runDictationPipeline,
  type StageLlm,
} from "./dictation/pipeline.js";
import type { StagePrompt } from "./dictation/prompts.js";
import {
  type DictationCall,
  recordDictationCalls,
} from "./dictation/record.js";
import { applyDictionaryReplacements } from "./dictionary-replacements.js";
import { buildRewritePrompt, resolveToneStage } from "./editor/prompts.js";
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

/**
 * The answer budget of one piece of a dictation that does not fit the
 * window. A piece must also end inside the cleanup timeout (20 s, task
 * profile `cleanup`): Gemma 4 E2B writes about 144 tokens/s
 * (specs/llm-runtime-tuning.md 4.1), so 2048 tokens take about 14 s.
 */
const CLEANUP_PIECE_MAX_OUTPUT_TOKENS = 2048;

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

/** The started cleanup model of one dictation and its guarded calls. */
interface CleanupSession {
  provider: string;
  modelId: string;
  /**
   * One stage call with the context guard. `build` makes the prompt of a
   * text. A cleanup text that does not fit is cut into pieces; a polish or
   * tone text that does not fit is not sent (the stage keeps its input).
   */
  clean(
    stage: LlmStage,
    text: string,
    build: (text: string) => StagePrompt,
  ): Promise<CleanupOutcome>;
  stageLlm: StageLlm;
}

/**
 * Start the cleanup model. null when it does not start: the person then gets
 * the raw text (an engine problem, #341). Every call is pushed to `calls`.
 */
async function startCleanupSession(
  rawText: string,
  calls: DictationCall[],
): Promise<CleanupSession | null> {
  const resolved = await resolveTaskCall("cleanup", {
    autoMaxOutputTokens: maxOutputTokensForCleanup(rawText),
  });
  const chatModel = await createChatModel(resolved.provider, resolved.modelId, {
    task: "cleanup",
    sampling: resolved.samplingParams,
  }).catch((err: unknown) => {
    log.warn(
      `LLM cleanup skipped: the model ${resolved.modelId} did not start; the raw text is kept: ${errorMessage(err)}`,
    );
    return null;
  });
  if (!chatModel) return null;

  // The polish and tone stages send no prefix cache header, so the worker
  // keeps the cached cleanup prefix (specs/dictation-pipeline.md 4.6).
  let plainModel: Promise<LanguageModel | null> | null = null;
  const modelFor = (stage: LlmStage): Promise<LanguageModel | null> => {
    if (stage === "cleanup") return Promise.resolve(chatModel);
    plainModel ??= createChatModel(resolved.provider, resolved.modelId, {
      task: "cleanup",
      sampling: resolved.samplingParams,
      prefixCache: false,
    }).catch((err: unknown) => {
      log.warn(`the ${stage} stage model did not start: ${errorMessage(err)}`);
      return null;
    });
    return plainModel;
  };

  /** One call. It never throws: a fault gives the input text. */
  const cleanOne = async (
    stage: LlmStage,
    text: string,
    call: StagePrompt & { resolved: ResolvedTaskCall },
  ): Promise<CleanupOutcome> => {
    const model = await modelFor(stage);
    if (!model) {
      return {
        cleaned: text,
        model: null,
        inputTokens: 0,
        outputTokens: 0,
        error: new Error("no model"),
      };
    }
    let error: unknown;
    const startedAt = Date.now();
    // Every dictation stage is the `interactive` class (§5.4), the most
    // latency-sensitive LLM call in the app. The lane is held for the one
    // `generateText` inside `cleanupWithModel` and released before the
    // bookkeeping, so a failed call never leaves the lane occupied.
    const result = await withLlmLane(
      call.resolved.provider,
      call.resolved.modelId,
      { cls: "interactive", taskId: "cleanup" },
      () =>
        cleanupWithModel({
          model,
          text,
          system: call.system,
          prompt: call.prompt,
          temperature: call.resolved.temperature,
          topP: call.resolved.topP,
          maxOutputTokens: call.resolved.maxOutputTokens,
          // The empty/filler-only case is handled once in postProcess.
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
    calls.push({
      stage,
      provider: call.resolved.provider,
      modelId: call.resolved.modelId,
      system: call.system,
      prompt: call.prompt,
      temperature: call.resolved.temperature,
      maxOutputTokens: call.resolved.maxOutputTokens,
      text: result.model ? result.cleaned : null,
      error: result.model ? null : error ? errorMessage(error) : "no answer",
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      startedAt,
      finishedAt: Date.now(),
    });
    return { ...result, error };
  };

  const resolveFor = (text: string) =>
    resolveTaskCall("cleanup", {
      autoMaxOutputTokens: maxOutputTokensForCleanup(text),
    });

  const contextWindow = contextWindowFor(resolved.provider, resolved.modelId);
  const fitsCall = (call: StagePrompt, maxOutputTokens: number) =>
    fitsWindow(
      estimateCallTokens({
        instructions: call.system,
        messages: [{ content: call.prompt }],
      }),
      maxOutputTokens,
      contextWindow,
    );

  const clean: CleanupSession["clean"] = async (stage, text, build) => {
    /** Clean each piece with its own prompt and answer budget, in order. */
    const cleanPieces = async (pieces: string[]): Promise<CleanupOutcome> => {
      const out: CleanupOutcome[] = [];
      for (const [i, piece] of pieces.entries()) {
        const r = await cleanOne(stage, piece, {
          ...build(piece),
          resolved: await resolveFor(piece),
        });
        if (!r.model) {
          log.warn(
            `cleanup piece ${i + 1} of ${pieces.length} failed; its raw text is kept: ${r.error instanceof Error ? r.error.message.slice(0, 200) : String(r.error)}`,
          );
        }
        out.push(r);
      }
      return joinCleanedPieces(pieces, out);
    };

    // The context guard (specs/llm-runtime-tuning.md 9 item 5). A text that
    // fits is sent as one call. A longer cleanup text is cut into pieces that
    // fit the window and whose answer budget is at most
    // CLEANUP_PIECE_MAX_OUTPUT_TOKENS, so each answer can end in time. The
    // person gets cleaned text, never an error.
    const call = build(text);
    const callResolved = await resolveFor(text);
    if (fitsCall(call, callResolved.maxOutputTokens)) {
      const result = await cleanOne(stage, text, {
        ...call,
        resolved: callResolved,
      });
      if (
        stage === "cleanup" &&
        !result.model &&
        isInputOverflow(result.error)
      ) {
        // The model refused the call: the estimate was too low. Cut the text
        // in two near the middle and try once more.
        const limit = Math.ceil(estimatePromptTokens(text) * 0.55);
        const pieces = splitTextToFit(
          text,
          (p) => estimatePromptTokens(p) <= limit,
        );
        log.error(
          `context exceeded: the model refused the cleanup (${text.length} chars); one more try in ${pieces.length} pieces`,
        );
        return cleanPieces(pieces);
      }
      return result;
    }
    if (stage !== "cleanup") {
      log.warn(
        `context guard: the ${stage} stage text (${text.length} chars) does not fit the window (${contextWindow} tokens); the stage is skipped`,
      );
      return {
        cleaned: text,
        model: null,
        inputTokens: 0,
        outputTokens: 0,
        error: new Error("does not fit"),
      };
    }
    // The answer budget of a piece: the "auto" value of the cleanup task for
    // the piece, and at least the preset floor (task-profiles.ts).
    const floor = (await resolveTaskCall("cleanup", { autoMaxOutputTokens: 1 }))
      .maxOutputTokens;
    const pieceFits = (p: string) =>
      maxOutputTokensForCleanup(p) <= CLEANUP_PIECE_MAX_OUTPUT_TOKENS &&
      fitsCall(build(p), Math.max(floor, maxOutputTokensForCleanup(p)));
    if (pieceFits("")) {
      const pieces = splitTextToFit(text, pieceFits);
      log.warn(
        `context guard: cleanup of ${text.length} chars does not fit the window (${contextWindow} tokens); split into ${pieces.length} pieces`,
      );
      return cleanPieces(pieces);
    }
    // Even an empty text does not fit: the system prompt and the answer floor
    // fill the window. A split cannot help. Send the text as one call; a
    // refusal gives the input text.
    log.error(
      `context guard: the cleanup prompt alone does not fit the window (${contextWindow} tokens); sent as one call`,
    );
    return cleanOne(stage, text, { ...call, resolved: callResolved });
  };

  return {
    provider: resolved.provider,
    // Record the resolved model id (e.g. `groq/qwen/qwen3-32b`), not the AI
    // SDK's prefix-stripped `result.model`, so the history label stays
    // consistent with older rows.
    modelId: resolved.modelId,
    clean,
    stageLlm: async (call) => {
      const r = await clean(call.stage, call.input, call.build);
      return { text: r.model ? r.cleaned : null };
    },
  };
}

/**
 * Clean one dictation and apply the dictionary.
 *
 * Low, medium and high run the staged pipeline (specs/dictation-pipeline.md):
 * code stages, one short cleanup call per part (medium, high), polish (high)
 * and tone (tone on). Custom keeps one call with the user's prompt. It never
 * throws: a fault gives the stage input, a model that does not start gives
 * the raw text.
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
  const calls: DictationCall[] = [];

  if (llm && isLlmCleanupEnabled()) {
    const tones = getEffectiveCleanupTones();
    const toneOptions = {
      destination: resolvedDestination,
      personalTone: tones.personalTone,
      personalSurface:
        resolvedDestination === "personal" ? personalSurface : null,
      workTone: tones.workTone,
      emailTone: tones.emailTone,
      overallTone: tones.overallTone,
    };
    const intensity = tones.intensity;
    // Low intensity is code only: no LLM call at all, also with a tone on
    // (owner decision 2026-10-26, specs/dictation-pipeline.md 4.4).
    let session: CleanupSession | null = null;
    let modelReady = intensity === "low";
    if (intensity !== "low") {
      if (!(await isCleanupModelSupported(llm.provider, llm.model_id))) {
        log.warn(
          `Skipping LLM cleanup: unsupported cleanup model ${llm.provider}/${llm.model_id}`,
        );
      } else {
        handoffMs = Date.now() - handoffStart;
        session = await startCleanupSession(normalizedRawText, calls);
        modelReady = session !== null;
      }
    }

    if (intensity === "custom") {
      // The user's Custom prompt keeps one call: their prompt, the tone
      // block and the language block (editor/prompts.ts).
      if (session) {
        const promptOptions = {
          languages: options.languages,
          intensity,
          customPrompt: tones.customPrompt,
          ...toneOptions,
        };
        const result = await session.clean("cleanup", normalizedRawText, (t) =>
          buildRewritePrompt(t, promptOptions),
        );
        if (!result.model) log.error(`LLM cleanup failed: ${result.error}`);
        cleanedText = result.cleaned;
      }
    } else if (modelReady) {
      // A model that does not start keeps the raw text (#341).
      const pipeline = await runDictationPipeline(
        {
          raw: normalizedRawText,
          intensity,
          tone: intensity === "low" ? null : resolveToneStage(toneOptions),
          languages: options.languages ?? [],
        },
        session ? session.stageLlm : null,
      );
      cleanedText = pipeline.text;
      const fallbacks = pipeline.stages.filter((st) => st.fellBack);
      if (fallbacks.length > 0) {
        log.warn(
          `dictation stages kept their input: ${fallbacks.map((st) => `${st.stage} (${st.fellBack?.join(", ")})`).join("; ")}`,
        );
      }
    }
    if (session && calls.some((c) => c.text !== null)) {
      llmProvider = session.provider;
      llmModel = session.modelId;
      for (const c of calls) {
        inputTokens += c.inputTokens;
        outputTokens += c.outputTokens;
      }
    }
  }
  if (calls.length > 0) recordDictationCalls(getDb(), calls);

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
