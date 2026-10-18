import type { CallRecord, CallSink, GatewayErrorKind } from "./call-record.js";
import type {
  CallStructuredInput,
  CallStructuredResult,
  CreateModel,
  callStructured,
} from "./gateway.js";
import {
  blankFacts,
  CancelledError,
  GatewayError,
  SchemaError,
} from "./gateway-errors.js";
import type { ParsedCall } from "./recorder.js";

// The one retry layer (specs/meeting-enhance-agentic.md 5.6, Q9). A unit is
// the retry boundary: `callUnit` makes one retry per call, with the one
// `gatewayRetryOn` rule. No LangGraph import, no meeting import. Every effect
// comes from `deps`, so a test replaces the recorder, gateway, model and wait.

/** The one retry rule: only a typed error with advice is retried. */
export function gatewayRetryOn(error: unknown): error is GatewayError {
  return error instanceof GatewayError && error.retry !== null;
}

/** The run context of the workflow satisfies it. */
export interface UnitContext {
  signal: AbortSignal;
  isStopped(): boolean;
  /** Stop the run: no other unit starts a call (3.4.5). */
  stopRun?(kind: GatewayErrorKind): void;
}

export interface UnitRecorder extends CallSink {
  /** The newest finished call of a unit key, else null (7.7). */
  finishedCall(runId: string, unitKey: string): ParsedCall | null;
}

export interface CallUnitDeps {
  recorder: UnitRecorder;
  callStructured: typeof callStructured;
  createModel?: CreateModel;
  /** The retry wait. Rejects when the signal aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

/** `callUnit` sets the four omitted members. */
export type UnitInput<T> = Omit<
  CallStructuredInput<T>,
  "sink" | "stopped" | "retry" | "createModel"
>;

/**
 * Build the result of a call that a resumed run finished before. The stored
 * object goes through the schema again; null when the schema rejects it.
 */
function resultFromParsedCall<T>(
  done: ParsedCall,
  schema: {
    safeParse(v: unknown): { success: true; data: T } | { success: false };
  },
): CallStructuredResult<T> | null {
  const parsed = schema.safeParse(done.parsed);
  if (!parsed.success) return null;
  return {
    object: parsed.data,
    finishReason: "stop",
    rawFinishReason: done.rawFinishReason,
    usage: done.usage,
    modelRequested: done.modelRequested,
    modelServed: done.modelServed,
    latencyMs: done.latencyMs ?? 0,
    queuedMs: done.queuedMs ?? 0,
    attempt: done.attempt,
    paramsLedger: done.params,
    structuredMode: done.params.structuredMode,
    callId: done.callId,
  };
}

/**
 * A failure that hits every unit of the run, read from the record of the call.
 * The gateway writes the record while it still holds the lane lease, so a unit
 * that waits in the lane sees the stop when its lease opens and sends no
 * request (5.1 step 4). Without this, the next waiter wakes before the node
 * calls `stopRun`: one HTTP 401 would cost two requests, not one (GR18). The
 * thrown error carries `runWide` for the kinds that the record cannot tell.
 */
function runWideKindOf(record: CallRecord): GatewayErrorKind | null {
  switch (record.errorKind) {
    case "provider_auth":
    case "model_mismatch":
      return record.errorKind;
    case "abnormal_stop":
      // Unified `stop` with a bad raw reason: `unknown_raw` or `missing_raw`.
      return record.finishUnified === "stop" ? "abnormal_stop" : null;
    default:
      return null;
  }
}

export async function callUnit<T>(
  input: UnitInput<T>,
  ctx: UnitContext,
  deps: CallUnitDeps,
): Promise<CallStructuredResult<T>> {
  // After a resume: a finished call is reused. It sends no request and writes
  // no row.
  const done = deps.recorder.finishedCall(input.runId, input.unitKey);
  const reused = done && resultFromParsedCall(done, input.schema.zod);
  if (reused) return reused;

  const sink: CallSink = {
    startAttempt: (a) => deps.recorder.startAttempt(a),
    recordCall: (record) => {
      const recorded = deps.recorder.recordCall(record);
      const kind = runWideKindOf(record);
      if (kind) ctx.stopRun?.(kind);
      return recorded;
    },
  };
  const call: CallStructuredInput<T> = {
    ...input,
    sink,
    stopped: () => ctx.isStopped(),
    ...(deps.createModel ? { createModel: deps.createModel } : {}),
  };
  try {
    return await deps.callStructured(call);
  } catch (e) {
    if (!gatewayRetryOn(e) || ctx.isStopped() || e.retry === null) throw e;
    // The wait comes before the lane lease, so a waiting call holds no slot.
    try {
      await deps.sleep(e.retry.waitMs, ctx.signal);
    } catch {
      throw new CancelledError({
        message: "Cancelled during the retry wait.",
        facts: blankFacts({
          step: input.step,
          unitKey: input.unitKey,
          modelRequested: input.profile.modelId,
        }),
        phase: "queued",
      });
    }
    // A second failure is final.
    return deps.callStructured({
      ...call,
      retry: {
        kind: e.kind,
        change: e.retry.change,
        ...(e instanceof SchemaError
          ? { validatorMessage: e.validatorMessage }
          : {}),
      },
    });
  }
}
