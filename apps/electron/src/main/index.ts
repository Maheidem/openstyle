// Prevent EPIPE crashes when stdout/stderr is a closed pipe (e.g. Linux
// AppImage launched detached from a terminal).
for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") return;
    throw err;
  });
}

// GUI apps on macOS inherit the minimal launchd PATH (/usr/bin:/bin:/usr/sbin:/sbin)
// which excludes Homebrew directories where cmake and other tools live.
if (process.platform === "darwin") {
  const extra = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
  ];
  const current = process.env.PATH ?? "";
  const dirs = current.split(":");
  const missing = extra.filter((p) => !dirs.includes(p));
  if (missing.length > 0) {
    process.env.PATH = `${current}:${missing.join(":")}`;
  }
}

// In development, load a local-only env file (cwd: apps/electron) so dev flags
// take effect without exporting them in the shell.
// `process.env.NODE_ENV` is replaced at build time (see electron.vite.config.ts),
// so this whole block is dead-code-eliminated from packaged/production builds.
if (process.env.NODE_ENV !== "production") {
  const proc = process as typeof process & {
    loadEnvFile?: (path?: string) => void;
  };
  try {
    proc.loadEnvFile?.(".env.local");
  } catch {
    // no .env.local present — that's fine
  }
}

import { electronApp, optimizer } from "@electron-toolkit/utils";
import { createAppLogger, enableFileLogging } from "@openstyle/utils";
import { app, dialog, protocol, screen } from "electron";
import { registerAppProtocol } from "./app-protocol";
import { recoverDuckedVolumeFromCrash } from "./audio-control/volume-ducker";
import {
  registerHotkeyIpc,
  scheduleHotkeyRegistration,
} from "./hotkeys/dictation";
import { registerCoreIpc, registerSystemIpc } from "./ipc/core-ipc";
import { readSettings } from "./local-settings";
import { broadcastToWindows, refreshMeetingsFlag, state } from "./main-state";
import { createTray, rebuildMenus } from "./menus";
import { migrateLegacyUserData } from "./migrate-user-data";
import { startLinuxPasteHelper } from "./paste";
import { startupPermissionWarning } from "./permission-checks";
import {
  getCurrentMicrophonePermission,
  hasCurrentAccessibilityPermission,
  showRequiredPermissionDialog,
} from "./permission-dialogs";
import { registerQuitHandlers } from "./quit";
import { updateRemixBar } from "./remix/bar-window";
import { registerRemixIpc } from "./remix/ipc";
import {
  pruneSelfUpdaterDownloads,
  sweepSelfUpdaterBackups,
} from "./self-updater";
import { startServerHost } from "./server-host";
import { registerUpdater } from "./updater";
import {
  createAppWindow,
  resolveAppWindowPosition,
  setProgrammaticPosition,
} from "./windows/pill-window";
import {
  configureSettingsWindow,
  isOnboardingActive,
  showSettingsWindow,
} from "./windows/settings-window";

// Test isolation: E2E/probe runs in the unpackaged dev binary would otherwise
// share the real "Electron" userData (settings.json included) with a running
// dev instance. Must be set before anything reads app.getPath("userData").
const userDataOverride =
  process.env.OPENSTYLE_USER_DATA ?? process.env.FREESTYLE_USER_DATA;
if (userDataOverride) {
  app.setPath("userData", userDataOverride);
}

// Quiet E2E mode (macOS only): a local E2E run must not disturb the person at
// the screen. No dock icon, no focus steal, no always-on-top overlay, no tray
// icon, no notification, and every window is fully transparent (opacity 0)
// and ignores the real mouse. Playwright drives the renderers over CDP, so
// interaction and screenshots still work. Linux CI runs under Xvfb, so its
// behavior stays unchanged.
const quietE2E =
  (process.env.OPENSTYLE_E2E ?? process.env.FREESTYLE_E2E) === "1" &&
  process.platform === "darwin";
state.quietE2E = quietE2E;
if (quietE2E) {
  app.setActivationPolicy("accessory");
  app.on("browser-window-created", (_, window) => {
    window.setOpacity(0);
    window.setIgnoreMouseEvents(true);
    // Without this, any shown window (even at opacity 0 or off-screen)
    // changes the macOS menu bar tint while the app runs.
    window.setHiddenInMissionControl(true);
  });
}

const log = createAppLogger("electron");

// Persist all logs (this process + the in-process server) to a single rotating
// file so users can share diagnostics. `app.getPath("logs")` resolves to
// ~/Library/Logs/Openstyle (macOS), %APPDATA%\Openstyle\logs (Windows), or
// ~/.config/Openstyle/logs (Linux). enableFileLogging() is order-independent:
// it also back-fills loggers that were created during module import.
let logsDir = "";
try {
  logsDir = app.getPath("logs");
  enableFileLogging(logsDir);
  log.info(`File logging enabled at ${logsDir}`);
} catch (err) {
  log.error(`Failed to enable file logging: ${String(err)}`);
}

// Renaming the product to Openstyle moved userData from <appData>/Openstyle to
// <appData>/Openstyle, stranding every existing install's history. Copy the old
// profile across before the first read of settings.json (readSettings) or of
// OPENSTYLE_DB_PATH (set from userData further down). Runs after the
// OPENSTYLE_USER_DATA override above so E2E profiles are never touched.
migrateLegacyUserData();

// Seed the Remix bar hold flag after the user-data override and migration.
state.remixBarHeldForOnboarding = readSettings().onboardingComplete !== true;

// Global crash handlers — without these, errors in the main process vanish
// silently (no console in a packaged app). Log, then for a truly uncaught
// exception show a dialog and quit, since process state is unknown after
// that point.
let isHandlingFatal = false;
process.on("uncaughtException", (err, origin) => {
  if (isHandlingFatal) return;
  isHandlingFatal = true;
  log.error(`Uncaught exception (${origin}): ${err?.stack ?? String(err)}`);
  try {
    dialog.showMessageBoxSync({
      type: "error",
      title: "Openstyle ran into a problem",
      message: "Openstyle hit an unexpected error and needs to close.",
      detail:
        `${String(err?.message ?? err)}\n\n` + `Logs are saved at:\n${logsDir}`,
      buttons: ["Quit"],
    });
  } catch {
    // dialog may be unavailable before the app is ready
  }
  app.exit(1);
});

process.on("unhandledRejection", (reason) => {
  log.error(
    `Unhandled rejection: ${
      reason instanceof Error
        ? (reason.stack ?? reason.message)
        : String(reason)
    }`,
  );
});

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      // Without this, Chromium's media stack refuses to play <video>/<audio>
      // served from the scheme (the sign-in demo video, for one).
      stream: true,
    },
  },
]);

configureSettingsWindow({ scheduleHotkeyRegistration });

// Prevent multiple instances.  If another instance already holds the lock,
// quit immediately and let the primary instance handle activation.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

app.on("second-instance", () => {
  if (state.settingsWindow) {
    if (state.settingsWindow.isMinimized()) state.settingsWindow.restore();
    // Quiet E2E: show without focus.
    if (quietE2E) {
      state.settingsWindow.showInactive();
      return;
    }
    state.settingsWindow.show();
    state.settingsWindow.focus();
  } else {
    showSettingsWindow();
  }
});

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  void startLinuxPasteHelper();
  void recoverDuckedVolumeFromCrash();
  // Clean up any .old-<ts> app bundle backup left behind if a previous
  // self-update's post-swap cleanup didn't get to run (see self-updater.ts).
  void sweepSelfUpdaterBackups();
  // Delete cached update zips of older versions (keeps the delta base).
  void pruneSelfUpdaterDownloads();

  // Set app user model id for windows
  electronApp.setAppUserModelId("com.openstyle.app");

  // Override app.name so macOS menu shows "Openstyle" instead of the package name
  app.setName("Openstyle");

  // Register the custom app:// protocol for production SPA support
  registerAppProtocol();

  rebuildMenus();

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  registerCoreIpc({ logsDir });

  await startServerHost({ userDataOverride });

  // Quiet E2E: no menu bar icon.
  if (!quietE2E) createTray();

  createAppWindow();

  // Meeting Mode boot tasks, deferred until the in-process server is up:
  // cache the feature flag for the tray and sweep meetings a crash left in
  // 'recording' (finalize WAV headers, mark 'interrupted') or 'transcribing'
  // (job died with the process — mark 'failed', partial transcript kept).
  setTimeout(() => {
    refreshMeetingsFlag();
    void state.meetingRecorder?.sweepOrphans();
  }, 3000);

  // Onboarding already has dedicated permission cards. Existing users instead
  // get one actionable warning once a user-facing window can be shown.
  void isOnboardingActive().then((onboardingActive) => {
    state.remixBarHeldForOnboarding = onboardingActive;
    updateRemixBar();
    const warning = startupPermissionWarning(
      process.platform,
      onboardingActive,
      hasCurrentAccessibilityPermission(),
      getCurrentMicrophonePermission(),
    );
    if (warning) {
      void showRequiredPermissionDialog(warning);
    }
  });

  // Clamp the pill to valid display bounds when monitors change.
  const repositionPillForDisplayChange = (): void => {
    if (!state.mainWindow) return;
    const before = readSettings().pillPosition as string;
    const { x, y } = resolveAppWindowPosition();
    setProgrammaticPosition(state.mainWindow, x, y);
    const after = (readSettings().pillPosition as string) ?? "bottom-center";
    if (before !== after) {
      broadcastToWindows("settings:pill-position-changed", after);
    }
  };
  screen.on("display-removed", repositionPillForDisplayChange);
  screen.on("display-metrics-changed", repositionPillForDisplayChange);

  if (readSettings().showDashboardOnLaunch !== false) {
    showSettingsWindow();
  }

  registerUpdater();

  registerSystemIpc();

  registerHotkeyIpc();

  registerRemixIpc();
});

registerQuitHandlers();
