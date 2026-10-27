// Auto-update wiring for the main process.
// Registers the updater IPC handlers.
// Wires update events only when the app is not in development.
import { is } from "@electron-toolkit/utils";
import { createAppLogger } from "@openstyle/utils";
import { app, ipcMain, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { parse } from "semver";
import { shouldStartAutoDownload } from "./auto-update-policy";
import { readSettings, writeSettings } from "./local-settings";
import { state } from "./main-state";
import {
  rebuildMenus,
  restartAndUpdate,
  takeStopRecordingConfirm,
} from "./menus";
import { notify } from "./notifications";
import {
  isRunningFromReadOnlyLocation,
  READ_ONLY_UPDATE_RE,
  RELEASES_PAGE_URL,
  showMoveToApplicationsDialog,
} from "./permission-dialogs";
import { selfUpdater } from "./self-updater";
import { prefetchMlxRuntime } from "./server-host";
import { refreshTrayIcon } from "./tray-icon";
import {
  applyChannel,
  e2eReleasesUrl,
  githubFeedOptions,
  isNewerVersion,
  isUpdateChannel,
  resolveChannel,
  runningVersion,
  switchNeedsDowngrade,
  type UpdateChannel,
} from "./update-channel";

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

  const version = runningVersion(app.getVersion());
  // The version that the last check found. `allowOlder` is true only after the
  // explicit switch to Stable (owner decision D4).
  let availableUpdate: { version: string; allowOlder: boolean } | null = null;
  // True only during the check that the explicit switch to Stable starts.
  let explicitDowngrade = false;
  // The version to install at once when its download ends (the switch to
  // Stable installs the Stable version right away).
  let installWhenDownloaded: string | null = null;
  // True when the user agreed that the switch to Stable stops a recording.
  let switchStopsRecording = false;

  // Downloads the release zip through selfUpdater (see the updater:download
  // handler for why). A click on the banner opens the releases page when the
  // download fails. The background download of "Automatic updates" only logs
  // the failure: it must not open a browser. The next check tries again.
  function startSelfUpdateDownload(openReleasesOnFailure: boolean): void {
    const update = availableUpdate;
    if (!update) {
      log.warn("Self-update download requested, but no check found an update");
      return;
    }
    state.updateDownloadState = "downloading";
    state.settingsWindow?.webContents.send("updater:downloading", {
      percent: 0,
      transferred: 0,
      total: 0,
    });
    selfUpdater
      .downloadUpdate(update.version, { allowOlder: update.allowOlder })
      .catch((err) => {
        state.updateDownloadState = "idle";
        const msg = err instanceof Error ? err.message : String(err);
        state.settingsWindow?.webContents.send("updater:error", {
          message: msg,
        });
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

  // The dev flavor (pnpm dev:install) updates by a rebuild, never by the feed.
  // An E2E run with a fake release feed turns updates on for an unpackaged app.
  const e2eFeed = e2eReleasesUrl();
  const updatesOn = e2eFeed !== null || (!is.dev && !state.devFlavor);

  if (updatesOn) {
    const autoUpdateEnabled = readSettings().autoUpdate !== false;
    if (e2eFeed) {
      const feed = githubFeedOptions(e2eFeed);
      if (feed) autoUpdater.setFeedURL(feed);
      autoUpdater.forceDevUpdateConfig = true;
      const parsed = parse(version);
      if (parsed) {
        // electron-updater reads the version once, from the unpackaged app.
        (autoUpdater as unknown as { currentVersion: unknown }).currentVersion =
          parsed;
      }
    }
    // Set the channel before the first check. allowDowngrade stays false.
    applyChannel(
      autoUpdater,
      resolveChannel(readSettings().updateChannel, version),
    );
    // Builds before 2.15.1 were ad-hoc signed, and Squirrel.Mac rejected
    // their updates AFTER downloading them ("Code signature ... did not pass
    // validation"). Since 2.15.1, CI signs with the self-signed certificate
    // "Openstyle Release". It is unverified whether Squirrel.Mac accepts
    // updates signed with that certificate, so we still use electron-updater
    // only to *check* the release feed. On macOS, downloading and installing
    // goes through selfUpdater (see self-updater.ts) instead of Squirrel.Mac;
    // other platforms open the releases page. autoDownload is always false,
    // so electron-updater never itself downloads the update artifact.
    autoUpdater.autoDownload = false;
    // Honour the same preference on quit. Upstream hardcoded this to true, so a
    // single manual "Check for Updates" could stage a release that then
    // installed itself on the next quit even with auto-update turned off.
    autoUpdater.autoInstallOnAppQuit = autoUpdateEnabled;
    autoUpdater.logger = createAppLogger("updater");

    autoUpdater.on("update-available", (info) => {
      availableUpdate = {
        version: info.version,
        allowOlder: explicitDowngrade,
      };
      if (explicitDowngrade) installWhenDownloaded = info.version;
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
          // The explicit switch to Stable downloads also with "Automatic
          // updates" off: the user asked for that version.
          autoUpdateEnabled:
            readSettings().autoUpdate !== false || explicitDowngrade,
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
      refreshTrayIcon();
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
      // The fake feed of an E2E run has no MLX worker to prefetch.
      if (!e2eFeed) prefetchMlxRuntime(info.version);
      if (installWhenDownloaded === info.version) {
        installWhenDownloaded = null;
        log.info(`Switch to Stable: installing ${info.version} now`);
        restartAndUpdate({ stopRecording: switchStopsRecording });
      }
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
    // Squirrel.Mac is not used for the install (see the autoDownload=false
    // comment above), so electron-updater's own downloadUpdate() is not
    // called. On a packaged macOS build we
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

  ipcMain.on("updater:install", (_event, options: unknown) => {
    const stopRecording =
      typeof options === "object" &&
      options !== null &&
      (options as { stopRecording?: unknown }).stopRecording === true;
    restartAndUpdate({ stopRecording });
  });

  ipcMain.handle("updater:take-stop-confirm", () => takeStopRecordingConfirm());

  ipcMain.handle("updater:check", async () => {
    if (!updatesOn) return null;
    try {
      const result = await autoUpdater.checkForUpdates();
      const latest = result?.updateInfo?.version;
      if (!latest) return null;
      // Only report an update when the remote version is newer. A plain
      // inequality reported an OLDER Stable version to a Dev build.
      if (!isNewerVersion(latest, version)) return null;
      return { version: latest, downloadState: state.updateDownloadState };
    } catch {
      return null;
    }
  });

  // -- Update channel (Settings > Application, Advanced mode) --
  ipcMain.handle("settings:update-channel", () => ({
    channel: resolveChannel(readSettings().updateChannel, version),
    version,
  }));

  ipcMain.handle(
    "settings:set-update-channel",
    async (_event, channel: unknown, stopRecording: unknown): Promise<void> => {
      if (!isUpdateChannel(channel)) return;
      await switchChannel(channel, stopRecording === true);
    },
  );

  // Save the channel, forget an update of the old channel, and check at once.
  // The switch to Stable from an alpha build checks with downgrade on, then
  // downloads and installs the current Stable version (owner decision D4).
  // Every other check keeps downgrade off.
  async function switchChannel(
    channel: UpdateChannel,
    stopRecording: boolean,
  ): Promise<void> {
    writeSettings({ updateChannel: channel });
    if (!updatesOn) return;
    log.info(`Update channel set to ${channel}`);
    // A check that started before the switch uses the old channel, and a new
    // checkForUpdates() call would only return that check. Wait for it first.
    // checkForUpdatesPromise is not in the electron-updater types.
    const running = (
      autoUpdater as unknown as {
        checkForUpdatesPromise?: Promise<unknown> | null;
      }
    ).checkForUpdatesPromise;
    if (running) await running.catch(() => {});
    selfUpdater.discardDownload();
    state.updateDownloadState = "idle";
    availableUpdate = null;
    installWhenDownloaded = null;
    switchStopsRecording = stopRecording;
    notifiedAvailableVersion = null;
    notifiedDownloadedVersion = null;
    refreshTrayIcon();
    rebuildMenus();
    state.settingsWindow?.webContents.send("updater:cleared");

    const downgrade = switchNeedsDowngrade(channel, version);
    applyChannel(autoUpdater, channel, { allowDowngrade: downgrade });
    explicitDowngrade = downgrade;
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      log.warn(
        `Update check after the channel switch failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      explicitDowngrade = false;
      applyChannel(autoUpdater, channel);
    }
    if (readSettings().autoUpdate !== false) startUpdateCheckInterval();
  }
}
