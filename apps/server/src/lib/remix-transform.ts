import {
  maxOutputTokensForCleanup,
  stripWrappingQuotes,
} from "@freestyle-voice/stt";
import { createAppLogger } from "@freestyle-voice/utils";
import { findRemixPreset } from "@freestyle-voice/validations";
import { generateText } from "ai";
import { isCleanupModelSupported } from "../routes/models.js";
import { buildRemixPrompt } from "./editor/remix-prompts.js";
import { getLlmProvider } from "./llm/registry.js";
import { createChatModel, getDefaultModels } from "./providers.js";

const log = createAppLogger("remix");

/** A remix run failed in a way the pill should show the user. */
export class RemixTransformError extends Error {
  constructor(
    message: string,
    /** Distinguishes "you need to set something up" from "it broke". */
    readonly kind: "no-model" | "unsupported-model" | "failed" = "failed",
  ) {
    super(message);
    this.name = "RemixTransformError";
  }
}

export interface RunRemixTransformOptions {
  text: string;
  /** A preset id, when the user picked one off the list. */
  remixId?: string;
  /** What the user said, when they didn't. */
  instruction?: string;
  languages?: string[];
}

export interface RemixTransformResult {
  text: string;
  instruction: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

/**
 * Resolve the edit to perform. A preset id wins over a spoken instruction when
 * both are present (the id can only come from the pill's own list, so it is
 * the more trustworthy of the two), and an unknown id falls back to the spoken
 * text rather than failing — a client shipping a preset this server doesn't
 * know about is a version skew, not a reason to lose the user's remix.
 */
function resolveInstruction(options: RunRemixTransformOptions): string | null {
  if (options.remixId) {
    const preset = findRemixPreset(options.remixId);
    if (preset) return preset.instruction;
  }
  const spoken = options.instruction?.trim();
  return spoken ? spoken : null;
}

/**
 * Run one remix over a text selection and return the replacement text.
 *
 * Unlike dictation cleanup, this never falls back to returning the input
 * unchanged: the caller pastes the result straight over the user's selection,
 * and a silent no-op there is indistinguishable from a remix that decided
 * nothing needed changing. Failures throw so the pill can say so.
 */
export async function runRemixTransform(
  options: RunRemixTransformOptions,
): Promise<RemixTransformResult> {
  const instruction = resolveInstruction(options);
  if (!instruction) {
    throw new RemixTransformError("No remix was given", "failed");
  }

  const llm = getDefaultModels().llm;
  if (!llm) {
    throw new RemixTransformError(
      "No AI model is set up yet. Pick one in Settings > Models.",
      "no-model",
    );
  }

  if (!(await isCleanupModelSupported(llm.provider, llm.model_id))) {
    throw new RemixTransformError(
      `${llm.model_id} can't run remix. Pick a different model in Settings > Models.`,
      "unsupported-model",
    );
  }
  const { system, prompt } = buildRemixPrompt(options.text, {
    instruction,
    languages: options.languages,
  });
  // Called directly rather than through the shared cleanup helper: that one
  // sanitizes transcript artifacts (collapsing a duplicated trailing
  // paragraph, in particular) which would quietly eat a repeated line from a
  // legitimately list-shaped result, and it swallows model errors into a
  // raw-text fallback this path must not take.
  const providerOptions = getLlmProvider(llm.provider)?.providerOptions?.(
    llm.model_id,
  );
  const result = await generateText({
    model: await createChatModel(llm.provider, llm.model_id),
    system,
    prompt,
    temperature: 0,
    // The budget is sized off the input, which is the right shape here too —
    // an edit is roughly as long as what it edits. "Expand" is the exception,
    // and the helper already leaves generous headroom.
    maxOutputTokens: maxOutputTokensForCleanup(options.text),
    ...(providerOptions ? { providerOptions } : {}),
  });
  const usage: RemixTransformResult["usage"] = {
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
  };

  // Models like to hand back a rewrite in quotes even when told not to. The
  // rest of the transcript sanitizer is deliberately not applied here.
  const text = stripWrappingQuotes(result.text);

  if (!text.trim()) {
    throw new RemixTransformError("The model returned nothing", "failed");
  }

  return { text, instruction, usage };
}

/** Shared failure bookkeeping for the route's catch-all. */
export function reportRemixTransformFailure(err: unknown): void {
  log.error(`Remix failed: ${err}`);
}
