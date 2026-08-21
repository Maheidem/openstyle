import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createAppLogger } from "@openstyle/utils";
import { assertEnoughDiskSpace, describeDownloadError } from "../disk.js";
import {
  getManagedMlxWorkerPath,
  getMlxCacheDir,
  getMlxRuntimeDir,
  isAppleSiliconMac,
  MLX_ASR_MODELS,
} from "./constants.js";
import { getMlxAsrServerScriptPath } from "./python.js";

const log = createAppLogger("mlx-asr");

// Disk head-room for the runtime download/extract. The worker archive expands
// to several times its compressed size (scipy/numpy/mlx), and the archive and
// extracted tree co-exist briefly during extraction.
const RUNTIME_EXTRACT_RATIO = 4;
const MIN_RUNTIME_FREE_BYTES = 2 * 1024 ** 3; // 2 GB floor

const MLX_WORKER_ASSET_NAME = "mlx_asr_worker-darwin-arm64.tar.gz";
// This fork publishes its own worker archive. Upstream stopped shipping the
// asset entirely in 0.8.0 ("Remove local"), so pointing at their /latest/
// resolves to a release that has no worker and the download fails.
const MLX_WORKER_REPO = "Maheidem/openstyle";
const DEFAULT_MLX_WORKER_LATEST_URL = `https://github.com/${MLX_WORKER_REPO}/releases/latest/download/${MLX_WORKER_ASSET_NAME}`;
// Keep this in sync with scripts/build_mlx_asr_worker.sh so unchanged worker
// builds don't force users to redownload identical archives on every app release.
const MLX_WORKER_BUILD_SPEC =
  "pyinstaller=6.20.0;mlx-audio=0.4.3;huggingface_hub=1.17.0;transformers>=5.7,<5.13;bundle=onedir";

// --- Integrity verification -------------------------------------------------
//
// The worker archive is downloaded and tar-extracted into a binary that then
// runs as a subprocess (mlx-asr/server.ts, spawnWorkerProcess), so its
// contents must be verified before extraction. Neither `.craft.yml` (line 26
// `includeNames`) nor the release workflow (`.github/workflows/build.yml`,
// "Upload macOS artifacts") publish a dedicated checksum/digest *file*
// alongside `mlx_asr_worker-darwin-arm64.tar.gz` — confirmed by reading both.
//
// GitHub itself, however, computes and serves a `sha256:` digest for every
// release asset via the Releases API (`digest` field, `GET
// /repos/{owner}/{repo}/releases/tags/{tag}` and `/releases/latest`) — this is
// independent of our own release/build pipeline, needs no publishing step,
// and was confirmed live against the published 1.0.0 release while writing
// this (`mlx_asr_worker-darwin-arm64.tar.gz` ->
// `sha256:f5f8301d055c5fd5c78e29a9a35b465df11d3947aa7d030f3b9a0a8c4529c054`).
// That makes it the most robust available source of truth: it already covers
// every past and future release with zero pipeline changes, so it's used as
// the primary check. `PINNED_WORKER_DIGESTS` below is a hand-maintained
// fallback for when that API call is unreachable or rate-limited.
const MLX_WORKER_RELEASES_API = `https://api.github.com/repos/${MLX_WORKER_REPO}/releases`;

/**
 * Fallback sha256 digests for `mlx_asr_worker-darwin-arm64.tar.gz`, keyed by
 * release tag. Only consulted when the live GitHub Releases API digest
 * lookup (`resolveExpectedWorkerDigest`, below) is unreachable — that API
 * path needs no maintenance and covers every release automatically, so this
 * map is defense-in-depth, not the primary check.
 *
 * NEEDS ATTENTION ON EVERY RELEASE that rebuilds the worker archive: add the
 * new tag's digest here. Missing entries are NOT a silent gap — the download
 * still fails closed if the live API lookup *also* fails for that tag — but
 * closing this properly means never having to hand-maintain this map at all.
 * That requires a release-pipeline change outside this file's scope:
 *   - add `sha256sum dist/mlx_asr_worker-darwin-arm64.tar.gz >
 *     dist/mlx_asr_worker-darwin-arm64.tar.gz.sha256` after the "Build MLX
 *     ASR worker archive" step in `.github/workflows/build.yml`
 *   - add that filename to the `mac-builds` upload artifact list in the same
 *     workflow
 *   - add a `.sha256` suffix to the `includeNames` regex in `.craft.yml`
 *     (line 26) so `craft publish` actually uploads it as a release asset
 * Once a sidecar digest file is published, prefer fetching it directly over
 * both this map and the API digest lookup.
 */
const PINNED_WORKER_DIGESTS: Record<string, string> = {
  "1.0.0": "f5f8301d055c5fd5c78e29a9a35b465df11d3947aa7d030f3b9a0a8c4529c054",
  "1.0.1": "f5f8301d055c5fd5c78e29a9a35b465df11d3947aa7d030f3b9a0a8c4529c054",
};

// Best-effort fallback for the "no explicit release tag" (releases/latest)
// download path when the `/releases/latest` API call itself is what fails.
// GitHub's asset redirect for `releases/latest/download/...` lands on an
// opaque, signed `release-assets.githubusercontent.com` URL with no release
// tag anywhere in it (confirmed: `curl -sIL -w '%{url_effective}'` against
// the real latest-download URL), so the tag can't be recovered from the
// download response itself — only from the API call, which is exactly the
// call that failed. Keep this pointed at whichever tag is newest in
// PINNED_WORKER_DIGESTS. This only matters when the GitHub API is
// unreachable at the exact moment a "latest" download runs; the live API
// lookup is always tried first, so staleness here is harmless the rest of
// the time.
const PINNED_LATEST_WORKER_TAG = "1.0.1";

export interface MlxRuntimeDownloadStatus {
  available: boolean;
  downloading: boolean;
  url: string | null;
  downloadProgress?: {
    bytesDownloaded: number;
    bytesTotal: number;
    percent: number;
    speedBps: number;
  };
  error?: string;
}

interface ActiveRuntimeDownload {
  controller: AbortController;
  bytesDownloaded: number;
  bytesTotal: number;
  speedBps: number;
  lastUpdate: number;
  lastBytes: number;
  error?: string;
  promise: Promise<void>;
}

interface InstalledMlxRuntimeMetadata {
  downloadedAt: string;
  sourceUrl: string;
  workerVersion: string | null;
  /** App semver this worker install was synced for (post-update activation). */
  syncedAppVersion: string | null;
}

let activeDownload: ActiveRuntimeDownload | null = null;
let cachedExpectedVersion: string | null | undefined;

/** OPENSTYLE_MLX_ASR_WORKER_VERSION, or its legacy FREESTYLE_ name. */
function mlxAsrWorkerVersionOverride(): string | undefined {
  return (
    process.env.OPENSTYLE_MLX_ASR_WORKER_VERSION ||
    process.env.FREESTYLE_MLX_ASR_WORKER_VERSION ||
    undefined
  );
}

function expectedRuntimeVersion(): string | null {
  return mlxAsrWorkerVersionOverride() || deriveBundledWorkerVersion();
}

function deriveBundledWorkerVersion(): string | null {
  if (cachedExpectedVersion !== undefined) {
    return cachedExpectedVersion;
  }

  try {
    const scriptPath = getMlxAsrServerScriptPath();
    if (!scriptPath || !existsSync(scriptPath)) {
      cachedExpectedVersion = null;
      return null;
    }

    const script = readFileSync(scriptPath);
    cachedExpectedVersion = createHash("sha256")
      .update(MLX_WORKER_BUILD_SPEC)
      .update("\0")
      .update(script)
      .digest("hex")
      .slice(0, 16);
    return cachedExpectedVersion;
  } catch {
    cachedExpectedVersion = null;
    return null;
  }
}

/** OPENSTYLE_MLX_ASR_RELEASE_TAG, or its legacy FREESTYLE_ name. */
export function mlxAsrReleaseTagOverride(): string | undefined {
  return (
    process.env.OPENSTYLE_MLX_ASR_RELEASE_TAG ||
    process.env.FREESTYLE_MLX_ASR_RELEASE_TAG ||
    undefined
  );
}

function runtimeReleaseTag(): string | null {
  return mlxAsrReleaseTagOverride() || mlxAsrWorkerVersionOverride() || null;
}

function runtimeUrlForReleaseTag(releaseTag: string): string {
  return `https://github.com/${MLX_WORKER_REPO}/releases/download/${releaseTag}/${MLX_WORKER_ASSET_NAME}`;
}

/** OPENSTYLE_MLX_ASR_WORKER_URL, or its legacy FREESTYLE_ name. */
function mlxAsrWorkerUrlOverride(): string | undefined {
  return (
    process.env.OPENSTYLE_MLX_ASR_WORKER_URL ||
    process.env.FREESTYLE_MLX_ASR_WORKER_URL ||
    undefined
  );
}

/**
 * `OPENSTYLE_MLX_ASR_WORKER_URL` — TRUSTED-OPERATOR-ONLY escape hatch. Points
 * the worker-archive download at an arbitrary URL instead of this fork's own
 * GitHub releases, for local development against an unpublished worker
 * build. There is no way to know an "expected" digest for an arbitrary host,
 * so `downloadRuntimeToDir` skips integrity verification whenever this is
 * the source — loudly (a `log.warn` on every download) rather than silently.
 * Never set this from untrusted input. The legacy FREESTYLE_MLX_ASR_WORKER_URL
 * name is still read as a fallback.
 */
function runtimeUrl(): string | null {
  const envUrl = mlxAsrWorkerUrlOverride();
  if (envUrl) return envUrl;

  const releaseTag = runtimeReleaseTag();
  if (releaseTag) {
    return runtimeUrlForReleaseTag(releaseTag);
  }

  return DEFAULT_MLX_WORKER_LATEST_URL;
}

/**
 * Resolve the sha256 the downloaded worker archive must match before it is
 * extracted. Tries the live GitHub Releases API digest first (works for any
 * past or future release with no maintenance); falls back to the pinned map
 * for this build when that lookup is unreachable. Returns `null` if neither
 * source has an answer — the caller fails closed in that case.
 */
async function resolveExpectedWorkerDigest(
  releaseTag: string | null,
  signal: AbortSignal,
): Promise<string | null> {
  const apiUrl = releaseTag
    ? `${MLX_WORKER_RELEASES_API}/tags/${encodeURIComponent(releaseTag)}`
    : `${MLX_WORKER_RELEASES_API}/latest`;

  let resolvedTag = releaseTag;
  try {
    const res = await fetch(apiUrl, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      headers: { Accept: "application/vnd.github+json" },
    });
    if (res.ok) {
      const release = (await res.json()) as {
        tag_name?: string;
        assets?: { name?: string; digest?: string | null }[];
      };
      resolvedTag = releaseTag ?? release.tag_name ?? null;
      const asset = release.assets?.find(
        (a) => a.name === MLX_WORKER_ASSET_NAME,
      );
      const match = asset?.digest
        ? /^sha256:([0-9a-f]{64})$/i.exec(asset.digest)
        : null;
      if (match) return match[1]!.toLowerCase();
    }
  } catch {
    // GitHub API unreachable/rate-limited — fall through to the pinned map.
  }

  const pinnedTag = resolvedTag ?? PINNED_LATEST_WORKER_TAG;
  return PINNED_WORKER_DIGESTS[pinnedTag] ?? null;
}

function getMlxRuntimeStagingRoot(): string {
  return join(
    getMlxCacheDir(),
    "staging",
    `${process.platform}-${process.arch}`,
  );
}

function stagedRuntimeRoot(releaseTag: string): string {
  return join(getMlxRuntimeStagingRoot(), releaseTag);
}

function stagedWorkerPath(releaseTag: string): string {
  return join(
    stagedRuntimeRoot(releaseTag),
    "mlx_asr_worker",
    "mlx_asr_worker",
  );
}

function isStagedRuntimeReady(releaseTag: string): boolean {
  return existsSync(stagedWorkerPath(releaseTag));
}

function hfRepoCacheDir(hfId: string): string {
  return join(
    process.env.HUGGINGFACE_HUB_CACHE ??
      (process.env.HF_HOME
        ? join(process.env.HF_HOME, "hub")
        : join(homedir(), ".cache", "huggingface", "hub")),
    `models--${hfId.replaceAll("/", "--")}`,
  );
}

function hasSnapshotFiles(snapshotDir: string): boolean {
  try {
    return readdirSync(snapshotDir).length > 0;
  } catch {
    return false;
  }
}

function hasAnyMlxModelDownloaded(): boolean {
  return MLX_ASR_MODELS.some((model) => {
    const snapshotsDir = join(hfRepoCacheDir(model.hfId), "snapshots");
    if (!existsSync(snapshotsDir)) return false;
    try {
      return readdirSync(snapshotsDir, { withFileTypes: true }).some(
        (entry) =>
          entry.isDirectory() &&
          hasSnapshotFiles(join(snapshotsDir, entry.name)),
      );
    } catch {
      return false;
    }
  });
}

function runtimeMetadataPath(rootDir = getMlxRuntimeDir()): string {
  return join(rootDir, "metadata.json");
}

function readInstalledRuntimeMetadata(): InstalledMlxRuntimeMetadata | null {
  try {
    const raw = readFileSync(runtimeMetadataPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<InstalledMlxRuntimeMetadata>;
    return {
      downloadedAt:
        typeof parsed.downloadedAt === "string" ? parsed.downloadedAt : "",
      sourceUrl: typeof parsed.sourceUrl === "string" ? parsed.sourceUrl : "",
      workerVersion:
        typeof parsed.workerVersion === "string" ? parsed.workerVersion : null,
      syncedAppVersion:
        typeof parsed.syncedAppVersion === "string"
          ? parsed.syncedAppVersion
          : null,
    };
  } catch {
    return null;
  }
}

function writeRuntimeMetadata(
  rootDir: string,
  sourceUrl: string,
  syncedAppVersion: string | null,
): void {
  const metadata: InstalledMlxRuntimeMetadata = {
    downloadedAt: new Date().toISOString(),
    sourceUrl,
    workerVersion: expectedRuntimeVersion(),
    syncedAppVersion,
  };
  writeFileSync(
    runtimeMetadataPath(rootDir),
    JSON.stringify(metadata, null, 2),
    "utf8",
  );
}

function isRuntimeSyncedForAppVersion(appVersion: string): boolean {
  const meta = readInstalledRuntimeMetadata();
  if (meta?.syncedAppVersion !== appVersion) return false;
  if (!isManagedMlxRuntimeAvailable()) return false;
  return !needsManagedMlxRuntimeUpdate();
}

export function isMlxRuntimeInstallable(): boolean {
  return isAppleSiliconMac() && !!runtimeUrl();
}

export function isManagedMlxRuntimeAvailable(): boolean {
  return existsSync(getManagedMlxWorkerPath());
}

export function getInstalledMlxRuntimeVersion(): string | null {
  return readInstalledRuntimeMetadata()?.workerVersion ?? null;
}

export function needsManagedMlxRuntimeUpdate(): boolean {
  const version = expectedRuntimeVersion();
  if (!version || !isManagedMlxRuntimeAvailable()) return false;
  return getInstalledMlxRuntimeVersion() !== version;
}

export function getMlxRuntimeDownloadStatus(): MlxRuntimeDownloadStatus {
  const available = isManagedMlxRuntimeAvailable();
  if (activeDownload?.error) {
    return {
      available,
      downloading: false,
      url: runtimeUrl(),
      error: activeDownload.error,
    };
  }
  if (activeDownload) {
    return {
      available,
      downloading: true,
      url: runtimeUrl(),
      downloadProgress: activeDownload.bytesTotal
        ? {
            bytesDownloaded: activeDownload.bytesDownloaded,
            bytesTotal: activeDownload.bytesTotal,
            percent: Math.round(
              (activeDownload.bytesDownloaded / activeDownload.bytesTotal) *
                100,
            ),
            speedBps: activeDownload.speedBps,
          }
        : undefined,
    };
  }
  return { available, downloading: false, url: runtimeUrl() };
}

export async function ensureMlxRuntimeDownloaded(): Promise<void> {
  if (isManagedMlxRuntimeAvailable() && !needsManagedMlxRuntimeUpdate()) return;
  if (!isMlxRuntimeInstallable()) {
    throw new Error("MLX ASR runtime is only available on Apple Silicon Macs.");
  }
  if (activeDownload && !activeDownload.error) return activeDownload.promise;
  if (activeDownload?.error) activeDownload = null;

  const controller = new AbortController();
  const active: ActiveRuntimeDownload = {
    controller,
    bytesDownloaded: 0,
    bytesTotal: 0,
    speedBps: 0,
    lastUpdate: Date.now(),
    lastBytes: 0,
    promise: Promise.resolve(),
  };

  active.promise = downloadRuntime(active).finally(() => {
    if (activeDownload === active && !active.error) {
      activeDownload = null;
    }
  });
  activeDownload = active;
  return active.promise;
}

export async function updateManagedMlxRuntimeIfNeeded(): Promise<boolean> {
  if (!needsManagedMlxRuntimeUpdate()) return false;
  await ensureMlxRuntimeDownloaded();
  return true;
}

/** Stage the worker for an upcoming app release without replacing the active runtime. */
export async function prefetchManagedMlxRuntimeForAppRelease(
  releaseTag: string,
): Promise<boolean> {
  if (!isAppleSiliconMac() || !hasAnyMlxModelDownloaded()) return false;
  if (isStagedRuntimeReady(releaseTag)) return false;
  if (!isMlxRuntimeInstallable()) return false;
  if (activeDownload && !activeDownload.error) return false;

  const controller = new AbortController();
  const active: ActiveRuntimeDownload = {
    controller,
    bytesDownloaded: 0,
    bytesTotal: 0,
    speedBps: 0,
    lastUpdate: Date.now(),
    lastBytes: 0,
    promise: Promise.resolve(),
  };

  active.promise = downloadRuntimeToDir(
    active,
    stagedRuntimeRoot(releaseTag),
    runtimeUrlForReleaseTag(releaseTag),
    releaseTag,
    true, // always our own tagged GitHub release — never the URL override
  ).finally(() => {
    if (activeDownload === active && !active.error) {
      activeDownload = null;
    }
  });
  activeDownload = active;
  await active.promise;
  return isStagedRuntimeReady(releaseTag);
}

function promoteStagedRuntime(releaseTag: string): boolean {
  if (!isStagedRuntimeReady(releaseTag)) return false;

  const runtimeDir = getMlxRuntimeDir();
  const stagedRoot = stagedRuntimeRoot(releaseTag);
  const sourceUrl = runtimeUrlForReleaseTag(releaseTag);

  rmSync(runtimeDir, { recursive: true, force: true });
  mkdirSync(dirname(runtimeDir), { recursive: true });
  renameSync(stagedRoot, runtimeDir);
  writeRuntimeMetadata(runtimeDir, sourceUrl, releaseTag);

  rmSync(getMlxRuntimeStagingRoot(), { recursive: true, force: true });

  return isManagedMlxRuntimeAvailable();
}

/**
 * After an app restart on a new version, promote a worker staged during app update.
 * Does not download on its own — lazy MLX paths fetch the worker on first use if
 * staging was skipped. No-ops unless the user has downloaded at least one MLX model.
 */
export async function activateManagedMlxRuntimeForAppVersion(
  appVersion: string,
): Promise<boolean> {
  if (!isAppleSiliconMac() || !hasAnyMlxModelDownloaded()) return false;
  if (isRuntimeSyncedForAppVersion(appVersion)) return false;
  if (!promoteStagedRuntime(appVersion)) return false;
  return true;
}

export function cancelMlxRuntimeDownload(): boolean {
  if (!activeDownload) return false;
  activeDownload.controller.abort();
  activeDownload = null;
  return true;
}

function runtimeDownloadHttpError(url: string, status: number): Error {
  if (
    status === 404 &&
    url.includes(`github.com/${MLX_WORKER_REPO}/releases/download/`)
  ) {
    return new Error(
      "MLX runtime download failed because this Openstyle release does not include the MLX worker asset yet.",
    );
  }

  if (
    status === 404 &&
    url.includes(`github.com/${MLX_WORKER_REPO}/releases/latest/download/`)
  ) {
    return new Error(
      "MLX runtime download failed because no published Openstyle release contains the MLX worker asset yet.",
    );
  }

  if (status === 403 && url.includes(`github.com/${MLX_WORKER_REPO}`)) {
    return new Error(
      "MLX runtime download failed because GitHub temporarily rejected the request (HTTP 403). Please try again in a few minutes.",
    );
  }

  return new Error(`MLX runtime download failed: HTTP ${status}`);
}

async function downloadRuntime(active: ActiveRuntimeDownload): Promise<void> {
  const url = runtimeUrl();
  if (!url) throw new Error("MLX ASR worker download URL is not configured.");

  const runtimeDir = getMlxRuntimeDir();
  const releaseTag = runtimeReleaseTag();
  // OPENSTYLE_MLX_ASR_WORKER_URL is the only trusted-operator escape hatch
  // that changes *where* the archive comes from; an arbitrary host has no
  // digest we can look up, so integrity verification is skipped for it (loud
  // warning logged from downloadRuntimeToDir, not silently). Every other path
  // — the default "latest" URL and an explicit release tag — is still our
  // own GitHub release and is always verified.
  const isOperatorUrlOverride = Boolean(mlxAsrWorkerUrlOverride());
  const tempDir = `${runtimeDir}.downloading`;
  // Capture the old metadata before the directory is destroyed so
  // syncedAppVersion survives the re-download.
  const prevMeta = readInstalledRuntimeMetadata();
  await downloadRuntimeToDir(
    active,
    tempDir,
    url,
    releaseTag,
    !isOperatorUrlOverride,
  );

  rmSync(runtimeDir, { recursive: true, force: true });
  mkdirSync(dirname(runtimeDir), { recursive: true });
  renameSync(tempDir, runtimeDir);
  const syncedVersion = releaseTag ?? prevMeta?.syncedAppVersion ?? null;
  writeRuntimeMetadata(runtimeDir, url, syncedVersion);

  if (!isManagedMlxRuntimeAvailable()) {
    throw new Error("MLX runtime downloaded but worker executable is missing.");
  }
}

/** Record that the active worker matches this app version (after promote or lazy install). */
export function markManagedMlxRuntimeSyncedForAppVersion(
  appVersion: string,
): void {
  if (!isManagedMlxRuntimeAvailable()) return;
  const existing = readInstalledRuntimeMetadata();
  writeRuntimeMetadata(
    getMlxRuntimeDir(),
    existing?.sourceUrl ?? runtimeUrl() ?? "",
    appVersion,
  );
}

async function downloadRuntimeToDir(
  active: ActiveRuntimeDownload,
  destDir: string,
  url: string,
  releaseTag: string | null,
  verifyIntegrity: boolean,
): Promise<void> {
  const archivePath = join(destDir, "mlx_asr_worker.tar.gz");

  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });

  try {
    const res = await fetch(url, {
      signal: active.controller.signal,
      redirect: "follow",
    });
    if (!res.ok || !res.body) {
      throw runtimeDownloadHttpError(url, res.status);
    }

    const contentLength = res.headers.get("content-length");
    if (contentLength) active.bytesTotal = Number.parseInt(contentLength, 10);

    // Fail fast (before spending bandwidth) if the volume can't hold the
    // compressed archive plus its much larger extracted bundle. The PyInstaller
    // worker expands to several times the download size, so reserve ~4x the
    // archive, with a conservative floor.
    const archiveBytes = active.bytesTotal || 0;
    const requiredBytes = Math.max(
      MIN_RUNTIME_FREE_BYTES,
      archiveBytes * RUNTIME_EXTRACT_RATIO,
    );
    await assertEnoughDiskSpace(destDir, requiredBytes);

    // Hash while streaming to disk rather than re-reading the archive
    // afterwards.
    const hash = createHash("sha256");
    const hashThrough = new Transform({
      transform(chunk, _enc, cb) {
        hash.update(chunk as Buffer);
        cb(null, chunk);
      },
    });

    await pipeline(
      webBodyToReadable(res.body, active),
      hashThrough,
      createWriteStream(archivePath),
    );

    const actualDigest = hash.digest("hex");

    if (verifyIntegrity) {
      const expectedDigest = await resolveExpectedWorkerDigest(
        releaseTag,
        active.controller.signal,
      );
      if (!expectedDigest) {
        log.error(
          `No trusted sha256 digest available to verify the MLX ASR worker archive for release ${
            releaseTag ?? "latest"
          } (downloaded sha256: ${actualDigest}). Refusing to extract an unverified binary.`,
        );
        throw new Error(
          "MLX runtime download failed integrity verification: no trusted checksum is published for this release yet. Refusing to extract an unverified binary.",
        );
      }
      if (actualDigest !== expectedDigest) {
        log.error(
          `MLX ASR worker archive checksum mismatch for release ${
            releaseTag ?? "latest"
          }: expected ${expectedDigest}, got ${actualDigest}.`,
        );
        throw new Error(
          "MLX runtime download failed integrity verification: the downloaded archive does not match the expected checksum. Refusing to extract a corrupted or tampered download.",
        );
      }
    } else {
      // OPENSTYLE_MLX_ASR_WORKER_URL is in use — see the doc comment on
      // runtimeUrl(). There is no trusted digest to check an arbitrary host
      // against, so verification is deliberately skipped here, loudly.
      log.warn(
        `OPENSTYLE_MLX_ASR_WORKER_URL is set — downloaded the MLX ASR worker from an operator-supplied URL (${url}, sha256 ${actualDigest}) and skipped integrity verification. Trusted-operator-only escape hatch; do not point this at an untrusted URL.`,
      );
    }

    execFileSync("tar", ["xzf", archivePath, "-C", destDir], {
      stdio: "pipe",
      timeout: 120_000,
    });
    unlinkSync(archivePath);
  } catch (err) {
    rmSync(destDir, { recursive: true, force: true });
    if (active.controller.signal.aborted) return;
    active.error = describeDownloadError(err);
    throw err;
  }
}

function webBodyToReadable(
  body: ReadableStream<Uint8Array>,
  progress: ActiveRuntimeDownload,
): Readable {
  const reader = body.getReader();
  return new Readable({
    async read() {
      try {
        const { done, value } = await reader.read();
        if (done) {
          this.push(null);
          return;
        }
        progress.bytesDownloaded += value.byteLength;
        const now = Date.now();
        const elapsed = now - progress.lastUpdate;
        if (elapsed >= 500) {
          const delta = progress.bytesDownloaded - progress.lastBytes;
          progress.speedBps = Math.round((delta / elapsed) * 1000);
          progress.lastUpdate = now;
          progress.lastBytes = progress.bytesDownloaded;
        }
        this.push(Buffer.from(value));
      } catch (err) {
        this.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    },
  });
}
