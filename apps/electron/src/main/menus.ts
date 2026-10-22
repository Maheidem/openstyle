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
import trayRecordingIconPath from "../../resources/tray/logoRecording.png?asset";
import trayIconPath from "../../resources/tray/logoTemplate.png?asset";
import { isFakeMeetingCapture } from "./fake-meeting-capture";
import { refreshMeetingsFlag, state } from "./main-state";
import { MeetingDevicesChangedError } from "./meeting-recorder";
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
import { trayAppearance } from "./tray-appearance";
import { showSettingsWindow } from "./windows/settings-window";
import {
  createTrayPopoverWindow,
  hideTrayPopover,
  toggleTrayPopover,
} from "./windows/tray-popover-window";

const log = createAppLogger("electron");

export function restartAndUpdate(): void {
  // E2E seam: a test checks that this path runs. It never installs or quits.
  if ((process.env.OPENSTYLE_E2E ?? process.env.FREESTYLE_E2E) === "1") {
    log.info("E2E: restart and update requested; no install");
    (app as NodeJS.EventEmitter).emit("e2e:restart-and-update");
    return;
  }
  if (process.platform === "darwin" && selfUpdater.isReadyToInstall) {
    // Self-update path (see self-updater.ts): quitAndInstall() would hand
    // this off to Squirrel.Mac. Squirrel.Mac rejected the ad-hoc-signed
    // builds before 2.15.1. It is unverified whether it accepts builds
    // signed with the "Openstyle Release" certificate.
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

/**
 * The short native menu of a right click on the tray icon (a left click on
 * Linux, where the panel shows this menu). The popover is the main place for
 * the rest (windows/tray-popover-window.ts).
 */
export function buildTrayContextMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: "Open Openstyle",
      click: () => showSettingsWindow(),
    },
    {
      label: "Settings…",
      click: () => showSettingsWindow("/settings"),
    },
    {
      label: "Help",
      click: () => showSettingsWindow("/help"),
    },
    buildUpdateMenuItem(),
    // Meeting Mode: feature-flagged ("meetings") and darwin >= 14.4 only.
    ...(state.meetingsFlagEnabled &&
    (isSystemAudioCaptureSupported() || isFakeMeetingCapture()) &&
    state.meetingRecorder
      ? [
          { type: "separator" as const },
          state.meetingRecorder.status === "idle"
            ? {
                label: "Start meeting recording",
                click: (): void => {
                  void state.meetingRecorder?.start().catch((err) => {
                    // The Meetings page shows the devices and asks the
                    // user to confirm them, in the app language (#169).
                    if (err instanceof MeetingDevicesChangedError) {
                      showSettingsWindow("/meetings?confirmStart=1");
                      return;
                    }
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

/**
 * Show the red tray icon while a meeting records, and the normal icon at
 * other times. It does nothing when there is no tray (quiet E2E mode).
 */
export function updateTrayForMeeting(recording: boolean): void {
  if (!state.tray) return;
  const look = trayAppearance(recording);
  state.tray.setImage(trayImage(look.icon, look.template));
  state.tray.setToolTip(look.tooltip);
}

function trayImage(
  icon: "default" | "recording",
  template: boolean,
): Electron.NativeImage {
  // createFromPath also loads the @2x file next to the path.
  const image = nativeImage.createFromPath(
    icon === "recording" ? trayRecordingIconPath : trayIconPath,
  );
  // A template image follows the light/dark menu bar on macOS.
  image.setTemplateImage(template);
  return image;
}

export function createTray(): void {
  const look = trayAppearance(state.meetingRecorder?.status === "recording");
  state.tray = new Tray(trayImage(look.icon, look.template));
  state.tray.setToolTip(look.tooltip);

  if (process.platform === "linux") {
    // Linux desktop panels often don't fire the right-click event, so
    // assign the menu natively so the OS can register it via DBusMenu.
    state.tray.setContextMenu(buildTrayContextMenu());
  } else {
    // macOS/Windows: right click shows the short menu. Using setContextMenu
    // on macOS would override the click handler.
    state.tray.on("right-click", () => {
      log.info("Tray right click");
      hideTrayPopover("right-click");
      // Opportunistic background refresh — the menu template is synchronous,
      // so a flag flip shows up on the next open.
      void refreshMeetingsFlag();
      state.tray!.popUpContextMenu(buildTrayContextMenu());
    });
  }

  // Left click toggles the popover (on Linux the panel often sends no click).
  state.tray.on("click", () => {
    log.info("Tray left click");
    toggleTrayPopover("tray-click");
  });

  // Make the popover now, so the first click shows it at once. Linux panels
  // often send no click (they show the menu), so there it is made on the
  // first toggle only.
  if (process.platform !== "linux") createTrayPopoverWindow();
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
