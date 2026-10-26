import { createAppLogger } from "@openstyle/utils";
import {
  type LlmSkipReason,
  MEETING_SUMMARY_TIMEOUT_SETTING_KEY,
  meetingSummaryTimeoutMs,
} from "@openstyle/validations";
import { callUnit } from "../../../llm/call-unit.js";
import type { CallStructuredResult } from "../../../llm/gateway.js";
import {
  ContextExceededError,
  LengthError,
} from "../../../llm/gateway-errors.js";
import type { CallProfile } from "../../../llm/model-profiles.js";
import {
  fetchModelsFromRegistry,
  getModelCostCached,
} from "../../../model-registry.js";
import { speakerDisplayLabel } from "../../merge.js";
import { chunkTranscript, estimateTokens, formatSegment } from "../chunking.js";
import type { RunContext, WorkflowDeps } from "../context.js";
import {
  buildSummaryOverviewFromTranscriptSystemPrompt,
  buildSummaryOverviewSystemPrompt,
  buildSummaryOverviewUserPrompt,
  buildSummaryPartUserPrompt,
  buildSummaryStageSystemPrompt,
  renderSummaryNotes,
  SUMMARY_EXTRACT_STAGES,
  type SummaryExtractStage,
} from "../prompts.js";
import {
  type MeetingSummary,
  SUMMARY_STAGE_LISTS,
  type SummaryStage,
  type SummaryStageAnswer,
  summaryStageStepSchema,
} from "../schemas.js";
import type { WorkflowStateType } from "../state.js";
import {
  MAX_SUMMARIZE_CALLS,
  mergeSummaryAnswers,
  plannedSummaryCalls,
  renderSummaryMarkdown,
  repairCutAnswer,
  summaryCallsFor,
  withSupportedOwners,
} from "../summary-pure.js";
import {
  type CorrectChunkResult,
  type NodeFailure,
  type NodeStatus,
  type PreparedMeeting,
  type PreparedSegment,
  SAFETY_TOKENS,
  type SummarizeResult,
} from "../types.js";
import {
  appliesSizeLimits,
  fitsContext,
  guardNode,
  type Leaf,
  runStep,
  runUnitRoute,
} from "../unit.js";

const log = createAppLogger("summarize");

// Node `summarize` (specs/meeting-enhance-agentic.md 4.5), split into narrow
// calls (LLM design ethos, AGENTS.md). The transcript is one part when it
// fits the context budget, else parts of whole segments. For each part, four
// extraction calls: `decisions`, `actionItems`, `keyPoints` and
// `openQuestions`. Code merges the parts: it keeps a decision or an open
// question only when its quote is in the transcript, removes duplicates and
// drops an owner that the transcript does not support. Then one `overview`
// call writes the overview: from the transcript for a one-part meeting, from
// the merged items for a longer one. Code renders the Markdown. The node
// writes no meeting data: `save` does (SW3).

/** Today `DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS` (4.0.5, 4.5.4). */
const SUMMARY_ANSWER_TOKENS = 4096;
/** A part is split for a cut answer only when each half keeps this many tokens (4.0.5). */
const MIN_SPLIT_TOKENS_SUMMARY = 2000;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

export const SUMMARIZE_IS_STUB = false;

export function skippedSummary(): SummarizeResult {
  return {
    status: "skipped",
    summary: null,
    markdown: "",
    llmProvider: null,
    llmModel: null,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    callCount: 0,
    failure: null,
    llmCallIds: [],
    partial: false,
  };
}

export function failedSummary(failure: NodeFailure): SummarizeResult {
  return { ...skippedSummary(), status: "failed", failure };
}

/**
 * The job ceiling of one Summarize run (4.5.3, X8):
 * `clamp(2 x perCallMs x plannedCalls, 2 x perCallMs, 4 h)`. The factor 2 on
 * `plannedCalls` leaves room for one retry of each call.
 */
export function summaryCeilingMs(
  perCallMs: number,
  plannedCalls: number,
): number {
  const raw = 2 * perCallMs * Math.max(1, plannedCalls);
  return Math.min(Math.max(raw, 2 * perCallMs), FOUR_HOURS_MS);
}

let ceilingOverrideMs: number | null = null;
/** Test seam: a fixed ceiling in ms instead of the formula. null puts it back. */
export function __setSummaryCeilingMsForTests(ms: number | null): void {
  ceilingOverrideMs = ms;
}

function readSettingFrom(deps: WorkflowDeps, key: string): string | undefined {
  try {
    const row = deps.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value;
  } catch {
    return undefined;
  }
}

/** A call count over `MAX_SUMMARIZE_CALLS` stops the unit (4.5.3). */
class CallLimitStop extends Error {}

function failure(
  kind: NodeFailure["kind"],
  unitKey: string | null,
  message: string,
): NodeFailure {
  return {
    node: "summarize",
    unitKey,
    kind,
    finishReason: null,
    rawFinishReason: null,
    attempt: null,
    llmCallIds: [],
    message,
  };
}

/**
 * The end of one stage step: the answers of its leaves (more than one when
 * the part was split), or the reason to stop. `cut`: the `length` failure of
 * a leaf whose cut answer was repaired (PR #258).
 */
type StageOutcome =
  | { ok: true; answers: SummaryStageAnswer[]; cut: NodeFailure | null }
  | { ok: false; status: NodeStatus; failure: NodeFailure | null };

const lineTokens = (lines: readonly string[]) =>
  lines.reduce((sum, l) => sum + estimateTokens(l) + 1, 0);

/**
 * The step key of a stage call. One part: the stage name ("decisions"). More
 * parts: the stage and the part index ("decisions:2" is part 3).
 */
export function summaryStepKey(
  stage: SummaryStage,
  part: number,
  parts: number,
): string {
  return stage === "overview" || parts === 1 ? stage : `${stage}:${part}`;
}

/**
 * The segments as `chunkTranscript` takes them (4.5 Inputs). The text of a
 * segment is, first value that exists: this run's correction (stage `enhance`,
 * unit `ok`), the stored `enhancedText`, the raw text. A unit `ok` without a
 * correction for the segment gives the raw text: `save` resets the stored value.
 */
function summarySegments(
  prepared: PreparedMeeting,
  corrections: readonly CorrectChunkResult[],
  chained: boolean,
) {
  const okIds = new Set<string>();
  const corrected = new Map<string, string>();
  if (chained) {
    for (const chunk of corrections) {
      for (const unit of chunk.units) {
        if (unit.status !== "ok") continue;
        for (const id of unit.segmentIds) okIds.add(id);
        for (const c of unit.corrections) corrected.set(c.id, c.text);
      }
    }
  }
  const textOf = (s: PreparedSegment): string =>
    okIds.has(s.id)
      ? (corrected.get(s.id) ?? s.text)
      : (s.enhancedText ?? s.text);
  return prepared.segments
    .map((s) => ({
      startMs: s.startMs,
      endMs: s.startMs,
      text: textOf(s),
      speaker: s.speaker,
      ...(s.speakerLabel ? { speakerLabel: s.speakerLabel } : {}),
      ...(s.speakerName ? { speakerName: s.speakerName } : {}),
    }))
    .filter((s) => s.text.trim().length > 0);
}

export function makeSummarizeNode(deps: WorkflowDeps) {
  async function run(
    state: WorkflowStateType,
    ctx: RunContext,
  ): Promise<SummarizeResult> {
    const prepared = state.prepared;
    const models = state.models;
    if (!prepared || !models) throw new Error("prepare did not run");
    if (ctx.isCancelled()) return { ...skippedSummary(), status: "cancelled" };
    if (ctx.isStopped()) return skippedSummary();

    const profile: CallProfile = models.summarize;
    const segments = summarySegments(
      prepared,
      state.corrections,
      state.stages.includes("enhance"),
    );
    if (segments.length === 0) {
      return failedSummary(
        failure(
          "empty_input",
          null,
          "The transcript has no text to summarize.",
        ),
      );
    }
    // `formatSegment` labels an undiarized speaker "Unidentified" (4.5 Inputs).
    const lines = segments.map(formatSegment);
    const transcriptTokens = estimateTokens(lines.join("\n"));
    const labels = [
      ...new Set(segments.map((s) => speakerDisplayLabel(s, "Unidentified"))),
    ];

    const promptInput = {
      language: prepared.language,
      instructions: prepared.summary.instructions,
      context: prepared.context,
      earlierMeetings: prepared.folderMemory?.summaryBlock ?? null,
    };
    const systems = Object.fromEntries(
      SUMMARY_EXTRACT_STAGES.map((s) => [
        s,
        buildSummaryStageSystemPrompt(s, promptInput),
      ]),
    ) as Record<SummaryExtractStage, string>;
    const overviewSystem = buildSummaryOverviewSystemPrompt(promptInput);
    // The overview call reads the merged items, not the transcript: only the
    // extraction prompts count for the size of a part.
    const systemTokens = Math.max(
      ...Object.values(systems).map(estimateTokens),
    );
    const maxOut = Math.min(
      profile.maxOutputTokens ?? Number.POSITIVE_INFINITY,
      SUMMARY_ANSWER_TOKENS,
    );
    const fit =
      profile.contextWindow === null
        ? Number.POSITIVE_INFINITY
        : profile.contextWindow - systemTokens - maxOut - SAFETY_TOKENS;
    const contextBudget = Math.min(prepared.summary.contextBudget, fit);

    // Cost: the registry price, or null (4.5 rule 4). A fault gives null.
    let price: { input: number; output: number } | null = null;
    try {
      if (profile.provider !== "server") {
        await fetchModelsFromRegistry();
        price = getModelCostCached(profile.provider, profile.modelId);
      }
    } catch {
      price = null;
    }

    // Deviation from spec 4.5.3: PreparedMeeting.summary has no timeout field,
    // so the job ceiling reads the timeout setting here, not prepared.summary.
    const perCallMs = meetingSummaryTimeoutMs(
      readSettingFrom(deps, MEETING_SUMMARY_TIMEOUT_SETTING_KEY),
    );
    const ceilingMs = (plannedCalls: number) =>
      ceilingOverrideMs ?? summaryCeilingMs(perCallMs, plannedCalls);
    let callSignal = ctx.signal;

    const totals = {
      input: 0,
      output: 0,
      callIds: [] as (number | null)[],
      last: null as CallStructuredResult<SummaryStageAnswer> | null,
    };
    let made = 0;
    const absorb = (r: CallStructuredResult<SummaryStageAnswer>) => {
      totals.input += r.usage.input ?? 0;
      totals.output += r.usage.output ?? 0;
      totals.callIds.push(r.callId);
      totals.last = r;
    };

    /** The newest cut answer of each unit key (PR #258). */
    const cutAnswers = new Map<string, LengthError>();
    /** Leaf key -> the `length` failure of a leaf repaired from its cut answer. */
    const repaired = new Map<string, NodeFailure>();

    /**
     * A leaf that failed `length` at the end of the route, with a cut answer
     * that closes into a valid answer of its stage, becomes `ok` with the
     * repaired object (PR #258). Its failure stays in `repaired`: the step
     * row is `partial` and the result is marked partial.
     */
    const repairLeaves = <M>(
      stage: SummaryStage,
      leaves: Leaf<M, SummaryStageAnswer>[],
    ): Leaf<M, SummaryStageAnswer>[] =>
      leaves.map((leaf) => {
        if (leaf.status !== "failed" || leaf.failure?.kind !== "length") {
          return leaf;
        }
        const cut = cutAnswers.get(leaf.key);
        if (!cut?.cutText) return leaf;
        const object = repairCutAnswer(
          cut.cutText,
          summaryStageStepSchema(stage, {
            sizeLimits: appliesSizeLimits(profile),
          }).zod,
          SUMMARY_STAGE_LISTS[stage],
        );
        if (object === null) return leaf;
        repaired.set(leaf.key, leaf.failure);
        const f = cut.facts;
        const result: CallStructuredResult<SummaryStageAnswer> = {
          object,
          finishReason: "stop",
          rawFinishReason: f.rawFinishReason ?? "length",
          usage: f.usage ?? {
            input: null,
            output: null,
            reasoning: null,
            cached: null,
          },
          modelRequested: f.modelRequested,
          modelServed: f.modelServed,
          latencyMs: f.latencyMs,
          queuedMs: 0,
          attempt: f.attempt,
          paramsLedger: f.paramsLedger,
          structuredMode: f.structuredMode,
          callId: f.callId,
        };
        return { ...leaf, status: "ok", result, failure: null };
      });

    /** One stage call through the length route (4.0.6, 4.5.5). */
    async function routeStage<M>(o: {
      stage: SummaryStage;
      key: string;
      members: M[];
      system: string;
      user: (members: readonly M[]) => string;
      tokensOf: (members: readonly M[]) => number;
      /** Step 2 `split` for a cut answer: Infinity turns it off. */
      minSplitTokens: number;
      /** Step 2 `split` for an input that is too long for the window. */
      minSplitTokensInput: number;
    }): Promise<Leaf<M, SummaryStageAnswer>[]> {
      try {
        const leaves = await runUnitRoute<M, SummaryStageAnswer>(
          {
            node: "summarize",
            ctx,
            profile,
            minSplitTokens: o.minSplitTokens,
            minSplitTokensInput: o.minSplitTokensInput,
            tokensOf: o.tokensOf,
            maxOutput: () => maxOut,
            fits: (members, out, p) =>
              fitsContext(
                p,
                estimateTokens(o.system) + estimateTokens(o.user(members)),
                out,
              ),
            call: (unit) => {
              if (made >= MAX_SUMMARIZE_CALLS) throw new CallLimitStop();
              made += 1;
              cutAnswers.delete(unit.key);
              return callUnit(
                {
                  step: "summarize",
                  runId: state.runId,
                  unitKey: unit.key,
                  chunkIndex: null,
                  schema: summaryStageStepSchema(o.stage, {
                    sizeLimits: appliesSizeLimits(unit.profile),
                  }),
                  instructions: o.system,
                  messages: [{ role: "user", content: o.user(unit.members) }],
                  profile: unit.profile,
                  maxOutputTokens: unit.maxOutputTokens,
                  signal: callSignal,
                  onQueued: (i) => ctx.progress.onQueued(i),
                  onHeld: (held) => ctx.progress.callHeld(held),
                },
                ctx,
                deps,
              ).catch((err: unknown) => {
                if (err instanceof LengthError && err.where === "output") {
                  cutAnswers.set(unit.key, err);
                }
                if (err instanceof ContextExceededError) {
                  log.warn(
                    `context budget: summarize ${unit.key} is too long for the window`,
                  );
                }
                throw err;
              });
            },
            onSplit: () => ctx.progress.addTotal(1),
            onLeafEnd: (leaf) => {
              if (leaf.status === "ok") ctx.progress.callEnded("ok");
              else if (leaf.status === "failed")
                ctx.progress.callEnded("failed");
            },
          },
          o.key,
          o.members,
        );
        const out = repairLeaves(o.stage, leaves);
        for (const leaf of out) if (leaf.result) absorb(leaf.result);
        return out;
      } catch (err) {
        if (!(err instanceof CallLimitStop)) throw err;
        return [
          {
            key: o.key,
            members: o.members,
            status: "failed",
            result: null,
            failure: failure(
              "budget_exceeded",
              o.key,
              `The summary needs more than ${MAX_SUMMARIZE_CALLS} calls.`,
            ),
          },
        ];
      }
    }

    /** All leaves ok: their answers in order. Else the reason to stop. */
    const settle = <M>(
      leaves: readonly Leaf<M, SummaryStageAnswer>[],
    ): StageOutcome => {
      const bad =
        leaves.find((l) => l.status === "failed") ??
        leaves.find((l) => l.status === "cancelled") ??
        leaves.find((l) => l.status !== "ok");
      if (bad) {
        return {
          ok: false,
          status: bad.status === "ok" ? "failed" : bad.status,
          failure: bad.failure,
        };
      }
      const cutLeaf = leaves.find((l) => repaired.has(l.key));
      return {
        ok: true,
        answers: leaves.flatMap((l) => (l.result ? [l.result.object] : [])),
        cut: cutLeaf ? (repaired.get(cutLeaf.key) ?? null) : null,
      };
    };

    /** The step row of a stage: `partial` when a leaf was repaired (PR #258). */
    const stepRow = (
      o: StageOutcome,
    ): {
      status: NodeStatus;
      failure: NodeFailure | null;
      skipReason?: LlmSkipReason;
    } => {
      if (!o.ok) {
        // A unit is skipped only when the run stopped before its call.
        return o.status === "skipped"
          ? { status: o.status, failure: o.failure, skipReason: "stopped" }
          : { status: o.status, failure: o.failure };
      }
      return o.cut
        ? { status: "partial", failure: o.cut }
        : { status: "ok", failure: null };
    };

    const stage = (key: string, body: () => Promise<StageOutcome>) =>
      runStep(deps, state.runId, { key, node: "summarize" }, body, stepRow);

    const stop = (o: StageOutcome & { ok: false }): SummarizeResult => ({
      ...skippedSummary(),
      status: o.status,
      failure: o.failure,
    });

    // --- The plan -----------------------------------------------------------
    const budgetStop = async (key: string, message: string) => {
      const f = failure("budget_exceeded", key, message);
      await runStep(
        deps,
        state.runId,
        { key, node: "summarize" },
        async () => f,
        (r) => ({ status: "failed", failure: r }),
      );
      return failedSummary(f);
    };
    const firstKey = summaryStepKey(SUMMARY_EXTRACT_STAGES[0], 0, 1);
    if ("error" in plannedSummaryCalls(transcriptTokens, contextBudget)) {
      return budgetStop(
        firstKey,
        `The summary needs more than ${MAX_SUMMARIZE_CALLS} calls.`,
      );
    }
    const parts =
      transcriptTokens <= contextBudget
        ? [lines]
        : chunkTranscript(segments, contextBudget).map((c) => c.split("\n"));
    const plannedCalls = summaryCallsFor(parts.length);
    if (plannedCalls > MAX_SUMMARIZE_CALLS) {
      return budgetStop(
        firstKey,
        `The summary needs more than ${MAX_SUMMARIZE_CALLS} calls.`,
      );
    }
    ctx.progress.addTotal(plannedCalls);
    callSignal = AbortSignal.any([
      ctx.signal,
      AbortSignal.timeout(ceilingMs(plannedCalls)),
    ]);

    // --- Extraction: three narrow calls for each part ------------------------
    const answers: SummaryStageAnswer[] = [];
    for (const [i, part] of parts.entries()) {
      if (parts.length > 1) {
        ctx.progress.summaryPart({ n: i + 1, of: parts.length });
      }
      for (const s of SUMMARY_EXTRACT_STAGES) {
        const key = summaryStepKey(s, i, parts.length);
        const done = await stage(key, async () =>
          settle(
            await routeStage<string>({
              stage: s,
              key,
              members: part,
              system: systems[s],
              user: (members) =>
                buildSummaryPartUserPrompt(members, i, parts.length),
              tokensOf: lineTokens,
              minSplitTokens: MIN_SPLIT_TOKENS_SUMMARY,
              // A part that is too long for the window always splits.
              minSplitTokensInput: 0,
            }),
          ),
        );
        if (!done.ok) return stop(done);
        answers.push(...done.answers);
      }
    }

    // --- Code: merge the parts, check the owners ------------------------------
    const joined = mergeSummaryAnswers(answers, lines);
    const merged = withSupportedOwners(joined.items, labels, lines.join("\n"));
    if (
      merged.dropped + joined.droppedDecisions + joined.droppedQuestions >
      0
    ) {
      log.info(
        `summarize: code checks dropped ${joined.droppedDecisions} decision(s) and ${joined.droppedQuestions} open question(s) with no quote in the transcript, and set ${merged.dropped} owner(s) to null`,
      );
    }

    // --- The overview: one last call ------------------------------------------
    // A one-part meeting: the overview reads the transcript. A longer one: it
    // reads the merged items (the notes). The members are lines: a text that
    // the model refuses as too long for the window splits in two halves, and
    // the two overviews are joined (specs/llm-runtime-tuning.md 9 item 5).
    if (parts.length > 1) ctx.progress.summaryPart("combine");
    const fromTranscript = parts.length === 1;
    const done = await stage("overview", async () =>
      settle(
        await routeStage<string>({
          stage: "overview",
          key: "overview",
          members: fromTranscript
            ? lines
            : renderSummaryNotes(merged.items).split("\n"),
          system: fromTranscript
            ? buildSummaryOverviewFromTranscriptSystemPrompt(promptInput)
            : overviewSystem,
          user: (members) =>
            fromTranscript
              ? buildSummaryPartUserPrompt(members, 0, 1)
              : buildSummaryOverviewUserPrompt(members.join("\n")),
          tokensOf: lineTokens,
          minSplitTokens: Number.POSITIVE_INFINITY,
          minSplitTokensInput: 0,
        }),
      ),
    );
    if (!done.ok) return stop(done);
    const summary: MeetingSummary = {
      overview: done.answers
        .map((a) => a.overview ?? "")
        .join(" ")
        .trim(),
      ...merged.items,
    };

    const last = totals.last as CallStructuredResult<SummaryStageAnswer> | null;
    return {
      status: "ok",
      summary,
      markdown: renderSummaryMarkdown(summary),
      llmProvider: profile.provider,
      llmModel: last ? (last.modelServed ?? last.modelRequested) : null,
      inputTokens: totals.input,
      outputTokens: totals.output,
      costUsd: price
        ? totals.input * price.input + totals.output * price.output
        : null,
      callCount: totals.callIds.length,
      failure: null,
      llmCallIds: totals.callIds,
      partial: repaired.size > 0,
    };
  }

  // `stepKey` is null: the body opens its own steps with `runStep`.
  const guarded = guardNode<WorkflowStateType, SummarizeResult>(
    deps,
    {
      id: "summarize",
      stepKey: null,
      failed: (_state, f) => failedSummary(f),
      outcome: (r) => ({ status: r.status, failure: r.failure }),
    },
    run,
  );
  return async (state: WorkflowStateType) => ({
    summary: await guarded(state),
  });
}
