import { createRunAdmin } from "../../llm/recorder.js";
import { stripTracingEnv } from "../../llm/workflow/env-guard.js";
import type { ChatTurnInput } from "../pipeline.js";
import { type Exit, Turn } from "../turn.js";
import type { TurnResult } from "../types.js";

// Runs one Ask turn through the graph (specs/meeting-chat-agent.md 11.9.3).
// LangGraph loads with a dynamic `import()` on the first turn, after the four
// tracing variables are removed (the Enhance graph does the same), so a
// bundling fault breaks Ask only.

/** Super-steps that a turn may take before `GraphRecursionError` (11.9.6). */
function recursionLimit(t: Turn): number {
  return 3 * t.input.settings.rounds + 80;
}

/** True when the chat run has a row in `llm_runs`, which a checkpoint needs. */
function hasRunRow(t: Turn): boolean {
  const { db, llm } = t.input;
  try {
    return (
      db.prepare("SELECT 1 FROM llm_runs WHERE id = ?").get(llm.runId) !==
      undefined
    );
  } catch {
    return false;
  }
}

export async function runGraph(input: ChatTurnInput): Promise<TurnResult> {
  const t = new Turn(input);
  stripTracingEnv();
  const { buildResearchGraph } = await import("./graph.js");
  const checkpoint = hasRunRow(t);
  const graph = buildResearchGraph(t, checkpoint);
  const runId = input.llm.runId;
  const state = await graph.invoke(
    { turnId: runId },
    {
      configurable: { thread_id: runId },
      recursionLimit: recursionLimit(t),
    },
  );
  const exit = state.result as Exit | null;
  if (!exit) throw new Error("The Ask graph ended with no result.");
  // The answer is stored in `chat_messages`, so the checkpoints of a finished
  // turn go (11.9.8). The checkpoints of a failed turn stay: an error above
  // skips this line.
  if (checkpoint) createRunAdmin(input.db).deleteCheckpoints(runId);
  return t.resolve(exit);
}
