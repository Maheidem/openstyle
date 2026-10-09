// Menus, tray and update restart for the Electron main process.
// Builds the application menu, the tray menu and the restart-to-update flow.
// Mutable shared values live on the state object from main-state.ts.
import { is } from "@electron-toolkit/utils";
import { createAppLogger } from "@openstyle/utils";
import {
  app,
  dialog,
  Menu,
  type MenuItemConstructorOptions,
  nativeImage,
  shell,
  Tray,
} from "electron";
import { autoUpdater } from "electron-updater";
import trayIconPath from "../../resources/tray/logoTemplate.png?asset";
import { refreshMeetingsFlag, state } from "./main-state";
import {
  isRunningFromReadOnlyLocation,
  READ_ONLY_UPDATE_RE,
  RELEASES_PAGE_URL,
  showMoveToApplicationsDialog,
} from "./permission-dialogs";
import {
  factoryReset,
  resetOnboarding,
  resetToneConfiguration,
} from "./resets";
import { selfUpdater } from "./self-updater";
import { stopServerHost } from "./server-host";
import { isSystemAudioCaptureSupported } from "./system-audio-capture";
import { showSettingsWindow } from "./windows/settings-window";

const log = createAppLogger("electron");

export function restartAndUpdate(): void {
  if (process.platform === "darwin" && selfUpdater.isReadyToInstall) {
    // Self-update path (see self-updater.ts): quitAndInstall() would hand
    // this off to Squirrel.Mac, which rejects our ad-hoc-signed downloads.
    // Extraction/swap can take a few seconds, so isUpdaterQuitting is only
    // set right before installUpdate() actually calls app.quit() (via the
    // onBeforeQuit callback) — not here — so a manual quit mid-install still
    // goes through normal before-quit cleanup instead of being mistaken for
    // the updater's own quit.
    void selfUpdater
      .installUpdate(async () => {
        state.isUpdaterQuitting = true;
        // Wait for the server process to stop. The quit that follows does not
        // wait, and the server process stops its speech child servers first.
        await stopServerHost(2000).catch(() => {});
      })
      .catch((err) => {
        state.updateDownloadState = "idle";
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`Self-update install failed: ${msg}`);
        state.settingsWindow?.webContents.send("updater:error", {
          message: msg,
        });
      });
    return;
  }
  // Kept for non-macOS platforms / future signed macOS builds, where
  // Squirrel's own install flow works.
  state.isUpdaterQuitting = true;
  autoUpdater.quitAndInstall();
}

async function checkForUpdatesFromMenu(): Promise<void> {
  if (is.dev) {
    dialog.showMessageBox({
      type: "info",
      title: "Check for Updates",
      message: "Update checking is not available in development mode.",
    });
    return;
  }
  if (isRunningFromReadOnlyLocation()) {
    showMoveToApplicationsDialog();
    return;
  }
  // autoDownload is always false (see the update setup below), so this check
  // does not download by itself. The update-available handler can start the
  // download when "Automatic updates" is on. Always run a fresh check.
  try {
    const result = await autoUpdater.checkForUpdates();
    const latest = result?.updateInfo?.version;
    if (latest && latest !== app.getVersion()) {
      const { response } = await dialog.showMessageBox({
        type: "info",
        title: "Update Available",
        message: `A new version (v${latest}) is available.`,
        detail: `You are currently running v${app.getVersion()}.`,
        buttons: ["View Release", "Later"],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) {
        void shell.openExternal(RELEASES_PAGE_URL);
      }
    } else {
      dialog.showMessageBox({
        type: "info",
        title: "No Updates",
        message: "You are running the latest version.",
        detail: `Current version: v${app.getVersion()}`,
      });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "";
    if (READ_ONLY_UPDATE_RE.test(msg) && isRunningFromReadOnlyLocation()) {
      showMoveToApplicationsDialog();
    } else {
      dialog.showMessageBox({
        type: "error",
        title: "Update Check Failed",
        message: "Unable to check for updates. Please try again later.",
      });
    }
  }
}

function buildUpdateMenuItem(): { label: string; click: () => void } {
  return state.updateDownloadState === "downloaded"
    ? { label: "Restart & Update", click: () => restartAndUpdate() }
    : { label: "Check for Updates...", click: () => checkForUpdatesFromMenu() };
}

// Dev-only menu items, shared by the tray menu and the application menu.
function devMenuItems(): MenuItemConstructorOptions[] {
  return [
    { type: "separator" },
    { label: "Reset Onboarding", click: resetOnboarding },
    {
      label: "Reset Tone Configuration",
      click: () => {
        void resetToneConfiguration();
      },
    },
    {
      label: "Hard Reset",
      click: () => {
        void factoryReset();
      },
    },
  ];
}

export function buildTrayContextMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: "Settings",
      click: () => showSettingsWindow("/settings"),
    },
    {
      label: "Help",
      click: () => showSettingsWindow("/help"),
    },
    buildUpdateMenuItem(),
    // Meeting Mode: feature-flagged ("meetings") and darwin >= 14.4 only.
    ...(state.meetingsFlagEnabled &&
    isSystemAudioCaptureSupported() &&
    state.meetingRecorder
      ? [
          { type: "separator" as const },
          state.meetingRecorder.status === "idle"
            ? {
                label: "Start meeting recording",
                click: (): void => {
                  void state.meetingRecorder?.start().catch((err) => {
                    log.error(`Meeting start failed: ${String(err)}`);
                    dialog.showErrorBox(
                      "Meeting recording",
                      err instanceof Error ? err.message : String(err),
                    );
                  });
                },
              }
            : {
                label: "Stop meeting recording",
                enabled: state.meetingRecorder.status === "recording",
                click: (): void => {
                  void state.meetingRecorder?.stop();
                },
              },
        ]
      : []),
    ...(is.dev ? devMenuItems() : []),
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        app.quit();
      },
    },
  ]);
}

export function createTray(): void {
  const trayImage = nativeImage.createFromPath(trayIconPath);
  // Mark as template so macOS adapts to menu bar light/dark
  trayImage.setTemplateImage(true);

  state.tray = new Tray(trayImage);
  state.tray.setToolTip("Openstyle");

  if (process.platform === "linux") {
    // Linux desktop panels often don't fire the right-click event, so
    // assign the menu natively so the OS can register it via DBusMenu.
    state.tray.setContextMenu(buildTrayContextMenu());
  } else {
    // macOS/Windows: left-click opens settings, right-click shows menu.
    // Using setContextMenu on macOS would override the click handler.
    state.tray.on("right-click", () => {
      // Opportunistic background refresh — the menu template is synchronous,
      // so a flag flip shows up on the next open.
      refreshMeetingsFlag();
      state.tray!.popUpContextMenu(buildTrayContextMenu());
    });
  }

  state.tray.on("click", () => {
    showSettingsWindow();
  });
}

// Rebuild the application menu so update-related labels stay current.
export function rebuildMenus(): void {
  const appMenu = Menu.buildFromTemplate([
    ...(process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              {
                label: "Settings",
                accelerator: "CommandOrControl+,",
                click: () => showSettingsWindow("/settings"),
              },
              { type: "separator" as const },
              buildUpdateMenuItem(),
              ...(is.dev ? devMenuItems() : []),
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      role: "window",
      submenu: [{ role: "minimize" }, { role: "close" }],
    },
    {
      role: "help",
      submenu: [
        {
          label: "Openstyle Help",
          click: () => showSettingsWindow("/help"),
        },
      ],
    },
  ]);
  Menu.setApplicationMenu(appMenu);

  // On Linux the tray menu is static (setContextMenu), so rebuild it
  // when update state changes. macOS/Windows rebuild on every right-click.
  if (process.platform === "linux") {
    state.tray?.setContextMenu(buildTrayContextMenu());
  }
}
