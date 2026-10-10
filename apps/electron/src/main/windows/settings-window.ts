// Owns the settings (dashboard) window and its routing.
// The hotkey scheduler is injected by configureSettingsWindow.
// This avoids an import cycle with the hotkeys and dictation modules.
import { join } from "node:path";
import { app, BrowserWindow, shell } from "electron";
import icon from "../../../resources/icon.png?asset";
import { readSettings } from "../local-settings";
import { state, stopHotkeyRecorderProcess } from "../main-state";
import { getDashboardURL } from "../renderer-urls";
import { getConfiguredModelCount } from "../server-target";

export interface SettingsWindowDeps {
  scheduleHotkeyRegistration: (hotkey?: string) => void;
}

let scheduleHotkeyRegistration: SettingsWindowDeps["scheduleHotkeyRegistration"] =
  () => {
    throw new Error("configureSettingsWindow was not called");
  };

export function configureSettingsWindow(deps: SettingsWindowDeps): void {
  scheduleHotkeyRegistration = deps.scheduleHotkeyRegistration;
}

// In-flight settings-window creation. createSettingsWindow awaits an onboarding
// probe before it assigns settingsWindow, so this serializes concurrent opens
// to avoid spawning a second window during that gap.
let settingsWindowCreating: Promise<void> | null = null;

export function createSettingsWindow(initialPath?: string): Promise<void> {
  // Serialize concurrent opens: the first call owns creation, the rest await it.
  if (settingsWindowCreating) return settingsWindowCreating;
  if (state.settingsWindow) return Promise.resolve();
  const creation = buildSettingsWindow(initialPath).finally(() => {
    settingsWindowCreating = null;
  });
  settingsWindowCreating = creation;
  return creation;
}

/** Show the dashboard and bring the app to the front (dock icon + focus). */
export function revealSettingsWindow(win: BrowserWindow): void {
  // Quiet E2E: show without focus, dock icon or app activation.
  if (state.quietE2E) {
    win.showInactive();
    return;
  }
  if (process.platform === "darwin") {
    app.dock?.show();
    app.focus({ steal: true });
  }
  win.show();
  win.focus();
}

async function buildSettingsWindow(initialPath?: string): Promise<void> {
  // Resolve the initial route BEFORE creating the window. The onboarding probe
  // is an async server call; doing it first means there's no await gap between
  // assigning `settingsWindow` and using it, so a close (or a concurrent open)
  // during the probe can't null-deref or show a half-loaded window.
  const startPath = (await isOnboardingActive())
    ? "/onboarding"
    : (initialPath ?? "/today");

  state.settingsWindow = new BrowserWindow({
    width: 1152,
    height: 648,
    minWidth: 720,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === "darwin"
      ? {
          backgroundColor: "#00000000",
          transparent: true,
          vibrancy: "under-window" as const,
          visualEffectState: "active" as const,
        }
      : {}),
    titleBarStyle: process.platform === "darwin" ? "hidden" : "default",
    trafficLightPosition:
      process.platform === "darwin" ? { x: 16, y: 16 } : undefined,
    ...(process.platform === "linux" ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      // Quiet E2E: the window is transparent, so keep it rendering.
      ...(state.quietE2E ? { backgroundThrottling: false } : {}),
    },
  });

  state.settingsWindow.on("ready-to-show", () => {
    revealSettingsWindow(state.settingsWindow!);
  });

  state.settingsWindow.on("closed", () => {
    if (state.hotkeyRecorder) {
      stopHotkeyRecorderProcess();
      scheduleHotkeyRegistration(state.currentHotkeyAccel ?? undefined);
    }
    state.remixPracticeTarget = false;
    state.settingsWindow = null;
  });

  // Backstop: a full-page navigation tears the onboarding renderer down
  // without running its unmount cleanup.
  state.settingsWindow.webContents.on("did-navigate", () => {
    state.remixPracticeTarget = false;
  });

  state.settingsWindow.on("enter-full-screen", () => {
    state.settingsWindow?.webContents.send("fullscreen:changed", true);
  });

  state.settingsWindow.on("leave-full-screen", () => {
    state.settingsWindow?.webContents.send("fullscreen:changed", false);
  });

  state.settingsWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  state.settingsWindow.loadURL(getDashboardURL(startPath));
}

/**
 * Matches the route decision in buildSettingsWindow. Existing users who have
 * configured models are treated as onboarded even if the lightweight setting
 * predates onboardingComplete.
 */
export async function isOnboardingActive(): Promise<boolean> {
  if (readSettings().onboardingComplete === true) return false;
  return (await getConfiguredModelCount()) === 0;
}

export function showSettingsWindow(path?: string): void {
  if (!state.settingsWindow) {
    void createSettingsWindow(path);
    return;
  }
  if (path) {
    void state.settingsWindow.loadURL(getDashboardURL(path));
  }
  revealSettingsWindow(state.settingsWindow);
}
