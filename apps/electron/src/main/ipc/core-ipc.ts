/**
 * Core IPC handlers for the main process.
 * Each register function owns one group of channels.
 * The caller must keep the registration order unchanged.
 */
import { OutputMode } from "@openstyle/sdk";
import { createAppLogger } from "@openstyle/utils";
import { clipboard, globalShortcut, ipcMain } from "electron";
import { isActiveAudioPlaybackMode } from "../../shared/audio-playback";
import { normalizePillCancelMode } from "../../shared/pill-cancel";
import { registerJobAbortIpc } from "../abortable-jobs";
import {
  getLinuxFrontmostApp,
  getMacFrontmostApp,
  getOpenAppCandidates,
  getWindowsFrontmostApp,
} from "../active-window";
import { registerAppSettingsIpc } from "../app-settings-ipc";
import { registerDiskUsageIpc } from "../disk-usage";
import { HotkeyRecorder } from "../hotkey-recorder";
import {
  handleDictationHotkeyDown,
  handleDictationHotkeyUp,
  scheduleHotkeyRegistration,
} from "../hotkeys/dictation";
import { registerImportIpc } from "../import-audio";
import { readSettings, writeSettings } from "../local-settings";
import {
  broadcastServerChanged,
  broadcastToWindows,
  state,
  stopHotkeyRecorderProcess,
} from "../main-state";
import { registerMeetingImportIpc } from "../meeting-import";
import { registerMeetingIpc } from "../meeting-ipc";
import { MeetingRecorder } from "../meeting-recorder";
import { buildTrayContextMenu } from "../menus";
import { notifyImportComplete, notifyPasteFailed } from "../notifications";
import { pasteIntoFocusedApp } from "../paste";
import {
  hasCurrentAccessibilityPermission,
  openAccessibilitySettings,
  openMicrophoneSettings,
} from "../permission-dialogs";
import { registerPermissionsIpc } from "../permissions-ipc";
import { updateRemixBar } from "../remix/bar-window";
import {
  getServerPort,
  getServerToken,
  getServerUrl,
  serverClient,
  serverFetch,
} from "../server-target";
import { createMeetingCaptureWindow } from "../windows/meeting-capture-window";
import {
  getPillAlignmentForCustom,
  hidePill,
  resolveAppWindowPosition,
  setPillExpanded,
  setPillHotRect,
  setProgrammaticPosition,
} from "../windows/pill-window";

const hotkeyRecorderLog = createAppLogger("hotkey-recorder");

/**
 * Mechanically deliver final dictation text to the user's focused app — paste
 * or copy, exactly as resolved by the renderer before this is invoked, so
 * `text`/`mode` here are the host's final word: no further transformation runs
 * in this process anymore. Emits the `outputDelivered` event (relayed to the
 * server's `event` hook sink) with whatever mode was ultimately used.
 */
async function deliverOutput(
  text: string,
  mode: typeof OutputMode.Paste | typeof OutputMode.Clipboard,
): Promise<void> {
  if (!text.trim()) {
    return;
  }

  try {
    if (mode === OutputMode.Paste) {
      await pasteIntoFocusedApp(text);
    } else {
      clipboard.writeText(text);
    }
  } catch (err) {
    // pasteIntoFocusedApp left the transcript on the clipboard — tell the user
    // instead of letting the dictation silently vanish.
    notifyPasteFailed();
    throw err;
  }
}

export function registerCoreIpc({ logsDir }: { logsDir: string }): void {
  // IPC: paste text at cursor.
  ipcMain.handle("paste:text", async (_event, text: string) => {
    await deliverOutput(text, OutputMode.Paste);
  });

  // IPC: copy text to clipboard.
  ipcMain.handle("copy:text", async (_event, text: string) => {
    await deliverOutput(text, OutputMode.Clipboard);
  });

  ipcMain.handle("audio:prepare", async (_event, mode: unknown) => {
    if (!isActiveAudioPlaybackMode(mode)) return;
    await state.audioPlaybackController.prepare(mode);
  });

  ipcMain.handle("audio:restore", async () => {
    await state.audioPlaybackController.restore();
  });

  // Settings → Data: aggregate disk usage (UX-08) — async walk in the main
  // process, so the settings window never touches the filesystem.
  registerDiskUsageIpc();

  // --- Import screen ---------------------------------------------------------
  registerJobAbortIpc();
  registerImportIpc({
    serverFetch,
    getParentWindow: () => state.mainWindow,
    onTranscribed: ({ fileName }) => notifyImportComplete(fileName),
  });

  // Meeting import (specs/meeting-import.md §4.4): same picker/upload shape
  // as the dictation Import screen, but the upload lands in
  // POST /api/meetings/import as a full meeting record.
  registerMeetingImportIpc({
    serverFetch,
    getParentWindow: () => state.mainWindow,
  });

  // --- Meeting Mode ---------------------------------------------------------
  state.meetingRecorder = new MeetingRecorder({
    serverFetch,
    createCaptureWindow: createMeetingCaptureWindow,
    broadcastLevel: (event) => {
      broadcastToWindows("meeting:level", event);
    },
    broadcastStatus: (status) => {
      broadcastToWindows("meeting:status-changed", status);
      // Linux keeps a static tray menu; elsewhere it rebuilds on right-click.
      if (process.platform === "linux") {
        state.tray?.setContextMenu(buildTrayContextMenu());
      }
    },
  });

  registerMeetingIpc({
    getMeetingRecorder: () => state.meetingRecorder,
    serverClient,
  });

  // IPC: broadcast output mode changes to pill window
  ipcMain.on("settings:output-mode-changed", (_event, mode: string) => {
    state.mainWindow?.webContents.send("settings:output-mode-changed", mode);
  });

  // IPC: broadcast the sound setting to the pill window
  ipcMain.on("settings:sound-enabled-changed", (_event, enabled: unknown) => {
    state.mainWindow?.webContents.send(
      "settings:sound-enabled-changed",
      enabled === true,
    );
  });

  ipcMain.on("settings:pill-cancel-mode-changed", (_event, mode: unknown) => {
    state.mainWindow?.webContents.send(
      "settings:pill-cancel-mode-changed",
      normalizePillCancelMode(mode),
    );
  });

  ipcMain.on("settings:audio-playback-mode-changed", (_event, mode: string) => {
    state.mainWindow?.webContents.send(
      "settings:audio-playback-mode-changed",
      mode,
    );
  });

  // IPC: relay cleanup-context changes (llm_cleanup / cleanup tones) from the
  // dashboard to the pill so it refreshes its cached routing decision instead
  // of re-fetching /api/settings on every recording start.
  ipcMain.on("settings:cleanup-context-changed", () => {
    state.mainWindow?.webContents.send("settings:cleanup-context-changed");
  });

  // IPC: hide the pill window on request from renderer
  ipcMain.on("pill:hide", () => {
    hidePill();
  });

  // IPC: the renderer needs (or no longer needs) room for the status card.
  ipcMain.on(
    "pill:set-expanded",
    (_event, expanded: boolean, expansion?: unknown) => {
      setPillExpanded(
        expanded === true,
        expansion === "remix-chat" ? expansion : "card",
      );
    },
  );

  // null = fully interactive; otherwise click-through outside the rect.
  ipcMain.on("pill:set-hot-rect", (_event, rect: unknown) => {
    if (rect === null) {
      setPillHotRect(null);
      return;
    }
    if (typeof rect !== "object" || rect === null) return;
    const { x, y, width, height } = rect as Record<string, unknown>;
    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      typeof width !== "number" ||
      typeof height !== "number" ||
      ![x, y, width, height].every(Number.isFinite)
    ) {
      return;
    }
    setPillHotRect({ x, y, width, height });
  });

  // IPC: fan out per-frame audio levels from the pill to other windows
  // (e.g. the Today tutorial demo) so they can render a live waveform.
  ipcMain.on("audio:level", (_event, level: number) => {
    if (typeof level !== "number") return;
    state.settingsWindow?.webContents.send("audio:level", level);
  });

  // IPC: pill notifies that a transcription has finished + been pasted, so
  // history-driven views (Today, History) can refetch without polling.
  ipcMain.on("transcription:done", () => {
    state.settingsWindow?.webContents.send("transcription:done");
  });

  registerAppSettingsIpc({
    getServerPort,
    getServerUrl,
    getServerToken,
    readSettings,
    writeSettings,
    broadcastServerChanged,
    logsDir,
  });

  registerPermissionsIpc({
    hasAccessibilityPermission: hasCurrentAccessibilityPermission,
    openAccessibilitySettings,
    openMicrophoneSettings,
    completeOnboarding: () => {
      writeSettings({ onboardingComplete: true });
      state.remixPracticeTarget = false;
      state.remixBarHeldForOnboarding = false;
      updateRemixBar();
    },
  });

  if ((process.env.OPENSTYLE_E2E ?? process.env.FREESTYLE_E2E) === "1") {
    ipcMain.on("e2e:trigger-hotkey-down", () => handleDictationHotkeyDown());
    ipcMain.on("e2e:trigger-hotkey-up", () => handleDictationHotkeyUp());
  }

  // IPC: hotkey recording — global native listener + renderer DOM on macOS
  ipcMain.on("hotkey-record:start", () => {
    // Park remix listener while recording a hotkey.
    if (state.remixKeyListener) {
      state.remixKeyListener.stop();
      state.remixKeyListener = null;
      state.remixPressed = false;
    }
    // Pause the active hotkey listener so it doesn't fire during recording
    if (state.keyListener) {
      state.keyListener.stop();
      state.keyListener = null;
    }
    globalShortcut.unregisterAll();

    stopHotkeyRecorderProcess();
    const target =
      state.settingsWindow?.webContents ??
      state.mainWindow?.webContents ??
      null;
    if (!target) return;

    state.hotkeyRecorder = new HotkeyRecorder({
      onCancel: () => {
        stopHotkeyRecorderProcess();
        scheduleHotkeyRegistration(state.currentHotkeyAccel ?? undefined);
      },
      onError: (message) => {
        hotkeyRecorderLog.warn(message);
      },
    });
    state.hotkeyRecorder.start(target);
  });

  ipcMain.on("hotkey-record:stop", (_event, hotkey?: string) => {
    stopHotkeyRecorderProcess();
    scheduleHotkeyRegistration(
      typeof hotkey === "string" && hotkey.length > 0
        ? hotkey
        : (state.currentHotkeyAccel ?? undefined),
    );
  });
}

export function registerSystemIpc(): void {
  // -- Context-aware dictation: get frontmost app + browser context --
  ipcMain.handle("system:frontmost-app", async () => {
    try {
      if (process.platform === "darwin") {
        return await getMacFrontmostApp();
      }
      if (process.platform === "win32") {
        return await getWindowsFrontmostApp();
      }
      if (process.platform === "linux") {
        return await getLinuxFrontmostApp();
      }
    } catch {
      // graceful fallback
    }
    return null;
  });

  ipcMain.handle("system:open-app-candidates", async () => {
    try {
      return await getOpenAppCandidates();
    } catch {
      return [];
    }
  });

  // -- Pill position setting --
  ipcMain.handle("settings:pill-position", () => {
    const pos = (readSettings().pillPosition as string) ?? "bottom-center";
    // For a custom position, derive the correct top/bottom alignment token
    // from the actual window position relative to its display.
    if (pos === "custom") return getPillAlignmentForCustom();
    return pos;
  });

  ipcMain.on("settings:set-pill-position", (_event, position: string) => {
    if (position === "custom") {
      writeSettings({ pillPosition: position });
    } else {
      writeSettings({ pillPosition: position, pillCustomPosition: undefined });
    }
    // Reposition the window and notify the renderer for CSS alignment.
    if (state.mainWindow) {
      const { x, y } = resolveAppWindowPosition();
      setProgrammaticPosition(state.mainWindow, x, y);
    }
    // For custom, resolve the live alignment; for presets, send as-is.
    const broadcast =
      position === "custom" ? getPillAlignmentForCustom() : position;
    broadcastToWindows("settings:pill-position-changed", broadcast);
  });
}
