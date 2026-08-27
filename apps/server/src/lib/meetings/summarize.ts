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

import { estimateTokens, resolveDefaultChatCall } from "./llm-call.js";
import type { MergedSegment } from "./merge.js";
import {
  buildMeetingSummaryMapPrompt,
  buildMeetingSummaryReducePrompt,
  buildMeetingSummaryUserPrompt,
  MEETING_SUMMARY_MAP_SYSTEM_PROMPT,
  MEETING_SUMMARY_REDUCE_SYSTEM_PROMPT,
  MEETING_SUMMARY_SYSTEM_PROMPT,
  withSummaryInstructions,
} from "./summary-prompt.js";

/** Conservative default transcript-context budget (tokens). */
export const DEFAULT_SUMMARY_CONTEXT_BUDGET_TOKENS = 8000;
/**
 * Default output budget for the final summary (tokens), shared by every
 * single/map/reduce call (`summarizeMeeting` below) — not scaled to input
 * like `@openstyle/stt`'s `maxOutputTokensForCleanup`, since a summary
 * doesn't grow with transcript length the way cleanup output does.
 *
 * 1500 was too tight in practice: a reasoning-capable local model spends part
 * of this same budget on hidden `<think>` output before writing the visible
 * summary (observed ~300-400 tokens of chain-of-thought per call, meeting
 * 8e6aea86-ca4c-4aeb-9c1c-19cc4416daec), so only ~1100-1200 tokens were ever
 * left for the actual markdown. A map call on a near-full 8000-token chunk
 * came within 65 tokens of the cap (1435/1500, `finish_reason: "stop"`), and
 * the reduce call combining two dense partials hit it exactly
 * (`finish_reason: "length"`) — `postProcess` (`@openstyle/stt`) then
 * discarded the truncated output as untrustworthy and
 * `resolveDefaultChatCall` (`llm-call.ts`) turned that into a hard failure,
 * so Summarize 500'd on a meeting Enhance had just completed fine (Enhance
 * sizes its own per-chunk budget off actual content, `enhance.ts`'s
 * `chunkTokens * 1.3 + 200` — summarize's flat constant didn't).
 *
 * 4096 was chosen over mirroring `@openstyle/stt`'s
 * `MAX_CLEANUP_OUTPUT_TOKENS` (8192) deliberately: map calls already run
 * near-full transcript chunks (up to `DEFAULT_SUMMARY_CONTEXT_BUDGET_TOKENS`
 * prompt tokens), and this package has no visibility into the context window
 * a user's local server was actually launched with — 7687 + 8192 ≈ 16k is
 * far likelier to overrun a modest `--ctx-size` than 7687 + 4096 ≈ 11.8k.
 */
export const DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS = 4096;
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
  /**
   * User-authored instructions appended to the summary system prompt.
   * Defaults to the persisted `meeting_summary_instructions` setting when
   * readable, else "" (no change to the default prompt).
   */
  summaryInstructions?: string;
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
 * Default LLM call: thin wrapper around the shared `resolveDefaultChatCall`
 * helper (`llm-call.ts`) — `kind` is summary-specific bookkeeping the shared
 * helper doesn't need. Kept as its own binding (rather than passing
 * `resolveDefaultChatCall` directly as `SummaryLlmCall`) so injecting
 * `llmCall` (tests) never touches the database or provider SDKs.
 */
const defaultLlmCall: SummaryLlmCall = (request) =>
  resolveDefaultChatCall({ ...request, taskId: "meetingSummarize" });

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

/** Resolve the summary-instructions profile from settings when no option is given. */
async function resolveSummaryInstructions(): Promise<string> {
  try {
    const [{ getDb }, { parseMeetingSummaryInstructions }] = await Promise.all([
      import("../db.js"),
      import("@openstyle/validations"),
    ]);
    const row = getDb()
      .prepare(
        "SELECT value FROM settings WHERE key = 'meeting_summary_instructions'",
      )
      .get() as { value: string } | undefined;
    return parseMeetingSummaryInstructions(row?.value);
  } catch {
    return "";
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
  const summaryInstructions =
    options.summaryInstructions ?? (await resolveSummaryInstructions());

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
      system: withSummaryInstructions(
        MEETING_SUMMARY_SYSTEM_PROMPT,
        summaryInstructions,
      ),
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
      system: withSummaryInstructions(
        MEETING_SUMMARY_REDUCE_SYSTEM_PROMPT,
        summaryInstructions,
      ),
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
