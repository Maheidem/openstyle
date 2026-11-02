import { StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import type { Exit } from "../turn.js";

// The graph state of one Ask turn (specs/meeting-chat-agent.md 11.9.4). It
// holds raw data: routing keys, counters and results. It never holds a prompt
// and never a class instance. The instances (the source map, the model, the
// database) live in `Turn`, which the nodes close over, as `WorkflowDeps` does
// in the Enhance graph.

/** The nodes an edge can pick. */
export const NEXT = [
  "plan",
  "act",
  "observe",
  "reflect",
  "blocks",
  "synthesize",
  "cite_check",
  "not_found",
  "end",
] as const;
export type Next = (typeof NEXT)[number];

export const ResearchState = new StateSchema({
  // set once by the runner
  turnId: z.string(),
  // the path of the turn: the round loop of the tools, or the broad answer
  path: z.enum(["tools", "broad"]).default("tools"),
  // the loop
  iteration: z.number().default(0),
  // the answer jobs: the index of the job and the attempts of the job
  jobIndex: z.number().default(0),
  attempts: z.number().default(0),
  // routing and the end
  next: z.enum(NEXT).default("plan"),
  notFoundReason: z.string().nullable().default(null),
  result: z.custom<Exit>().nullable().default(null),
});

export type ResearchStateType = typeof ResearchState.State;
