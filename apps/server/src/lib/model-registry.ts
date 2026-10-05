/**
 * The models.dev registry: one in-memory cache, the cost lookup and the
 * cleanup-model support check. Lives in lib so lib code does not import
 * from routes. The cost lookup is cache-only on purpose (see
 * {@link getModelCostCached}).
 */
import { isLocalProvider } from "./llm/registry.js";
import { stripModelPrefix } from "./model-id.js";

export const DEPRECATED_STATUS = "deprecated";
export const REGISTRY_FETCH_TIMEOUT_MS = 3000;
const UNSUITABLE_CLEANUP_MODEL_PATTERN =
  /guard|safeguard|safety|moderation|classif(?:y|ier|ication)?|embed(?:ding)?|image/i;

interface RegistryModel {
  id: string;
  name: string;
  family?: string;
  modalities?: { input?: string[]; output?: string[] };
  cost?: { input?: number; output?: number };
  status?: string;
  [key: string]: unknown;
}

export interface RegistryProvider {
  id: string;
  name: string;
  models?: Record<string, RegistryModel>;
  [key: string]: unknown;
}

export function isCleanupSuitableModel(model: RegistryModel): boolean {
  const searchable = [model.id, model.name, model.family ?? ""].join(" ");
  return !UNSUITABLE_CLEANUP_MODEL_PATTERN.test(searchable);
}

// OpenAI-compatible LLM gateways (aggregators fronting many vendors' models).
// Their catalogs live in models.dev under a single provider key, so they flow
// through the same registry loop as first-party vendors — no key required to
// list them. Models are tagged with the gateway's display name (badge in the
// picker) and stay non-curated (behind "Show all models"). Add any future
// gateway here and it works end to end with no further wiring.
export const LLM_GATEWAYS: Record<string, string> = {
  openrouter: "OpenRouter",
  vercel: "Vercel AI Gateway",
};

// In-memory cache for models.dev data
let modelsCache: { data: unknown; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/** True when the in-memory registry cache is present and unexpired. */
function isRegistryCacheFresh(): boolean {
  return !!modelsCache && Date.now() - modelsCache.fetchedAt < CACHE_TTL_MS;
}

export async function fetchModelsFromRegistry(): Promise<
  Record<string, unknown>
> {
  if (isRegistryCacheFresh()) {
    return (modelsCache as { data: unknown }).data as Record<string, unknown>;
  }

  const res = await fetch("https://models.dev/api.json", {
    signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch models.dev: ${res.status}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  modelsCache = { data, fetchedAt: Date.now() };
  return data;
}

/**
 * Warm the models.dev registry cache in the background (fire-and-forget).
 * Called from the transcribe pre-warm route while the user is still speaking so
 * the per-dictation cost lookup ({@link getModelCostCached}) hits a warm cache
 * and never blocks the response on a network round-trip. No-op when the cache
 * is already fresh; swallows errors (cost is non-critical).
 */
export function prewarmModelCostRegistry(): void {
  if (isRegistryCacheFresh()) return;
  void fetchModelsFromRegistry().catch(() => {
    // Best-effort — a failed warm just means the next cost lookup returns null.
  });
}

/**
 * Pull per-token cost for a model out of an already-fetched registry object.
 * Costs in the registry are per-million tokens; returned values are per-token.
 * Provider is taken from the models.dev provider key, not parsed from model ID.
 */
function lookupCostInRegistry(
  registry: Record<string, unknown>,
  providerId: string,
  modelId: string,
): { input: number; output: number } | null {
  const provider = registry[providerId] as RegistryProvider | undefined;
  if (!provider?.models) return null;

  const shortId = stripModelPrefix(providerId, modelId);
  const model = provider.models[modelId] ?? provider.models[shortId] ?? null;
  if (!model?.cost) return null;

  return {
    input: (model.cost.input ?? 0) / 1_000_000,
    output: (model.cost.output ?? 0) / 1_000_000,
  };
}

/**
 * Synchronous, cache-only cost lookup for the transcription hot path. Never
 * triggers a network fetch: on a cold/expired cache it returns null (cost is
 * recorded as 0) rather than stalling the user-facing response on a models.dev
 * round-trip. Warm the cache ahead of time via {@link prewarmModelCostRegistry}.
 */
export function getModelCostCached(
  providerId: string,
  modelId: string,
): { input: number; output: number } | null {
  if (!isRegistryCacheFresh() || !modelsCache) return null;
  try {
    return lookupCostInRegistry(
      modelsCache.data as Record<string, unknown>,
      providerId,
      modelId,
    );
  } catch {
    return null;
  }
}

export async function isCleanupModelSupported(
  providerId: string,
  modelId: string,
): Promise<boolean> {
  if (isLocalProvider(providerId)) return true;
  if (providerId in LLM_GATEWAYS) return true;

  try {
    const registry = await fetchModelsFromRegistry();
    const provider = registry[providerId] as RegistryProvider | undefined;
    if (!provider?.models) return false;

    const shortId = stripModelPrefix(providerId, modelId);
    const model = provider.models[modelId] ?? provider.models[shortId] ?? null;
    if (!model) return false;

    const inputMods = model.modalities?.input ?? [];
    const outputMods = model.modalities?.output ?? [];
    return (
      model.status !== DEPRECATED_STATUS &&
      inputMods.includes("text") &&
      outputMods.includes("text") &&
      isCleanupSuitableModel(model)
    );
  } catch {
    return true;
  }
}
