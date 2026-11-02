import type { DatabaseSync } from "node:sqlite";
import type {
  ChatMessage,
  ChatProgress,
  ChatScope,
} from "@openstyle/validations";
import type { ChatLlm } from "./llm.js";
import type { ChatSettings } from "./settings.js";
import { type Exit, Turn } from "./turn.js";
import type { TurnResult } from "./types.js";

export { HARD_CAP_CALLS, REWRITE_SCORE, SCORE_FLOOR } from "./turn.js";

// The turn pipeline of the meeting chat agent (specs/meeting-chat-agent.md
// 2.2). Stages 0, 2, 3 and 5 are code. Stages 1, 2b and 4 are LLM calls.
// Router design (owner decision 2026-10-31): MIXED. A native tool call gives
// the tool and its arguments. Code validates the call. An invalid or missing
// call falls back to the structured router (stage 1) and the slot call (2b).
// Dates always come from the code date parser.
// The stages are the methods of `Turn` (`turn.ts`).

export interface ChatTurnInput {
  db: DatabaseSync;
  scope: ChatScope;
  question: string;
  /** The stored messages of the thread before this question. */
  history: ChatMessage[];
  settings: ChatSettings;
  llm: ChatLlm;
  signal: AbortSignal;
  /** The clock of the turn. The eval sets it. */
  now?: number;
  /** Eval only: a write question gives a proposal. Nothing is applied in any case. */
  allowProposals?: boolean;
  /** Called when the turn enters a new stage (D20): the route keeps it for the client to poll. */
  onProgress?: (p: ChatProgress) => void;
  /** "Answer anyway": no clarifying question for this turn (D20). */
  noClarify?: boolean;
  /** Override of `SCORE_FLOOR` (the eval measures it). */
  scoreFloor?: number;
}

export async function runChatTurn(input: ChatTurnInput): Promise<TurnResult> {
  const t = new Turn(input);
  t.begin();
  const out = await runStages(t);
  return t.resolve(out);
}

async function runStages(t: Turn): Promise<Exit> {
  const gate = t.clarify();
  if (gate) return gate;
  const routed = await t.route();
  if (routed.kind === "exit") return routed.exit;
  if (routed.kind === "broad") return broad(t);

  for (let round = 1; round <= t.input.settings.rounds; round++) {
    const stop = await t.actRound(round);
    if (stop) return stop;
    if (t.loopDone(round)) break;
  }
  const blocks = t.blocksStage();
  if (blocks?.kind === "exit") return blocks.exit;
  if (blocks?.kind === "status_text") {
    t.beginBroad();
    const res = t.resolve(await broad(t));
    return { kind: "result", result: t.statusResult(res, blocks.blocks) };
  }
  const floor = await t.floorStage();
  if (floor.kind === "exit") return floor.exit;
  return t.answerStage(floor.job);
}

/** The synthesis path: gather, observe, then the answer jobs. */
async function broad(t: Turn): Promise<Exit> {
  await t.broadGather();
  const seen = t.broadObserve();
  if (seen) return seen;
  const plan = await t.broadJobs();
  if (plan.kind === "exit") return plan.exit;
  if (!plan.merge) return t.answerStage(plan.jobs[0] as never);
  const results: TurnResult[] = [];
  for (const [i, job] of plan.jobs.entries()) {
    results.push(t.resolve(await t.answerStage(job)));
    if (i < plan.jobs.length - 1) {
      const between = t.betweenSlices(results);
      if (between === "break") break;
      if (between) return between;
    }
  }
  return t.mergeSlices(results);
}
