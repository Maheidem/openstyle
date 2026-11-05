/**
 * Permission and onboarding IPC handlers. The handler bodies come from the
 * `whenReady` block in `index.ts`. The channel names and return values are
 * the same. `ipc/core-ipc.ts` builds the deps. State from `main-state.ts` reaches this file through the
 * `deps` functions.
 */

import { ipcMain, systemPreferences } from "electron";
import {
  type OnboardingState,
  readOnboardingState,
  sanitizeDraft,
  sanitizeStep,
} from "../shared/onboarding";
import { checkLinuxSetup } from "./linux-setup";

interface RegisterPermissionsIpcOptions {
  hasAccessibilityPermission: () => boolean;
  openAccessibilitySettings: () => void;
  openMicrophoneSettings: () => void;
  /** Runs when the renderer reports that onboarding is complete. */
  completeOnboarding: () => void;
  /** The local settings file (step and draft of the first run). */
  readSettings: () => Record<string, unknown>;
  writeSettings: (patch: Record<string, unknown>) => void;
}

/**
 * E2E seam: OPENSTYLE_E2E_PERMISSIONS=granted|denied makes the permission
 * checks answer without the OS (a CI Mac has no grants, and a request raises a
 * system dialog). It works only in E2E mode.
 */
function fakePermission(): "granted" | "denied" | null {
  if ((process.env.OPENSTYLE_E2E ?? process.env.FREESTYLE_E2E) !== "1") {
    return null;
  }
  const value = process.env.OPENSTYLE_E2E_PERMISSIONS;
  return value === "granted" || value === "denied" ? value : null;
}

export function registerPermissionsIpc({
  hasAccessibilityPermission,
  openAccessibilitySettings,
  openMicrophoneSettings,
  completeOnboarding,
  readSettings,
  writeSettings,
}: RegisterPermissionsIpcOptions): void {
  ipcMain.handle("permissions:check-mic", async () => {
    const fake = fakePermission();
    if (fake) return fake;
    if (process.platform === "linux") {
      // Linux has no OS-level mic permission API; the renderer resolves the
      // real state with a getUserMedia probe (see lib/permissions.ts).
      return "unknown";
    }
    // macOS and Windows both report the real privacy-settings state here.
    return systemPreferences.getMediaAccessStatus("microphone");
  });

  ipcMain.handle("permissions:request-mic", async () => {
    const fake = fakePermission();
    if (fake) return fake;
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
    const fake = fakePermission();
    if (fake) return fake === "granted";
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

  // The saved step and draft of the first run. The renderer writes them at
  // every Continue and reads them at start (resume after a quit).
  ipcMain.handle(
    "onboarding:get-state",
    (): OnboardingState => readOnboardingState(readSettings()),
  );

  ipcMain.handle(
    "onboarding:set-state",
    (_event, patch: { step?: unknown; draft?: unknown }) => {
      const next: Record<string, unknown> = {};
      const step = sanitizeStep(patch?.step);
      if (step !== null) next.onboardingStep = step;
      if (patch?.draft !== undefined) {
        // A patch merges into the saved draft: a field that is not in it stays.
        next.onboardingDraft = {
          ...readOnboardingState(readSettings()).draft,
          ...sanitizeDraft(patch.draft),
        };
      }
      if (Object.keys(next).length > 0) writeSettings(next);
    },
  );
}
