/**
 * Permission and onboarding IPC handlers. The handler bodies come from the
 * `whenReady` block in `index.ts`. The channel names and return values are
 * the same. `ipc/core-ipc.ts` builds the deps. State from `main-state.ts` reaches this file through the
 * `deps` functions.
 */

import { ipcMain, systemPreferences } from "electron";
import { checkLinuxSetup } from "./linux-setup";

interface RegisterPermissionsIpcOptions {
  hasAccessibilityPermission: () => boolean;
  openAccessibilitySettings: () => void;
  openMicrophoneSettings: () => void;
  /** Runs when the renderer reports that onboarding is complete. */
  completeOnboarding: () => void;
}

export function registerPermissionsIpc({
  hasAccessibilityPermission,
  openAccessibilitySettings,
  openMicrophoneSettings,
  completeOnboarding,
}: RegisterPermissionsIpcOptions): void {
  ipcMain.handle("permissions:check-mic", async () => {
    if (process.platform === "linux") {
      // Linux has no OS-level mic permission API; the renderer resolves the
      // real state with a getUserMedia probe (see lib/permissions.ts).
      return "unknown";
    }
    // macOS and Windows both report the real privacy-settings state here.
    return systemPreferences.getMediaAccessStatus("microphone");
  });

  ipcMain.handle("permissions:request-mic", async () => {
    if (process.platform === "darwin") {
      const granted = await systemPreferences.askForMediaAccess("microphone");
      return granted ? "granted" : "denied";
    }
    if (process.platform === "win32") {
      // Windows has no programmatic prompt; report the privacy-settings
      // state so the UI can send the user to Settings when it's denied.
      return systemPreferences.getMediaAccessStatus("microphone");
    }
    return "unknown"; // Linux: renderer probes getUserMedia instead
  });

  ipcMain.handle("permissions:check-accessibility", async () => {
    return hasAccessibilityPermission();
  });

  ipcMain.on("permissions:open-accessibility", () => {
    openAccessibilitySettings();
  });

  ipcMain.on("permissions:open-mic-settings", () => {
    openMicrophoneSettings();
  });

  // IPC: Linux system setup (input-group access for the hotkey listener and
  // the xdotool/wtype paste fallback). Returns null on other platforms.
  ipcMain.handle("permissions:check-linux-setup", async () => {
    if (process.platform !== "linux") return null;
    return checkLinuxSetup();
  });

  ipcMain.on("onboarding:set-complete", () => {
    completeOnboarding();
  });
}
