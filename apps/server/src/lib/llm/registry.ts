import type { GroqLanguageModelOptions } from "@ai-sdk/groq";
import type { PostProcessParams } from "@openstyle/stt";
import type { CleanupSampling } from "@openstyle/validations";
import type { LanguageModel } from "ai";
import { getDb } from "../db.js";
import { traceLlmFetch } from "../trace.js";

/** The provider-options shape accepted by the cleanup `generateText` call. */
type CleanupProviderOptions = NonNullable<PostProcessParams["providerOptions"]>;

/**
 * Per-task context threaded into `createModel` (specs/llm-task-profiles.md
 * §8.1). `sampling` is the resolver's already-merged verbatim sampling object
 * (§8.3) — only `local-llm`'s entry reads it; every other provider ignores
 * the parameter entirely.
 */
export interface LlmTaskContext {
  task: string;
  sampling: Record<string, unknown>;
}

/**
 * A cleanup/post-processing LLM backend. Mirrors the transcription
 * `TranscriptionProvider` shape: adding a provider is a single descriptor in
 * the registry below. Provider SDKs are imported lazily inside `createModel`
 * so pulling in this module at boot doesn't eagerly evaluate every `@ai-sdk/*`
 * package.
 */
export interface LlmProvider {
  readonly providerId: string;
  /** Local endpoints resolve their own credentials rather than a stored key. */
  readonly local?: boolean;
  /**
   * Build (or return a cached) chat model. `modelId` is already stripped of the
   * provider prefix for prefixed providers; `apiKey` is `"local"` for local
   * providers. `taskContext` (§8.1) carries the resolver's per-task sampling
   * params; only `local-llm`'s entry reads it.
   */
  createModel(
    modelId: string,
    apiKey: string,
    taskContext?: LlmTaskContext,
  ): Promise<LanguageModel> | LanguageModel;
  /** Per-model provider options merged into the cleanup `generateText` call.
   *  `reasoningEnabled` (§6.4, §7.3) comes from the resolved task profile. */
  providerOptions?(
    modelId: string,
    reasoningEnabled: boolean,
  ): CleanupProviderOptions | undefined;
  /** Warm the connection while the user is still speaking. */
  prewarm?(modelId: string): void;
}

function stripGroqPrefix(modelId: string): string {
  return modelId.startsWith("groq/") ? modelId.slice("groq/".length) : modelId;
}

/**
 * Reasoning-mode flags for Groq models that would otherwise emit visible
 * chain-of-thought or spend latency on reasoning we don't want during cleanup.
 *
 * Task-aware (specs/llm-task-profiles.md §7.3): `reasoningEnabled` comes from
 * the resolved task profile (§6.4), not a cleanup-only assumption. The
 * `false` branch stays **per-family** — `qwen/qwen3-32b` keeps `"none"`,
 * `openai/gpt-oss-{20b,120b}` keep `"low"` — because those are not the same
 * value; collapsing both families to one constant would silently downgrade
 * gpt-oss's reasoning effort from `"low"` to `"none"` for every v1 task
 * (all default `reasoningEnabled: false`) with no UI interaction and no
 * changelog-worthy intent behind it. `reasoningEnabled: false` reproduces
 * today's exact behavior for both model families, byte for byte; the `true`
 * branch (`"medium"` for both) is new and reachable only via a future task
 * profile or per-task override that sets `reasoningEnabled: true`.
 */
export function groqCleanupProviderOptions(
  modelId: string,
  reasoningEnabled: boolean,
): { groq: GroqLanguageModelOptions } | undefined {
  const shortId = stripGroqPrefix(modelId);

  switch (shortId) {
    case "qwen/qwen3-32b":
      return {
        groq: {
          reasoningFormat: "hidden",
          reasoningEffort: reasoningEnabled ? "medium" : "none",
        },
      };
    case "openai/gpt-oss-20b":
    case "openai/gpt-oss-120b":
      return {
        groq: {
          reasoningFormat: "hidden",
          reasoningEffort: reasoningEnabled ? "medium" : "low",
        },
      };
    default:
      return undefined;
  }
}

/**
 * Merge user-chosen sampling parameters into an outgoing chat-completions body.
 *
 * `top_k`, `min_p`, `repetition_penalty` and `chat_template_kwargs` have no
 * route through the AI SDK — `topK` is dropped with an `unsupported` warning
 * and `providerOptions` silently strips keys its schema doesn't know — so they
 * are written onto the wire body instead.
 *
 * The sampling params are spread LAST so they win over what the SDK built:
 * cleanup hardcodes `temperature: 0`, and reversing the order would silently
 * discard the user's temperature. Anything that isn't a JSON object is
 * returned untouched, so a surprise body shape degrades to "send as-is".
 */
export function mergeSamplingIntoBody(
  body: string,
  sampling: CleanupSampling,
): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return body;
    }
    const merged: Record<string, unknown> = { ...parsed, ...sampling };

    // max_tokens is a floor, not a cap. The user sets it to give a thinking
    // model room to reason; the caller computes it from the input length. Every
    // local-llm path shares this fetch, and Remix legitimately needs a bigger
    // budget than cleanup and has no truncation fallback -- a literal override
    // tuned for cleanup would silently cut its rewrites short.
    if (typeof sampling.max_tokens === "number") {
      const computed = (parsed as { max_tokens?: unknown }).max_tokens;
      merged.max_tokens =
        typeof computed === "number"
          ? Math.max(computed, sampling.max_tokens)
          : sampling.max_tokens;
    }

    return JSON.stringify(merged);
  } catch {
    return body;
  }
}

/**
 * A `fetch` wrapper for `createOpenAI` that rewrites the request body with the
 * user's sampling params. The SDK's `postToApi` hands the body over as an
 * already-serialized JSON string, hence the parse/merge/stringify round trip.
 *
 * It also writes the trace-log entry for this boundary, and does so *after* the
 * merge — this is the only place that sees the body exactly as it goes on the
 * wire, sampling params included. With no sampling configured the body is
 * passed through byte-for-byte and only the trace is written.
 */
export function createSamplingFetch(
  sampling: CleanupSampling,
): typeof globalThis.fetch {
  const hasSampling = Object.keys(sampling).length > 0;
  return (input, init) => {
    if (!hasSampling || typeof init?.body !== "string") {
      return traceLlmFetch(input, init);
    }
    return traceLlmFetch(input, {
      ...init,
      body: mergeSamplingIntoBody(init.body, sampling),
    });
  };
}

const PROVIDERS: LlmProvider[] = [
  {
    providerId: "openai",
    createModel: async (modelId, apiKey) => {
      const { createOpenAI } = await import("@ai-sdk/openai");
      return createOpenAI({ apiKey }).chat(modelId);
    },
  },
  {
    providerId: "groq",
    // Uses the cached, keep-alive Groq client which resolves its own key.
    createModel: async (modelId) => {
      const { getGroqChatModel } = await import("../groq-http.js");
      return getGroqChatModel(modelId);
    },
    providerOptions: (modelId, reasoningEnabled) =>
      groqCleanupProviderOptions(modelId, reasoningEnabled),
    prewarm: (modelId) => {
      void import("../groq-http.js").then(({ prewarmGroqConnection }) =>
        prewarmGroqConnection(stripGroqPrefix(modelId)),
      );
    },
  },
  {
    providerId: "anthropic",
    createModel: async (modelId, apiKey) => {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      return createAnthropic({ apiKey }).chat(modelId);
    },
  },
  {
    providerId: "google",
    createModel: async (modelId, apiKey) => {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      return createGoogleGenerativeAI({ apiKey }).chat(modelId);
    },
  },
  {
    providerId: "mistral",
    createModel: async (modelId, apiKey) => {
      const { createMistral } = await import("@ai-sdk/mistral");
      return createMistral({ apiKey }).chat(modelId);
    },
  },
  {
    // OpenRouter is an AI gateway exposing an OpenAI-compatible
    // chat-completions API. Model IDs are stored prefixed as
    // `openrouter/<vendor>/<model>` and stripped to `<vendor>/<model>` before
    // being handed to the gateway (see `PROVIDER_PREFIXED_CHAT_MODELS`).
    providerId: "openrouter",
    createModel: async (modelId, apiKey) => {
      const { createOpenAI } = await import("@ai-sdk/openai");
      return createOpenAI({
        apiKey,
        baseURL: "https://openrouter.ai/api/v1",
      }).chat(modelId);
    },
  },
  {
    // Vercel AI Gateway — OpenAI-compatible chat-completions API. Model IDs are
    // `<vendor>/<model>` (e.g. `anthropic/claude-opus-4.8`), used as-is.
    providerId: "vercel",
    createModel: async (modelId, apiKey) => {
      const { createOpenAI } = await import("@ai-sdk/openai");
      return createOpenAI({
        apiKey,
        baseURL: "https://ai-gateway.vercel.sh/v1",
      }).chat(modelId);
    },
  },
  {
    providerId: "local-llm",
    local: true,
    createModel: async (modelId, _apiKey, taskContext) => {
      const { createOpenAI } = await import("@ai-sdk/openai");
      const db = getDb();
      const urlRow = db
        .prepare("SELECT value FROM settings WHERE key = 'local_llm_url'")
        .get() as { value: string } | undefined;
      if (!urlRow?.value) {
        throw new Error(
          "Local LLM endpoint URL not configured. Go to Settings > Models to set it up.",
        );
      }
      const keyRow = db
        .prepare("SELECT value FROM settings WHERE key = 'local_llm_api_key'")
        .get() as { value: string } | undefined;

      const baseURL = urlRow.value.replace(/\/v1\/?$/, "");
      const apiKey = keyRow?.value || "local";

      // No more direct `cleanup_sampling` read here — the caller already
      // resolved this task's sampling params (`resolveTaskCall`,
      // specs/llm-task-profiles.md §8.3) and hands them in via
      // `taskContext.sampling`. A call site that doesn't pass `taskContext`
      // gets no sampling merge, same as an empty object.
      return createOpenAI({
        apiKey,
        baseURL: `${baseURL}/v1`,
        // Always intercepted: this wrapper is what writes the trace log, and
        // it is the only point that sees the final post-merge request body.
        // With no sampling configured it forwards the body untouched.
        fetch: createSamplingFetch(
          (taskContext?.sampling ?? {}) as CleanupSampling,
        ),
      }).chat(modelId);
    },
  },
];

const providerMap = new Map(PROVIDERS.map((p) => [p.providerId, p]));

/**
 * Resolve a cleanup LLM provider by id, matching an exact id first and then
 * falling back to a prefix match (e.g. `"openai/gpt-4o-mini"` → `openai`).
 */
export function getLlmProvider(providerId: string): LlmProvider | null {
  const exact = providerMap.get(providerId);
  if (exact) return exact;
  for (const provider of PROVIDERS) {
    if (providerId.startsWith(provider.providerId)) return provider;
  }
  return null;
}
