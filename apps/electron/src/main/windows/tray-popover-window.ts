// Tray popover: the small panel under the menu bar icon (issue #317).
// A left click on the tray icon toggles it. It must never take focus from the
// app that the user dictates into, so on macOS it is a non-activating panel
// that cannot become the key window.
// This file must not import pill-window.ts: pill-window.ts imports this file.
import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { createAppLogger } from "@openstyle/utils";
import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  type Rectangle,
  screen,
} from "electron";
import { version as packageVersion } from "../../../package.json";
import type {
  TrayPopoverState,
  TrayPopoverTarget,
} from "../../shared/tray-popover";
import { isFakeMeetingCapture } from "../fake-meeting-capture";
import { refreshMeetingsFlag, state } from "../main-state";
import { getNativeBinaryPath } from "../native-binary";
import { getTrayPopoverURL } from "../renderer-urls";
import { isSystemAudioCaptureSupported } from "../system-audio-capture";
import { currentTrayAppearance, refreshTrayIcon } from "../tray-icon";
import { trayPopoverPosition } from "../tray-popover-position";
import { showSettingsWindow } from "./settings-window";

const log = createAppLogger("electron");

const POPOVER_WIDTH = 320;
/** The height until the renderer reports the height of its content. */
const INITIAL_HEIGHT = 420;
const EDGE = 8;

const TARGET_PATHS: Record<TrayPopoverTarget, string | undefined> = {
  // No path: show the main window on the page it already shows.
  app: undefined,
  settings: "/settings",
  history: "/today",
  confirmMeeting: "/meetings?confirmStart=1",
};

let contentHeight = INITIAL_HEIGHT;
/** True while the popover holds the global Escape shortcut. */
let escapeOwned = false;
let clickWatcher: ChildProcess | null = null;
/** Show the popover when its page ends loading (a show before the load). */
let showAfterLoad = false;

/** Make the popover window, hidden. The tray calls it once at start. */
export function createTrayPopoverWindow(): void {
  if (state.trayPopover) return;
  const win = new BrowserWindow({
    width: POPOVER_WIDTH,
    height: INITIAL_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: true,
    skipTaskbar: true,
    roundedCorners: true,
    autoHideMenuBar: true,
    // The window never becomes the key window, so it never takes keyboard
    // focus from the app that the user works in.
    focusable: false,
    // The first click on a window that is not key goes to the page, so the
    // buttons work with one click.
    acceptFirstMouse: true,
    // Quiet E2E: never always-on-top.
    alwaysOnTop: !state.quietE2E,
    // A macOS panel with the non-activating style: a click in it does not
    // make Openstyle the active app.
    ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      // The window is hidden most of the time. Keep its timers on time when
      // it shows, and keep quiet E2E (opacity 0) rendering.
      backgroundThrottling: false,
    },
  });
  state.trayPopover = win;

  // Above full-screen apps and on every Space, like a menu. Quiet E2E skips
  // this: setVisibleOnAllWorkspaces toggles the macOS process type, which
  // brings back the dock icon (the same rule as the pill).
  if (!state.quietE2E) {
    win.setAlwaysOnTop(true, "pop-up-menu");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  // Do not call showTrayPopover here: isLoading() is still true during
  // did-finish-load (Chromium clears it later, at did-stop-loading), so it
  // would wait for the load again and never show. Linux hit this on its first
  // toggle, because Linux makes the window on the first toggle (menus.ts).
  win.webContents.on("did-finish-load", () => {
    if (!showAfterLoad) return;
    showAfterLoad = false;
    revealTrayPopover(win, "after-load");
  });

  win.on("closed", () => {
    if (state.trayPopover === win) state.trayPopover = null;
    releaseEscape();
    stopClickWatcher();
  });

  void win.loadURL(getTrayPopoverURL());
}

export function isTrayPopoverVisible(): boolean {
  return state.trayPopover?.isVisible() === true;
}

/** Show the popover if it is hidden, or hide it if it shows. */
export function toggleTrayPopover(reason: string): void {
  if (isTrayPopoverVisible()) hideTrayPopover(reason);
  else showTrayPopover(reason);
}

export function showTrayPopover(reason: string): void {
  if (!state.trayPopover) createTrayPopoverWindow();
  const win = state.trayPopover;
  if (!win) return;
  if (win.webContents.isLoading()) {
    showAfterLoad = true;
    return;
  }
  revealTrayPopover(win, reason);
}

/** Show the loaded popover without focus, and hold its close triggers. */
function revealTrayPopover(win: BrowserWindow, reason: string): void {
  if (win.isDestroyed()) return;
  placeTrayPopover(win);
  // showInactive: show the panel without making it key and without
  // activating the app.
  win.showInactive();
  win.webContents.send("tray-popover:shown");
  holdEscape();
  startClickWatcher();
  log.info(`Tray popover shown (${reason})`);
}

export function hideTrayPopover(reason: string): void {
  showAfterLoad = false;
  const win = state.trayPopover;
  if (!win?.isVisible()) return;
  win.hide();
  win.webContents.send("tray-popover:hidden");
  releaseEscape();
  stopClickWatcher();
  log.info(`Tray popover hidden (${reason})`);
}

function placeTrayPopover(win: BrowserWindow): void {
  const anchor = state.tray?.getBounds() ?? null;
  const display =
    anchor && anchor.width > 0
      ? screen.getDisplayMatching(anchor)
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const height = Math.min(contentHeight, display.workArea.height - 2 * EDGE);
  const { x, y } = trayPopoverPosition(anchor, display.workArea, {
    width: POPOVER_WIDTH,
    height,
  });
  win.setBounds({ x, y, width: POPOVER_WIDTH, height });
}

/**
 * Escape closes the popover. The panel never has keyboard focus, so this
 * uses a global shortcut, held only while the popover shows. A dictation
 * also uses Escape (pill-window.ts): when a dictation holds it, the popover
 * does not take it, and a dictation start hides the popover first.
 */
function holdEscape(): void {
  if (globalShortcut.isRegistered("Escape")) return;
  escapeOwned = globalShortcut.register("Escape", () => {
    hideTrayPopover("escape");
  });
}

function releaseEscape(): void {
  if (!escapeOwned) return;
  escapeOwned = false;
  globalShortcut.unregister("Escape");
}

/**
 * A click outside closes the popover. The panel never becomes key, so it gets
 * no blur event. While the popover shows, a small helper
 * (native/macos-click-watcher.swift) reports each mouse-down in any app. A
 * point outside the popover and outside the tray icon closes it. The tray
 * icon is left out because its own click handler toggles the popover. Quiet
 * E2E does not start the helper: the clicks of the person at the screen must
 * not change a test.
 */
function startClickWatcher(): void {
  if (process.platform !== "darwin" || state.quietE2E || clickWatcher) return;
  const binary = getNativeBinaryPath("macos-click-watcher");
  if (!binary) {
    log.warn(
      "macos-click-watcher not found: an outside click cannot close the tray popover",
    );
    return;
  }
  const child = spawn(binary, [], { stdio: ["pipe", "pipe", "ignore"] });
  clickWatcher = child;
  let buffer = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const match = /^DOWN (-?\d+) (-?\d+)$/.exec(line.trim());
      if (!match) continue;
      const point = { x: Number(match[1]), y: Number(match[2]) };
      if (isOutsideClick(point)) hideTrayPopover("outside-click");
    }
  });
  child.on("error", (err) => {
    log.warn(`macos-click-watcher failed: ${String(err)}`);
  });
  child.on("exit", () => {
    if (clickWatcher === child) clickWatcher = null;
  });
}

function stopClickWatcher(): void {
  const child = clickWatcher;
  clickWatcher = null;
  if (!child) return;
  child.stdin?.end();
  child.kill();
}

function contains(rect: Rectangle, point: { x: number; y: number }): boolean {
  return (
    point.x >= rect.x &&
    point.x < rect.x + rect.width &&
    point.y >= rect.y &&
    point.y < rect.y + rect.height
  );
}

function isOutsideClick(point: { x: number; y: number }): boolean {
  const win = state.trayPopover;
  if (!win?.isVisible()) return false;
  if (contains(win.getBounds(), point)) return false;
  const icon = state.tray?.getBounds();
  if (icon && contains(icon, point)) return false;
  return true;
}

/**
 * The Openstyle version. An unpacked run (dev, E2E) starts Electron with a
 * script, and app.getVersion() then gives the Electron version. So only a
 * packaged app asks Electron; other runs use package.json.
 */
function appVersion(): string {
  return app.isPackaged ? app.getVersion() : packageVersion;
}

function isTarget(value: unknown): value is TrayPopoverTarget {
  return typeof value === "string" && Object.hasOwn(TARGET_PATHS, value);
}

/** True when the IPC message comes from the popover page. */
function fromPopover(event: Electron.IpcMainEvent): boolean {
  return event.sender === state.trayPopover?.webContents;
}

/**
 * IPC of the popover page. `getHotkeyMode` comes from the dictation module,
 * which this file must not import (dictation imports pill-window, and
 * pill-window imports this file).
 */
export function registerTrayPopoverIpc(deps: {
  getHotkeyMode: () => "hold" | "toggle";
}): void {
  ipcMain.handle("tray-popover:state", async (): Promise<TrayPopoverState> => {
    await refreshMeetingsFlag();
    return {
      version: appVersion(),
      hotkey: state.currentHotkeyAccel,
      hotkeyMode: deps.getHotkeyMode(),
      dictating: state.hotkeyPressed,
      meetingsAvailable:
        state.meetingsFlagEnabled &&
        state.meetingRecorder !== null &&
        (isSystemAudioCaptureSupported() || isFakeMeetingCapture()),
      update: state.updateDownloadState,
      visible: isTrayPopoverVisible(),
    };
  });

  ipcMain.on("tray-popover:set-height", (event, height: unknown) => {
    if (!fromPopover(event) || typeof height !== "number") return;
    if (!Number.isFinite(height) || height <= 0) return;
    contentHeight = Math.ceil(height);
    const win = state.trayPopover;
    if (win?.isVisible()) placeTrayPopover(win);
  });

  ipcMain.on("tray-popover:hide", (event) => {
    if (fromPopover(event)) hideTrayPopover("escape-key");
  });

  ipcMain.on("tray-popover:open", (event, target: unknown) => {
    if (!fromPopover(event) || !isTarget(target)) return;
    hideTrayPopover(`open ${target}`);
    showSettingsWindow(TARGET_PATHS[target]);
  });

  // A click on a meeting job opens that meeting in the main window.
  ipcMain.on("tray-popover:open-meeting", (event, id: unknown) => {
    if (!fromPopover(event) || typeof id !== "string") return;
    if (!/^[\w-]{1,128}$/.test(id)) return;
    hideTrayPopover("open meeting");
    showSettingsWindow(`/meetings?meeting=${encodeURIComponent(id)}`);
  });

  ipcMain.on("tray-popover:quit", (event) => {
    if (fromPopover(event)) app.quit();
  });

  if ((process.env.OPENSTYLE_E2E ?? process.env.FREESTYLE_E2E) === "1") {
    // The same toggle as a left click on the tray icon.
    ipcMain.on("e2e:tray-popover-toggle", () => {
      toggleTrayPopover("e2e");
    });
    // The tray look that main shows now: a test cannot capture the menu bar.
    ipcMain.handle("e2e:tray-appearance", () => currentTrayAppearance());
    // An update that finished its download, for the popover footer.
    ipcMain.on("e2e:tray-popover-update-ready", () => {
      state.updateDownloadState = "downloaded";
      refreshTrayIcon();
    });
  }
}
