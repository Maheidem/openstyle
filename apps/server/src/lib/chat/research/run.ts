import type { ChatProgress } from "@openstyle/validations";
import { createRunAdmin } from "../../llm/recorder.js";
import { stripTracingEnv } from "../../llm/workflow/env-guard.js";
import type { ChatTurnInput } from "../pipeline.js";
import { type Exit, Turn } from "../turn.js";
import type { TurnResult } from "../types.js";
import { MAX_ITER } from "./research.js";
import { researchTrigger } from "./trigger.js";

// Runs one Ask turn through the graph (specs/meeting-chat-agent.md 11.9.3).
// LangGraph loads with a dynamic `import()` on the first turn, after the four
// tracing variables are removed (the Enhance graph does the same), so a
// bundling fault breaks Ask only.

/**
 * Super-steps that a turn may take before `GraphRecursionError` (11.9.6). A
 * research turn: one loop turn is 3 super-steps (`act`, `observe`,
 * `reflect`); the fixed nodes and the answer retries are 12, so the limit is
 * `3 x MAX_ITER + 12`. The stop rules fire long before it: the error means a
 * bug. A fast turn has rounds of `act`, `observe` and `reflect` as well, and
 * up to 4 answer slices of a map-reduce, so it gets more room.
 */
function recursionLimit(t: Turn): number {
  const { question, history, settings, llm } = t.input;
  const research = researchTrigger({
    question,
    history,
    enabled: settings.research,
  });
  if (research) {
    return 3 * (llm.isLocal ? MAX_ITER.local : MAX_ITER.cloud) + 12;
  }
  return 3 * settings.rounds + 80;
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
  let last: { result: Exit | null } | null = null;
  try {
    // The step text of the research loop streams with `custom`; the last
    // `values` chunk is the final state (11.9.8).
    const stream = await graph.stream(
      { turnId: runId },
      {
        configurable: { thread_id: runId },
        recursionLimit: recursionLimit(t),
        // The workers share one local model: at most 2 run at once (11.9.16).
        maxConcurrency: input.llm.isLocal ? 2 : 4,
        streamMode: ["custom", "values"],
      },
    );
    for await (const [mode, chunk] of stream) {
      if (mode === "custom") input.onProgress?.(chunk as ChatProgress);
      else last = chunk as { result: Exit | null };
    }
  } catch (e) {
    if ((e as { name?: string }).name !== "GraphRecursionError") throw e;
    // A bug: write the answer from the evidence the loop has (11.9.6).
    const started = Date.now();
    t.step("research", "recursion_limit", started);
    const ranked = t.sources.all().filter((x) => x.kind !== "folder");
    last = {
      result:
        ranked.length === 0
          ? { kind: "not_found", reason: "no_sources" }
          : await t.answerStage({ ranked, synth: true, focus: null }),
    };
  }
  const exit = last?.result ?? null;
  if (!exit) throw new Error("The Ask graph ended with no result.");
  // The answer is stored in `chat_messages`, so the checkpoints of a finished
  // turn go (11.9.8). The checkpoints of a failed turn stay: an error above
  // skips this line.
  if (checkpoint) createRunAdmin(input.db).deleteCheckpoints(runId);
  return t.resolve(exit);
}
