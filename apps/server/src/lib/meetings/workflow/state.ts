import { ReducedValue, StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import type { ResolvedModels } from "../../llm/model-profiles.js";
import type {
  CorrectChunkResult,
  IdentifySpeakersResult,
  PreparedMeeting,
  SaveResult,
  SummarizeResult,
  VerifyResult,
} from "./types.js";

// The graph state (specs/meeting-enhance-agentic.md 3.3). It holds run inputs
// and typed node results. It never holds a prompt or a raw answer; the
// recorder keeps those (D10).

const StageSchema = z.enum(["enhance", "summarize"]);

/** One entry for each chunkIndex. A later write replaces an earlier one. */
function mergeByChunkIndex(
  cur: CorrectChunkResult[],
  next: CorrectChunkResult[],
): CorrectChunkResult[] {
  const byIndex = new Map(cur.map((r) => [r.chunkIndex, r]));
  for (const r of next) byIndex.set(r.chunkIndex, r);
  return [...byIndex.values()].sort((a, b) => a.chunkIndex - b.chunkIndex);
}

export const WorkflowState = new StateSchema({
  runId: z.string(), // set once by the runner
  meetingId: z.string(),
  stages: z.array(StageSchema).min(1),
  // Set once by prepare (4.1). The model for each node is fixed here (4.1 P9).
  prepared: z.custom<PreparedMeeting>().nullable().default(null),
  models: z.custom<ResolvedModels>().nullable().default(null),
  // Fan-out results.
  corrections: new ReducedValue(
    z.array(z.custom<CorrectChunkResult>()).default(() => []),
    {
      inputSchema: z.array(z.custom<CorrectChunkResult>()),
      reducer: mergeByChunkIndex,
    },
  ),
  // Single results. Each node writes its own field once.
  identify: z.custom<IdentifySpeakersResult>().nullable().default(null),
  verify: z.custom<VerifyResult>().nullable().default(null),
  summary: z.custom<SummarizeResult>().nullable().default(null),
  saved: z.custom<SaveResult>().nullable().default(null),
});

export type WorkflowStateType = typeof WorkflowState.State;
