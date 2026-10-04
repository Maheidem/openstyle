import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listFiles, snapshotDownload } from "@huggingface/hub";
import { getDb } from "../db.js";
import {
  assertEnoughDiskSpace,
  DOWNLOAD_FREE_BUFFER_BYTES,
  describeDownloadError,
} from "../disk.js";
import { downloadErrorSourceUrl } from "../download-guard.js";
import { progressFetch } from "../hf/progress.js";
import {
  getMlxAsrModel,
  LEGACY_MLX_ASR_MODELS,
  MLX_ASR_MODELS,
  MLX_ASR_PROVIDER_ID,
  type MlxAsrModelDef,
} from "./constants.js";
import {
  deleteCustomModelRow,
  listCustomMlxDefs,
  recordCustomSnapshot,
} from "./custom-models.js";
import {
  describeMlxSetupBlocker,
  mlxSetupBlocker,
  resetPythonProbe,
} from "./python.js";
import {
  cancelMlxRuntimeDownload,
  ensureMlxRuntimeDownloaded,
  getMlxRuntimeDownloadStatus,
  isMlxRuntimeInstallable,
  updateManagedMlxRuntimeIfNeeded,
} from "./runtime.js";
import { stopMlxServer } from "./server.js";

export type MlxDownloadStatus =
  | "not_downloaded"
  | "downloading"
  | "ready"
  | "error";

export type MlxDownloadPhase = "building_binary" | "downloading_model";

export interface MlxModelDownloadState {
  model: string;
  sizeBytes: number;
  displayName: string;
  status: MlxDownloadStatus;
  phase?: MlxDownloadPhase;
  downloadProgress?: {
    bytesDownloaded: number;
    bytesTotal: number;
    percent: number;
    speedBps: number;
  };
  error?: string;
  /** URL to open in a browser to clear a proxy/coaching interception. */
  errorSourceUrl?: string;
}

interface ActiveMlxDownload {
  controller: AbortController;
  phase: MlxDownloadPhase;
  bytesDownloaded: number;
  bytesTotal: number;
  speedBps: number;
  lastUpdate: number;
  lastBytes: number;
  error?: string;
  errorSourceUrl?: string;
}

const activeDownloads = new Map<string, ActiveMlxDownload>();

function baseModelState(
  modelId: string,
  model: MlxAsrModelDef,
): Pick<MlxModelDownloadState, "model" | "sizeBytes" | "displayName"> {
  return {
    model: modelId,
    sizeBytes: model.sizeBytes,
    displayName: model.displayName,
  };
}

export function hfCacheRoot(): string {
  return (
    process.env.HUGGINGFACE_HUB_CACHE ??
    (process.env.HF_HOME
      ? join(process.env.HF_HOME, "hub")
      : join(homedir(), ".cache", "huggingface", "hub"))
  );
}

export function hfRepoCacheDir(hfId: string): string {
  return join(hfCacheRoot(), `models--${hfId.replaceAll("/", "--")}`);
}

function hasSnapshotFiles(snapshotDir: string): boolean {
  try {
    return readdirSync(snapshotDir).length > 0;
  } catch {
    return false;
  }
}

/**
 * A custom model counts as downloaded only when the snapshot of the stored
 * revision holds every expected file at its expected size (spec section 8).
 * Snapshot files are symlinks into blobs/. `statSync` follows them.
 */
function isCustomModelComplete(
  hfId: string,
  custom: NonNullable<MlxAsrModelDef["custom"]>,
): boolean {
  const snapshotDir = join(hfRepoCacheDir(hfId), "snapshots", custom.revision);
  if (!existsSync(snapshotDir)) return false;
  try {
    return custom.files.every(
      (file) => statSync(join(snapshotDir, file.path)).size === file.size,
    );
  } catch {
    return false;
  }
}

export function isMlxModelDownloaded(model: MlxAsrModelDef): boolean {
  if (model.custom) return isCustomModelComplete(model.hfId, model.custom);
  const snapshotsDir = join(hfRepoCacheDir(model.hfId), "snapshots");
  if (!existsSync(snapshotsDir)) return false;

  try {
    return readdirSync(snapshotsDir, { withFileTypes: true }).some(
      (entry) =>
        entry.isDirectory() && hasSnapshotFiles(join(snapshotsDir, entry.name)),
    );
  } catch {
    return false;
  }
}

export function getMlxModelStatus(
  modelId: string,
): MlxModelDownloadState | null {
  const model = getMlxAsrModel(modelId);
  if (!model) return null;

  const active = activeDownloads.get(modelId);
  if (active?.error) {
    return {
      ...baseModelState(modelId, model),
      status: "error",
      error: active.error,
      errorSourceUrl: active.errorSourceUrl,
    };
  }

  if (active) {
    const runtimeProgress =
      active.phase === "building_binary"
        ? getMlxRuntimeDownloadStatus().downloadProgress
        : undefined;
    return {
      ...baseModelState(modelId, model),
      status: "downloading",
      phase: active.phase,
      downloadProgress:
        runtimeProgress ??
        (active.bytesTotal
          ? {
              bytesDownloaded: active.bytesDownloaded,
              bytesTotal: active.bytesTotal,
              percent: Math.round(
                (active.bytesDownloaded / active.bytesTotal) * 100,
              ),
              speedBps: active.speedBps,
            }
          : undefined),
    };
  }

  const blocker = mlxSetupBlocker();
  if (blocker) {
    const canDownloadRuntime =
      isMlxRuntimeInstallable() &&
      (blocker.code === "no-runtime" || blocker.code === "deps-missing");
    if (canDownloadRuntime) {
      return { ...baseModelState(modelId, model), status: "not_downloaded" };
    }

    return {
      ...baseModelState(modelId, model),
      status: "error",
      error: blocker.message,
    };
  }

  if (isMlxModelDownloaded(model)) {
    return { ...baseModelState(modelId, model), status: "ready" };
  }

  return { ...baseModelState(modelId, model), status: "not_downloaded" };
}

/**
 * Catalog shown in pickers: the curated models, plus legacy models that
 * this install still has downloaded, plus the custom models the user added.
 */
export function getMlxCatalogModels(): MlxAsrModelDef[] {
  const legacy = LEGACY_MLX_ASR_MODELS.filter((m) => isMlxModelDownloaded(m));
  return [...MLX_ASR_MODELS, ...legacy, ...listCustomMlxDefs()];
}

export function getAllMlxModelStatuses(): MlxModelDownloadState[] {
  return getMlxCatalogModels().map((m) => getMlxModelStatus(m.id)!);
}

export function clearMlxDownloadError(modelId: string): void {
  const active = activeDownloads.get(modelId);
  if (active?.error) {
    activeDownloads.delete(modelId);
  }
}

export async function downloadMlxModel(modelId: string): Promise<void> {
  const model = getMlxAsrModel(modelId);
  if (!model) throw new Error(`Unknown MLX ASR model: ${modelId}`);

  const existing = activeDownloads.get(modelId);
  if (existing && !existing.error) {
    throw new Error(`Model ${modelId} is already downloading`);
  }
  if (existing?.error) {
    activeDownloads.delete(modelId);
  }

  const now = Date.now();
  const active: ActiveMlxDownload = {
    controller: new AbortController(),
    phase: "building_binary",
    bytesDownloaded: 0,
    bytesTotal: 0,
    speedBps: 0,
    lastUpdate: now,
    lastBytes: 0,
  };
  activeDownloads.set(modelId, active);

  await updateManagedMlxRuntimeIfNeeded().catch((err) => {
    console.warn(
      "[mlx-asr] Failed to refresh managed runtime before model download:",
      err instanceof Error ? err.message : String(err),
    );
  });

  let blocker = describeMlxSetupBlocker();
  if (blocker) {
    try {
      await ensureMlxRuntimeDownloaded();
      resetPythonProbe();
    } catch (err) {
      active.error = describeDownloadError(err);
      throw err;
    }

    blocker = describeMlxSetupBlocker();
    if (blocker) {
      active.error = blocker;
      throw new Error(blocker);
    }
  }

  // Cached weights still need the runtime above, but no weight download.
  if (isMlxModelDownloaded(model)) {
    activeDownloads.delete(modelId);
    return;
  }

  active.phase = "downloading_model";
  active.bytesDownloaded = 0;
  active.bytesTotal = 0;
  active.speedBps = 0;
  active.lastUpdate = Date.now();
  active.lastBytes = 0;

  const repo = { type: "model", name: model.hfId } as const;

  try {
    let total = 0;
    for await (const entry of listFiles({ repo, recursive: true })) {
      if (entry.type === "file") total += entry.size ?? 0;
    }
    active.bytesTotal = total;
  } catch {
    active.bytesTotal = 0;
  }

  try {
    // Fail fast if the model won't fit before streaming gigabytes from HF.
    if (active.bytesTotal > 0) {
      await assertEnoughDiskSpace(
        hfCacheRoot(),
        active.bytesTotal + DOWNLOAD_FREE_BUFFER_BYTES,
      );
    }

    const snapshotDir = await snapshotDownload({
      repo,
      cacheDir: hfCacheRoot(),
      fetch: progressFetch(active, active.controller.signal),
    });
    if (model.custom) recordCustomSnapshot(modelId, snapshotDir);
    activeDownloads.delete(modelId);
  } catch (err) {
    if (active.controller.signal.aborted) {
      activeDownloads.delete(modelId);
      return;
    }
    active.error = describeDownloadError(err);
    active.errorSourceUrl = downloadErrorSourceUrl(
      err,
      `https://huggingface.co/${model.hfId}`,
    );
    throw err;
  }
}

export function cancelMlxDownload(modelId: string): boolean {
  const active = activeDownloads.get(modelId);
  if (!active) return false;
  if (active.phase === "building_binary") {
    cancelMlxRuntimeDownload();
  }
  active.controller.abort();
  if (active.phase === "downloading_model") {
    const model = getMlxAsrModel(modelId);
    if (model) {
      try {
        rmSync(hfRepoCacheDir(model.hfId), { recursive: true, force: true });
      } catch {}
    }
  }
  activeDownloads.delete(modelId);
  return true;
}

export function deleteMlxModel(modelId: string): boolean {
  const model = getMlxAsrModel(modelId);
  if (!model) return false;

  cancelMlxDownload(modelId);
  stopMlxServer().catch(() => {});

  const dir = hfRepoCacheDir(model.hfId);
  const existed = existsSync(dir);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    return false;
  }

  try {
    const db = getDb();
    const configuredId = `${MLX_ASR_PROVIDER_ID}/${modelId}`;
    db.prepare(
      "DELETE FROM model_configs WHERE type = 'voice' AND provider = ? AND model_id = ?",
    ).run(MLX_ASR_PROVIDER_ID, configuredId);
  } catch {
    // DB may be unavailable during shutdown
  }

  // A custom model leaves the list. The caller adds it again through the dialog.
  const rowRemoved = model.custom ? deleteCustomModelRow(modelId) : false;
  return existed || rowRemoved;
}
