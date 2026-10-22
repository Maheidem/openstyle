/**
 * Shared mutable state of the main process.
 *
 * Many modules read and write the same values (windows, key listeners, hotkey
 * flags). An ES module cannot assign to an imported `let`. For this reason all
 * shared values are fields of the one `state` object. Always read and write
 * them as `state.<name>` at the time of use. Never keep a field in a long-lived
 * local variable.
 *
 * This module must have no side effects when it loads. `index.ts` sets
 * `quietE2E` after the user-data override.
 */
import type { BrowserWindow, Tray } from "electron";
import { AudioPlaybackController } from "./audio-control/controller";
import type { UpdateDownloadState } from "./auto-update-policy";
import type { HotkeyRecorder } from "./hotkey-recorder";
import type { NativeKeyListener } from "./key-listener";
import type { MeetingRecorder } from "./meeting-recorder";
import { serverFetch } from "./server-target";

export interface MainState {
  mainWindow: BrowserWindow | null;
  settingsWindow: BrowserWindow | null;
  tray: Tray | null;
  /** The popover under the tray icon (windows/tray-popover-window.ts). */
  trayPopover: BrowserWindow | null;
  keyListener: NativeKeyListener | null;
  // Latching flag: records that the native key listener started successfully.
  // It persists while the listener is temporarily torn down for hotkey recording,
  // but is never used to override the current macOS Accessibility trust result.
  accessibilityConfirmed: boolean;
  hotkeyPressed: boolean;
  currentHotkeyAccel: string | null;
  hotkeyRecorder: HotkeyRecorder | null;
  /** Per-language dictation hotkeys: lang code -> its native listener. */
  languageKeyListeners: Map<string, NativeKeyListener>;
  /** Lang code -> normalized accelerator currently registered for it. */
  languageHotkeyAccels: Map<string, string>;
  audioPlaybackController: AudioPlaybackController;
  /** Meeting Mode recorder (created on whenReady; darwin >= 14.4 only). */
  meetingRecorder: MeetingRecorder | null;
  /**
   * Cached `meetings` feature flag. Flags are server-owned (config.freestyle.json
   * behind GET /api/config/flags/:key — see apps/server/src/lib/config.ts), so
   * the tray reads this cache and refreshes it in the background: the tray menu
   * template must be built synchronously.
   */
  meetingsFlagEnabled: boolean;
  /**
   * Resolves once a freshly-created pill window has finished loading and is
   * visible.  `null` when no deferred show is in progress.
   */
  pillReadyPromise: Promise<void> | null;
  isUpdaterQuitting: boolean;
  updateDownloadState: UpdateDownloadState;
  hotkeyStuckTimer: NodeJS.Timeout | null;
  /** Quiet E2E mode. `index.ts` sets it once, right after it computes it. */
  quietE2E: boolean;
}

export const state: MainState = {
  mainWindow: null,
  settingsWindow: null,
  tray: null,
  trayPopover: null,
  keyListener: null,
  accessibilityConfirmed: false,
  hotkeyPressed: false,
  currentHotkeyAccel: null,
  hotkeyRecorder: null,
  languageKeyListeners: new Map<string, NativeKeyListener>(),
  languageHotkeyAccels: new Map<string, string>(),
  audioPlaybackController: new AudioPlaybackController(),
  meetingRecorder: null,
  meetingsFlagEnabled: false,
  pillReadyPromise: null,
  isUpdaterQuitting: false,
  updateDownloadState: "idle",
  hotkeyStuckTimer: null,
  quietE2E: false,
};

/**
 * Send one IPC message to the pill window and the settings window. The
 * channel must be a string literal, so the preload drift test can find it.
 */
export function broadcastToWindows(channel: string, ...args: unknown[]): void {
  state.mainWindow?.webContents.send(channel, ...args);
  state.settingsWindow?.webContents.send(channel, ...args);
}

/**
 * Broadcast a server target change (URL/token) to all renderer windows so they
 * re-point their API clients and refetch, without an app restart.
 */
export function broadcastServerChanged(): void {
  broadcastToWindows("server:changed");
}

/** Read the `meetings` flag again. The promise resolves after the read. */
export function refreshMeetingsFlag(): Promise<void> {
  return serverFetch("/config/flags/meetings")
    .then(async (res) => {
      if (!res.ok) return;
      const body = (await res.json()) as { value?: boolean };
      state.meetingsFlagEnabled = body.value === true;
    })
    .catch(() => {
      // server not up yet — keep the cached value
    });
}

export function stopHotkeyRecorderProcess(): void {
  state.hotkeyRecorder?.stop();
  state.hotkeyRecorder = null;
}
