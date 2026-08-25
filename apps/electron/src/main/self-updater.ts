// Electron glue for the macOS self-updater. All ad-hoc-signed-build reasoning
// lives in self-updater-core.ts's header comment; this file wires that pure
// logic into the running app: paths, IPC-facing events, and the
// download -> extract -> swap -> relaunch sequence.

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { app } from "electron";
import {
  cleanupBackup,
  downloadAndVerify,
  extractZip,
  fetchLatestManifest,
  findAppBundle,
  probeWritable,
  readBundleVersion,
  removeQuarantine,
  sanityCheckBundle,
  selectZipEntry,
  swapBundle,
  sweepOldBackups,
} from "./self-updater-core";

const MANIFEST_URL =
  "https://github.com/Maheidem/openstyle/releases/latest/download/latest-mac.yml";

// Both downloadUpdate() and installUpdate() report failures by rejecting
// their returned promise — there's no separate "error" event to listen for.
// Only "progress" and "downloaded" are emitted.
class SelfUpdater extends EventEmitter {
  private downloadedZipPath: string | null = null;
  private downloadedVersion: string | null = null;

  /**
   * Returns why self-update isn't available right now, or null when it is.
   * Callers use this to decide whether to fall back to opening the releases
   * page.
   */
  unavailableReason(): string | null {
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

  async downloadUpdate(): Promise<void> {
    const reason = this.unavailableReason();
    if (reason) throw new Error(`Self-update unavailable: ${reason}`);

    // The manifest is the source of truth for what we download — the
    // renderer's "available" version (surfaced via updater:check) is only
    // used to decide whether to offer a download at all.
    const manifest = await fetchLatestManifest(MANIFEST_URL);
    const entry = selectZipEntry(manifest, process.arch);
    // Resolve relative to "latest/download/" (same base as the manifest
    // itself) rather than guessing the release tag's "v" prefix — GitHub
    // redirects this to the real tagged asset URL either way.
    const zipUrl = entry.url.startsWith("http")
      ? entry.url
      : `https://github.com/Maheidem/openstyle/releases/latest/download/${entry.url}`;

    const destDir = join(app.getPath("userData"), "updates", manifest.version);
    const destPath = join(destDir, entry.url.split("/").pop() ?? "update.zip");

    await downloadAndVerify(zipUrl, entry.sha512, destPath, (p) => {
      this.emit("progress", p);
    });

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
   * `before-quit` handler checks. It's called this late (not up front)
   * because extraction/swap here can take several seconds and we don't want
   * a manual Cmd+Q during that window falling into the "quit is expected"
   * branch and skipping normal cleanup / preventDefault.
   */
  async installUpdate(onBeforeQuit?: () => void): Promise<void> {
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

    // oldBundleBackupPath is deliberately left in place here rather than
    // deleted immediately: this process may still be executing out of it
    // (mapped dylibs/resources not yet paged in), and app.quit() is seconds
    // away. sweepSelfUpdaterBackups() clears it on the next launch instead.
    swapBundle(currentBundle, newAppPath);
    await removeQuarantine(currentBundle);
    await cleanupBackup(stagingDir); // remove leftover extraction dir (e.g. __MACOSX)

    onBeforeQuit?.();
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

export const selfUpdater = new SelfUpdater();
