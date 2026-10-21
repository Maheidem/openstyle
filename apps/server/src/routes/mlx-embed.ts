import { SETTINGS_KEYS } from "@openstyle/validations";
import { Hono } from "hono";
import { writeSetting } from "../lib/db.js";
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
  cancelMlxEmbedDownload,
  clearMlxEmbedDownloadError,
  deleteMlxEmbedModel,
  downloadMlxEmbedModel,
  getAllMlxEmbedModelStatuses,
  getMlxEmbedModelStatus,
} from "../lib/mlx-embed/models.js";
import {
  getMlxEmbedWorkerState,
  getSearchEmbeddingModelId,
  mlxEmbedSetupBlocker,
  startMlxEmbedInBackground,
} from "../lib/mlx-embed/server.js";

// The built-in embedding model for search (specs/local-semantic-search.md
// 5.5). Same shapes as /api/mlx-llm.
const mlxEmbed = new Hono()
  .get("/status", (c) => {
    if (c.req.query("refresh") === "1") resetPythonProbe();
    const platformSupported = isAppleSiliconMac();
    const blocker = platformSupported ? mlxEmbedSetupBlocker() : null;
    return c.json({
      platformSupported,
      blockedReason: platformSupported
        ? (blocker?.message ?? null)
        : MLX_UNSUPPORTED_PLATFORM_REASON,
      runtime: getMlxRuntimeDownloadStatus(),
      models: platformSupported ? getAllMlxEmbedModelStatuses() : [],
      /** The catalog id of the search model, or null for "no model". */
      selected: getSearchEmbeddingModelId(),
      worker: getMlxEmbedWorkerState(),
    });
  })
  .post("/models/:model/download", (c) => {
    const modelId = c.req.param("model");
    const status = getMlxEmbedModelStatus(modelId);
    if (!status) {
      return c.json({ error: `Unknown MLX embedding model: ${modelId}` }, 400);
    }
    if (status.status === "ready") {
      return c.json({ ok: true, message: "Model already downloaded" });
    }
    if (status.status === "downloading") {
      return c.json({ ok: true, message: "Download already in progress" });
    }
    if (
      status.status === "error" &&
      mlxEmbedSetupBlocker() &&
      !isMlxRuntimeInstallable()
    ) {
      return c.json({ error: status.error ?? "MLX is not available" }, 400);
    }
    clearMlxEmbedDownloadError(modelId);
    downloadMlxEmbedModel(modelId).catch(() => {});
    return c.json({ ok: true, message: "Download started" });
  })
  .post("/models/:model/cancel", (c) =>
    c.json({ ok: cancelMlxEmbedDownload(c.req.param("model")) }),
  )
  .delete("/models/:model", (c) =>
    c.json({ ok: deleteMlxEmbedModel(c.req.param("model")) }),
  )
  // Use: make the model the search model and load it once in the background,
  // so a load failure shows on the Models page and not at the first search.
  .post("/models/:model/use", (c) => {
    const modelId = c.req.param("model");
    const status = getMlxEmbedModelStatus(modelId);
    if (!status) {
      return c.json({ error: `Unknown MLX embedding model: ${modelId}` }, 400);
    }
    if (status.status !== "ready") {
      return c.json({ error: "The search model is not downloaded yet." }, 400);
    }
    writeSetting(SETTINGS_KEYS.searchEmbeddingModel, modelId);
    startMlxEmbedInBackground(modelId);
    return c.json({ ok: true });
  });

export default mlxEmbed;
