import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../../db.js";
import type {
  CallUnitDeps,
  UnitContext,
  UnitRecorder,
} from "../../llm/call-unit.js";
import {
  type CreateModel,
  callStructured,
  probeEndpoint,
} from "../../llm/gateway.js";
import { LLM_LANE_CONCURRENCY_CLOUD } from "../../llm/lane.js";
import type { CallProfile, ReasoningSteps } from "../../llm/model-profiles.js";
import { createLlmRecorder, type LlmRecorder } from "../../llm/recorder.js";
import {
  createRunContextRegistry,
  type RunContextRegistry,
} from "../../llm/workflow/run-context-registry.js";
import { loadMergedTranscript } from "../transcript-io.js";
import type { FailureKind, NodeId } from "./types.js";

// The injection seams of the workflow (specs/meeting-enhance-agentic.md 3.4.2).
// Every effect that a test must replace sits in `WorkflowDeps`. Production
// builds it once with `productionDeps()`. No module-level recorder or sleep
// exists. The context registry is the only module-level state.

/**
 * LangGraph starts every task of a super-step at once unless the config sets a
 * cap. The lane stays the only throttle: on cloud two calls run and one waits.
 * The cap must be 2 or more: `maxConcurrency: 1` drops tasks (3.5 rule 2).
 */
export const WORKFLOW_FANOUT_CAP = LLM_LANE_CONCURRENCY_CLOUD + 1;

export interface WorkflowDeps extends CallUnitDeps {
  /** `getDb()` in production. Saver, recorder and `save` use it. */
  db: DatabaseSync;
  /** Also the CallSink of every call (5.1). */
  recorder: LlmRecorder & UnitRecorder;
  /** Gateway seam (5.1). A scripted `MockLanguageModelV4` enters here. */
  createModel?: CreateModel;
  /** Epoch ms. `Date.now` in production. */
  now: () => number;
  /** `prepare` calls it. */
  loadTranscript: typeof loadMergedTranscript;
  /** Throws when no context exists. */
  getRunContext: (runId: string) => RunContext;
  /** Called before a boot resume (3.4.7). */
  probeEndpoint: (
    p: Pick<CallProfile, "provider" | "modelId">,
  ) => Promise<boolean>;
  /** Test hook of 5.5 rule 4. `prepare` passes it to `resolveModels`. */
  reasoningSteps?: ReasoningSteps;
}

export interface RunContext extends UnitContext {
  readonly runId: string;
  readonly meetingId: string;
  /** Soft cancel: user cancel or deleted meeting. */
  readonly signal: AbortSignal;
  isCancelled(): boolean;
  /** A run-wide failure or the breaker stopped the run (3.4.5). */
  isStopped(): boolean;
  stopRun(kind: FailureKind): void;
  /** A call whose record write failed (7.7). */
  recordLost(): void;
  progress: {
    addTotal(calls: number): void;
    callEnded(outcome: "ok" | "failed"): void;
    onQueued(info: { waitedMs: number; ahead: number }): void;
  };
  /** `prepare` calls this once; the runner stores it. */
  setInputHash(hash: string): void;
  /**
   * `guardNode` calls it first for every node run (4.0.2), before the step
   * row opens. Must not throw, be quick, be idempotent.
   */
  onNodeStart(node: NodeId): void;
}

export const runContexts: RunContextRegistry<RunContext> =
  createRunContextRegistry<RunContext>();

/** The retry wait. Rejects when the signal aborts. */
function realSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function productionDeps(): WorkflowDeps {
  const db = getDb();
  return {
    db,
    recorder: createLlmRecorder(db),
    callStructured,
    sleep: realSleep,
    now: Date.now,
    loadTranscript: loadMergedTranscript,
    getRunContext: (runId) => runContexts.get(runId),
    probeEndpoint,
  };
}
