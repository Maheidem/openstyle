import type { LlmSkipReason } from "@openstyle/validations";
import { callUnit } from "../../../llm/call-unit.js";
import { CancelledError, GatewayError } from "../../../llm/gateway-errors.js";
import {
  autoTitleOn,
  cleanTitle,
  readTitleInput,
  titleCall,
  titleMaxOutput,
  titleSkipReason,
  writeAiTitle,
} from "../../meeting-title.js";
import type { RunContext, WorkflowDeps } from "../context.js";
import type { WorkflowStateType } from "../state.js";
import type { NodeFailure, SuggestTitleResult } from "../types.js";
import {
  failureFromError,
  guardNode,
  internalFailure,
  skippedBecause,
} from "../unit.js";

// Node `suggestTitle` (auto title). One call that writes a short title from
// the summary overview of this run. It runs after `save` (and after
// `suggestTags` on an Enhance run), so it cannot change what another node
// sends or writes. It writes only over a `default` or `file` title, with one
// conditional UPDATE: a rename during the run wins. A failure is recorded on
// its step row, but `deriveRunStatus` does not read this node.

const UNIT_KEY = "title";

function skipped(reason: LlmSkipReason): SuggestTitleResult {
  return skippedBecause(
    { status: "skipped", title: null, written: false, failure: null },
    reason,
  );
}

export function failedTitleResult(failure: NodeFailure): SuggestTitleResult {
  return { status: "failed", title: null, written: false, failure };
}

/**
 * True when the graph goes to `suggestTitle` after `save` or `suggestTags`:
 * a run with Summarize that saved, the setting on, and a title the AI may
 * write. The node checks again when it runs.
 */
export function wantsTitle(
  state: WorkflowStateType,
  deps: WorkflowDeps,
): boolean {
  if (!state.stages.includes("summarize")) return false;
  if (!state.saved || state.saved.meetingGone) return false;
  if (state.summary?.status !== "ok") return false;
  const input = readTitleInput(deps.db, state.meetingId);
  if (!input) return false;
  return (
    titleSkipReason({
      settingOn: autoTitleOn(deps.db),
      source: input.source,
      overview: input.overview,
    }) === null
  );
}

export function makeSuggestTitleNode(deps: WorkflowDeps) {
  async function run(
    state: WorkflowStateType,
    ctx: RunContext,
  ): Promise<SuggestTitleResult> {
    const models = state.models;
    if (!models || !state.saved) return skipped("not_saved");
    if (state.saved.meetingGone) return skipped("meeting_gone");
    if (ctx.isCancelled()) return skipped("cancelled");
    if (ctx.isStopped()) return skipped("stopped");

    const input = readTitleInput(deps.db, state.meetingId);
    if (!input) return skipped("meeting_gone");
    // The overview of this run, else the stored one.
    const overview = state.summary?.summary?.overview?.trim() || input.overview;
    const reason = titleSkipReason({
      settingOn: autoTitleOn(deps.db),
      source: input.source,
      overview,
    });
    if (reason) return skipped(reason);

    const profile = models.suggestTitle;
    const call = titleCall({ ...input, overview }, profile);
    ctx.progress.addTotal(1);
    let answer: string;
    try {
      const result = await callUnit(
        {
          step: "suggestTitle",
          runId: state.runId,
          unitKey: UNIT_KEY,
          chunkIndex: null,
          schema: call.schema,
          instructions: call.instructions,
          messages: [{ role: "user", content: call.user }],
          profile,
          maxOutputTokens: titleMaxOutput(profile),
          signal: ctx.signal,
          onQueued: (i) => ctx.progress.onQueued(i),
          onHeld: (held) => ctx.progress.callHeld(held),
        },
        ctx,
        deps,
      );
      answer = result.object.title;
    } catch (err) {
      ctx.progress.callEnded("failed");
      if (err instanceof CancelledError) {
        return {
          status: "cancelled",
          title: null,
          written: false,
          failure: null,
        };
      }
      if (err instanceof GatewayError) {
        return failedTitleResult(
          failureFromError("suggestTitle", UNIT_KEY, err, []),
        );
      }
      throw err;
    }
    ctx.progress.callEnded("ok");
    const title = cleanTitle(answer);
    if (!title) {
      return failedTitleResult({
        ...internalFailure(
          "suggestTitle",
          UNIT_KEY,
          new Error("The model wrote an empty title."),
        ),
        kind: "empty_input",
      });
    }
    const written = writeAiTitle(deps.db, state.meetingId, title, {
      force: false,
    });
    return { status: "ok", title, written, failure: null };
  }

  const guarded = guardNode<WorkflowStateType, SuggestTitleResult>(
    deps,
    {
      id: "suggestTitle",
      stepKey: () => UNIT_KEY,
      failed: (_state, f) => failedTitleResult(f),
      outcome: (r) => ({ status: r.status, failure: r.failure }),
    },
    run,
  );
  return async (state: WorkflowStateType) => ({ title: await guarded(state) });
}
