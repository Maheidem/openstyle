import {
  MEETING_SUMMARY_TIMEOUT_SETTING_KEY,
  meetingSummaryTimeoutMs,
} from "@openstyle/validations";
import { callUnit } from "../../../llm/call-unit.js";
import type { CallStructuredResult } from "../../../llm/gateway.js";
import type { CallProfile } from "../../../llm/model-profiles.js";
import {
  fetchModelsFromRegistry,
  getModelCostCached,
} from "../../../model-registry.js";
import { chunkTranscript, estimateTokens, formatSegment } from "../chunking.js";
import type { RunContext, WorkflowDeps } from "../context.js";
import {
  buildSummaryMapSystemPrompt,
  buildSummaryMapUserPrompt,
  buildSummaryReduceSystemPrompt,
  buildSummaryReduceUserPrompt,
  buildSummarySingleSystemPrompt,
  buildSummarySingleUserPrompt,
  reduceBlocks,
} from "../prompts.js";
import { type MeetingSummary, meetingSummaryStepSchema } from "../schemas.js";
import type { WorkflowStateType } from "../state.js";
import {
  MAX_SUMMARIZE_CALLS,
  plannedSummaryCalls,
  renderSummaryMarkdown,
} from "../summary-pure.js";
import {
  type CorrectChunkResult,
  foldStatus,
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

// Node `summarize` (specs/meeting-enhance-agentic.md 4.5). One `single` call
// when the transcript fits the context budget. Else one `map` call for each
// chunk, then `reduce` calls until one summary is left. Every call returns the
// same five-field object (4.5.1). Code renders the Markdown. The node writes
// no meeting data: `save` does (SW3).

/** Today `DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS` (4.0.5, 4.5.4). */
const SUMMARY_ANSWER_TOKENS = 4096;
/** A map chunk is split only when each half keeps this many tokens (4.0.5). */
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

/** A plan or a call count over `MAX_SUMMARIZE_CALLS` stops the unit (4.5.3). */
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

type Outcome =
  | { ok: true; summary: MeetingSummary }
  | { ok: false; status: NodeStatus; failure: NodeFailure | null };

const lineTokens = (lines: readonly string[]) =>
  lines.reduce((sum, l) => sum + estimateTokens(l) + 1, 0);
const partialTokens = (partials: readonly MeetingSummary[]) =>
  reduceBlocks(partials).reduce((sum, b) => sum + estimateTokens(b) + 1, 0);

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

    const promptInput = {
      language: prepared.language,
      instructions: prepared.summary.instructions,
      context: prepared.context,
    };
    const singleSystem = buildSummarySingleSystemPrompt(promptInput);
    const mapSystem = buildSummaryMapSystemPrompt(promptInput);
    const reduceSystem = buildSummaryReduceSystemPrompt(promptInput);
    const systemTokens = Math.max(
      ...[singleSystem, mapSystem, reduceSystem].map(estimateTokens),
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
    const ceilingFor = (plannedCalls: number) =>
      ceilingOverrideMs ?? summaryCeilingMs(perCallMs, plannedCalls);
    let callSignal = ctx.signal;
    const armCeiling = (plannedCalls: number) => {
      callSignal = AbortSignal.any([
        ctx.signal,
        AbortSignal.timeout(ceilingFor(plannedCalls)),
      ]);
    };

    const totals = {
      input: 0,
      output: 0,
      callIds: [] as (number | null)[],
      last: null as CallStructuredResult<MeetingSummary> | null,
    };
    let made = 0;
    const absorb = (r: CallStructuredResult<MeetingSummary>) => {
      totals.input += r.usage.input ?? 0;
      totals.output += r.usage.output ?? 0;
      totals.callIds.push(r.callId);
      totals.last = r;
    };

    /** One unit through the length route (4.0.6, 4.5.5). */
    async function routeUnit<M>(o: {
      key: string;
      members: M[];
      system: string;
      user: (members: readonly M[]) => string;
      tokensOf: (members: readonly M[]) => number;
      /** Step 2 `split`: Infinity turns it off. */
      minSplitTokens: number;
      /** Step 3 `raise`. */
      raise: boolean;
      /** A `length` failure will be replanned: it is not a failed call. */
      quietLength?: boolean;
    }): Promise<Leaf<M, MeetingSummary>[]> {
      try {
        const leaves = await runUnitRoute<M, MeetingSummary>(
          {
            node: "summarize",
            ctx,
            profile,
            minSplitTokens: o.minSplitTokens,
            tokensOf: o.tokensOf,
            maxOutput: () => maxOut,
            fits: (members, out, p) =>
              o.raise &&
              fitsContext(
                p,
                estimateTokens(o.system) + estimateTokens(o.user(members)),
                out,
              ),
            call: (unit) => {
              if (made >= MAX_SUMMARIZE_CALLS) throw new CallLimitStop();
              made += 1;
              return callUnit(
                {
                  step: "summarize",
                  runId: state.runId,
                  unitKey: unit.key,
                  chunkIndex: null,
                  schema: meetingSummaryStepSchema({
                    sizeLimits: appliesSizeLimits(unit.profile),
                  }),
                  instructions: o.system,
                  messages: [{ role: "user", content: o.user(unit.members) }],
                  profile: unit.profile,
                  maxOutputTokens: unit.maxOutputTokens,
                  signal: callSignal,
                  onQueued: (i) => ctx.progress.onQueued(i),
                },
                ctx,
                deps,
              );
            },
            onSplit: () => ctx.progress.addTotal(1),
            onLeafEnd: (leaf) => {
              if (leaf.status === "ok") ctx.progress.callEnded("ok");
              else if (leaf.status === "failed") {
                if (o.quietLength && leaf.failure?.kind === "length") {
                  ctx.progress.callEnded("ok");
                } else ctx.progress.callEnded("failed");
              }
            },
          },
          o.key,
          o.members,
        );
        for (const leaf of leaves) if (leaf.result) absorb(leaf.result);
        return leaves;
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

    /** The outcome of a step row: the fold over its leaves. */
    const stepOutcome = (leaves: readonly Leaf<unknown, MeetingSummary>[]) => ({
      status: foldStatus(leaves.map((l) => l.status)),
      failure: leaves.find((l) => l.failure !== null)?.failure ?? null,
    });
    const step = <M>(
      key: string,
      body: () => Promise<Leaf<M, MeetingSummary>[]>,
    ) =>
      runStep(deps, state.runId, { key, node: "summarize" }, body, stepOutcome);

    /** All leaves ok: their objects in order. Else the reason to stop. */
    const settle = <M>(
      leaves: readonly Leaf<M, MeetingSummary>[],
    ): Outcome & { partials?: MeetingSummary[] } => {
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
      const partials = leaves.flatMap((l) =>
        l.result ? [l.result.object] : [],
      );
      return { ok: true, summary: partials[0] as MeetingSummary, partials };
    };

    /** Greedy groups of consecutive partials; each group fits the budget. */
    const groupPartials = (partials: MeetingSummary[]): MeetingSummary[][] => {
      const groups: MeetingSummary[][] = [];
      let cur: MeetingSummary[] = [];
      for (const p of partials) {
        const next = [...cur, p];
        if (cur.length > 0 && partialTokens(next) > contextBudget) {
          groups.push(cur);
          cur = [p];
        } else cur = next;
      }
      if (cur.length > 0) groups.push(cur);
      return groups;
    };

    const reduceUnit = async (
      key: string,
      group: MeetingSummary[],
    ): Promise<Outcome & { partials?: MeetingSummary[] }> =>
      settle(
        await step(key, () =>
          routeUnit<MeetingSummary>({
            key,
            members: group,
            system: reduceSystem,
            user: buildSummaryReduceUserPrompt,
            tokensOf: partialTokens,
            minSplitTokens: Number.POSITIVE_INFINITY,
            raise: true,
          }),
        ),
      );

    /** Map every chunk, then reduce level by level (4.5.3). */
    async function mapReduce(
      chunkBudget: number,
    ): Promise<Outcome | "one_chunk"> {
      const chunks = chunkTranscript(segments, chunkBudget);
      if (chunks.length < 2) return "one_chunk";
      const budgetFailure = (message: string): Outcome => ({
        ok: false,
        status: "failed",
        failure: failure("budget_exceeded", null, message),
      });
      const overLimit = (): Outcome =>
        budgetFailure(
          `The summary needs more than ${MAX_SUMMARIZE_CALLS} calls.`,
        );
      if (made + chunks.length + 1 > MAX_SUMMARIZE_CALLS) {
        return overLimit();
      }
      const partials: MeetingSummary[] = [];
      for (const [i, chunk] of chunks.entries()) {
        const key = `map:${i}`;
        ctx.progress.summaryPart({ n: i + 1, of: chunks.length });
        const done = settle(
          await step(key, () =>
            routeUnit<string>({
              key,
              members: chunk.split("\n"),
              system: mapSystem,
              user: (members) =>
                buildSummaryMapUserPrompt(members.join("\n"), i, chunks.length),
              tokensOf: lineTokens,
              minSplitTokens: MIN_SPLIT_TOKENS_SUMMARY,
              raise: true,
            }),
          ),
        );
        if (!done.ok) return done;
        partials.push(...(done.partials ?? []));
      }
      ctx.progress.summaryPart("combine");
      let current = partials;
      for (let level = 1; ; level++) {
        const groups = groupPartials(current);
        if (groups.length === current.length && current.length > 1) {
          // No pair fits one call: grouping cannot make progress.
          return budgetFailure(
            "The context budget cannot hold two partial summaries.",
          );
        }
        if (
          groups.length > 1 &&
          made + groups.length + 1 > MAX_SUMMARIZE_CALLS
        ) {
          return overLimit();
        }
        if (groups.length === 1) {
          return reduceUnit(`reduce:${level}:0`, groups[0] as MeetingSummary[]);
        }
        const next: MeetingSummary[] = [];
        for (const [g, group] of groups.entries()) {
          // A lone partial goes to the next level as it is: no call.
          if (group.length === 1) {
            next.push(group[0] as MeetingSummary);
            continue;
          }
          const done = await reduceUnit(`reduce:${level}:${g}`, group);
          if (!done.ok) return done;
          next.push(done.summary);
        }
        current = next;
      }
    }

    const singleCall = (quietLength: boolean) =>
      routeUnit<string>({
        key: "single",
        members: lines,
        system: singleSystem,
        user: (members) => buildSummarySingleUserPrompt(members.join("\n")),
        tokensOf: lineTokens,
        minSplitTokens: Number.POSITIVE_INFINITY,
        raise: false,
        quietLength,
      });

    // --- The plan -----------------------------------------------------------
    const plan = plannedSummaryCalls(transcriptTokens, contextBudget);
    if ("error" in plan) {
      const key = transcriptTokens <= contextBudget ? "single" : "map:0";
      const f = failure(
        "budget_exceeded",
        key,
        "The context budget cannot hold two partial summaries.",
      );
      await runStep(
        deps,
        state.runId,
        { key, node: "summarize" },
        async () => f,
        (r) => ({ status: "failed", failure: r }),
      );
      return failedSummary(f);
    }
    ctx.progress.addTotal(plan.calls);
    armCeiling(plan.calls);

    let outcome: Outcome;
    if (transcriptTokens <= contextBudget) {
      // One row `single`. It stays open when a `length` replans the summary
      // into map and reduce calls, and ends `succeeded` with the summary.
      outcome = await runStep(
        deps,
        state.runId,
        { key: "single", node: "summarize" },
        async (): Promise<Outcome> => {
          const leaves = await singleCall(true);
          const first = settle(leaves);
          if (first.ok || first.failure?.kind !== "length") return first;
          // Step 2 of 4.5.5: a map and reduce plan at half the tokens.
          const half = Math.ceil(transcriptTokens / 2);
          const replan = plannedSummaryCalls(transcriptTokens, half);
          if ("error" in replan) return first;
          ctx.progress.addTotal(replan.calls);
          armCeiling(replan.calls);
          const done = await mapReduce(half);
          return done === "one_chunk" ? first : done;
        },
        (o) =>
          o.ok
            ? { status: "ok", failure: null }
            : { status: o.status, failure: o.failure },
      );
    } else {
      const done = await mapReduce(contextBudget);
      outcome =
        done === "one_chunk"
          ? // One oversized segment: it cannot be chunked, so send it whole.
            await runStep(
              deps,
              state.runId,
              { key: "single", node: "summarize" },
              async () => settle(await singleCall(false)),
              (o) =>
                o.ok
                  ? { status: "ok", failure: null }
                  : { status: o.status, failure: o.failure },
            )
          : done;
    }

    if (!outcome.ok) {
      return {
        ...skippedSummary(),
        status: outcome.status,
        failure: outcome.failure,
      };
    }
    const last = totals.last as CallStructuredResult<MeetingSummary> | null;
    return {
      status: "ok",
      summary: outcome.summary,
      markdown: renderSummaryMarkdown(outcome.summary),
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
