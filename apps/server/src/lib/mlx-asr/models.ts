import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
  hfCacheRoot,
  hfRepoCacheDir,
  LEGACY_MLX_ASR_MODELS,
  MLX_ASR_MODELS,
  MLX_ASR_PROVIDER_ID,
  type MlxAsrModelDef,
} from "./constants.js";
import {
  deleteCustomModelRow,
  hasRemoteCode,
  listCustomMlxDefs,
  MAX_MODEL_BYTES,
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
import { fillWhisperProcessor } from "./whisper-processor.js";

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

/** Progress and cancel state of one model download. `mlx-llm` uses it too. */
export interface ActiveMlxDownload {
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

interface ExpectedFile {
  path: string;
  size: number;
}

/**
 * The repo file list that the last download expected. The download writes it
 * into the repo cache dir before it fetches, so a partial snapshot never reads
 * as complete. Cancel and delete remove it with the repo dir.
 */
const MANIFEST_FILE = "openstyle-expected-files.json";

function readManifest(repoDir: string): ExpectedFile[] | null {
  try {
    const parsed = JSON.parse(
      readFileSync(join(repoDir, MANIFEST_FILE), "utf8"),
    ) as { files?: ExpectedFile[] };
    return Array.isArray(parsed.files) ? parsed.files : null;
  } catch {
    return null;
  }
}

function writeManifest(repoDir: string, files: ExpectedFile[]): void {
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, MANIFEST_FILE), JSON.stringify({ files }));
}

/** The files of `files` that the snapshot holds at their expected size. */
function presentFiles(
  snapshotDir: string,
  files: ExpectedFile[],
): ExpectedFile[] {
  return files.filter((file) => {
    try {
      // Snapshot files are symlinks into blobs/. `statSync` follows them.
      return statSync(join(snapshotDir, file.path)).size === file.size;
    } catch {
      return false;
    }
  });
}

/** The hub writes `blobs/<etag>.incomplete` while a file downloads. */
function hasIncompleteBlob(repoDir: string): boolean {
  try {
    return readdirSync(join(repoDir, "blobs")).some((name) =>
      name.endsWith(".incomplete"),
    );
  } catch {
    return false;
  }
}

/**
 * A crash or an older failed run can leave `.incomplete` blobs. The hub
 * writes such a file again from 0, so an old one only blocks the check above.
 */
function removeIncompleteBlobs(repoDir: string): void {
  try {
    for (const name of readdirSync(join(repoDir, "blobs"))) {
      if (name.endsWith(".incomplete")) {
        rmSync(join(repoDir, "blobs", name), { force: true });
      }
    }
  } catch {}
}

const WEIGHT_FILE = /\.(safetensors|npz)$/;

/**
 * A snapshot with no manifest (an older app version or another HF tool) is
 * complete when every entry resolves (no broken symlink) and it has weights.
 */
function looksComplete(snapshotDir: string): boolean {
  try {
    const entries = readdirSync(snapshotDir, { recursive: true }) as string[];
    for (const entry of entries) statSync(join(snapshotDir, entry));
    return entries.some((entry) => WEIGHT_FILE.test(entry));
  } catch {
    return false;
  }
}

/**
 * A custom model counts as downloaded only when the snapshot of the stored
 * revision holds every expected file at its expected size (spec section 8).
 */
function isCustomModelComplete(
  hfId: string,
  custom: NonNullable<MlxAsrModelDef["custom"]>,
): boolean {
  const snapshotDir = join(hfRepoCacheDir(hfId), "snapshots", custom.revision);
  if (!existsSync(snapshotDir)) return false;
  return presentFiles(snapshotDir, custom.files).length === custom.files.length;
}

export function isMlxModelDownloaded(model: MlxAsrModelDef): boolean {
  if (model.custom) return isCustomModelComplete(model.hfId, model.custom);
  return isHfSnapshotPresent(model.hfId);
}

/**
 * True when the shared HF cache holds a complete snapshot of the repo: no
 * `.incomplete` blob, and every file of the manifest at its expected size.
 * Stat calls only. The speech and the LLM models use it.
 */
export function isHfSnapshotPresent(hfId: string): boolean {
  const repoDir = hfRepoCacheDir(hfId);
  const snapshotsDir = join(repoDir, "snapshots");
  if (!existsSync(snapshotsDir) || hasIncompleteBlob(repoDir)) return false;

  const manifest = readManifest(repoDir);
  try {
    return readdirSync(snapshotsDir, { withFileTypes: true }).some((entry) => {
      if (!entry.isDirectory()) return false;
      const dir = join(snapshotsDir, entry.name);
      return manifest
        ? presentFiles(dir, manifest).length === manifest.length
        : looksComplete(dir);
    });
  } catch {
    return false;
  }
}

/** The bytes of the manifest files that a snapshot of the repo already holds. */
function storedBytes(repoDir: string, files: ExpectedFile[]): number {
  let best = 0;
  try {
    const snapshotsDir = join(repoDir, "snapshots");
    for (const revision of readdirSync(snapshotsDir)) {
      const bytes = presentFiles(join(snapshotsDir, revision), files).reduce(
        (sum, file) => sum + file.size,
        0,
      );
      best = Math.max(best, bytes);
    }
  } catch {}
  return best;
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
    return {
      ...baseModelState(modelId, model),
      status: "downloading",
      phase: active.phase,
      downloadProgress: activeDownloadProgress(active),
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

/** The progress of a running download: the runtime phase or the weights phase. */
export function activeDownloadProgress(
  active: ActiveMlxDownload,
): MlxModelDownloadState["downloadProgress"] {
  if (active.phase === "building_binary") {
    const runtimeProgress = getMlxRuntimeDownloadStatus().downloadProgress;
    if (runtimeProgress) return runtimeProgress;
  }
  return active.bytesTotal
    ? {
        bytesDownloaded: active.bytesDownloaded,
        bytesTotal: active.bytesTotal,
        percent: Math.round((active.bytesDownloaded / active.bytesTotal) * 100),
        speedBps: active.speedBps,
      }
    : undefined;
}

/** A new download state in the runtime phase. */
export function newActiveMlxDownload(): ActiveMlxDownload {
  const now = Date.now();
  return {
    controller: new AbortController(),
    phase: "building_binary",
    bytesDownloaded: 0,
    bytesTotal: 0,
    speedBps: 0,
    lastUpdate: now,
    lastBytes: 0,
  };
}

/**
 * Make sure the managed MLX worker runtime is installed. On a failure it sets
 * `active.error` and throws. The speech and the LLM models share the runtime.
 */
export async function ensureMlxRuntimeForDownload(
  active: ActiveMlxDownload,
): Promise<void> {
  await updateManagedMlxRuntimeIfNeeded().catch((err) => {
    console.warn(
      "[mlx-asr] Failed to refresh managed runtime before model download:",
      err instanceof Error ? err.message : String(err),
    );
  });

  let blocker = describeMlxSetupBlocker();
  if (!blocker) return;
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

/** The waits before the 2nd, 3rd and 4th try of a snapshot download. */
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000];

/**
 * A dropped connection: undici "terminated" (the HF CDN reset a long body
 * stream), ECONNRESET or another socket error. A new try can pass.
 */
function isRetryableNetworkError(err: unknown): boolean {
  for (let e = err, depth = 0; e && depth < 4; depth++) {
    const { message, code } = e as { message?: unknown; code?: unknown };
    const text = `${typeof code === "string" ? code : ""} ${
      typeof message === "string" ? message : ""
    }`;
    if (
      /terminated|ECONNRESET|EPIPE|ETIMEDOUT|UND_ERR_SOCKET|socket|other side closed/i.test(
        text,
      )
    ) {
      return true;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

function waitOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Download the snapshot of `hfId` into the shared HF cache with progress in
 * `active`: read the file list, check the free disk space, write the manifest,
 * then fetch. A dropped connection gets 3 more tries. The hub skips the files
 * that are already complete, and it fetches a partial file again from the
 * start (`@huggingface/hub` 2.13 has no resume). `checkTotal` can refuse the
 * download when it knows the total size. Returns the snapshot folder. The
 * caller handles errors and cancel.
 */
export async function downloadHfSnapshot(
  active: ActiveMlxDownload,
  hfId: string,
  checkTotal?: (totalBytes: number) => void,
): Promise<string> {
  active.phase = "downloading_model";
  active.bytesDownloaded = 0;
  active.bytesTotal = 0;
  active.speedBps = 0;
  active.lastUpdate = Date.now();
  active.lastBytes = 0;

  const repo = { type: "model", name: hfId } as const;
  const repoDir = hfRepoCacheDir(hfId);

  let files: ExpectedFile[] | null = [];
  try {
    for await (const entry of listFiles({ repo, recursive: true })) {
      if (entry.type === "file") {
        files.push({ path: entry.path, size: entry.size ?? 0 });
      }
    }
  } catch {
    files = null;
  }
  active.bytesTotal = files?.reduce((sum, file) => sum + file.size, 0) ?? 0;

  checkTotal?.(active.bytesTotal);

  // Fail fast if the model won't fit before streaming gigabytes from HF.
  if (active.bytesTotal > 0) {
    await assertEnoughDiskSpace(
      hfCacheRoot(),
      active.bytesTotal + DOWNLOAD_FREE_BUFFER_BYTES,
    );
  }

  if (files?.length) writeManifest(repoDir, files);
  removeIncompleteBlobs(repoDir);

  for (let attempt = 0; ; attempt++) {
    try {
      return await snapshotDownload({
        repo,
        cacheDir: hfCacheRoot(),
        fetch: progressFetch(active, active.controller.signal),
      });
    } catch (err) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (
        active.controller.signal.aborted ||
        delay === undefined ||
        !isRetryableNetworkError(err)
      ) {
        throw err;
      }
      console.warn(
        `[mlx] Download of ${hfId} dropped (try ${attempt + 1}): ${
          err instanceof Error ? err.message : String(err)
        }. Trying again in ${delay / 1000} s.`,
      );
      await waitOrAbort(delay, active.controller.signal);
      // The partial file starts again from 0. Count only the stored files.
      active.bytesDownloaded = files ? storedBytes(repoDir, files) : 0;
      active.lastBytes = active.bytesDownloaded;
      active.lastUpdate = Date.now();
    }
  }
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

  const active = newActiveMlxDownload();
  activeDownloads.set(modelId, active);

  await ensureMlxRuntimeForDownload(active);

  // Cached weights still need the runtime above, but no weight download.
  if (isMlxModelDownloaded(model)) {
    activeDownloads.delete(modelId);
    return;
  }

  try {
    // The add step checked the size once. The repo can grow before a retry.
    const snapshotDir = await downloadHfSnapshot(
      active,
      model.hfId,
      (totalBytes) => {
        if (model.custom && totalBytes > MAX_MODEL_BYTES) {
          throw new Error(
            "This model is now larger than 8 GiB. It was not downloaded.",
          );
        }
      },
    );
    if (model.custom) {
      // An old mlx-whisper repo has no processor files. Add them before the
      // scan and the record, so both see them (spec section 14).
      if (model.family === "whisper") {
        await fillWhisperProcessor(snapshotDir, active.controller.signal);
      }
      // The add step checked `main` once. Check the files that were stored.
      if (hasRemoteCode(hfRepoCacheDir(model.hfId))) {
        rmSync(hfRepoCacheDir(model.hfId), { recursive: true, force: true });
        throw new Error(
          "This model now holds its own code files. It was blocked and removed.",
        );
      }
      recordCustomSnapshot(modelId, snapshotDir);
    }
    activeDownloads.delete(modelId);
  } catch (err) {
    if (active.controller.signal.aborted) {
      // A write that was in flight can recreate files after the cancel or the
      // delete removed the dir. Remove them, unless a new download owns the dir.
      if (!activeDownloads.has(modelId)) {
        try {
          rmSync(hfRepoCacheDir(model.hfId), { recursive: true, force: true });
        } catch {}
      } else if (activeDownloads.get(modelId) === active) {
        activeDownloads.delete(modelId);
      }
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
