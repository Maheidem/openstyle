import type { LanguageModel } from "ai";
import { getApiKey } from "./api-keys.js";
import {
  reconcileRetiredCloudLlmModels,
  retiredReplacement,
  warnRetiredOnce,
} from "./cloud-models.js";
import { getDb } from "./db.js";
import type { LlmTaskContext } from "./llm/registry.js";
import { getLlmProvider, isLocalProvider } from "./llm/registry.js";
import { reconcileUnsupportedMlxVoiceDefault } from "./mlx-asr/reconcile.js";
import { MLX_LLM_PROVIDER_ID } from "./mlx-llm/constants.js";
import { reconcileRemovedMlxLlmModels } from "./mlx-llm/reconcile.js";
import { stripModelPrefix } from "./model-id.js";

const PROVIDER_PREFIXED_CHAT_MODELS = new Set([
  "openai",
  "anthropic",
  "google",
  "mistral",
  "openrouter",
  "vercel",
  "server",
  MLX_LLM_PROVIDER_ID,
]);

function getChatModelId(providerId: string, modelId: string): string {
  return PROVIDER_PREFIXED_CHAT_MODELS.has(providerId)
    ? stripModelPrefix(providerId, modelId)
    : modelId;
}

interface DefaultModels {
  voice: { provider: string; model_id: string; model_name: string } | null;
  llm: { provider: string; model_id: string; model_name: string } | null;
}

export function getDefaultModels(): DefaultModels {
  reconcileUnsupportedMlxVoiceDefault();
  reconcileRemovedMlxLlmModels();
  reconcileRetiredCloudLlmModels();
  const db = getDb();
  const voice = db
    .prepare(
      "SELECT provider, model_id, model_name FROM model_configs WHERE type = 'voice' AND is_default = 1 LIMIT 1",
    )
    .get() as
    | { provider: string; model_id: string; model_name: string }
    | undefined;
  const llm = db
    .prepare(
      "SELECT provider, model_id, model_name FROM model_configs WHERE type = 'llm' AND is_default = 1 LIMIT 1",
    )
    .get() as
    | { provider: string; model_id: string; model_name: string }
    | undefined;

  return {
    voice: voice ?? null,
    llm: llm ?? null,
  };
}

export async function createChatModel(
  providerId: string,
  modelId: string,
  taskContext?: LlmTaskContext,
): Promise<LanguageModel> {
  const provider = getLlmProvider(providerId);
  if (!provider) throw new Error(`Unsupported provider: ${providerId}`);

  const isLocal = isLocalProvider(providerId);
  const apiKey = isLocal ? "local" : getApiKey(providerId);
  if (!apiKey)
    throw new Error(`No API key configured for provider: ${providerId}`);

  // A retired id fails at the provider. Use its replacement and say so, for
  // callers that hold an id the default reconcile did not rewrite.
  const retired = retiredReplacement(providerId, modelId);
  if (retired) warnRetiredOnce(providerId, modelId, retired.message);

  return provider.createModel(
    getChatModelId(providerId, retired ? retired.modelId : modelId),
    apiKey,
    taskContext,
  );
}
