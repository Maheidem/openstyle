import { existsSync, rmSync } from "node:fs";
import { getDb } from "../db.js";
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
import {
  getMlxLlmModel,
  MLX_LLM_MODELS,
  MLX_LLM_PROVIDER_ID,
  type MlxLlmModelDef,
} from "./constants.js";
import {
  getMlxLlmWorkerState,
  mlxLlmSetupBlocker,
  mlxLlmWorkerOverride,
  stopMlxLlmWorker,
} from "./server.js";

// Downloads and status of the local LLM models (specs/local-mlx-llm.md 3.2).
// The weights go into the shared HF cache with the speech model code path.

export interface MlxLlmModelState extends MlxModelDownloadState {
  hfId: string;
  family: MlxLlmModelDef["family"];
  contextTokens: number;
  maxOutputTokens: number;
  recommended: boolean;
}

const activeDownloads = new Map<string, ActiveMlxDownload>();

function baseState(def: MlxLlmModelDef): Omit<MlxLlmModelState, "status"> {
  return {
    model: def.id,
    hfId: def.hfId,
    displayName: def.displayName,
    family: def.family,
    sizeBytes: def.sizeBytes,
    contextTokens: def.contextTokens,
    maxOutputTokens: def.maxOutputTokens,
    recommended: def.recommended === true,
  };
}

export function isMlxLlmModelDownloaded(def: MlxLlmModelDef): boolean {
  return isHfSnapshotPresent(def.hfId);
}

export function getMlxLlmModelStatus(modelId: string): MlxLlmModelState | null {
  const def = getMlxLlmModel(modelId);
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

  const blocker = mlxLlmSetupBlocker();
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
    status: isMlxLlmModelDownloaded(def) ? "ready" : "not_downloaded",
  };
}

export function getAllMlxLlmModelStatuses(): MlxLlmModelState[] {
  return MLX_LLM_MODELS.map((m) => getMlxLlmModelStatus(m.id)!);
}

export function clearMlxLlmDownloadError(modelId: string): void {
  if (activeDownloads.get(modelId)?.error) activeDownloads.delete(modelId);
}

export async function downloadMlxLlmModel(modelId: string): Promise<void> {
  const def = getMlxLlmModel(modelId);
  if (!def) throw new Error(`Unknown MLX LLM model: ${modelId}`);

  const existing = activeDownloads.get(modelId);
  if (existing && !existing.error) {
    throw new Error(`Model ${modelId} is already downloading`);
  }

  const active = newActiveMlxDownload();
  activeDownloads.set(modelId, active);

  // The LLM worker is the same managed runtime as the speech worker. An
  // operator worker override needs no runtime.
  if (!mlxLlmWorkerOverride()) await ensureMlxRuntimeForDownload(active);

  if (isMlxLlmModelDownloaded(def)) {
    activeDownloads.delete(modelId);
    return;
  }

  try {
    await downloadHfSnapshot(active, def.hfId);
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

export function cancelMlxLlmDownload(modelId: string): boolean {
  const active = activeDownloads.get(modelId);
  if (!active) return false;
  if (active.phase === "building_binary") cancelMlxRuntimeDownload();
  active.controller.abort();
  const def = getMlxLlmModel(modelId);
  if (active.phase === "downloading_model" && def) {
    try {
      rmSync(hfRepoCacheDir(def.hfId), { recursive: true, force: true });
    } catch {}
  }
  activeDownloads.delete(modelId);
  return true;
}

export function deleteMlxLlmModel(modelId: string): boolean {
  const def = getMlxLlmModel(modelId);
  if (!def) return false;

  cancelMlxLlmDownload(modelId);
  if (getMlxLlmWorkerState().model === modelId) {
    stopMlxLlmWorker().catch(() => {});
  }

  const dir = hfRepoCacheDir(def.hfId);
  const existed = existsSync(dir);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    return false;
  }

  try {
    getDb()
      .prepare(
        "DELETE FROM model_configs WHERE type = 'llm' AND provider = ? AND model_id = ?",
      )
      .run(MLX_LLM_PROVIDER_ID, `${MLX_LLM_PROVIDER_ID}/${modelId}`);
  } catch {
    // The DB can be closed during shutdown.
  }
  return existed;
}
