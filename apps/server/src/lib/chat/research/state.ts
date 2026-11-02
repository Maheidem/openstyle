import { ReducedValue, StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import { REFLECT_NEXT } from "../prompts.js";
import type { Exit } from "../turn.js";
import {
  DONE,
  type Evidence,
  evidenceSchema,
  type Lead,
  leadSchema,
  type Step,
  stepSchema,
} from "./research.js";
import { recordSchema, type WorkerRecord } from "./workers.js";

// The graph state of one Ask turn (specs/meeting-chat-agent.md 11.9.4). It
// holds raw data: routing keys, counters, leads, evidence and results. It
// never holds a prompt and never a class instance. The instances (the source
// map, the model, the database) live in `Turn`, which the nodes close over, as
// `WorkflowDeps` does in the Enhance graph.

/** The nodes an edge can pick. */
export const GO = [
  "plan",
  "scout",
  "fanout",
  "join",
  "act",
  "observe",
  "reflect",
  "blocks",
  "synthesize",
  "cite_check",
  "not_found",
  "end",
] as const;
export type Go = (typeof GO)[number];

const mergeById = (cur: Lead[], next: Lead[]): Lead[] => {
  const byId = new Map(cur.map((l) => [l.id, l]));
  for (const l of next) byId.set(l.id, l);
  return [...byId.values()];
};

const mergeByLabel = (cur: Evidence[], next: Evidence[]): Evidence[] => {
  const byLabel = new Map(cur.map((e) => [e.label, e]));
  for (const e of next) byLabel.set(e.label, e);
  return [...byLabel.values()];
};

const mergeByKey = (
  cur: WorkerRecord[],
  next: WorkerRecord[],
): WorkerRecord[] => {
  const byKey = new Map(cur.map((r) => [r.key, r]));
  for (const r of next) byKey.set(r.key, r);
  return [...byKey.values()];
};

const append = (cur: Step[], next: Step[]): Step[] => [...cur, ...next];

export const ResearchState = new StateSchema({
  // set once by the runner and by `scope`
  turnId: z.string(),
  mode: z.enum(["fast", "research"]).default("fast"),
  maxIter: z.number().default(0),
  // the path of the turn: the round loop of the tools, the broad answer, or the research loop
  path: z.enum(["tools", "broad", "research"]).default("tools"),
  // the plan
  leads: new ReducedValue(
    z.array(leadSchema).default(() => []),
    {
      inputSchema: z.array(leadSchema),
      reducer: mergeById,
    },
  ),
  // the loop
  evidence: new ReducedValue(
    z.array(evidenceSchema).default(() => []),
    {
      inputSchema: z.array(evidenceSchema),
      reducer: mergeByLabel,
    },
  ),
  steps: new ReducedValue(
    z.array(stepSchema).default(() => []),
    {
      inputSchema: z.array(stepSchema),
      reducer: append,
    },
  ),
  // the workers (11.9.16): one record for each item or meeting
  fan: z.enum(["items", "meetings"]).nullable().default(null),
  records: new ReducedValue(
    z.array(recordSchema).default(() => []),
    {
      inputSchema: z.array(recordSchema),
      reducer: mergeByKey,
    },
  ),
  iteration: z.number().default(0),
  /** The closed action that `reflect` chose. */
  next: z.enum(REFLECT_NEXT).nullable().default(null),
  done: z.enum(DONE).nullable().default(null),
  // the answer jobs: the index of the job and the attempts of the job
  jobIndex: z.number().default(0),
  attempts: z.number().default(0),
  // routing and the end
  go: z.enum(GO).default("plan"),
  notFoundReason: z.string().nullable().default(null),
  result: z.custom<Exit>().nullable().default(null),
});

export type ResearchStateType = typeof ResearchState.State;
