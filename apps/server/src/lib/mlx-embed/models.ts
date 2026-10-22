import { existsSync, rmSync } from "node:fs";
import { createAppLogger } from "@openstyle/utils";
import { SETTINGS_KEYS } from "@openstyle/validations";
import { deleteSetting, getDb, withTransaction } from "../db.js";
import { describeDownloadError } from "../disk.js";
import { downloadErrorSourceUrl } from "../download-guard.js";
import { hfRepoCacheDir } from "../mlx-asr/constants.js";
import {
  type ActiveMlxDownload,
  activeDownloadProgress,
  downloadHfSnapshot,
  ensureMlxRuntimeForDownload,
  isHfSnapshotPresent,
  type MlxModelDownloadState,
  newActiveMlxDownload,
} from "../mlx-asr/models.js";
import {
  cancelMlxRuntimeDownload,
  isMlxRuntimeInstallable,
} from "../mlx-asr/runtime.js";
import { notifySearchModelDeleted } from "../search/notify.js";
import { purgeModelRows } from "../search/vec-store.js";
import {
  getMlxEmbedModel,
  MLX_EMBED_ALLOW_PATTERNS,
  MLX_EMBED_MODELS,
  type MlxEmbedModelDef,
} from "./constants.js";
import {
  getMlxEmbedWorkerState,
  getSearchEmbeddingModelId,
  mlxEmbedSetupBlocker,
  mlxEmbedWorkerOverride,
  stopMlxEmbedWorker,
} from "./server.js";

// Downloads and status of the built-in embedding models
// (specs/local-semantic-search.md 5.3). The weights go into the shared HF
// cache, at the pinned revision of each model, with the speech and LLM code
// path.

export interface MlxEmbedModelState extends MlxModelDownloadState {
  hfId: string;
  revision: string;
  dims: number;
  /** This model is the search model (setting `search_embedding_model`). */
  selected: boolean;
}

const log = createAppLogger("search");

const activeDownloads = new Map<string, ActiveMlxDownload>();

function baseState(def: MlxEmbedModelDef): Omit<MlxEmbedModelState, "status"> {
  return {
    model: def.id,
    hfId: def.hfId,
    revision: def.revision,
    displayName: def.displayName,
    sizeBytes: def.sizeBytes,
    dims: def.dims,
    selected: getSearchEmbeddingModelId() === def.id,
  };
}

export function isMlxEmbedModelDownloaded(def: MlxEmbedModelDef): boolean {
  return isHfSnapshotPresent(def.hfId, def.revision);
}

export function getMlxEmbedModelStatus(
  modelId: string,
): MlxEmbedModelState | null {
  const def = getMlxEmbedModel(modelId);
  if (!def) return null;

  const active = activeDownloads.get(modelId);
  if (active?.error) {
    return {
      ...baseState(def),
      status: "error",
      error: active.error,
      errorSourceUrl: active.errorSourceUrl,
    };
  }
  if (active) {
    return {
      ...baseState(def),
      status: "downloading",
      phase: active.phase,
      downloadProgress: activeDownloadProgress(active),
    };
  }

  const blocker = mlxEmbedSetupBlocker();
  if (blocker) {
    const canDownloadRuntime =
      isMlxRuntimeInstallable() &&
      (blocker.code === "no-runtime" || blocker.code === "deps-missing");
    return canDownloadRuntime
      ? { ...baseState(def), status: "not_downloaded" }
      : { ...baseState(def), status: "error", error: blocker.message };
  }

  return {
    ...baseState(def),
    status: isMlxEmbedModelDownloaded(def) ? "ready" : "not_downloaded",
  };
}

export function getAllMlxEmbedModelStatuses(): MlxEmbedModelState[] {
  return MLX_EMBED_MODELS.map((m) => getMlxEmbedModelStatus(m.id)!);
}

export function clearMlxEmbedDownloadError(modelId: string): void {
  if (activeDownloads.get(modelId)?.error) activeDownloads.delete(modelId);
}

export async function downloadMlxEmbedModel(modelId: string): Promise<void> {
  const def = getMlxEmbedModel(modelId);
  if (!def) throw new Error(`Unknown MLX embedding model: ${modelId}`);

  const existing = activeDownloads.get(modelId);
  if (existing && !existing.error) {
    throw new Error(`Model ${modelId} is already downloading`);
  }

  const active = newActiveMlxDownload();
  activeDownloads.set(modelId, active);

  // The embedding worker is the same managed runtime as the speech worker.
  // An operator worker override needs no runtime.
  if (!mlxEmbedWorkerOverride()) await ensureMlxRuntimeForDownload(active);

  if (isMlxEmbedModelDownloaded(def)) {
    activeDownloads.delete(modelId);
    return;
  }

  try {
    await downloadHfSnapshot(active, def.hfId, {
      allowPatterns: MLX_EMBED_ALLOW_PATTERNS,
      revision: def.revision,
    });
    activeDownloads.delete(modelId);
  } catch (err) {
    if (active.controller.signal.aborted) {
      // A write in flight can recreate files after the cancel removed the dir.
      if (!activeDownloads.has(modelId)) {
        try {
          rmSync(hfRepoCacheDir(def.hfId), { recursive: true, force: true });
        } catch {}
      } else if (activeDownloads.get(modelId) === active) {
        activeDownloads.delete(modelId);
      }
      return;
    }
    active.error = describeDownloadError(err);
    active.errorSourceUrl = downloadErrorSourceUrl(
      err,
      `https://huggingface.co/${def.hfId}`,
    );
    throw err;
  }
}

export function cancelMlxEmbedDownload(modelId: string): boolean {
  const active = activeDownloads.get(modelId);
  if (!active) return false;
  if (active.phase === "building_binary") cancelMlxRuntimeDownload();
  active.controller.abort();
  const def = getMlxEmbedModel(modelId);
  if (active.phase === "downloading_model" && def) {
    try {
      rmSync(hfRepoCacheDir(def.hfId), { recursive: true, force: true });
    } catch {}
  }
  activeDownloads.delete(modelId);
  return true;
}

/**
 * Delete the files of the model. When it is the search model, the setting is
 * cleared, so search reads "no model" (spec 5.5). The index rows of the model
 * go too: chunks, index state and vectors (spec 9.2). A later Use of the
 * same model builds the index again.
 */
export function deleteMlxEmbedModel(modelId: string): boolean {
  const def = getMlxEmbedModel(modelId);
  if (!def) return false;

  cancelMlxEmbedDownload(modelId);
  if (getMlxEmbedWorkerState().model === modelId) {
    stopMlxEmbedWorker().catch(() => {});
  }

  const dir = hfRepoCacheDir(def.hfId);
  const existed = existsSync(dir);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    return false;
  }

  if (getSearchEmbeddingModelId() === modelId) {
    deleteSetting(SETTINGS_KEYS.searchEmbeddingModel);
  }
  notifySearchModelDeleted(modelId);
  const db = getDb();
  const purged = withTransaction(db, () => purgeModelRows(db, modelId));
  log.info(
    `search model ${modelId} deleted: chunks=${purged.chunks} states=${purged.states} vectors=${purged.vectors}`,
  );
  return existed;
}
