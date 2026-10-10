// macOS and Windows permission checks and dialogs for dictation.
// Reads and updates the shared main state, and opens System Settings.
// Leaf module: it imports no other new module except main-state.
import { accessSync, constants } from "node:fs";
import { dirname } from "node:path";
import { createAppLogger } from "@openstyle/utils";
import { app, dialog, shell, systemPreferences } from "electron";
import { state } from "./main-state";
import {
  type DictationPermission,
  missingDictationPermission,
  resolveAccessibilityPermission,
  type StartupPermissionWarning,
} from "./permission-checks";

const hotkeyLog = createAppLogger("hotkey");

const ACCESSIBILITY_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility";
const MICROPHONE_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Microphone";

export function hasCurrentAccessibilityPermission(): boolean {
  if (process.platform !== "darwin") return true;
  const resolved = resolveAccessibilityPermission(
    process.platform,
    systemPreferences.isTrustedAccessibilityClient(false),
    state.accessibilityConfirmed,
  );
  if (state.accessibilityConfirmed && !resolved.accessibilityConfirmed) {
    hotkeyLog.warn("macOS Accessibility permission is no longer available.");
  }
  state.accessibilityConfirmed = resolved.accessibilityConfirmed;
  return resolved.granted;
}

export function getMissingDictationPermission(): DictationPermission | null {
  const microphoneStatus = getCurrentMicrophonePermission();
  return missingDictationPermission(
    process.platform,
    hasCurrentAccessibilityPermission(),
    microphoneStatus,
  );
}

export function getCurrentMicrophonePermission(): string {
  return process.platform === "darwin" || process.platform === "win32"
    ? systemPreferences.getMediaAccessStatus("microphone")
    : "unknown";
}

export function openAccessibilitySettings(): void {
  if (process.platform !== "darwin") return;
  // Passing true adds Openstyle to the Accessibility list and shows the native
  // prompt; macOS still requires the user to enable the toggle themselves.
  systemPreferences.isTrustedAccessibilityClient(true);
  void shell.openExternal(ACCESSIBILITY_SETTINGS_URL);
}

export function openMicrophoneSettings(): void {
  if (process.platform === "darwin") {
    void shell.openExternal(MICROPHONE_SETTINGS_URL);
  } else if (process.platform === "win32") {
    void shell.openExternal("ms-settings:privacy-microphone");
  }
}

let permissionDialogPromise: Promise<void> | null = null;

export function showRequiredPermissionDialog(
  permission: StartupPermissionWarning,
): Promise<void> {
  if (permissionDialogPromise) return permissionDialogPromise;

  const accessibility = permission === "accessibility";
  const both = permission === "accessibility-and-microphone";
  permissionDialogPromise = dialog
    .showMessageBox({
      type: "error",
      title: both
        ? "Permissions Required"
        : accessibility
          ? "Accessibility Permission Required"
          : "Microphone Permission Required",
      message: both
        ? "Accessibility and Microphone permissions are required before dictation can work."
        : accessibility
          ? "Accessibility permission is required for dictation and text insertion."
          : "Microphone access is required to record dictation.",
      detail: both
        ? "Enable Openstyle in System Settings > Privacy & Security under Accessibility and Microphone."
        : accessibility
          ? "Enable Openstyle in System Settings > Privacy & Security > Accessibility."
          : process.platform === "darwin"
            ? "Enable Openstyle in System Settings > Privacy & Security > Microphone."
            : "Enable microphone access for Openstyle in Windows Settings.",
      buttons: both
        ? ["Open Accessibility Settings", "Open Microphone Settings", "Not Now"]
        : ["Open System Settings", "Cancel"],
      defaultId: 0,
      cancelId: both ? 2 : 1,
    })
    .then(({ response }) => {
      if (both) {
        if (response === 0) openAccessibilitySettings();
        if (response === 1) openMicrophoneSettings();
      } else if (response === 0 && accessibility) {
        openAccessibilitySettings();
      } else if (response === 0) {
        openMicrophoneSettings();
      }
    })
    .finally(() => {
      permissionDialogPromise = null;
    });
  return permissionDialogPromise;
}

export function isRunningFromReadOnlyLocation(): boolean {
  if (process.platform !== "darwin") return false;
  const exePath = app.getPath("exe");
  if (
    exePath.startsWith("/Volumes/") ||
    exePath.includes("/AppTranslocation/")
  ) {
    return true;
  }
  try {
    accessSync(dirname(exePath), constants.W_OK);
    return false;
  } catch {
    return true;
  }
}

export const READ_ONLY_UPDATE_RE =
  /EROFS|EACCES|read[- ]only|permission denied/i;

export const RELEASES_PAGE_URL =
  "https://github.com/Maheidem/openstyle/releases/latest";

let readOnlyDialogShown = false;

export function showMoveToApplicationsDialog(): void {
  if (readOnlyDialogShown) return;
  readOnlyDialogShown = true;
  dialog.showMessageBox({
    type: "warning",
    title: "Move to Applications",
    message:
      "Openstyle is running from a read-only location and can\u2019t update itself.",
    detail:
      "Please drag Openstyle into your Applications folder and relaunch it from there.",
    buttons: ["OK"],
  });
}
