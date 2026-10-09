/**
 * Dev reset actions for the main process.
 * Resets onboarding, tone settings and all local data.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { closeDb, stopMlxServer, stopWhisperServer } from "@openstyle/server";
import { createAppLogger } from "@openstyle/utils";
import { app, dialog, globalShortcut } from "electron";
import { SETTINGS_KEYS } from "../shared/settings-keys";
import * as linuxAutostart from "./linux-autostart";
import { clearSettingsCache, writeSettings } from "./local-settings";
import { state } from "./main-state";
import { updateRemixBar } from "./remix/bar-window";
import { getDashboardURL } from "./renderer-urls";
import { putServerSetting } from "./server-target";
import {
  createSettingsWindow,
  revealSettingsWindow,
  showSettingsWindow,
} from "./windows/settings-window";

const log = createAppLogger("electron");

export function resetOnboarding(): void {
  writeSettings({ onboardingComplete: false });
  state.remixBarHeldForOnboarding = true;
  updateRemixBar();
  showSettingsWindow("/onboarding");
}

// Dev-only: reset every sector tone to off and cleanup intensity to medium.
export async function resetToneConfiguration(): Promise<void> {
  const resets: ReadonlyArray<readonly [string, string]> = [
    [SETTINGS_KEYS.cleanupPersonalTone, "off"],
    [SETTINGS_KEYS.cleanupWorkTone, "off"],
    [SETTINGS_KEYS.cleanupEmailTone, "off"],
    [SETTINGS_KEYS.cleanupOverallTone, "off"],
    [SETTINGS_KEYS.cleanupIntensity, "medium"],
  ];

  // Always write through the server so the values land in the DB the app reads
  // from — local or a configured remote.
  const results = await Promise.all(
    resets.map(([key, value]) => putServerSetting(key, value)),
  );
  if (results.some((ok) => !ok)) {
    log.warn("Reset tone configuration failed: one or more settings rejected");
  }

  const tonePath = "/settings/tone";
  if (!state.settingsWindow) {
    void createSettingsWindow(tonePath);
    return;
  }

  const url = getDashboardURL(tonePath);
  const current = state.settingsWindow.webContents.getURL();
  if (current.includes(tonePath)) {
    state.settingsWindow.webContents.reloadIgnoringCache();
  } else {
    void state.settingsWindow.loadURL(url);
  }
  revealSettingsWindow(state.settingsWindow);
}

export async function factoryReset(): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: "warning",
    buttons: ["Cancel", "Hard Reset"],
    defaultId: 0,
    cancelId: 0,
    title: "Hard Reset (Dev)",
    message: "Delete all Openstyle settings & data and restart?",
    detail:
      "Removes settings, API keys, history, and dictionary/vocabulary, then " +
      "relaunches into onboarding. Downloaded voice models are kept. macOS " +
      "Microphone/Accessibility permissions are not affected.",
  });
  if (response !== 1) return;

  try {
    await stopWhisperServer().catch(() => {});
    await stopMlxServer().catch(() => {});

    if (state.keyListener) {
      state.keyListener.stop();
      state.keyListener = null;
    }
    if (process.platform === "win32") {
      globalShortcut.unregisterAll();
    }

    try {
      closeDb();
    } catch {}

    if (state.httpServer) {
      state.httpServer.close();
      state.httpServer = null;
    }

    const userData = app.getPath("userData");
    for (const f of [
      "settings.json",
      "freestyle.db",
      "freestyle.db-wal",
      "freestyle.db-shm",
    ]) {
      await rm(join(userData, f), { force: true });
    }

    clearSettingsCache();
    if (process.platform === "linux") {
      linuxAutostart.setEnabled(false);
    } else {
      app.setLoginItemSettings({ openAtLogin: false });
    }

    app.relaunch();
    app.exit(0);
  } catch (err) {
    log.error(
      `factory-reset failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    dialog.showErrorBox(
      "Hard Reset failed",
      `${err instanceof Error ? err.message : String(err)}\n\nThe app may be in a partially reset state. Quit and relaunch manually.`,
    );
  }
}
