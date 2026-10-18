import type { WorkflowDeps } from "../context.js";
import type { WorkflowStateType } from "../state.js";
import type { NodeFailure, SummarizeResult } from "../types.js";
import { guardNode } from "../unit.js";

// Node `summarize` (specs/meeting-enhance-agentic.md 4.5). WP5a ships a stub
// that returns `skipped`. WP6 writes the body and sets `SUMMARIZE_IS_STUB` to
// false. Tests that need the real body skip while the flag is true.
export const SUMMARIZE_IS_STUB = true;

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

export function makeSummarizeNode(deps: WorkflowDeps) {
  // `stepKey` is null: the body of WP6 opens its own steps with `runStep`.
  const guarded = guardNode<WorkflowStateType, SummarizeResult>(
    deps,
    {
      id: "summarize",
      stepKey: null,
      failed: (_state, f) => failedSummary(f),
      outcome: (r) => ({ status: r.status, failure: r.failure }),
    },
    async () => skippedSummary(),
  );
  return async (state: WorkflowStateType) => ({
    summary: await guarded(state),
  });
}
