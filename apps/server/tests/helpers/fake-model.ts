import { MockLanguageModelV4 } from "ai/test";

// A scripted language model for the gateway tests (specs/meeting-enhance-agentic.md
// 10.5.1). It enters the gateway through the `createModel` seam. The fake sits
// below the code under test: the real gateway, gate, ledger and recorder run.

export type Unified =
  | "stop"
  | "length"
  | "content-filter"
  | "tool-calls"
  | "error"
  | "other";

/** One scripted answer of the model. */
export interface ScriptedReply {
  unified: Unified;
  raw: string | undefined;
  text: string;
  /** Served model in `response.modelId`. Default: the mock model id. `null`: absent. */
  servedModel?: string | null;
  /** Raw response body, for the refusal and reasoning checks. */
  responseBody?: unknown;
  /** Request body the SDK would have built, for the ledger. */
  requestBody?: unknown;
  reasoningTokens?: number;
  cachedTokens?: number;
  /** Reasoning content parts. */
  reasoningText?: string;
  warnings?: { type: "unsupported"; feature: string }[];
  /** The provider sends no usage numbers. */
  noUsage?: boolean;
}

/** A step that never answers. It ends when the call is aborted. */
export const HANG = Symbol("hang");

export type ScriptStep = ScriptedReply | Error | typeof HANG;

export function reply(
  unified: Unified,
  raw: string | undefined,
  text: string,
  extra: Partial<ScriptedReply> = {},
): ScriptedReply {
  return { unified, raw, text, ...extra };
}

/** A `stop` reply with valid JSON. */
export function okReply(text: string, extra: Partial<ScriptedReply> = {}) {
  return reply("stop", "stop", text, extra);
}

export interface FakeModel {
  model: MockLanguageModelV4;
  /** Requests the model got, one entry per `doGenerate` call. */
  calls: MockLanguageModelV4["doGenerateCalls"];
}

/**
 * A mock model that plays `script` one step per call. A step that is an
 * `Error` is thrown. The last step repeats when the script runs out.
 */
export function scriptedModel(
  modelId: string,
  script: ScriptStep[],
  provider = "fake.chat",
): FakeModel {
  let n = 0;
  const model = new MockLanguageModelV4({
    provider,
    modelId,
    doGenerate: async (options) => {
      const step = script[Math.min(n, script.length - 1)];
      n += 1;
      if (step === undefined) throw new Error("empty script");
      if (step instanceof Error) throw step;
      if (step === HANG) {
        const signal = options.abortSignal;
        await new Promise<never>((_, reject) => {
          const abort = () =>
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            );
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      }
      const r = step as ScriptedReply;
      return {
        content: [
          ...(r.reasoningText
            ? [{ type: "reasoning" as const, text: r.reasoningText }]
            : []),
          { type: "text" as const, text: r.text },
        ],
        finishReason: { unified: r.unified, raw: r.raw },
        usage: r.noUsage
          ? {
              inputTokens: {
                total: undefined,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: {
                total: undefined,
                text: undefined,
                reasoning: undefined,
              },
            }
          : {
              inputTokens: {
                total: 120,
                noCache: 120 - (r.cachedTokens ?? 0),
                cacheRead: r.cachedTokens ?? 0,
                cacheWrite: 0,
              },
              outputTokens: {
                total: 30,
                text: 30 - (r.reasoningTokens ?? 0),
                reasoning: r.reasoningTokens ?? 0,
              },
            },
        warnings: r.warnings ?? [],
        response: {
          ...(r.servedModel === null
            ? {}
            : { modelId: r.servedModel ?? modelId }),
          ...(r.responseBody !== undefined ? { body: r.responseBody } : {}),
        },
        ...(r.requestBody !== undefined
          ? { request: { body: r.requestBody } }
          : {}),
      };
    },
  });
  return { model, calls: model.doGenerateCalls };
}

/** The `createModel` seam of the gateway for a ready model. */
export function seamFor(model: MockLanguageModelV4) {
  return async () => model;
}
