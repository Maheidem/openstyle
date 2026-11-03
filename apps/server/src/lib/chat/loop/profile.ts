// The model profile of the Ask tool loop (specs/meeting-chat-agent.md 11.10.5,
// decision D22). Code picks the first call, the step cap and the size of a
// result from the class of the model. The class comes from the model id and
// from the provider, never from a setting. The numbers are the measured
// winners of the phase 1 eval (see the spec, section 11.10.12).

export type FirstCall = "search" | "list_meetings" | "auto";

export type ModelClass = "e2b" | "e4b" | "qwen-flash" | "local" | "cloud";

export interface LoopProfile {
  readonly cls: ModelClass;
  /** `auto` leaves the first call to the model. The others force it. */
  readonly first: FirstCall;
  /** Most model calls in the loop. The answer call comes after them. */
  readonly stepCap: number;
  /** Size cap of one tool result, in characters. */
  readonly resultChars: number;
  /** Output tokens of one loop step. */
  readonly stepTokens: number;
  /** Source budget of the answer call, in estimated tokens. */
  readonly answerBudget: number;
  /** Output tokens of the answer call. */
  readonly answerTokens: number;
  /** The item ledger is on. Only a cloud model writes and reads it. */
  readonly ledger: boolean;
}

const SMALL = {
  resultChars: 6000,
  stepTokens: 300,
  answerBudget: 10_000,
  answerTokens: 1800,
} as const;
const LARGE = {
  resultChars: 20_000,
  stepTokens: 1000,
  answerBudget: 30_000,
  answerTokens: 3500,
} as const;

/** The profile of the model that the user selected. */
export function loopProfile(model: {
  modelId: string;
  isLocal: boolean;
}): LoopProfile {
  const id = model.modelId;
  if (!model.isLocal) {
    return {
      cls: "cloud",
      first: "auto",
      stepCap: 10,
      ledger: true,
      ...LARGE,
    };
  }
  if (/e2b/i.test(id)) {
    return {
      cls: "e2b",
      first: "list_meetings",
      stepCap: 3,
      ledger: false,
      ...SMALL,
    };
  }
  if (/e4b/i.test(id)) {
    return {
      cls: "e4b",
      first: "search",
      stepCap: 5,
      ledger: false,
      ...SMALL,
    };
  }
  if (/qwen3[.-]?8.*flash/i.test(id)) {
    return {
      cls: "qwen-flash",
      first: "list_meetings",
      stepCap: 10,
      ledger: false,
      ...LARGE,
    };
  }
  // An unknown local model gets the small floor and a forced search.
  return {
    cls: "local",
    first: "search",
    stepCap: 5,
    ledger: false,
    ...SMALL,
  };
}
