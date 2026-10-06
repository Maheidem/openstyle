import { zValidator } from "@hono/zod-validator";
import {
  addCustomMlxModelSchema,
  mlxSearchQuerySchema,
  serverStartSchema,
} from "@openstyle/validations";
import type { Context } from "hono";
import { Hono } from "hono";
import {
  isAppleSiliconMac,
  MLX_ASR_PROVIDER_ID,
  MLX_ASR_PROVIDER_NAME,
  MLX_UNSUPPORTED_PLATFORM_REASON,
} from "../lib/mlx-asr/constants.js";
import {
  addCustomModel,
  searchMlxModels,
  validateCustomModel,
} from "../lib/mlx-asr/custom-validate.js";
import { CustomModelError } from "../lib/mlx-asr/hf-http.js";
import {
  cancelMlxDownload,
  clearMlxDownloadError,
  deleteMlxModel,
  downloadMlxModel,
  getAllMlxModelStatuses,
  getMlxCatalogModels,
  getMlxModelStatus,
} from "../lib/mlx-asr/models.js";
import {
  describeMlxSetupBlocker,
  resetPythonProbe,
} from "../lib/mlx-asr/python.js";
import {
  getMlxRuntimeDownloadStatus,
  isMlxRuntimeInstallable,
} from "../lib/mlx-asr/runtime.js";
import {
  canRunMlxAsr,
  getMlxAsrKeepAliveMinutes,
  startMlxInBackground,
  stopMlxServer,
} from "../lib/mlx-asr/server.js";
import { getDefaultModels } from "../lib/providers.js";
import { stripProviderPrefix } from "../lib/streaming/types.js";

/** Keep the `{ error, code }` shape when the body or query fails the schema. */
function invalidInput(
  result: { success: boolean },
  c: Context,
): Response | undefined {
  if (result.success) return undefined;
  return c.json({ error: "Invalid input", code: "invalid_input" }, 400);
}

/** Map a custom model failure to `{ error, code, ...extra }`. */
function customModelError(c: Context, err: unknown) {
  if (!(err instanceof CustomModelError)) throw err;
  return c.json(
    { error: err.message, code: err.code, ...err.extra },
    err.status,
  );
}

const mlxAsr = new Hono()
  .get("/status", (c) => {
    if (c.req.query("refresh") === "1") {
      resetPythonProbe();
    }

    const platformSupported = isAppleSiliconMac();
    const blockedReason = describeMlxSetupBlocker();

    return c.json({
      platformSupported,
      canRun: canRunMlxAsr(),
      blockedReason,
      keepAliveMinutes: getMlxAsrKeepAliveMinutes(),
      runtime: getMlxRuntimeDownloadStatus(),
      models: platformSupported ? getAllMlxModelStatuses() : [],
      modelDefinitions: platformSupported
        ? getMlxCatalogModels().map((m) => ({
            id: m.id,
            hfId: m.hfId,
            family: m.family,
            displayName: m.displayName,
            sizeBytes: m.sizeBytes,
            ramRequired: m.ramRequired,
            speed: m.speed,
            quality: m.quality,
            quantized: m.quantized,
            custom: m.custom,
          }))
        : [],
      setupHint: platformSupported
        ? (blockedReason ??
          `Press Download on a ${MLX_ASR_PROVIDER_NAME} model to fetch weights.`)
        : MLX_UNSUPPORTED_PLATFORM_REASON,
    });
  })
  .get(
    "/search",
    zValidator("query", mlxSearchQuerySchema, invalidInput),
    async (c) => {
      try {
        return c.json(await searchMlxModels(c.req.valid("query").q));
      } catch (err) {
        return customModelError(c, err);
      }
    },
  )
  .post(
    "/custom-models/validate",
    zValidator("json", addCustomMlxModelSchema, invalidInput),
    async (c) => {
      try {
        const { hfId, family, totalBytes, revision } =
          await validateCustomModel(c.req.valid("json").model);
        return c.json({ hfId, family, totalBytes, revision });
      } catch (err) {
        return customModelError(c, err);
      }
    },
  )
  .post(
    "/custom-models",
    zValidator("json", addCustomMlxModelSchema, invalidInput),
    async (c) => {
      try {
        return c.json(await addCustomModel(c.req.valid("json").model), 201);
      } catch (err) {
        return customModelError(c, err);
      }
    },
  )
  .post("/models/:model/download", async (c) => {
    const modelId = c.req.param("model");

    const status = getMlxModelStatus(modelId);
    if (!status) {
      return c.json({ error: `Unknown MLX ASR model: ${modelId}` }, 400);
    }

    if (status.status === "ready") {
      return c.json({ ok: true, message: "Model already downloaded" });
    }

    if (status.status === "downloading") {
      return c.json({ ok: true, message: "Download already in progress" });
    }

    if (
      status.status === "error" &&
      !canRunMlxAsr() &&
      !isMlxRuntimeInstallable()
    ) {
      return c.json({ error: status.error ?? "MLX ASR is not available" }, 400);
    }

    clearMlxDownloadError(modelId);
    downloadMlxModel(modelId).catch(() => {});

    return c.json({ ok: true, message: "Download started" });
  })
  .post("/models/:model/cancel", (c) => {
    const modelId = c.req.param("model");
    const cancelled = cancelMlxDownload(modelId);
    return c.json({ ok: cancelled });
  })
  .delete("/models/:model", (c) => {
    const modelId = c.req.param("model");
    const deleted = deleteMlxModel(modelId);
    return c.json({ ok: deleted });
  })
  .post("/server/start", zValidator("json", serverStartSchema), async (c) => {
    let modelId = c.req.valid("json").modelId;

    if (!modelId) {
      const defaults = getDefaultModels();
      if (defaults.voice?.provider === MLX_ASR_PROVIDER_ID) {
        modelId = stripProviderPrefix(defaults.voice.model_id);
      }
    }

    if (!modelId) {
      return c.json({ error: "No model specified" }, 400);
    }

    if (!canRunMlxAsr()) {
      return c.json(
        {
          error:
            describeMlxSetupBlocker() ??
            "MLX ASR is not available. Install Python 3.12+ and mlx-audio (pip install mlx-audio).",
        },
        400,
      );
    }

    const status = getMlxModelStatus(modelId);
    if (!status || status.status !== "ready") {
      return c.json({ error: "MLX ASR model is not downloaded yet." }, 400);
    }

    startMlxInBackground(modelId);
    return c.json({ ok: true });
  })
  .post("/server/stop", async (c) => {
    await stopMlxServer();
    return c.json({ ok: true });
  });

export default mlxAsr;
