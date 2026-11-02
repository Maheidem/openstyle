import type { DatabaseSync } from "node:sqlite";
import type {
  ChatMessage,
  ChatProgress,
  ChatScope,
} from "@openstyle/validations";
import type { ChatLlm } from "./llm.js";
import { runGraph } from "./research/run.js";
import type { ChatSettings } from "./settings.js";
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
  /** "Show all": the open-items list is not capped for this turn (11.9.16). */
  showAll?: boolean;
  /** Eval only: escalate a fast turn to research when its search spans this many meetings. */
  spreadMin?: number;
  /** Override of `SCORE_FLOOR` (the eval measures it). */
  scoreFloor?: number;
  /** Eval only: `false` runs the research loop with no reflect call (code order of strategies). */
  researchReflect?: boolean;
  /** Eval only: called with the time of each checkpoint write, in ms (bar D17). */
  onCheckpointMs?: (ms: number) => void;
}

export async function runChatTurn(input: ChatTurnInput): Promise<TurnResult> {
  return runGraph(input);
}
