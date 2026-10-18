import { Command, END, Send, START, StateGraph } from "@langchain/langgraph";
import { NodeSqliteSaver } from "../../llm/workflow/checkpoint-saver.js";
import type { WorkflowDeps } from "./context.js";
import {
  failedCorrectResult,
  makeCorrectChunkNode,
} from "./nodes/correct-chunk.js";
import {
  failedIdentifyResult,
  makeIdentifySpeakersNode,
} from "./nodes/identify-speakers.js";
import { makePrepareNode } from "./nodes/prepare.js";
import { makeSaveNode } from "./nodes/save.js";
import { failedSummary, makeSummarizeNode } from "./nodes/summarize.js";
import { makeVerifyEvidenceNode } from "./nodes/verify-evidence.js";
import { WorkflowState, type WorkflowStateType } from "./state.js";
import type { CorrectChunkInput } from "./types.js";
import { internalFailure } from "./unit.js";

// The workflow graph (specs/meeting-enhance-agentic.md 3.2, Figure 1). One
// graph, six nodes. This module and `state.ts` may import LangGraph statically;
// the runner and the nodes import them as types only. `load-graph.ts` loads
// this module with a dynamic import, after it removes the tracing variables.

export function buildGraph(deps: WorkflowDeps) {
  const stopped = (runId: string): boolean => {
    const ctx = deps.getRunContext(runId);
    return ctx.isCancelled() || ctx.isStopped();
  };

  /** Edge rule 4: after a node, a cancel or a stop sends the graph to `save`. */
  const afterIdentify = (state: WorkflowStateType) =>
    stopped(state.runId) ? "save" : "verifyEvidence";
  const afterVerify = (state: WorkflowStateType) => {
    if (stopped(state.runId)) return "save";
    return state.stages.includes("summarize") ? "summarize" : "save";
  };

  // Edge rule 1: one Send for each chunk, or straight to `summarize`.
  const afterPrepare = (state: WorkflowStateType) => {
    const prepared = state.prepared;
    if (!prepared || stopped(state.runId)) return "save";
    if (!state.stages.includes("enhance")) return "summarize";
    const models = state.models;
    if (!models) return "save";
    const bySegment = new Map(prepared.segments.map((s) => [s.id, s]));
    return prepared.chunks.map((ids, chunkIndex) => {
      const input: CorrectChunkInput = {
        runId: state.runId,
        meetingId: state.meetingId,
        chunkIndex,
        segments: ids.flatMap((id) => {
          const s = bySegment.get(id);
          return s ? [s] : [];
        }),
        language: prepared.language,
        vocabTerms: prepared.vocabTerms,
        profile: models.correctChunk,
      };
      return new Send("correctChunk", input);
    });
  };

  /**
   * A backstop for what `guardNode` misses (3.2 rule 7): record a typed
   * `internal` failure and go to `save`.
   */
  const handler =
    <S>(update: (state: S, error: Error) => Record<string, unknown>) =>
    (state: S, { error }: { node: string; error: Error }) =>
      new Command({ goto: "save", update: update(state, error) });

  return new StateGraph(WorkflowState)
    .addNode("prepare", makePrepareNode(deps))
    .addNode("correctChunk", makeCorrectChunkNode(deps), {
      errorHandler: handler<CorrectChunkInput>((input, error) => ({
        corrections: [
          failedCorrectResult(
            input,
            internalFailure("correctChunk", `chunk:${input.chunkIndex}`, error),
          ),
        ],
      })),
    })
    .addNode("identifySpeakers", makeIdentifySpeakersNode(deps), {
      errorHandler: handler<WorkflowStateType>((_state, error) => ({
        identify: failedIdentifyResult(
          internalFailure("identifySpeakers", "candidates", error),
        ),
      })),
    })
    .addNode("verifyEvidence", makeVerifyEvidenceNode(deps))
    .addNode("summarize", makeSummarizeNode(deps), {
      errorHandler: handler<WorkflowStateType>((_state, error) => ({
        summary: failedSummary(internalFailure("summarize", null, error)),
      })),
    })
    .addNode("save", makeSaveNode(deps))
    .addEdge(START, "prepare")
    .addConditionalEdges("prepare", afterPrepare)
    .addEdge("correctChunk", "identifySpeakers")
    .addConditionalEdges("identifySpeakers", afterIdentify)
    .addConditionalEdges("verifyEvidence", afterVerify)
    .addEdge("summarize", "save")
    .addEdge("save", END)
    .compile({ checkpointer: new NodeSqliteSaver(deps.db) });
}

export type CompiledWorkflow = ReturnType<typeof buildGraph>;
