/**
 * Meeting summarization: turn a merged, speaker-labeled meeting transcript
 * into a markdown summary (Overview / Key Points / Decisions / Action Items).
 *
 * Short transcripts are summarized in a single LLM call; transcripts over the
 * context budget go through sentence-boundary map-reduce — the transcript is
 * split into chunks at merged-segment boundaries (with a small trailing
 * overlap for continuity), each chunk gets a partial summary (map), and one
 * final call combines the partials (reduce).
 *
 * Model resolution goes through the existing LLM registry (`providers.ts` →
 * `llm/registry.ts`), so it works with every configured provider including
 * the `local-llm` BYO OpenAI-compatible endpoint. Calls run through the
 * prompt-agnostic `postProcess` wrapper from `@openstyle/stt` with an
 * explicit `maxOutputTokens` — the wrapper's own token heuristic sizes output
 * off input length, which is wrong for summaries.
 */

import type { PostProcessParams } from "@openstyle/stt";
import { postProcess } from "@openstyle/stt";
import type { MergedSegment } from "./merge.js";
import {
  buildMeetingSummaryMapPrompt,
  buildMeetingSummaryReducePrompt,
  buildMeetingSummaryUserPrompt,
  MEETING_SUMMARY_MAP_SYSTEM_PROMPT,
  MEETING_SUMMARY_REDUCE_SYSTEM_PROMPT,
  MEETING_SUMMARY_SYSTEM_PROMPT,
} from "./summary-prompt.js";

/** Conservative default transcript-context budget (tokens). */
export const DEFAULT_SUMMARY_CONTEXT_BUDGET_TOKENS = 8000;
/** Default output budget for the final summary (tokens). */
export const DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS = 1500;
/**
 * Overlap carried from the tail of one chunk into the head of the next, as a
 * fraction of the chunk budget (capped in tokens). Whole segments only — a
 * chunk never starts or ends mid-segment.
 */
const OVERLAP_FRACTION = 0.1;
const OVERLAP_MAX_TOKENS = 400;

/** One LLM request issued by the summarizer. */
export interface SummaryLlmRequest {
  system: string;
  prompt: string;
  maxOutputTokens: number;
  /** Which phase of the pipeline this call belongs to. */
  kind: "single" | "map" | "reduce";
}

/** What a summary LLM call must return. Token fields are 0 when unknown. */
export interface SummaryLlmResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** Provider/model that actually served the call, when known. */
  provider?: string | null;
  model?: string | null;
  /** Per-token USD pricing, when the callable can resolve it. */
  pricing?: { input: number; output: number } | null;
}

/** Injectable LLM dependency; the default resolves the app's default model. */
export type SummaryLlmCall = (
  request: SummaryLlmRequest,
) => Promise<SummaryLlmResponse>;

export interface SummarizeMeetingOptions {
  /**
   * Transcript token budget per LLM call. Defaults to the persisted
   * `meeting_summary_context_budget` setting when readable, else
   * {@link DEFAULT_SUMMARY_CONTEXT_BUDGET_TOKENS}.
   */
  contextBudgetTokens?: number;
  /** Output budget per call. Default {@link DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS}. */
  maxOutputTokens?: number;
  /** Override the LLM call (tests, alternate backends). */
  llmCall?: SummaryLlmCall;
}

export interface SummarizeMeetingResult {
  markdown: string;
  llmProvider: string | null;
  llmModel: string | null;
  /** Aggregated across all map/reduce calls. */
  inputTokens: number;
  outputTokens: number;
  /** `null` when pricing for the model is unavailable. */
  costUsd: number | null;
}

/** Rough token estimate (~4 chars/token), mirroring `@openstyle/stt` tokens.ts. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Format one merged segment as a labeled transcript line. */
function formatSegment(segment: MergedSegment): string {
  return `${segment.speaker}: ${segment.text}`;
}

/**
 * Split the transcript into chunks of whole segments, each at most
 * `budgetTokens` (a single oversized segment still becomes its own chunk),
 * prepending a token-capped tail of the previous chunk as overlap.
 */
export function chunkTranscript(
  segments: readonly MergedSegment[],
  budgetTokens: number,
): string[] {
  const lines = segments.map(formatSegment);
  const lineTokens = lines.map((l) => estimateTokens(l) + 1); // +1 for the newline
  const overlapBudget = Math.min(
    OVERLAP_MAX_TOKENS,
    Math.floor(budgetTokens * OVERLAP_FRACTION),
  );

  const chunks: string[] = [];
  let index = 0;
  while (index < lines.length) {
    // Fresh (non-overlap) segments for this chunk. Always take at least one
    // so an oversized single segment cannot stall the loop.
    const freshStart = index;
    let used = 0;
    while (
      index < lines.length &&
      (index === freshStart || used + lineTokens[index] <= budgetTokens)
    ) {
      used += lineTokens[index];
      index++;
    }

    // Overlap: trailing whole segments of the previous chunk, newest-last,
    // within the overlap budget.
    const overlap: string[] = [];
    let overlapUsed = 0;
    for (let j = freshStart - 1; j >= 0; j--) {
      if (overlapUsed + lineTokens[j] > overlapBudget) break;
      overlap.unshift(lines[j]);
      overlapUsed += lineTokens[j];
    }

    chunks.push([...overlap, ...lines.slice(freshStart, index)].join("\n"));
  }
  return chunks;
}

/**
 * Default LLM call: resolve the app's default chat model through the LLM
 * registry and run the prompt through the `@openstyle/stt` post-process
 * wrapper. Imports are dynamic so injecting `llmCall` (tests) never touches
 * the database or provider SDKs.
 */
const defaultLlmCall: SummaryLlmCall = async (request) => {
  const [{ createChatModel, getDefaultModels }, { getLlmProvider }] =
    await Promise.all([
      import("../providers.js"),
      import("../llm/registry.js"),
    ]);
  const llm = getDefaultModels().llm;
  if (!llm) {
    throw new Error(
      "No AI model is set up yet. Pick one in Settings > Models.",
    );
  }
  const model = await createChatModel(llm.provider, llm.model_id);
  const providerOptions = getLlmProvider(llm.provider)?.providerOptions?.(
    llm.model_id,
  ) as PostProcessParams["providerOptions"];

  // The wrapper never throws — it falls back to returning the input text with
  // `model: null`. A transcript echoed back is not a summary, so surface the
  // failure to the caller instead.
  let callError: unknown = null;
  const result = await postProcess({
    model,
    text: request.prompt,
    system: request.system,
    prompt: request.prompt,
    maxOutputTokens: request.maxOutputTokens,
    skipEmptyText: false,
    ...(providerOptions ? { providerOptions } : {}),
    onError: (err) => {
      callError = err;
    },
  });
  if (result.model === null) {
    throw callError instanceof Error
      ? callError
      : new Error(`Meeting summary LLM call failed: ${String(callError)}`);
  }

  let pricing: { input: number; output: number } | null = null;
  try {
    const { getModelCostCached } = await import("../../routes/models.js");
    pricing = getModelCostCached(llm.provider, llm.model_id);
  } catch {
    // Cost is best-effort; a missing registry just reports null cost.
  }

  return {
    text: result.cleaned,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    provider: llm.provider,
    model: llm.model_id,
    pricing,
  };
};

/** Resolve the context budget from settings when no option is given. */
async function resolveContextBudget(): Promise<number> {
  try {
    const [{ getDb }, { parseMeetingSummaryContextBudget }] = await Promise.all(
      [import("../db.js"), import("@openstyle/validations")],
    );
    const row = getDb()
      .prepare(
        "SELECT value FROM settings WHERE key = 'meeting_summary_context_budget'",
      )
      .get() as { value: string } | undefined;
    return parseMeetingSummaryContextBudget(row?.value);
  } catch {
    return DEFAULT_SUMMARY_CONTEXT_BUDGET_TOKENS;
  }
}

/**
 * Summarize a merged meeting transcript into markdown.
 *
 * Single-pass when the labeled transcript fits the context budget; otherwise
 * map-reduce over segment-boundary chunks with overlap.
 */
export async function summarizeMeeting(
  segments: readonly MergedSegment[],
  options: SummarizeMeetingOptions = {},
): Promise<SummarizeMeetingResult> {
  const llmCall = options.llmCall ?? defaultLlmCall;
  const maxOutputTokens =
    options.maxOutputTokens ?? DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS;

  const withText = segments.filter((s) => s.text.trim().length > 0);
  if (withText.length === 0) {
    return {
      markdown: "",
      llmProvider: null,
      llmModel: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
    };
  }

  const contextBudgetTokens =
    options.contextBudgetTokens ?? (await resolveContextBudget());

  let inputTokens = 0;
  let outputTokens = 0;
  let llmProvider: string | null = null;
  let llmModel: string | null = null;
  let pricing: { input: number; output: number } | null = null;

  const call = async (request: SummaryLlmRequest): Promise<string> => {
    const response = await llmCall(request);
    inputTokens += response.inputTokens;
    outputTokens += response.outputTokens;
    llmProvider = response.provider ?? llmProvider;
    llmModel = response.model ?? llmModel;
    pricing = response.pricing ?? pricing;
    return response.text;
  };

  const transcript = withText.map(formatSegment).join("\n");
  let markdown: string;

  if (estimateTokens(transcript) <= contextBudgetTokens) {
    markdown = await call({
      system: MEETING_SUMMARY_SYSTEM_PROMPT,
      prompt: buildMeetingSummaryUserPrompt(transcript),
      maxOutputTokens,
      kind: "single",
    });
  } else {
    const chunks = chunkTranscript(withText, contextBudgetTokens);
    const partials: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      partials.push(
        await call({
          system: MEETING_SUMMARY_MAP_SYSTEM_PROMPT,
          prompt: buildMeetingSummaryMapPrompt(chunks[i], i, chunks.length),
          maxOutputTokens,
          kind: "map",
        }),
      );
    }
    markdown = await call({
      system: MEETING_SUMMARY_REDUCE_SYSTEM_PROMPT,
      prompt: buildMeetingSummaryReducePrompt(partials),
      maxOutputTokens,
      kind: "reduce",
    });
  }

  const activePricing = pricing as { input: number; output: number } | null;
  const costUsd = activePricing
    ? inputTokens * activePricing.input + outputTokens * activePricing.output
    : null;

  return {
    markdown,
    llmProvider,
    llmModel,
    inputTokens,
    outputTokens,
    costUsd,
  };
}
