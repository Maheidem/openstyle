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
import { withLlmLane } from "../llm/lane.js";
import { getModelCostCached } from "../model-registry.js";

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
  /** Cancel seam threaded from the meeting job (`activeJobCancellations`).
   *  A call cancelled while QUEUED never fires (spec §5.7). */
  shouldStop?: () => boolean;
  /** Queued-progress seam, threaded to the job blob for the UI. */
  onQueued?: (info: { waitedMs: number; ahead: number }) => void;
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

/** The part of a chat request a meeting feature builds itself. */
export type ChatCallInput = Omit<
  ChatCallRequest,
  "taskId" | "shouldStop" | "onQueued"
>;

/**
 * Build the default call function for one task id. Summarize and Enhance
 * both use it, so they share one place that threads the cancel and queue
 * seams. Callers that inject their own `llmCall` (tests) never reach it,
 * so they never touch the database or provider SDKs.
 */
export function defaultChatCallFor<TInput extends ChatCallInput>(
  taskId: ChatCallRequest["taskId"],
  seams: Pick<ChatCallRequest, "shouldStop" | "onQueued">,
): (request: TInput) => Promise<ChatCallResponse> {
  return (request) =>
    resolveDefaultChatCall({
      ...request,
      taskId,
      // Cancel + queue-progress seams (§5.5/§5.7), threaded from the job so a
      // cancel landing while a call is still QUEUED stops it before the
      // request ever goes out.
      ...(seams.shouldStop ? { shouldStop: seams.shouldStop } : {}),
      ...(seams.onQueued ? { onQueued: seams.onQueued } : {}),
    });
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
  // Per-CALL lane (§5.2/§5.4): Summarize and Enhance are `background`, so a
  // map/reduce run of N chunks takes and frees N separate slots and an
  // interactive dictation cleanup gets every gap between them. Held across
  // `postProcess` only — never across the meeting, the chunk loop, or the
  // job. The lease is acquired before the model is even resolved, because the
  // resolution is what names the endpoint (§5.1: the lane IS the endpoint).
  // `withLlmLane` frees the slot before the `result.model === null` check
  // below, so a failed call never leaves the lane occupied. That is the
  // difference between a dead engine stalling one call and a dead engine
  // stalling every call.
  const result = await withLlmLane(
    resolved.provider,
    {
      cls: "background",
      taskId: request.taskId,
      ...(request.shouldStop ? { shouldStop: request.shouldStop } : {}),
      ...(request.onQueued ? { onQueued: request.onQueued } : {}),
    },
    () =>
      postProcess({
        model,
        text: request.prompt,
        system: request.system,
        prompt: request.prompt,
        temperature: resolved.temperature,
        topP: resolved.topP,
        maxOutputTokens: resolved.maxOutputTokens,
        skipEmptyText: false,
        ...(providerOptions ? { providerOptions } : {}),
        // Non-streaming call, so this window has to cover the entire generation.
        // For `meetingSummarize` it is the user-settable
        // `meeting_summary_timeout_seconds` (default 600 s), resolved fresh in
        // `task-profiles.ts` -> `taskTimeoutMs()`; `meetingEnhance` keeps its
        // user-settable `meeting_enhance_timeout_seconds` (default 600 s) for
        // the same reason — a non-streaming generation on one local worker slot
        // cannot be bounded by a 60 s guess. Seconds -> ms happens there, once.
        signal: AbortSignal.timeout(resolved.timeoutMs),
        onError: (err) => {
          callError = err;
        },
      }),
  );
  if (result.model === null) {
    throw callError instanceof Error
      ? callError
      : new Error(`Meeting LLM call failed: ${String(callError)}`);
  }

  let pricing: { input: number; output: number } | null = null;
  try {
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
