import { createAppLogger } from "@openstyle/utils";
import {
  REMIX_CLIENT_TOOLS,
  type RemixAgentRequest,
} from "@openstyle/validations";
import {
  convertToModelMessages,
  type FlexibleSchema,
  stepCountIs,
  streamText,
  type ToolSet,
  tool,
  type UIMessage,
} from "ai";
import { buildRemixAgentSystem } from "./editor/remix-prompts.js";
import { getLlmProvider } from "./llm/registry.js";
import { resolveTaskCall } from "./llm/task-profiles.js";
import { createChatModel } from "./providers.js";

const log = createAppLogger("remix-agent");

/** Primitive tools mean more, smaller steps: a canvas-app edit costs 6-8
 * calls before verification. A run that hasn't converged in 16 is lost. */
export const REMIX_MAX_STEPS = 16;

/**
 * The agent loop has no per-step "input length" to scale an output budget
 * off the way a one-shot rewrite does (specs/llm-task-profiles.md §8.2) —
 * a flat, generous constant sized to comfortably cover one step's worth of
 * text plus a tool call, not the whole `REMIX_MAX_STEPS`-step budget.
 * Proposed, not measured — revisit after real agent-loop output sizes are
 * observed (spec §12 open question 2).
 */
export const REMIX_AGENT_AUTO_MAX_OUTPUT_TOKENS = 4096;

/**
 * The client-side tools, as AI SDK declarations. No `execute`: the loop
 * pauses at the call, the call streams to the renderer, the renderer executes
 * it against the document and re-sends the thread with the result appended.
 */
export function remixClientTools(): ToolSet {
  return Object.fromEntries(
    Object.entries(REMIX_CLIENT_TOOLS).map(([name, def]) => [
      name,
      tool({
        description: def.description,
        // The per-tool schema types are a union across the map; the cast keeps
        // tool()'s generic from collapsing it to never. Validation still runs
        // against each tool's own zod schema at call time.
        inputSchema: def.inputSchema as FlexibleSchema<Record<string, unknown>>,
      }),
    ]),
  );
}

export interface ByokModelChoice {
  provider: string;
  model_id: string;
}

/**
 * The agent loop on the user's own model. Identical shape to the cloud run —
 * same system prompt, same client tools — minus the server tools (web search
 * is a cloud capability) and minus metering.
 */
export async function runRemixAgentLocally(
  request: RemixAgentRequest,
  // Retained for the route's own pre-flight `isCleanupModelSupported` gate
  // (routes/remix/agent.ts) — the actual model/params used here are resolved
  // fresh below via the "remix" task profile, which independently falls back
  // to the same app-wide default this was built from unless a per-task model
  // override is assigned (specs/llm-task-profiles.md §6.3).
  _llm: ByokModelChoice,
  abortSignal: AbortSignal | undefined,
): Promise<Response> {
  const resolved = await resolveTaskCall("remix", {
    autoMaxOutputTokens: REMIX_AGENT_AUTO_MAX_OUTPUT_TOKENS,
  });
  const providerOptions = getLlmProvider(resolved.provider)?.providerOptions?.(
    resolved.modelId,
    resolved.reasoningEnabled,
  );
  const combinedSignal = AbortSignal.any(
    [abortSignal, AbortSignal.timeout(resolved.timeoutMs)].filter(
      (s): s is AbortSignal => s != null,
    ),
  );

  const result = streamText({
    model: await createChatModel(resolved.provider, resolved.modelId, {
      task: "remix",
      sampling: resolved.samplingParams,
    }),
    system: buildRemixAgentSystem(request.context, { hasWebSearch: false }),
    messages: await convertToModelMessages(request.messages as UIMessage[]),
    tools: remixClientTools(),
    stopWhen: stepCountIs(REMIX_MAX_STEPS),
    temperature: resolved.temperature,
    maxOutputTokens: resolved.maxOutputTokens,
    abortSignal: combinedSignal,
    ...(providerOptions ? { providerOptions } : {}),
    onError: ({ error }) => {
      log.error(`Remix agent (BYOK) stream error: ${error}`);
    },
  });

  return result.toUIMessageStreamResponse({
    onError: (error) => {
      log.error(
        `Remix agent (BYOK) failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return "Remix failed.";
    },
  });
}
