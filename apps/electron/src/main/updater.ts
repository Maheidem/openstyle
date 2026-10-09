// Auto-update wiring for the main process.
// Registers the updater IPC handlers.
// Wires update events only when the app is not in development.
import { is } from "@electron-toolkit/utils";
import { prefetchManagedMlxRuntimeForAppRelease } from "@openstyle/server";
import { createAppLogger } from "@openstyle/utils";
import { app, ipcMain, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { shouldStartAutoDownload } from "./auto-update-policy";
import { readSettings } from "./local-settings";
import { state } from "./main-state";
import { rebuildMenus, restartAndUpdate } from "./menus";
import { notify } from "./notifications";
import {
  isRunningFromReadOnlyLocation,
  READ_ONLY_UPDATE_RE,
  RELEASES_PAGE_URL,
  showMoveToApplicationsDialog,
} from "./permission-dialogs";
import { selfUpdater } from "./self-updater";

const log = createAppLogger("electron");

export function registerUpdater(): void {
  // -- Auto-update helpers --
  const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  let updateCheckTimer: ReturnType<typeof setInterval> | null = null;

  // autoDownload is always false, so checkForUpdates() only checks the feed.
  // The update-available handler starts the download when "Automatic updates"
  // is on. The selfUpdater "downloaded" handler shows the completion
  // notification.
  function runUpdateCheck(): void {
    autoUpdater.checkForUpdates().catch((err) => {
      log.warn(
        `Update check failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  // Downloads the release zip through selfUpdater (see the updater:download
  // handler for why). A click on the banner opens the releases page when the
  // download fails. The background download of "Automatic updates" only logs
  // the failure: it must not open a browser. The next check tries again.
  function startSelfUpdateDownload(openReleasesOnFailure: boolean): void {
    state.updateDownloadState = "downloading";
    state.settingsWindow?.webContents.send("updater:downloading", {
      percent: 0,
      transferred: 0,
      total: 0,
    });
    selfUpdater.downloadUpdate().catch((err) => {
      state.updateDownloadState = "idle";
      const msg = err instanceof Error ? err.message : String(err);
      state.settingsWindow?.webContents.send("updater:error", { message: msg });
      if (!openReleasesOnFailure) {
        log.warn(`Background self-update download failed: ${msg}`);
        return;
      }
      log.warn(
        `Self-update download failed, falling back to releases page: ${msg}`,
      );
      void shell.openExternal(RELEASES_PAGE_URL);
    });
  }

  function startUpdateCheckInterval(): void {
    if (updateCheckTimer) return;
    updateCheckTimer = setInterval(runUpdateCheck, UPDATE_CHECK_INTERVAL_MS);
  }

  // -- Auto-updater with IPC notifications --
  // Track versions we already notified about so periodic checks don't spam.
  // Separate flags for "available" vs "downloaded" because both events fire
  // for the same version and each deserves one notification.
  let notifiedAvailableVersion: string | null = null;
  let notifiedDownloadedVersion: string | null = null;

  if (!is.dev) {
    const autoUpdateEnabled = readSettings().autoUpdate !== false;
    // Every build is ad-hoc signed (no paid Apple Developer identity yet).
    // Squirrel.Mac deterministically rejects ad-hoc-signed updates AFTER
    // downloading them ("Code signature ... did not pass validation"), so we
    // still use electron-updater only to *check* the release feed. On
    // macOS, downloading and installing goes through selfUpdater (see
    // self-updater.ts) instead of Squirrel.Mac; other platforms open the
    // releases page. autoDownload is always false, so electron-updater never
    // itself downloads the (Squirrel-incompatible) update artifact.
    autoUpdater.autoDownload = false;
    // Honour the same preference on quit. Upstream hardcoded this to true, so a
    // single manual "Check for Updates" could stage a release that then
    // installed itself on the next quit even with auto-update turned off.
    autoUpdater.autoInstallOnAppQuit = autoUpdateEnabled;
    autoUpdater.logger = createAppLogger("updater");

    autoUpdater.on("update-available", (info) => {
      state.settingsWindow?.webContents.send("updater:available", {
        version: info.version,
      });
      // electron-updater never auto-downloads (autoDownload is always false
      // — see above). With "Automatic updates" on, the main process starts
      // the self-update download here. With it off, the in-app banner drives
      // the download via updater:download. The setting is read now, not at
      // startup, so a toggle in settings applies to the next check.
      if (
        shouldStartAutoDownload({
          autoUpdateEnabled: readSettings().autoUpdate !== false,
          downloadState: state.updateDownloadState,
          selfUpdateUnavailableReason: selfUpdater.unavailableReason(),
        })
      ) {
        log.info(`Automatic updates on: downloading ${info.version}`);
        startSelfUpdateDownload(false);
      }
      if (notifiedAvailableVersion !== info.version) {
        notifiedAvailableVersion = info.version;
        notify(
          "Openstyle Update Available",
          `Version ${info.version} is available.`,
          "/settings",
        );
      }
    });

    selfUpdater.on("progress", (p) => {
      state.settingsWindow?.webContents.send("updater:downloading", p);
    });

    selfUpdater.on("downloaded", (info) => {
      state.updateDownloadState = "downloaded";
      state.settingsWindow?.webContents.send("updater:downloaded", {
        version: info.version,
      });
      if (notifiedDownloadedVersion !== info.version) {
        notifiedDownloadedVersion = info.version;
        notify(
          "Update Ready to Install",
          `Version ${info.version} has been downloaded. Restart to update.`,
          "/settings",
        );
      }
      if (updateCheckTimer) {
        clearInterval(updateCheckTimer);
        updateCheckTimer = null;
      }
      rebuildMenus();
      void prefetchManagedMlxRuntimeForAppRelease(info.version).catch((err) => {
        log.warn(
          `Failed to stage MLX runtime for ${info.version}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    });

    autoUpdater.on("error", (err) => {
      if (state.updateDownloadState === "downloading") {
        state.updateDownloadState = "idle";
      }
      const msg = err?.message ?? "Update failed";
      if (READ_ONLY_UPDATE_RE.test(msg) && isRunningFromReadOnlyLocation()) {
        showMoveToApplicationsDialog();
        state.settingsWindow?.webContents.send("updater:error", {
          message:
            "Openstyle is running from a read-only location. Move it to Applications and relaunch.",
        });
      } else {
        state.settingsWindow?.webContents.send("updater:error", {
          message: msg,
        });
      }
    });

    if (isRunningFromReadOnlyLocation()) {
      notify(
        "Move Openstyle to Applications",
        "Openstyle can\u2019t update from this location. Move it to your Applications folder and relaunch.",
        "/settings",
      );
    } else if (autoUpdateEnabled) {
      // Only poll when auto-update is actually on. Upstream polled every 5
      // minutes regardless of the setting, so turning auto-update off still
      // talked to the release feed and still raised update notifications.
      runUpdateCheck();
      startUpdateCheckInterval();
    }
  }

  ipcMain.on("updater:download", () => {
    // Every build is ad-hoc signed, so Squirrel.Mac would reject a download
    // done through electron-updater's own downloadUpdate() (see the
    // autoDownload=false comment above). On a packaged macOS build we
    // instead download + verify the release zip ourselves via selfUpdater
    // (self-updater.ts) and skip Squirrel entirely. Everywhere else (dev
    // builds, other platforms, or if self-update can't run here) we fall
    // back to sending the user to the releases page.
    const reason = selfUpdater.unavailableReason();
    if (reason) {
      log.warn(`Self-update unavailable (${reason}); opening releases page`);
      void shell.openExternal(RELEASES_PAGE_URL);
      return;
    }
    startSelfUpdateDownload(true);
  });

  ipcMain.on("updater:install", () => {
    restartAndUpdate();
  });

  ipcMain.handle("updater:check", async () => {
    if (is.dev) return null;
    try {
      const result = await autoUpdater.checkForUpdates();
      const latest = result?.updateInfo?.version;
      if (!latest) return null;
      // Only report an update when the remote version is actually newer
      if (latest === app.getVersion()) return null;
      return { version: latest, downloadState: state.updateDownloadState };
    } catch {
      return null;
    }
  });
}
