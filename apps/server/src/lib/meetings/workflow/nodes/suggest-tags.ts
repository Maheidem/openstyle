import { createAppLogger } from "@openstyle/utils";
import {
  type LlmSkipReason,
  MAX_SUGGESTED_TAGS,
  normalizeTagNames,
} from "@openstyle/validations";
import { callUnit } from "../../../llm/call-unit.js";
import { ContextExceededError } from "../../../llm/gateway-errors.js";
import type { CallProfile } from "../../../llm/model-profiles.js";
import { addSuggestedTags, listTagsWithCounts } from "../../tags.js";
import { estimateTokens } from "../chunking.js";
import type { RunContext, WorkflowDeps } from "../context.js";
import {
  buildTagsSystemPrompt,
  buildTagsUserPrompt,
  promptContextWithFolder,
} from "../prompts.js";
import { MEETING_TAGS_STEP_SCHEMA, type MeetingTags } from "../schemas.js";
import type { WorkflowStateType } from "../state.js";
import {
  type NodeFailure,
  SAFETY_TOKENS,
  type SuggestTagsResult,
  TAGS_ANSWER_TOKENS,
  TAGS_MAX_INPUT_TOKENS,
  TAGS_PROMPT_MAX_EXISTING,
} from "../types.js";
import {
  fitsContext,
  guardNode,
  runUnitRoute,
  skippedBecause,
} from "../unit.js";

// Node `suggestTags` (issue #231). One call that suggests at most 5 topic
// tags for the meeting. It runs after `save`, so it cannot change a prompt or
// an output of another node. It writes its own tag rows with source 'llm'
// and never removes a tag. A failure here is recorded on its step row, but
// `deriveRunStatus` does not read this node, so the run keeps its status.

const UNIT_KEY = "tags";

const log = createAppLogger("suggest-tags");

function tokensOfLines(lines: readonly string[]): number {
  return lines.reduce((sum, l) => sum + estimateTokens(l) + 1, 0);
}

/**
 * Keep lines from the whole meeting, spread evenly, until the budget is
 * full. A transcript that fits is returned as it is.
 */
export function sampleLines(
  lines: readonly string[],
  budget: number,
): string[] {
  const costs = lines.map((l) => estimateTokens(l) + 1);
  const total = costs.reduce((a, b) => a + b, 0);
  if (total <= budget) return [...lines];
  const ratio = budget / total;
  const out: string[] = [];
  let used = 0;
  let credit = 0;
  lines.forEach((line, i) => {
    const cost = costs[i] ?? 0;
    credit += cost * ratio;
    if (credit >= cost && used + cost <= budget) {
      out.push(line);
      used += cost;
      credit -= cost;
    }
  });
  return out;
}

/**
 * The tags to store from the model answer: normalized, without duplicates, at
 * most MAX_SUGGESTED_TAGS. A small model can write a tag in snake case
 * ("machine_learning"), so an underscore becomes a space first.
 */
export function suggestedTagNames(raw: readonly string[]): string[] {
  return normalizeTagNames(raw.map((t) => t.replace(/_+/g, " "))).slice(
    0,
    MAX_SUGGESTED_TAGS,
  );
}

/** The existing tags for the prompt: the most used first, then by name. */
function existingTagsForPrompt(deps: WorkflowDeps): string[] {
  return listTagsWithCounts(deps.db)
    .sort((a, b) => b.meeting_count - a.meeting_count)
    .slice(0, TAGS_PROMPT_MAX_EXISTING)
    .map((t) => t.name)
    .sort();
}

function maxOutputFor(profile: CallProfile): number {
  const reasoningShare = profile.reasoning.countsInMaxOutput
    ? profile.reasoning.budgetTokens
    : 0;
  return Math.min(
    profile.maxOutputTokens ?? Number.POSITIVE_INFINITY,
    TAGS_ANSWER_TOKENS + reasoningShare,
  );
}

function skipped(reason: LlmSkipReason): SuggestTagsResult {
  return skippedBecause(
    { status: "skipped", suggested: [], added: [], failure: null },
    reason,
  );
}

export function failedTagsResult(failure: NodeFailure): SuggestTagsResult {
  return { status: "failed", suggested: [], added: [], failure };
}

/** The transcript lines, with the corrected text of this run where it exists. */
function transcriptLines(state: WorkflowStateType): string[] {
  const corrected = new Map<string, string>();
  for (const chunk of state.corrections) {
    for (const unit of chunk.units) {
      for (const c of unit.corrections) corrected.set(c.id, c.text);
    }
  }
  return (state.prepared?.segments ?? []).flatMap((s) => {
    const text = (corrected.get(s.id) ?? s.text).trim();
    return text ? [`${s.displayLabel}: ${text}`] : [];
  });
}

export function makeSuggestTagsNode(deps: WorkflowDeps) {
  async function run(
    state: WorkflowStateType,
    ctx: RunContext,
  ): Promise<SuggestTagsResult> {
    const prepared = state.prepared;
    const models = state.models;
    if (!prepared || !models || !state.saved) return skipped("not_saved");
    if (state.saved.meetingGone) return skipped("meeting_gone");
    if (ctx.isCancelled()) return skipped("cancelled");
    if (ctx.isStopped()) return skipped("stopped");

    const profile = models.suggestTags;
    const system = buildTagsSystemPrompt({
      title: prepared.title,
      context: promptContextWithFolder(prepared),
      existingTags: existingTagsForPrompt(deps),
      maxTags: MAX_SUGGESTED_TAGS,
    });
    const systemTokens = estimateTokens(system);
    const maxOut = maxOutputFor(profile);
    const budget = Math.min(
      TAGS_MAX_INPUT_TOKENS,
      profile.contextWindow === null
        ? Number.POSITIVE_INFINITY
        : profile.contextWindow - systemTokens - maxOut - SAFETY_TOKENS,
    );
    const lines = sampleLines(transcriptLines(state), budget);
    if (lines.length === 0) return skipped("empty_transcript");

    ctx.progress.addTotal(1);
    let refused = false;
    const route = (key: string, members: string[]) =>
      runUnitRoute<string, MeetingTags>(
        {
          node: "suggestTags",
          ctx,
          profile,
          // One unit. Never split it.
          minSplitTokens: Number.POSITIVE_INFINITY,
          tokensOf: tokensOfLines,
          maxOutput: (_members, p) => maxOutputFor(p),
          fits: (members, out, p) =>
            fitsContext(p, systemTokens + tokensOfLines(members), out),
          call: (unit) =>
            callUnit(
              {
                step: "suggestTags",
                runId: state.runId,
                unitKey: unit.key,
                chunkIndex: null,
                schema: MEETING_TAGS_STEP_SCHEMA,
                instructions: system,
                messages: [
                  { role: "user", content: buildTagsUserPrompt(unit.members) },
                ],
                profile: unit.profile,
                maxOutputTokens: unit.maxOutputTokens,
                signal: ctx.signal,
                onQueued: (i) => ctx.progress.onQueued(i),
                onHeld: (held) => ctx.progress.callHeld(held),
              },
              ctx,
              deps,
            ).catch((err: unknown) => {
              if (err instanceof ContextExceededError) refused = true;
              throw err;
            }),
          onLeafEnd: (leaf) => {
            if (leaf.status === "ok") ctx.progress.callEnded("ok");
            else if (leaf.status === "failed") ctx.progress.callEnded("failed");
          },
        },
        key,
        members,
      );
    let leaves = await route(UNIT_KEY, lines);
    if (refused && leaves[0]?.status === "failed") {
      // The context guard (specs/llm-runtime-tuning.md 9 item 5): the unit
      // never splits, so it tries once more with half of the lines.
      const fewer = sampleLines(lines, Math.floor(tokensOfLines(lines) / 2));
      log.warn(
        `context budget: suggestTags is too long for the window; one more try with ${fewer.length} of ${lines.length} lines`,
      );
      if (fewer.length > 0) {
        ctx.progress.addTotal(1);
        leaves = await route(`${UNIT_KEY}/1`, fewer);
      }
    }
    const leaf = leaves[leaves.length - 1];
    // A unit is skipped only when the run stopped before its call.
    if (leaf?.status === "skipped") return skipped("stopped");
    if (leaf?.status !== "ok" || !leaf.result) {
      return {
        status: leaf?.status === "cancelled" ? "cancelled" : "failed",
        suggested: [],
        added: [],
        failure: leaf?.failure ?? null,
      };
    }
    const suggested = suggestedTagNames(leaf.result.object.tags);
    const added = addSuggestedTags(state.meetingId, suggested, deps.db);
    return { status: "ok", suggested, added, failure: null };
  }

  const guarded = guardNode<WorkflowStateType, SuggestTagsResult>(
    deps,
    {
      id: "suggestTags",
      stepKey: () => UNIT_KEY,
      failed: (_state, f) => failedTagsResult(f),
      outcome: (r) => ({ status: r.status, failure: r.failure }),
    },
    run,
  );
  return async (state: WorkflowStateType) => ({ tags: await guarded(state) });
}
