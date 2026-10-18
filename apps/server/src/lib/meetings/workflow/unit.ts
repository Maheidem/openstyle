import type { LlmStepStatus } from "@openstyle/validations";
import type { CallStructuredResult } from "../../llm/gateway.js";
import {
  CancelledError,
  GatewayError,
  LengthError,
  ReasoningLeakError,
} from "../../llm/gateway-errors.js";
import {
  type CallProfile,
  withReasoningOff,
} from "../../llm/model-profiles.js";
import type { RunContext, WorkflowDeps } from "./context.js";
import {
  BREAKER_N,
  type FailureKind,
  type NodeFailure,
  type NodeId,
  type NodeStatus,
  PrepareFailure,
  SAFETY_TOKENS,
} from "./types.js";

// Step rows, the node guard and the length route (specs/meeting-enhance-agentic.md
// 4.0.2, 4.0.6, 4.0.7). Exactly one party opens and closes each step row.

const ONE_LINE_MAX = 200;

function oneLineText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, ONE_LINE_MAX);
}

/** The failure of a node fault that no typed result covers. */
export function internalFailure(
  node: NodeId,
  unitKey: string | null,
  err: unknown,
): NodeFailure {
  const name = err instanceof Error ? err.name : "Error";
  const message = err instanceof Error ? err.message : String(err);
  return {
    node,
    unitKey,
    kind: "internal",
    finishReason: null,
    rawFinishReason: null,
    attempt: null,
    llmCallIds: [],
    message: oneLineText(`${name}: ${message}`),
  };
}

/** A typed gateway error as the failure of one unit. */
export function failureFromError(
  node: NodeId,
  unitKey: string,
  err: GatewayError,
  llmCallIds: (number | null)[],
): NodeFailure {
  return {
    node,
    unitKey,
    kind: err.kind,
    finishReason: err.facts.finishReason,
    rawFinishReason: err.facts.rawFinishReason,
    attempt: err.facts.attempt,
    llmCallIds,
    message: oneLineText(err.message),
  };
}

/** The failure of a unit that the user cancelled. */
function cancelledFailure(
  node: NodeId,
  unitKey: string,
  llmCallIds: (number | null)[],
): NodeFailure {
  return {
    node,
    unitKey,
    kind: "cancelled",
    finishReason: null,
    rawFinishReason: null,
    attempt: null,
    llmCallIds,
    message: "Cancelled by user.",
  };
}

function stepStatusOf(status: NodeStatus): LlmStepStatus {
  return status === "ok" ? "succeeded" : status;
}

export interface NodeSpec<S extends { runId: string }, R> {
  id: NodeId;
  /**
   * "prepare", `chunk:${i}`, "candidates", "verify", "save". null for
   * "summarize": its body opens its own steps.
   */
  stepKey: ((state: S) => string) | null;
  /** The typed failed result of the node. null for "prepare": its fault is rethrown. */
  failed: ((state: S, f: NodeFailure) => R) | null;
  /** For "save" it reads the SaveResult (4.6). */
  outcome: (r: R) => {
    status: NodeStatus;
    failure: NodeFailure | null;
    /** Why a node skipped itself. It goes to the step row detail. */
    skipDetail?: string | null;
  };
}

/**
 * Wrap a node body. It calls `ctx.onNodeStart`, opens the step row, runs the
 * body, turns any throw into one `internal` failure, and closes the row.
 */
export function guardNode<S extends { runId: string }, R>(
  deps: WorkflowDeps,
  node: NodeSpec<S, R>,
  fn: (state: S, ctx: RunContext) => Promise<R>,
): (state: S) => Promise<R> {
  return async (state) => {
    const ctx = deps.getRunContext(state.runId);
    try {
      ctx.onNodeStart(node.id);
    } catch {
      // A hook fault never stops a node.
    }
    const key = node.stepKey ? node.stepKey(state) : null;
    if (key !== null) {
      deps.recorder.startStep(state.runId, { key, node: node.id });
    }
    let result: R;
    try {
      result = await fn(state, ctx);
    } catch (err) {
      if (node.failed === null) {
        // `prepare`: no data exists to save. The runner ends the run.
        if (key !== null) {
          const kind =
            err instanceof PrepareFailure || err instanceof GatewayError
              ? err.kind
              : "internal";
          deps.recorder.finishStep(state.runId, key, "failed", {
            kind,
            detail: oneLineText(
              err instanceof Error ? err.message : String(err),
            ),
          });
        }
        throw err;
      }
      const failure = internalFailure(node.id, key, err);
      result = node.failed(state, failure);
    }
    if (key !== null) {
      const out = node.outcome(result);
      deps.recorder.finishStep(
        state.runId,
        key,
        stepStatusOf(out.status),
        out.failure
          ? { kind: out.failure.kind, detail: out.failure.message }
          : out.skipDetail
            ? { kind: "skipped", detail: out.skipDetail }
            : undefined,
      );
    }
    return result;
  };
}

/**
 * Open a step row, run the body, close the row. A node calls `startStep` and
 * `finishStep` only through this helper. On a throw it closes the row `failed`
 * with kind `internal` and rethrows.
 */
export async function runStep<R>(
  deps: WorkflowDeps,
  runId: string,
  step: { key: string; node: NodeId },
  body: () => Promise<R>,
  outcome: (r: R) => { status: NodeStatus; failure: NodeFailure | null },
): Promise<R> {
  deps.recorder.startStep(runId, step);
  let result: R;
  try {
    result = await body();
  } catch (err) {
    deps.recorder.finishStep(runId, step.key, "failed", {
      kind: "internal",
      detail: oneLineText(err instanceof Error ? err.message : String(err)),
    });
    throw err;
  }
  const out = outcome(result);
  deps.recorder.finishStep(
    runId,
    step.key,
    stepStatusOf(out.status),
    out.failure
      ? { kind: out.failure.kind, detail: out.failure.message }
      : undefined,
  );
  return result;
}

// ---------------------------------------------------------------------------
// Failure breaker (3.4.5)
// ---------------------------------------------------------------------------

/**
 * Counts final failures of one kind in a row for each run. After `BREAKER_N`
 * it stops the run, so a cause that hits every unit costs a few requests, not
 * one per unit.
 */
export function createBreaker(): (
  ctx: RunContext,
  kind: FailureKind | null,
) => void {
  // Keyed by the context object, so the entry goes with the run's context.
  const streaks = new WeakMap<RunContext, { kind: FailureKind; n: number }>();
  return (ctx, kind) => {
    if (kind === null) {
      streaks.delete(ctx);
      return;
    }
    const cur = streaks.get(ctx);
    const n = cur?.kind === kind ? cur.n + 1 : 1;
    streaks.set(ctx, { kind, n });
    if (n >= BREAKER_N) ctx.stopRun(kind);
  };
}

/**
 * Feed the breaker with the end of one unit (a chunk, with all its halves). A
 * unit whose leaves all ended `ok` resets the streak. A unit whose leaves all
 * failed adds one failure of the kind of its first failed leaf. A mixed unit
 * changes nothing.
 */
export function recordUnitEnd(
  breaker: ReturnType<typeof createBreaker>,
  ctx: RunContext,
  leaves: readonly { status: string; failure: NodeFailure | null }[],
): void {
  if (leaves.every((l) => l.status === "ok")) {
    breaker(ctx, null);
    return;
  }
  const failed = leaves.filter((l) => l.status === "failed");
  if (failed.length > 0 && failed.length === leaves.length) {
    breaker(ctx, failed[0]?.failure?.kind ?? null);
  }
}

// ---------------------------------------------------------------------------
// The length route (4.0.6)
// ---------------------------------------------------------------------------

/** One leaf of the route: a unit, or a half after a `split`. */
export interface Leaf<M, T> {
  key: string;
  members: M[];
  status: "ok" | "failed" | "cancelled" | "skipped";
  result: CallStructuredResult<T> | null;
  failure: NodeFailure | null;
}

export interface RouteSpec<M, T> {
  node: NodeId;
  ctx: RunContext;
  profile: CallProfile;
  minSplitTokens: number;
  tokensOf(members: readonly M[]): number;
  /** The node formula of the output limit (4.2.4, 4.3.5). */
  maxOutput(members: readonly M[], profile: CallProfile): number;
  /** The fit check of 4.0.5 for the `raise` step. */
  fits(members: readonly M[], maxOutput: number, profile: CallProfile): boolean;
  /** One call through `callUnit`. */
  call(unit: {
    key: string;
    members: M[];
    profile: CallProfile;
    maxOutputTokens: number;
  }): Promise<CallStructuredResult<T>>;
  /** The unit starts one more call than planned (a split). */
  onSplit?(): void;
  /** A leaf ended: `ok` or a final failure. */
  onLeafEnd?(leaf: Leaf<M, T>): void;
}

function reasoningOn(profile: CallProfile): boolean {
  return profile.reasoning.mode === "bounded";
}

/** Cut the members in two halves near the middle by tokens, or null. */
function splitMembers<M>(
  members: readonly M[],
  tokensOf: (m: readonly M[]) => number,
  minSplitTokens: number,
): [M[], M[]] | null {
  if (members.length < 2) return null;
  const total = tokensOf(members);
  let best = -1;
  let bestGap = Number.POSITIVE_INFINITY;
  for (let i = 1; i < members.length; i++) {
    const gap = Math.abs(tokensOf(members.slice(0, i)) - total / 2);
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
    }
  }
  if (best < 1) return null;
  const a = members.slice(0, best);
  const b = members.slice(best);
  if (tokensOf(a) < minSplitTokens || tokensOf(b) < minSplitTokens) return null;
  return [a, b];
}

/**
 * Run one unit through steps 1 to 4 of the length route. Returns the flat list
 * of leaves, in member order. A final gateway error becomes a typed failure of
 * its leaf; the function does not throw for one. A run-wide failure stops the
 * run (3.4.5). Any other error is a bug and propagates to `guardNode`.
 */
export async function runUnitRoute<M, T>(
  spec: RouteSpec<M, T>,
  key: string,
  members: M[],
): Promise<Leaf<M, T>[]> {
  const { ctx, node } = spec;
  const callIds: (number | null)[] = [];
  let profile = spec.profile;
  let maxOut = spec.maxOutput(members, profile);
  let lowered = false;
  let raised = false;

  const end = (leaf: Leaf<M, T>): Leaf<M, T>[] => {
    spec.onLeafEnd?.(leaf);
    return [leaf];
  };
  const leaf = (
    status: Leaf<M, T>["status"],
    result: CallStructuredResult<T> | null,
    failure: NodeFailure | null,
  ): Leaf<M, T> => ({ key, members, status, result, failure });

  for (;;) {
    if (ctx.isCancelled()) {
      return end(leaf("cancelled", null, cancelledFailure(node, key, callIds)));
    }
    if (ctx.isStopped()) return end(leaf("skipped", null, null));
    try {
      const result = await spec.call({
        key,
        members,
        profile,
        maxOutputTokens: maxOut,
      });
      if (result.callId === null) ctx.recordLost();
      return end(leaf("ok", result, null));
    } catch (err) {
      if (!(err instanceof GatewayError)) throw err;
      callIds.push(err.facts.callId);
      // A call that reached the wire but wrote no record is a lost record.
      const neverSent =
        err.kind === "model_unavailable" ||
        (err instanceof CancelledError && err.phase === "queued");
      if (err.facts.callId === null && !neverSent) ctx.recordLost();
      if (err instanceof CancelledError) {
        if (ctx.isStopped() && !ctx.signal.aborted) {
          return end(leaf("skipped", null, null));
        }
        return end(
          leaf("cancelled", null, failureFromError(node, key, err, callIds)),
        );
      }

      const isLength = err instanceof LengthError;
      const isLeak = err instanceof ReasoningLeakError;
      if (isLength || (isLeak && reasoningOn(profile))) {
        const inputTooLong = isLength && err.where === "input";
        // Step 1: lowerReasoning.
        if (!inputTooLong && reasoningOn(profile) && !lowered) {
          lowered = true;
          profile = withReasoningOff(profile);
          maxOut = spec.maxOutput(members, profile);
          continue;
        }
        if (isLeak) {
          return end(
            leaf("failed", null, failureFromError(node, key, err, callIds)),
          );
        }
        // Step 2: split.
        const halves = splitMembers(
          members,
          spec.tokensOf,
          spec.minSplitTokens,
        );
        if (halves) {
          spec.onSplit?.();
          const first = await runUnitRoute(spec, `${key}/0`, halves[0]);
          const second = await runUnitRoute(spec, `${key}/1`, halves[1]);
          return [...first, ...second];
        }
        // Step 3: raise.
        if (!inputTooLong && !raised) {
          const cap = profile.maxOutputTokens ?? Number.POSITIVE_INFINITY;
          const next = Math.min(cap, 2 * maxOut);
          if (next > maxOut && spec.fits(members, next, profile)) {
            raised = true;
            maxOut = next;
            continue;
          }
        }
        // Step 4: fail.
        return end(
          leaf("failed", null, failureFromError(node, key, err, callIds)),
        );
      }

      if (err.runWide) ctx.stopRun(err.kind);
      return end(
        leaf("failed", null, failureFromError(node, key, err, callIds)),
      );
    }
  }
}

/** The fit check of 4.0.5. `contextWindow` null: always fits. */
export function fitsContext(
  profile: CallProfile,
  inputTokens: number,
  maxOutput: number,
): boolean {
  if (profile.contextWindow === null) return true;
  return inputTokens + maxOutput + SAFETY_TOKENS <= profile.contextWindow;
}
