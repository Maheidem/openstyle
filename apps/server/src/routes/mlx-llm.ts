import { zValidator } from "@hono/zod-validator";
import { mlxLlmServerStartSchema } from "@openstyle/validations";
import { Hono } from "hono";
import { deleteBlockedResponse } from "../lib/local-model-delete.js";
import {
  isAppleSiliconMac,
  MLX_UNSUPPORTED_PLATFORM_REASON,
} from "../lib/mlx-asr/constants.js";
import { resetPythonProbe } from "../lib/mlx-asr/python.js";
import {
  getMlxRuntimeDownloadStatus,
  isMlxRuntimeInstallable,
} from "../lib/mlx-asr/runtime.js";
import {
  getMlxLlmModel,
  MLX_LLM_PROVIDER_ID,
} from "../lib/mlx-llm/constants.js";
import {
  cancelMlxLlmDownload,
  clearMlxLlmDownloadError,
  deleteMlxLlmModel,
  downloadMlxLlmModel,
  getAllMlxLlmModelStatuses,
  getMlxLlmModelStatus,
  mlxLlmDeleteBlocker,
} from "../lib/mlx-llm/models.js";
import {
  getMlxLlmKeepAliveMinutes,
  getMlxLlmWorkerState,
  mlxLlmSetupBlocker,
  startMlxLlmInBackground,
  stopMlxLlmWorker,
} from "../lib/mlx-llm/server.js";
import { stripModelPrefix } from "../lib/model-id.js";
import { getDefaultModels } from "../lib/providers.js";

// The built-in local MLX LLM (specs/local-mlx-llm.md 3.5).
const mlxLlm = new Hono()
  .get("/status", (c) => {
    if (c.req.query("refresh") === "1") resetPythonProbe();
    const platformSupported = isAppleSiliconMac();
    const blocker = platformSupported ? mlxLlmSetupBlocker() : null;
    return c.json({
      platformSupported,
      blockedReason: platformSupported
        ? (blocker?.message ?? null)
        : MLX_UNSUPPORTED_PLATFORM_REASON,
      runtime: getMlxRuntimeDownloadStatus(),
      keepAliveMinutes: getMlxLlmKeepAliveMinutes(),
      models: platformSupported ? getAllMlxLlmModelStatuses() : [],
      worker: getMlxLlmWorkerState(),
    });
  })
  .post("/models/:model/download", (c) => {
    const modelId = c.req.param("model");
    const status = getMlxLlmModelStatus(modelId);
    if (!status) {
      return c.json({ error: `Unknown MLX LLM model: ${modelId}` }, 400);
    }
    if (status.status === "ready") {
      return c.json({ ok: true, message: "Model already downloaded" });
    }
    if (status.status === "downloading") {
      return c.json({ ok: true, message: "Download already in progress" });
    }
    if (
      status.status === "error" &&
      mlxLlmSetupBlocker() &&
      !isMlxRuntimeInstallable()
    ) {
      return c.json({ error: status.error ?? "MLX is not available" }, 400);
    }
    clearMlxLlmDownloadError(modelId);
    downloadMlxLlmModel(modelId).catch(() => {});
    return c.json({ ok: true, message: "Download started" });
  })
  .post("/models/:model/cancel", (c) =>
    c.json({ ok: cancelMlxLlmDownload(c.req.param("model")) }),
  )
  .delete("/models/:model", async (c) => {
    const modelId = c.req.param("model");
    const blocker = mlxLlmDeleteBlocker(modelId);
    if (blocker) return deleteBlockedResponse(c, blocker);
    return c.json({ ok: await deleteMlxLlmModel(modelId) });
  })
  .post("/server/start", zValidator("json", mlxLlmServerStartSchema), (c) => {
    let modelId = c.req.valid("json").model;
    if (!modelId) {
      const llm = getDefaultModels().llm;
      if (llm?.provider === MLX_LLM_PROVIDER_ID) {
        modelId = stripModelPrefix(MLX_LLM_PROVIDER_ID, llm.model_id);
      }
    }
    if (!modelId) return c.json({ error: "No model specified" }, 400);
    if (!getMlxLlmModel(modelId)) {
      return c.json({ error: `Unknown MLX LLM model: ${modelId}` }, 400);
    }
    const blocker = mlxLlmSetupBlocker();
    if (blocker) return c.json({ error: blocker.message }, 400);
    if (getMlxLlmModelStatus(modelId)?.status !== "ready") {
      return c.json({ error: "The MLX LLM model is not downloaded yet." }, 400);
    }
    startMlxLlmInBackground(modelId);
    return c.json({ ok: true });
  })
  .post("/server/stop", async (c) => {
    await stopMlxLlmWorker();
    return c.json({ ok: true });
  });

export default mlxLlm;
