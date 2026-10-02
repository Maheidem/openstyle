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

import { createAppLogger } from "@openstyle/utils";
import {
  DEFAULT_MEETING_SUMMARY_TIMEOUT_SECONDS,
  MEETING_SUMMARY_TIMEOUT_SETTING_KEY,
  meetingSummaryTimeoutMs,
} from "@openstyle/validations";
import { readSetting } from "../db.js";
import {
  type ChatCallInput,
  type ChatCallResponse,
  defaultChatCallFor,
  estimateTokens,
} from "./llm-call.js";
import { type MergedSegment, speakerDisplayLabel } from "./merge.js";
import {
  buildMeetingSummaryMapPrompt,
  buildMeetingSummaryReducePrompt,
  buildMeetingSummaryUserPrompt,
  MEETING_SUMMARY_MAP_SYSTEM_PROMPT,
  MEETING_SUMMARY_REDUCE_SYSTEM_PROMPT,
  MEETING_SUMMARY_SYSTEM_PROMPT,
  withMeetingContext,
  withSummaryInstructions,
} from "./summary-prompt.js";

const log = createAppLogger("meeting-summarize");

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

/**
 * Hard ceiling on the number of LLM calls one Summarize run may issue
 * (specs/meeting-llm-queue.md §5.8). Derived, not asserted:
 *
 *   fresh transcript per chunk <= budget - overlap = 8,000 - 400 = 7,600 tok
 *   tokens/hour of speech ~= 12,000  (** an ESTIMATE, ~200 tok/min ** — the
 *     repo measures no such figure; its only nearby measurement is the
 *     ~300-400 hidden reasoning tokens per call noted above)
 *   default  4 h meeting ->  48,000 tok -> ceil(48000/7600)  = 7 map -> 8 calls
 *   max     24 h meeting -> 144,000 tok -> ceil(144000/7600) = 19 map -> 20 calls
 *
 * 24 = 20 rounded up with headroom. It is a BOUND, not a target — the
 * typical run is 1 call, occasionally 8. Because the token/hour input above is
 * unverified, exceeding this number must `warn` loudly and fail, never
 * silently truncate: a silent truncation would turn "your 26-chunk meeting did
 * not all get summarized" into a summary that quietly omits content.
 *
 * The route uses the same constant for its job-level deadline
 * (`summarizeJobDeadlineMs` below), which is where this bound buys its real
 * protection: without it, one queued map/reduce run can hold the single local
 * worker slot for `calls x meeting_summary_timeout_seconds`.
 */
export const MAX_SUMMARIZE_CALLS = 24;

/**
 * How many LLM calls a transcript of `transcriptTokens` will cost at
 * `budgetTokens` per chunk: 1 for a single pass, else N map chunks + 1
 * reduce, clamped to {@link MAX_SUMMARIZE_CALLS}. Exported so the route's
 * job-level ceiling and this guard can never disagree about the count.
 */
export function plannedSummarizeCalls(
  transcriptTokens: number,
  budgetTokens: number,
): number {
  if (transcriptTokens <= budgetTokens) return 1;
  const freshPerChunk = Math.max(1, budgetTokens - overlapTokens(budgetTokens));
  const mapChunks = Math.ceil(transcriptTokens / freshPerChunk);
  return Math.min(mapChunks + 1, MAX_SUMMARIZE_CALLS);
}

/**
 * Job-level ceiling for one Summarize run (§5.8), derived in the open:
 *
 *   plannedCalls = min(N + 1, MAX_SUMMARIZE_CALLS)   // N map + 1 reduce; 1 single-pass
 *   deadline     = clamp(perCallMs x plannedCalls,
 *                        2 x perCallMs, 4 h)
 *
 * The `2 x perCallMs` FLOOR exists so a single call
 * that merely *hits* its own timeout does not kill the job on first attempt —
 * same posture as `transcriber.ts:267`'s `maxAttempts ?? 3`. Worked example
 * with the shipped defaults (per-call 600 s):
 *
 *   single pass, default      planned 1  -> 1200 s            (floor wins)
 *   4 h meeting, default      planned 8  -> 4800 s  (80 min)
 *   worst legal, default      planned 24 -> 14400 s = 4 h    (the clamp)
 *   worst legal, min timeout  planned 24 @ 30 s -> 720 s
 *
 * The 4 h clamp numerically coincides with `DEFAULT_MEETING_MAX_DURATION_HOURS
 * = 4`. That is a coincidence — do not read a derivation link into it and do
 * not couple them.
 */
export function summarizeJobDeadlineMs(
  perCallMs: number,
  plannedCalls: number,
): number {
  const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
  const raw = perCallMs * Math.max(1, plannedCalls);
  return Math.min(Math.max(raw, 2 * perCallMs), FOUR_HOURS_MS);
}

/**
 * Per-call timeout the job's calls will actually use, read fresh from the
 * same setting `taskTimeoutMs()` (`llm/task-profiles.ts`) reads for the call
 * itself — the ceiling and the calls it bounds must not disagree. Falls back
 * to the profile default when the setting is unset/out of bounds, which
 * `meetingSummaryTimeoutMs()` already folds in defensively.
 */
function summarizePerCallTimeoutMs(): number {
  try {
    return meetingSummaryTimeoutMs(
      readSetting(MEETING_SUMMARY_TIMEOUT_SETTING_KEY),
    );
  } catch {
    return DEFAULT_MEETING_SUMMARY_TIMEOUT_SECONDS * 1000;
  }
}

/** What one Summarize run is budgeted for (§5.8). */
export interface SummarizeJobPlan {
  /** Transcript size after blank-text drops, in estimated tokens. */
  transcriptTokens: number;
  /** Context budget per call, from settings. */
  contextBudgetTokens: number;
  /** Per-call timeout in force on the wire right now. */
  perCallMs: number;
  /** §5.8 `plannedCalls` — 1 single-pass, else min(N + 1, 24). */
  plannedCalls: number;
  /** §5.8 job ceiling in ms, derived from `plannedCalls` and `perCallMs`. */
  deadlineMs: number;
}

/**
 * Derive the job-level ceiling for one Summarize run from the transcript it
 * is about to send. Exported for the route (`runSummarizeJob`); the actual
 * call count still comes from `chunkTranscript`, and
 * `summarizeMeeting`'s own `MAX_SUMMARIZE_CALLS` guard is what fails a
 * transcript that exceeds the bound — this derives the wait, it does not
 * truncate anything.
 */
export async function summarizeJobPlan(
  segments: readonly MergedSegment[],
): Promise<SummarizeJobPlan> {
  const contextBudgetTokens = await resolveContextBudget();
  const perCallMs = summarizePerCallTimeoutMs();
  const transcriptTokens = estimateTokens(renderTranscript(segments));
  const plannedCalls = plannedSummarizeCalls(
    transcriptTokens,
    contextBudgetTokens,
  );
  return {
    transcriptTokens,
    contextBudgetTokens,
    perCallMs,
    plannedCalls,
    deadlineMs: summarizeJobDeadlineMs(perCallMs, plannedCalls),
  };
}

/** Overlap budget for one chunk — shared by the chunker and the call-count
 *  math above so the two cannot drift apart. */
function overlapTokens(budgetTokens: number): number {
  return Math.min(
    OVERLAP_MAX_TOKENS,
    Math.floor(budgetTokens * OVERLAP_FRACTION),
  );
}

/** One LLM request issued by the summarizer. */
export type SummaryLlmRequest = ChatCallInput & {
  /** Which phase of the pipeline this call belongs to. */
  kind: "single" | "map" | "reduce";
};

/** What a summary LLM call must return. Token fields are 0 when unknown. */
export type SummaryLlmResponse = ChatCallResponse;

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
  /** Cancel seam (§5.7): polled before each map/reduce call goes on the wire,
   *  so a cancelled summarize stops between chunks without touching the row. */
  shouldStop?: () => boolean;
  /** Queue-progress seam (§5.5): fired when a call has to wait for the LLM
   *  lane, so the job blob can surface "queued" to the renderer. */
  onQueued?: (info: { waitedMs: number; ahead: number }) => void;
  /** Call-progress seam: fired after each completed call with the running
   *  plan, so the async job behind POST /:id/summarize can render
   *  `done`/`total` in the polled job blob (the transcribe job gets this
   *  from `TranscriberDeps.onProgress`; the summarizer had no equivalent).
   *  `total` is the real call count for THIS transcript (1 single-pass, or
   *  N map + 1 reduce), which is not necessarily the ceiling the job
   *  derived up front (`plannedSummarizeCalls` clamps to
   *  {@link MAX_SUMMARIZE_CALLS}). */
  onProgress?: (p: { done: number; total: number }) => void;
  /**
   * User-authored instructions appended to the summary system prompt.
   * Defaults to the persisted `meeting_summary_instructions` setting when
   * readable, else "" (no change to the default prompt).
   */
  summaryInstructions?: string;
  /**
   * Free-text per-meeting context (specs/meeting-speaker-naming.md §3.4/
   * §9.3). Unlike `summaryInstructions`, there is no global-setting fallback
   * to resolve here — `summarizeMeeting` isn't given a `meetingId` to look
   * one up by, and the field is per-meeting, not a shared default. The route
   * always supplies `row.context ?? undefined`; omitted means "" (no change
   * to the default prompt).
   */
  meetingContext?: string;
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

/**
 * Render a transcript the way every caller of this module measures and sends
 * it: blank-text segments dropped, one `Label: text` line per segment.
 * Extracted so `summarizeMeeting` and the route's job-level ceiling
 * (`summarizeJobPlan` below) count the SAME string — two approximations of
 * "how big is this transcript" is exactly how a bound stops being a bound.
 */
function renderTranscript(segments: readonly MergedSegment[]): string {
  return segments
    .filter((s) => s.text.trim().length > 0)
    .map(formatSegment)
    .join("\n");
}

/** Format one merged segment as a labeled transcript line. The label rule
 * (named, numbered, or "Unidentified") lives in `speakerDisplayLabel`. */
function formatSegment(segment: MergedSegment): string {
  return `${speakerDisplayLabel(segment, "Unidentified")}: ${segment.text}`;
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
  const overlapBudget = overlapTokens(budgetTokens);

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
  const llmCall =
    options.llmCall ??
    defaultChatCallFor<SummaryLlmRequest>("meetingSummarize", options);
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
  // specs/meeting-speaker-naming.md §9.3: no DB fallback here (unlike
  // summaryInstructions) — the caller always supplies the meeting's own
  // `context` column; omitted means "" (no-op).
  const meetingContext = options.meetingContext ?? "";

  let inputTokens = 0;
  let outputTokens = 0;
  let llmProvider: string | null = null;
  let llmModel: string | null = null;
  let pricing: { input: number; output: number } | null = null;

  // Running call count for the polled job blob (see SummarizeMeetingOptions
  // .onProgress). `totalCalls` is 1 until the map/reduce branch knows the
  // real chunk count; a single-pass run never changes it.
  let callsDone = 0;
  let totalCalls = 1;

  const call = async (request: SummaryLlmRequest): Promise<string> => {
    const response = await llmCall(request);
    inputTokens += response.inputTokens;
    outputTokens += response.outputTokens;
    llmProvider = response.provider ?? llmProvider;
    llmModel = response.model ?? llmModel;
    pricing = response.pricing ?? pricing;
    options.onProgress?.({ done: ++callsDone, total: totalCalls });
    return response.text;
  };

  const transcript = renderTranscript(withText);
  let markdown: string;

  if (estimateTokens(transcript) <= contextBudgetTokens) {
    markdown = await call({
      system: withMeetingContext(
        withSummaryInstructions(
          MEETING_SUMMARY_SYSTEM_PROMPT,
          summaryInstructions,
        ),
        meetingContext,
      ),
      prompt: buildMeetingSummaryUserPrompt(transcript),
      maxOutputTokens,
      kind: "single",
    });
  } else {
    const chunks = chunkTranscript(withText, contextBudgetTokens);
    // The bound fires LOUDLY rather than truncating (§5.8/§7): the
    // token-per-hour figure behind MAX_SUMMARIZE_CALLS is an estimate, so a
    // transcript that exceeds it is a thing the user must be told about, not
    // a thing quietly omitted from their summary. Failing here also means no
    // partial summary is written — fail-closed, never a summary that looks
    // complete and is not.
    if (chunks.length + 1 > MAX_SUMMARIZE_CALLS) {
      log.warn(
        `transcript exceeds the bounded summarize budget: ${chunks.length} map chunks + 1 reduce > ${MAX_SUMMARIZE_CALLS} calls`,
      );
      throw new Error(
        `transcript exceeds the bounded summarize budget (${chunks.length} map chunks + 1 reduce > ${MAX_SUMMARIZE_CALLS} calls)`,
      );
    }
    const partials: string[] = [];
    totalCalls = chunks.length + 1;
    for (let i = 0; i < chunks.length; i++) {
      // Cancel between map chunks (§5.7). Only the LLM call site checks the
      // seam today — `shouldStop` reaches `acquireLlmLane`, where a call
      // still QUEUED is dropped before it goes on the wire — so the
      // summarizer's own loop stops as soon as a lane wait is cancelled.
      if (options.shouldStop?.()) {
        throw new Error("Summarize cancelled before the next chunk");
      }
      partials.push(
        await call({
          system: withMeetingContext(
            MEETING_SUMMARY_MAP_SYSTEM_PROMPT,
            meetingContext,
          ),
          prompt: buildMeetingSummaryMapPrompt(chunks[i], i, chunks.length),
          maxOutputTokens,
          kind: "map",
        }),
      );
    }
    markdown = await call({
      system: withMeetingContext(
        withSummaryInstructions(
          MEETING_SUMMARY_REDUCE_SYSTEM_PROMPT,
          summaryInstructions,
        ),
        meetingContext,
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
