import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createAppLogger, errorMessage } from "@openstyle/utils";
import { parseServerModelId } from "@openstyle/validations";
import { getApiKey } from "../api-keys.js";
import type {
  ChatTurn,
  GatewayErrorKind,
  TokenUsage,
} from "../llm/call-record.js";
import {
  type CallUnitDeps,
  callUnit,
  gatewayRetryOn,
} from "../llm/call-unit.js";
import {
  type CallToolTurnResult,
  type CreateModel,
  callStructured,
  callToolTurn,
  type StepSchema,
} from "../llm/gateway.js";
import {
  blankFacts,
  CancelledError,
  type GatewayError,
} from "../llm/gateway-errors.js";
import { type CallProfile, resolveCallProfile } from "../llm/model-profiles.js";
import { createLlmRecorder } from "../llm/recorder.js";
import { getLlmProvider, isLocalProvider } from "../llm/registry.js";
import { resolveTaskModel } from "../llm/task-profiles.js";
import { contextWindowFor } from "../llm/token-budget.js";
import { realSleep } from "../meetings/workflow/context.js";
import { getMlxLlmModel, MLX_LLM_PROVIDER_ID } from "../mlx-llm/constants.js";
import { isMlxLlmModelDownloaded } from "../mlx-llm/models.js";
import { stripModelPrefix } from "../model-id.js";
import { getOwnServer } from "../own-servers.js";
import type { NativeTool } from "./choices.js";

// The model side of one Ask turn (specs/meeting-chat-agent.md 2.5a stage 0,
// 2.6). One turn is one recorder run: scope "chat", scope id = thread id, kind
// "meetingChat". Each stage call is one `llm_calls` row. The pipeline decides
// which stage to call and owns the hard cap of calls; this file only makes the
// calls and keeps the count.

const log = createAppLogger("chat-llm");

/** The first call after a model load gets a longer limit, as the live chat does. */
const COLD_TIMEOUT_MS = 120_000;

/** Why the gate refused the turn (spec 2.5a, exits X1 and X2). */
export type ChatGateReason = "no_model" | "provider_not_ready";

export class ChatGateError extends Error {
  constructor(
    readonly reason: ChatGateReason,
    message: string,
  ) {
    super(message);
    this.name = "ChatGateError";
  }
}

export type NativeCallResult =
  | { kind: "call"; name: string; args: Record<string, unknown> }
  | { kind: "none"; text: string };

export interface ChatLlm {
  readonly provider: string;
  readonly modelId: string;
  readonly isLocal: boolean;
  /** The context window of the model, null when unknown (an own server). */
  readonly contextWindow: number | null;
  readonly runId: string;
  /** Native tool turn. Never throws for a missing call (kind "none"). */
  nativeCall(i: {
    system: string;
    messages: ChatTurn[];
    tools: NativeTool[];
    maxOutputTokens: number;
    unitKey: string;
  }): Promise<NativeCallResult>;
  /** Strict JSON stage (router intent, slots, answer). Throws GatewayError. */
  structured<T>(i: {
    step: "chatRoute" | "chatSlots" | "chatAnswer";
    unitKey: string;
    schema: StepSchema<T>;
    system: string;
    messages: ChatTurn[];
    maxOutputTokens: number;
  }): Promise<{
    object: T;
    finishReason: string;
    usage: TokenUsage;
    latencyMs: number;
  }>;
  /** Logical calls so far. The hard cap is the pipeline's. */
  calls(): number;
  /** Close the run. A second call does nothing. */
  finish(
    status: "succeeded" | "failed" | "cancelled",
    detail?: { errorKind?: string; errorDetail?: string },
  ): void;
}

/** Seams for tests. Production leaves them unset. */
export interface ChatLlmDeps {
  /** Replaces the gate and the profile resolution. */
  gate?: () => Promise<CallProfile>;
  callStructured?: typeof callStructured;
  callToolTurn?: typeof callToolTurn;
  createModel?: CreateModel;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

/**
 * The gate (stage 0): a model is set for the task and the provider is ready.
 * Throws `ChatGateError`. Returns the profile of the call.
 */
async function runGate(): Promise<CallProfile> {
  let target: { provider: string; modelId: string };
  try {
    target = await resolveTaskModel("meetingChat");
  } catch (err) {
    throw new ChatGateError("no_model", errorMessage(err));
  }
  const provider = getLlmProvider(target.provider);
  if (!provider) {
    throw new ChatGateError(
      "no_model",
      `The provider "${target.provider}" is unknown.`,
    );
  }
  if (target.provider === MLX_LLM_PROVIDER_ID) {
    const def = getMlxLlmModel(
      stripModelPrefix(MLX_LLM_PROVIDER_ID, target.modelId),
    );
    if (!def) {
      throw new ChatGateError(
        "no_model",
        "The local model is not in the list.",
      );
    }
    if (!isMlxLlmModelDownloaded(def)) {
      throw new ChatGateError(
        "provider_not_ready",
        "The local model is not downloaded.",
      );
    }
  } else if (provider.ownServer) {
    const server = parseServerModelId(target.modelId);
    if (!server || !getOwnServer(server.serverId)) {
      throw new ChatGateError(
        "provider_not_ready",
        "The server of the model is not in the list.",
      );
    }
  } else if (!isLocalProvider(target.provider) && !getApiKey(target.provider)) {
    throw new ChatGateError(
      "provider_not_ready",
      `No API key is set for ${target.provider}.`,
    );
  }
  return resolveCallProfile({
    taskId: "meetingChat",
    step: "chatAnswer",
    maxReasoningTokens: 0,
    pin: target,
  });
}

function kindOf(err: unknown): string {
  const k = (err as { kind?: unknown } | null)?.kind;
  return typeof k === "string" ? k : "unknown";
}

export async function createChatLlm(
  db: DatabaseSync,
  opts: { threadId: string; signal: AbortSignal; deps?: ChatLlmDeps },
): Promise<ChatLlm> {
  const deps = opts.deps ?? {};
  const profile = await (deps.gate ?? runGate)();
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const doToolTurn = deps.callToolTurn ?? callToolTurn;
  const { signal } = opts;

  const recorder = createLlmRecorder(db);
  const runId = randomUUID();
  const started = recorder.startRun({
    id: runId,
    scope: "chat",
    scopeId: opts.threadId,
    kind: "meetingChat",
    startedBy: "chat",
    graphVersion: 1,
    startedAt: now(),
  });
  if (started !== "ok") {
    // The turn goes on. The calls are not recorded.
    log.warn(`chat run not recorded (${started}, thread ${opts.threadId})`);
  }
  const unitDeps: CallUnitDeps = {
    recorder,
    callStructured: deps.callStructured ?? callStructured,
    sleep,
    ...(deps.createModel ? { createModel: deps.createModel } : {}),
  };
  const ctx = { signal, isStopped: () => signal.aborted };

  let calls = 0;
  let finished = false;
  const usedKeys = new Map<string, number>();
  // A repeated key (an answer retry) gets a suffix, so `callUnit` never takes
  // the finished call of the first one as its result. `/2` keeps the attempt
  // count of the recorder on the base step.
  const uniqueKey = (key: string): string => {
    const n = (usedKeys.get(key) ?? 0) + 1;
    usedKeys.set(key, n);
    return n === 1 ? key : `${key}/${n}`;
  };
  const timeoutFor = (): { timeoutMs: number } | Record<string, never> =>
    calls === 1 ? { timeoutMs: COLD_TIMEOUT_MS } : {};

  /** One logical call: a step row around the body. */
  async function inStep<R>(
    key: string,
    node: string,
    body: () => Promise<R>,
  ): Promise<R> {
    calls += 1;
    recorder.startStep(runId, { key, node });
    try {
      const result = await body();
      recorder.finishStep(runId, key, "succeeded");
      return result;
    } catch (err) {
      const kind = kindOf(err);
      recorder.finishStep(
        runId,
        key,
        kind === "cancelled" ? "cancelled" : "failed",
        { kind, detail: String(err) },
      );
      throw err;
    }
  }

  return {
    provider: profile.provider,
    modelId: profile.modelId,
    isLocal: isLocalProvider(profile.provider),
    contextWindow: contextWindowFor(profile.provider, profile.modelId),
    runId,

    async nativeCall(i) {
      const unitKey = uniqueKey(i.unitKey);
      return inStep(unitKey, "chatRoute", async () => {
        const base = {
          step: "chatRoute" as const,
          runId,
          unitKey,
          instructions: i.system,
          messages: i.messages,
          tools: i.tools,
          profile,
          maxOutputTokens: i.maxOutputTokens,
          signal,
          sink: recorder,
          stopped: () => signal.aborted,
          ...(deps.createModel ? { createModel: deps.createModel } : {}),
          ...timeoutFor(),
        };
        let result: CallToolTurnResult;
        try {
          result = await doToolTurn(base);
        } catch (e) {
          // One transport retry, like `callUnit`. The wait holds no lane slot.
          if (!gatewayRetryOn(e) || signal.aborted) throw e;
          const advice = (e as GatewayError).retry;
          if (advice === null) throw e;
          try {
            await sleep(advice.waitMs, signal);
          } catch {
            throw new CancelledError({
              message: "Cancelled during the retry wait.",
              facts: blankFacts({
                step: "chatRoute",
                unitKey,
                modelRequested: profile.modelId,
              }),
              phase: "queued",
            });
          }
          result = await doToolTurn({
            ...base,
            retry: { kind: (e as GatewayError).kind as GatewayErrorKind },
          });
        }
        return result.kind === "call"
          ? { kind: "call", name: result.name, args: result.args }
          : { kind: "none", text: result.text };
      });
    },

    async structured<T>(i: {
      step: "chatRoute" | "chatSlots" | "chatAnswer";
      unitKey: string;
      schema: StepSchema<T>;
      system: string;
      messages: ChatTurn[];
      maxOutputTokens: number;
    }) {
      const unitKey = uniqueKey(i.unitKey);
      return inStep(unitKey, i.step, async () => {
        const r = await callUnit(
          {
            step: i.step,
            runId,
            unitKey,
            chunkIndex: null,
            schema: i.schema,
            instructions: i.system,
            messages: i.messages,
            profile,
            maxOutputTokens: i.maxOutputTokens,
            signal,
            ...timeoutFor(),
          },
          ctx,
          unitDeps,
        );
        return {
          object: r.object,
          finishReason: r.finishReason,
          usage: r.usage,
          latencyMs: r.latencyMs,
        };
      });
    },

    calls: () => calls,

    finish(status, detail) {
      if (finished) return;
      finished = true;
      recorder.finishRun(runId, status, {
        errorKind: detail?.errorKind ?? null,
        errorDetail: detail?.errorDetail ?? null,
        result: { calls },
        lostRecords: 0,
        finishedAt: now(),
      });
    },
  };
}
