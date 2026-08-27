/**
 * Shared default chat-LLM call wiring for meeting features that need one
 * (`summarize.ts`, `enhance.ts`): resolve the app's default chat model
 * through the LLM registry and run the prompt through the `@openstyle/stt`
 * post-process wrapper. Imports are dynamic so injecting an alternate call
 * (tests) never touches the database or provider SDKs.
 *
 * Extracted from `summarize.ts`'s original `defaultLlmCall`
 * (specs/meeting-transcription-quality.md §6.3) — same wiring, reused by
 * Enhance instead of duplicated a second time.
 */

import type { PostProcessParams } from "@openstyle/stt";
import { postProcess } from "@openstyle/stt";
import type { LlmTaskId } from "@openstyle/validations";

/**
 * Rough token estimate (~4 chars/token), mirroring `@openstyle/stt`
 * tokens.ts. Shared by every meeting feature that chunks a transcript to a
 * token budget (`summarize.ts`, `enhance.ts`).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** One chat-completion request issued through the default model. */
export interface ChatCallRequest {
  system: string;
  prompt: string;
  maxOutputTokens: number;
  /** Which task profile (specs/llm-task-profiles.md §3) this call resolves
   *  through — Summarize and Enhance are the only two meeting features that
   *  share this helper. */
  taskId: Extract<LlmTaskId, "meetingSummarize" | "meetingEnhance">;
}

/** What a chat call returns. Token fields are 0 when unknown. */
export interface ChatCallResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** Provider/model that actually served the call, when known. */
  provider?: string | null;
  model?: string | null;
  /** Per-token USD pricing, when the callable can resolve it. */
  pricing?: { input: number; output: number } | null;
}

/**
 * Resolve the app's default chat model and run one prompt through it. The
 * `@openstyle/stt` wrapper never throws on its own — it falls back to
 * returning the input text with `model: null` — so a failed call is
 * indistinguishable from an echoed transcript unless this function turns
 * that fallback into a thrown error, which it does.
 */
export async function resolveDefaultChatCall(
  request: ChatCallRequest,
): Promise<ChatCallResponse> {
  const [{ createChatModel }, { getLlmProvider }, { resolveTaskCall }] =
    await Promise.all([
      import("../providers.js"),
      import("../llm/registry.js"),
      import("../llm/task-profiles.js"),
    ]);
  const resolved = await resolveTaskCall(request.taskId, {
    // A no-op against meetingSummarize's flat profile budget (§3.2); this is
    // what makes meetingEnhance's per-chunk number reach the wire.
    autoMaxOutputTokens: request.maxOutputTokens,
  });
  const model = await createChatModel(resolved.provider, resolved.modelId, {
    task: request.taskId,
    sampling: resolved.samplingParams,
  });
  const providerOptions = getLlmProvider(resolved.provider)?.providerOptions?.(
    resolved.modelId,
    resolved.reasoningEnabled,
  ) as PostProcessParams["providerOptions"];

  let callError: unknown = null;
  const result = await postProcess({
    model,
    text: request.prompt,
    system: request.system,
    prompt: request.prompt,
    temperature: resolved.temperature,
    maxOutputTokens: resolved.maxOutputTokens,
    skipEmptyText: false,
    ...(providerOptions ? { providerOptions } : {}),
    signal: AbortSignal.timeout(resolved.timeoutMs),
    onError: (err) => {
      callError = err;
    },
  });
  if (result.model === null) {
    throw callError instanceof Error
      ? callError
      : new Error(`Meeting LLM call failed: ${String(callError)}`);
  }

  let pricing: { input: number; output: number } | null = null;
  try {
    const { getModelCostCached } = await import("../../routes/models.js");
    pricing = getModelCostCached(resolved.provider, resolved.modelId);
  } catch {
    // Cost is best-effort; a missing registry just reports null cost.
  }

  return {
    text: result.cleaned,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    provider: resolved.provider,
    model: resolved.modelId,
    pricing,
  };
}
