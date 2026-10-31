import { existsSync, rmSync } from "node:fs";
import { createAppLogger } from "@openstyle/utils";
import { describeDownloadError } from "../disk.js";
import { hfRepoCacheDir } from "../mlx-asr/constants.js";
import {
  type ActiveMlxDownload,
  downloadHfSnapshot,
  ensureMlxRuntimeForDownload,
  isHfSnapshotPresent,
  newActiveMlxDownload,
} from "../mlx-asr/models.js";
import {
  getMlxRerankModel,
  MLX_RERANK_ALLOW_PATTERNS,
  MLX_RERANK_MODEL_ID,
  type MlxRerankModelDef,
} from "./constants.js";
import {
  getMlxRerankWorkerState,
  mlxRerankWorkerOverride,
  stopMlxRerankWorker,
} from "./server.js";

// Download and delete of the reranker model (specs/meeting-chat-agent.md
// 7.4.3). The weights go into the shared HF cache at the pinned revision, with
// the same helpers as the embed model. P1 has no download screen: the caller
// (a route or a setup step) calls ensureRerankModel().

const log = createAppLogger("mlx-rerank");

let active: ActiveMlxDownload | null = null;

export function isMlxRerankModelDownloaded(def: MlxRerankModelDef): boolean {
  return isHfSnapshotPresent(def.hfId, def.revision);
}

/**
 * Make sure the reranker model is on disk. Returns at once when it is.
 * Otherwise it downloads the pinned snapshot and resolves when the download
 * ends. Two calls at the same time share one download. Throws when the
 * download fails.
 */
export async function ensureRerankModel(): Promise<void> {
  const def = getMlxRerankModel(MLX_RERANK_MODEL_ID);
  if (!def) throw new Error(`Unknown reranker model: ${MLX_RERANK_MODEL_ID}`);
  if (isMlxRerankModelDownloaded(def)) return;
  if (active) {
    while (active) await new Promise((r) => setTimeout(r, 200));
    if (isMlxRerankModelDownloaded(def)) return;
    throw new Error("The reranker model download did not finish.");
  }
  const mine = newActiveMlxDownload();
  active = mine;
  try {
    // An operator worker override needs no managed runtime.
    if (!mlxRerankWorkerOverride()) await ensureMlxRuntimeForDownload(mine);
    await downloadHfSnapshot(mine, def.hfId, {
      allowPatterns: MLX_RERANK_ALLOW_PATTERNS,
      revision: def.revision,
    });
  } catch (err) {
    log.warn(`reranker download failed: ${describeDownloadError(err)}`);
    throw err;
  } finally {
    active = null;
  }
}

/** Stop the worker and delete the files of the model. */
export function deleteMlxRerankModel(): boolean {
  const def = getMlxRerankModel(MLX_RERANK_MODEL_ID);
  if (!def) return false;
  active?.controller.abort();
  if (getMlxRerankWorkerState().model === def.id) {
    stopMlxRerankWorker().catch(() => {});
  }
  const dir = hfRepoCacheDir(def.hfId);
  const existed = existsSync(dir);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    return false;
  }
  return existed;
}
