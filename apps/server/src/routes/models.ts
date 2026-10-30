import { zValidator } from "@hono/zod-validator";
import { configureModelSchema } from "@openstyle/validations";
import { Hono } from "hono";
import { z } from "zod";
import {
  CLOUD_LLM_LINEUP,
  CLOUD_VOICE_LINEUP,
  CURATED_LLM_IDS,
  dismissRetiredNotice,
  legacyNotice,
  listRetiredNotices,
  reconcileRetiredCloudLlmModels,
} from "../lib/cloud-models.js";
import { getDb } from "../lib/db.js";
import {
  MLX_ASR_PROVIDER_ID,
  MLX_ASR_PROVIDER_NAME,
} from "../lib/mlx-asr/constants.js";
import {
  getMlxCatalogModels,
  getMlxModelStatus,
} from "../lib/mlx-asr/models.js";
import { reconcileUnsupportedMlxVoiceDefault } from "../lib/mlx-asr/reconcile.js";
import {
  MLX_LLM_MODELS,
  MLX_LLM_PROVIDER_ID,
  MLX_LLM_PROVIDER_NAME,
} from "../lib/mlx-llm/constants.js";
import { getMlxLlmModelStatus } from "../lib/mlx-llm/models.js";
import { reconcileRemovedMlxLlmModels } from "../lib/mlx-llm/reconcile.js";
import { applyMlxLlmRetentionPolicy } from "../lib/mlx-llm/server.js";
import { listModelDiskUse } from "../lib/model-disk-usage.js";
import {
  DEPRECATED_STATUS,
  fetchModelsFromRegistry,
  isCleanupSuitableModel,
  LLM_GATEWAYS,
  type RegistryProvider,
} from "../lib/model-registry.js";
import { WHISPER_PROVIDER_ID } from "../lib/whisper/constants.js";
import { getCatalogModels, getModelStatus } from "../lib/whisper/models.js";

interface AvailableModel {
  provider_id: string;
  provider_name: string;
  model_id: string;
  model_name: string;
  family: string;
  type: "voice" | "llm";
  cost_input?: number;
  cost_output?: number;
  /** Surfaced in the default picker; non-curated models live behind "All models". */
  curated?: boolean;
  /** A short note for a model the provider plans to remove. */
  notice?: string;
  /**
   * Display name of the LLM gateway fronting this model (e.g. "OpenRouter"),
   * when the provider is an aggregator rather than a first-party vendor. The
   * picker shows this as a small badge next to the model.
   */
  gateway?: string;
}

/** The `notice` field of a legacy cloud model, or nothing. */
function legacyField(providerId: string, modelId: string): { notice?: string } {
  const notice = legacyNotice(providerId, modelId);
  return notice ? { notice } : {};
}

/** Build the /available entry for a local voice model. */
function toVoiceModel(
  def: { id: string; displayName: string },
  providerId: string,
  providerName: string,
  family: string,
): AvailableModel {
  return {
    provider_id: providerId,
    provider_name: providerName,
    model_id: `${providerId}/${def.id}`,
    model_name: def.displayName,
    family,
    type: "voice",
    cost_input: 0,
    cost_output: 0,
    curated: true,
  };
}

// Curated voice catalog: the cloud speech-to-text line-up (lib/cloud-models.ts).
// The models.dev registry is deliberately NOT merged for voice: untested model
// noise.
const BUILTIN_VOICE_MODELS: AvailableModel[] = CLOUD_VOICE_LINEUP.map((m) => ({
  provider_id: m.providerId,
  provider_name: m.providerName,
  model_id: m.modelId,
  model_name: m.name,
  family: m.family,
  type: "voice",
  ...legacyField(m.providerId, m.modelId),
}));

// Cleanup-LLM providers the app can actually run (see lib/providers.ts).
const SUPPORTED_LLM_PROVIDERS = new Set([
  "openai",
  "anthropic",
  "google",
  "groq",
  "mistral",
  ...Object.keys(LLM_GATEWAYS),
]);

// The curated line-up (lib/cloud-models.ts) is shown by default. Everything
// else from the registry sits behind the picker's "All models" expander. The
// line-up is also merged in when the registry has no entry for it, so a new
// model shows up when models.dev is late or offline.
const BUILTIN_LLM_MODELS: AvailableModel[] = CLOUD_LLM_LINEUP.map((m) => ({
  provider_id: m.providerId,
  provider_name: m.providerName,
  model_id: m.id,
  model_name: m.name,
  family: m.family,
  type: "llm",
  cost_input: m.costInput,
  cost_output: m.costOutput,
  curated: true,
}));

const models = new Hono()
  .get("/available", async (c) => {
    try {
      const available: AvailableModel[] = [];

      // Cleanup LLMs come from the registry, restricted to providers the app
      // can actually run. Voice is curated-only (no registry merge). A registry
      // outage must not take the curated/local catalog down with it.
      let registry: Record<string, unknown> = {};
      try {
        registry = await fetchModelsFromRegistry();
      } catch {
        // offline / models.dev unreachable — curated lists still work
      }
      for (const [providerId, providerData] of Object.entries(registry)) {
        if (!SUPPORTED_LLM_PROVIDERS.has(providerId)) continue;
        const provider = providerData as RegistryProvider;
        if (!provider.models) continue;

        for (const [, model] of Object.entries(provider.models)) {
          if (model.status === DEPRECATED_STATUS) continue;

          const inputMods = model.modalities?.input ?? [];
          const outputMods = model.modalities?.output ?? [];
          const isLLM =
            inputMods.includes("text") && outputMods.includes("text");

          if (isLLM && isCleanupSuitableModel(model)) {
            available.push({
              provider_id: providerId,
              provider_name: provider.name ?? providerId,
              model_id: model.id,
              model_name: model.name,
              family: model.family ?? "",
              type: "llm",
              cost_input: model.cost?.input,
              cost_output: model.cost?.output,
              curated: CURATED_LLM_IDS.has(`${providerId}/${model.id}`),
              gateway: LLM_GATEWAYS[providerId],
              ...legacyField(providerId, model.id),
            });
          }
        }
      }

      for (const model of BUILTIN_LLM_MODELS) {
        const exists = available.some(
          (item) =>
            item.provider_id === model.provider_id &&
            item.model_id === model.model_id &&
            item.type === model.type,
        );
        if (!exists) available.push(model);
      }

      // Curated cloud voice models
      available.push(
        ...BUILTIN_VOICE_MODELS.map((m) => ({ ...m, curated: true })),
      );

      // Local voice models. The catalog helpers list the curated models and
      // the legacy models on disk. Only ready models are shown.
      for (const m of getCatalogModels()) {
        if (getModelStatus(m.id)?.status === "ready") {
          available.push(
            toVoiceModel(
              m,
              WHISPER_PROVIDER_ID,
              "Local Whisper",
              "whisper-local",
            ),
          );
        }
      }
      for (const m of getMlxCatalogModels()) {
        if (getMlxModelStatus(m.id)?.status === "ready") {
          available.push(
            toVoiceModel(
              m,
              MLX_ASR_PROVIDER_ID,
              MLX_ASR_PROVIDER_NAME,
              m.family,
            ),
          );
        }
      }

      // The built-in local MLX LLM models. Only ready models are shown.
      for (const m of MLX_LLM_MODELS) {
        if (getMlxLlmModelStatus(m.id)?.status !== "ready") continue;
        available.push({
          provider_id: MLX_LLM_PROVIDER_ID,
          provider_name: MLX_LLM_PROVIDER_NAME,
          model_id: `${MLX_LLM_PROVIDER_ID}/${m.id}`,
          model_name: m.displayName,
          family: m.family,
          type: "llm",
          cost_input: 0,
          cost_output: 0,
          curated: true,
        });
      }

      return c.json(available);
    } catch (err) {
      return c.json(
        { error: "Failed to fetch models", detail: String(err) },
        500,
      );
    }
  })
  // The real disk use of each downloaded app model and the total.
  .get("/disk-usage", (c) => c.json(listModelDiskUse()))
  // Replacements of retired default models that the app has not shown yet.
  .get("/retired-notices", (c) => {
    reconcileRetiredCloudLlmModels();
    return c.json(listRetiredNotices());
  })
  .post(
    "/retired-notices/dismiss",
    zValidator(
      "json",
      z.object({ provider: z.string().min(1), from: z.string().min(1) }),
    ),
    (c) => {
      const { provider, from } = c.req.valid("json");
      dismissRetiredNotice(provider, from);
      return c.json({ ok: true });
    },
  )
  .get("/configured", (c) => {
    reconcileUnsupportedMlxVoiceDefault();
    reconcileRemovedMlxLlmModels();
    reconcileRetiredCloudLlmModels();
    const db = getDb();
    const rows = db
      .prepare(
        "SELECT id, provider, model_id, model_name, type, is_default, created_at FROM model_configs ORDER BY type, is_default DESC, created_at DESC",
      )
      .all() as {
      id: number;
      provider: string;
      model_id: string;
      model_name: string;
      type: string;
      is_default: number;
      created_at: string;
    }[];
    return c.json(rows);
  })
  .post("/configured", zValidator("json", configureModelSchema), (c) => {
    const db = getDb();
    const body = c.req.valid("json");

    // If setting as default, unset any existing default for this type
    if (body.is_default) {
      db.prepare("UPDATE model_configs SET is_default = 0 WHERE type = ?").run(
        body.type,
      );
    }

    const result = db
      .prepare(
        `INSERT INTO model_configs (provider, model_id, model_name, type, is_default)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider, model_id, type) DO UPDATE SET
           model_name = excluded.model_name,
           is_default = excluded.is_default`,
      )
      .run(
        body.provider,
        body.model_id,
        body.model_name,
        body.type,
        body.is_default ? 1 : 0,
      );
    // A new default LLM changes which local model is pinned or kept ready.
    if (body.type === "llm" && body.is_default) applyMlxLlmRetentionPolicy();

    return c.json({ id: result.lastInsertRowid, ...body }, 201);
  })
  .delete("/configured/:id", (c) => {
    const db = getDb();
    const id = Number(c.req.param("id"));

    db.prepare("DELETE FROM model_configs WHERE id = ?").run(id);

    return c.json({ ok: true });
  });

export default models;
