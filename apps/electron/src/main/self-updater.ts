// Electron glue for the macOS self-updater. The reason for the self-updater
// (signing history, Squirrel.Mac) is in the self-updater-core.ts header
// comment. This file wires that pure logic into the running app: paths,
// IPC-facing events, and the download -> extract -> swap -> relaunch sequence.

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createAppLogger } from "@openstyle/utils";
import { app } from "electron";
import {
  assembleZip,
  cleanupBackup,
  type DownloadProgress,
  downloadAndVerify,
  extractZip,
  fetchLatestManifest,
  fetchRange,
  findAppBundle,
  loadBlockmap,
  planDelta,
  probeWritable,
  pruneUpdateFolders,
  readBundleVersion,
  removeQuarantine,
  sanityCheckBundle,
  selectZipEntry,
  swapBundle,
  sweepOldBackups,
} from "./self-updater-core";
import {
  e2eReleasesUrl,
  isNewerVersion,
  releasesUrl,
  runningVersion,
} from "./update-channel";

const log = createAppLogger("electron");

// Only the E2E harness may point the updater at a local feed.
const RELEASES_URL = releasesUrl();

// Above this share of the zip, a delta saves too little. Download it all.
const MAX_DELTA_FRACTION = 0.7;

/**
 * Try to build `destPath` from the cached zip of the running version plus the
 * changed byte ranges. Returns false when a delta is not possible or fails.
 * The caller then downloads the whole zip.
 */
async function downloadDelta(
  zipUrl: string,
  newVersion: string,
  expectedSha512: string,
  destPath: string,
  onProgress: (p: DownloadProgress) => void,
): Promise<boolean> {
  const currentVersion = runningVersion(app.getVersion());
  const zipName = zipUrl.split("/").pop() ?? "";
  const oldZipName = zipName.replace(newVersion, currentVersion);
  const oldZipPath = join(
    app.getPath("userData"),
    "updates",
    currentVersion,
    oldZipName,
  );
  if (oldZipName === zipName || !existsSync(oldZipPath)) return false;

  try {
    const [oldMap, newMap] = await Promise.all([
      loadBlockmap(
        `${RELEASES_URL}/download/${currentVersion}/${oldZipName}.blockmap`,
      ),
      loadBlockmap(`${zipUrl}.blockmap`),
    ]);
    const plan = planDelta(oldMap, newMap);
    if (plan.bytesToFetch > plan.bytesTotal * MAX_DELTA_FRACTION) {
      log.info(
        `Delta update skipped: ${plan.bytesToFetch} of ${plan.bytesTotal} bytes changed`,
      );
      return false;
    }
    const { sha512 } = await assembleZip(
      oldZipPath,
      plan,
      (start, end) => fetchRange(zipUrl, start, end),
      destPath,
      onProgress,
    );
    if (sha512 !== expectedSha512) throw new Error("sha512 mismatch");
    log.info(
      `Delta update: fetched ${plan.bytesToFetch} of ${plan.bytesTotal} bytes`,
    );
    return true;
  } catch (err) {
    log.warn(
      `Delta update failed, using full download: ${err instanceof Error ? err.message : String(err)}`,
    );
    rmSync(destPath, { force: true });
    return false;
  }
}

// Both downloadUpdate() and installUpdate() report failures by rejecting
// their returned promise — there's no separate "error" event to listen for.
// Only "progress" and "downloaded" are emitted.
class SelfUpdater extends EventEmitter {
  private downloadedZipPath: string | null = null;
  private downloadedVersion: string | null = null;
  private downloadInFlight: {
    version: string;
    generation: number;
    promise: Promise<void>;
  } | null = null;
  // discardDownload() increments this. A download that started before the
  // increment ends without a "downloaded" event.
  private generation = 0;

  /**
   * Returns why self-update isn't available right now, or null when it is.
   * Callers use this to decide whether to fall back to opening the releases
   * page.
   */
  unavailableReason(): string | null {
    // E2E seam: a run with the fake release feed downloads, but never installs
    // (restartAndUpdate() stops before the install in an E2E run).
    if (e2eReleasesUrl()) return null;
    if (!app.isPackaged) return "not packaged";
    if (process.platform !== "darwin") return "not macOS";
    const bundle = findAppBundle(app.getPath("exe"));
    if (!bundle) return "not running from an .app bundle";
    return null;
  }

  private bundlePath(): string {
    const bundle = findAppBundle(app.getPath("exe"));
    if (!bundle)
      throw new Error("Could not locate .app bundle for running executable");
    return bundle;
  }

  /**
   * Download the release zip of `version`, the version that the update check
   * found on the current channel. The version must be newer than the running
   * version. Only the explicit switch to Stable passes `allowOlder`.
   * A second call for the same version while its download runs returns the
   * same promise, so two callers never write the same file.
   */
  downloadUpdate(
    version: string,
    options: { allowOlder?: boolean } = {},
  ): Promise<void> {
    const generation = this.generation;
    if (
      this.downloadInFlight?.version === version &&
      this.downloadInFlight.generation === generation
    ) {
      return this.downloadInFlight.promise;
    }
    const previous = this.downloadInFlight?.promise.catch(() => {});
    const promise = Promise.resolve(previous)
      .then(() =>
        this.runDownload(version, options.allowOlder === true, generation),
      )
      .finally(() => {
        if (this.downloadInFlight?.promise === promise) {
          this.downloadInFlight = null;
        }
      });
    this.downloadInFlight = { version, generation, promise };
    return promise;
  }

  /**
   * Forget the staged download, for example after a change of the update
   * channel. A download that runs now ends without a "downloaded" event.
   */
  discardDownload(): void {
    this.generation += 1;
    this.downloadedZipPath = null;
    this.downloadedVersion = null;
  }

  private async runDownload(
    version: string,
    allowOlder: boolean,
    generation: number,
  ): Promise<void> {
    const reason = this.unavailableReason();
    if (reason) throw new Error(`Self-update unavailable: ${reason}`);
    const current = runningVersion(app.getVersion());
    if (version === current) {
      throw new Error(`Version ${version} is already installed`);
    }
    if (!allowOlder && !isNewerVersion(version, current)) {
      throw new Error(
        `Version ${version} is not newer than the installed version ${current}`,
      );
    }

    // Read the feed file of the release tag that the check found. Tags have
    // no "v" prefix. Before 2.24.0 this read releases/latest, so a Dev check
    // that found an alpha downloaded the Stable zip.
    const tagUrl = `${RELEASES_URL}/download/${version}`;
    const manifest = await fetchLatestManifest(`${tagUrl}/latest-mac.yml`);
    if (manifest.version !== version) {
      throw new Error(
        `latest-mac.yml of release ${version} names version ${manifest.version}`,
      );
    }
    const entry = selectZipEntry(manifest, process.arch);
    const zipUrl = entry.url.startsWith("http")
      ? entry.url
      : `${tagUrl}/${entry.url}`;

    const destDir = join(app.getPath("userData"), "updates", manifest.version);
    const destPath = join(destDir, entry.url.split("/").pop() ?? "update.zip");

    const onProgress = (p: DownloadProgress) => this.emit("progress", p);
    const usedDelta = await downloadDelta(
      zipUrl,
      manifest.version,
      entry.sha512,
      destPath,
      onProgress,
    );
    if (!usedDelta) {
      await downloadAndVerify(zipUrl, entry.sha512, destPath, onProgress);
    }
    if (generation !== this.generation) {
      log.info(`Download of ${version} discarded: the update channel changed`);
      return;
    }

    this.downloadedZipPath = destPath;
    this.downloadedVersion = manifest.version;
    this.emit("downloaded", { version: manifest.version });
  }

  get isReadyToInstall(): boolean {
    return this.downloadedZipPath !== null;
  }

  /**
   * Extract, verify, atomically swap the app bundle, remove quarantine, and
   * relaunch. `onBeforeQuit` is called immediately before `app.quit()` — the
   * caller uses it to flip whatever "let this quit through" flag its
   * `before-quit` handler checks. It can return a promise: the install waits
   * for it, so the caller can stop child processes first. It's called this
   * late (not up front) because extraction/swap here can take several seconds and we don't want
   * a manual Cmd+Q during that window falling into the "quit is expected"
   * branch and skipping normal cleanup / preventDefault.
   */
  async installUpdate(
    onBeforeQuit?: () => void | Promise<void>,
  ): Promise<void> {
    if (!this.downloadedZipPath || !this.downloadedVersion) {
      throw new Error("No downloaded update to install");
    }
    const reason = this.unavailableReason();
    if (reason) throw new Error(`Self-update unavailable: ${reason}`);

    const currentBundle = this.bundlePath();
    const parent = join(currentBundle, "..");
    if (!probeWritable(parent)) {
      throw new Error(
        `${parent} is not writable. Move Openstyle to a writable location (e.g. /Applications) and relaunch.`,
      );
    }

    const stagingDir = join(parent, `.openstyle-update-${Date.now()}`);
    let newAppPath: string;
    try {
      newAppPath = await extractZip(this.downloadedZipPath, stagingDir);
      const executableName = app.getName();
      sanityCheckBundle(newAppPath, executableName);
      const extractedVersion = await readBundleVersion(newAppPath).catch(
        () => null,
      );
      if (extractedVersion && extractedVersion !== this.downloadedVersion) {
        throw new Error(
          `Downloaded bundle reports version ${extractedVersion}, expected ${this.downloadedVersion}`,
        );
      }
    } catch (err) {
      await cleanupBackup(stagingDir);
      throw err;
    }

    // Do not delete the old bundle backup here. This process can still run
    // from it (mapped dylibs and resources are not all paged in yet), and
    // app.quit() is only seconds away. sweepSelfUpdaterBackups() clears the
    // backup on the next launch.
    swapBundle(currentBundle, newAppPath);
    await removeQuarantine(currentBundle);
    await cleanupBackup(stagingDir); // remove leftover extraction dir (e.g. __MACOSX)

    await onBeforeQuit?.();
    relaunch(currentBundle);
  }
}

function relaunch(appPath: string): void {
  // Detached shell: `sleep 1` gives this process time to actually exit
  // before `open` launches the (possibly same-named) new binary. The path is
  // passed as $0 rather than interpolated into the shell string so spaces in
  // the path can't break quoting.
  const child = spawn("/bin/sh", ["-c", 'sleep 1 && open "$0"', appPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  app.quit();
}

/** Call once at startup to clear out `.old-*` backups left by a prior update. */
export async function sweepSelfUpdaterBackups(): Promise<void> {
  if (!app.isPackaged || process.platform !== "darwin") return;
  const bundle = findAppBundle(app.getPath("exe"));
  if (bundle) await sweepOldBackups(bundle);
}

/**
 * Call once at startup. Deletes the downloaded zips of every version except
 * the running one. The running version's zip is the base for the next delta.
 */
export async function pruneSelfUpdaterDownloads(): Promise<void> {
  if (!app.isPackaged || process.platform !== "darwin") return;
  await pruneUpdateFolders(
    join(app.getPath("userData"), "updates"),
    app.getVersion(),
  );
}

export const selfUpdater = new SelfUpdater();
