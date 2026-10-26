import { existsSync, rmSync } from "node:fs";
import { describeDownloadError } from "../disk.js";
import { downloadErrorSourceUrl } from "../download-guard.js";
import {
  type DefaultFallback,
  type DeleteBlocker,
  hasMeetingJobOfKind,
  releaseDeletedModel,
} from "../local-model-delete.js";
import type { MeetingJobKind } from "../meetings/job-registry.js";
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
  MLX_LLM_ALLOW_PATTERNS,
  MLX_LLM_MODELS,
  MLX_LLM_PROVIDER_ID,
  type MlxLlmModelDef,
} from "./constants.js";
import {
  getMlxLlmWorkerState,
  isMlxLlmWorkerBusy,
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
    await downloadHfSnapshot(active, def.hfId, {
      allowPatterns: MLX_LLM_ALLOW_PATTERNS,
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

const LLM_JOB_KINDS: ReadonlySet<MeetingJobKind> = new Set([
  "summarize",
  "enhance",
]);

/**
 * Why `modelId` cannot be deleted now, or null. A download must be
 * cancelled first. A model is in use while the worker holds it and a request
 * or a meeting Enhance or Summarize job runs.
 */
export function mlxLlmDeleteBlocker(modelId: string): DeleteBlocker | null {
  const active = activeDownloads.get(modelId);
  if (active && !active.error) return "downloading";
  if (
    getMlxLlmWorkerState().model === modelId &&
    (isMlxLlmWorkerBusy() || hasMeetingJobOfKind(LLM_JOB_KINDS))
  ) {
    return "in_use";
  }
  return null;
}

/**
 * The recommended model becomes the default after a delete of the default,
 * when it is on disk and is not the deleted model.
 */
function llmFallbackFor(modelId: string): DefaultFallback | null {
  const def = MLX_LLM_MODELS.find((m) => m.recommended);
  if (!def || def.id === modelId || !isMlxLlmModelDownloaded(def)) return null;
  return {
    provider: MLX_LLM_PROVIDER_ID,
    modelId: `${MLX_LLM_PROVIDER_ID}/${def.id}`,
    modelName: def.displayName,
  };
}

export async function deleteMlxLlmModel(modelId: string): Promise<boolean> {
  const def = getMlxLlmModel(modelId);
  if (!def) return false;

  cancelMlxLlmDownload(modelId);
  // Unload the model before its files go, so no worker holds deleted files.
  if (getMlxLlmWorkerState().model === modelId) {
    await stopMlxLlmWorker().catch(() => {});
  }

  const dir = hfRepoCacheDir(def.hfId);
  const existed = existsSync(dir);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    return false;
  }

  releaseDeletedModel({
    type: "llm",
    provider: MLX_LLM_PROVIDER_ID,
    modelId: `${MLX_LLM_PROVIDER_ID}/${modelId}`,
    fallback: llmFallbackFor(modelId),
  });
  return existed;
}
