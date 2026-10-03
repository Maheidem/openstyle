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

import { accessSync, constants } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { OutputMode } from "@openstyle/sdk";
import {
  activateManagedMlxRuntimeForAppVersion,
  closeDb,
  prefetchManagedMlxRuntimeForAppRelease,
  reconcileUnsupportedMlxVoiceDefault,
  startServer as startOpenstyleServer,
  stopMlxServer,
  stopWhisperServer,
} from "@openstyle/server";
import { createAppLogger, enableFileLogging } from "@openstyle/utils";
import {
  DEFAULT_SERVER_PORT,
  REMIX_CLIPBOARD_LIMIT,
} from "@openstyle/validations";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  Notification,
  nativeImage,
  net,
  protocol,
  screen,
  shell,
  systemPreferences,
  Tray,
} from "electron";
import { autoUpdater } from "electron-updater";
import icon from "../../resources/icon.png?asset";
import trayIconPath from "../../resources/tray/logoTemplate.png?asset";
import { isActiveAudioPlaybackMode } from "../shared/audio-playback";
import { getDefaultHotkey } from "../shared/hotkey-defaults";
import { normalizePillCancelMode } from "../shared/pill-cancel";
import {
  getDefaultRemixHotkey,
  REMIX_CLIPBOARD_PREVIEW_LIMIT,
} from "../shared/remix";
import { SETTINGS_KEYS } from "../shared/settings-keys";
import { registerJobAbortIpc } from "./abortable-jobs";
import {
  getFocusedWindowDisplay,
  getFrontmostContext,
  getLinuxFrontmostApp,
  getMacFrontmostApp,
  getOpenAppCandidates,
  getOpenstyleAppExclusions,
  getWindowsFrontmostApp,
} from "./active-window";
import { registerAppSettingsIpc } from "./app-settings-ipc";
import { AudioPlaybackController } from "./audio-control/controller";
import { recoverDuckedVolumeFromCrash } from "./audio-control/volume-ducker";
import { registerDiskUsageIpc } from "./disk-usage";
import { HotkeyRecorder } from "./hotkey-recorder";
import {
  diffLanguageHotkeys,
  isLanguageHotkeyTaken,
  isValidAccelerator,
  normalizeAccelerator,
} from "./hotkey-utils";
import { registerImportIpc } from "./import-audio";
import { NativeKeyListener } from "./key-listener";
import * as linuxAutostart from "./linux-autostart";
import { isWaylandSession } from "./linux-session";
import {
  clearSettingsCache,
  readSettings,
  writeSettings,
} from "./local-settings";
import {
  activateAnchorApp,
  isSecureInputActive,
  runKeystrokeScript,
  runMacAxCaps,
  runMacAxKey,
  runMacAxRead,
  runMacAxSelect,
  sendChordToFocusedApp,
  sendSelectAllToFocusedApp,
} from "./mac-ax";
import { registerMeetingImportIpc } from "./meeting-import";
import { registerMeetingIpc } from "./meeting-ipc";
import { MeetingRecorder } from "./meeting-recorder";
import { migrateLegacyUserData } from "./migrate-user-data";
import {
  copySelectionFromFocusedApp,
  pasteClipboardIntoFocusedApp,
  pasteIntoFocusedApp,
  startLinuxPasteHelper,
  stopLinuxPasteHelper,
} from "./paste";
import {
  type DictationPermission,
  missingDictationPermission,
  resolveAccessibilityPermission,
  type StartupPermissionWarning,
  startupPermissionWarning,
} from "./permission-checks";
import { registerPermissionsIpc } from "./permissions-ipc";
import {
  APP_HEIGHT,
  APP_WIDTH,
  presetPositionForDisplay,
  resolveCustomPosition,
} from "./pill-position";
import { isRemixTargetAllowed } from "./remix-target";
import {
  getDashboardURL,
  getMeetingCaptureURL,
  getPillURL,
  getRemixBarURL,
} from "./renderer-urls";
import { selfUpdater, sweepSelfUpdaterBackups } from "./self-updater";
import {
  getConfiguredModelCount,
  getServerPort,
  getServerSettings,
  getServerToken,
  getServerUrl,
  probeServerHealth,
  putServerSetting,
  serverClient,
  serverFetch,
  setServerPort,
  waitForServerReady,
} from "./server-target";
import { isSystemAudioCaptureSupported } from "./system-audio-capture";

// Test isolation: E2E/probe runs in the unpackaged dev binary would otherwise
// share the real "Electron" userData (settings.json included) with a running
// dev instance. Must be set before anything reads app.getPath("userData").
const userDataOverride =
  process.env.OPENSTYLE_USER_DATA ?? process.env.FREESTYLE_USER_DATA;
if (userDataOverride) {
  app.setPath("userData", userDataOverride);
}

const log = createAppLogger("electron");
const hotkeyLog = createAppLogger("hotkey");
const hotkeyRecorderLog = createAppLogger("hotkey-recorder");

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

/**
 * The window is grown to this while the renderer shows its expanded status
 * card (a failure the user has to answer — see `pill:set-expanded`). The extra
 * area is transparent and empty, so it stays collapsed the rest of the time
 * rather than sitting over the user's screen as a dead zone.
 */
const PILL_CARD_WIDTH = 340;
const PILL_CARD_HEIGHT = 144;
/** Held for the whole remix session so mid-morph setBounds doesn't blink. */
const PILL_CHAT_WIDTH = 440;
const PILL_CHAT_HEIGHT = 600;

type PillExpansion = "card" | "remix-chat";

function pillExpansionSize(expansion: PillExpansion): {
  width: number;
  height: number;
} {
  if (expansion === "remix-chat") {
    return { width: PILL_CHAT_WIDTH, height: PILL_CHAT_HEIGHT };
  }
  return { width: PILL_CARD_WIDTH, height: PILL_CARD_HEIGHT };
}

// Hot-rect: click-through except the reported surface; poll flips interactivity.

type PillHotRect = { x: number; y: number; width: number; height: number };
let pillHotRect: PillHotRect | null = null;
let pillHotPollTimer: NodeJS.Timeout | null = null;

function stopPillHotPoll(): void {
  if (pillHotPollTimer) {
    clearInterval(pillHotPollTimer);
    pillHotPollTimer = null;
  }
}

function setPillHotRect(rect: PillHotRect | null): void {
  // Tests drive the surfaces with synthetic DOM events; the machine's real
  // cursor must not be able to flip interactivity under them.
  if ((process.env.OPENSTYLE_E2E ?? process.env.FREESTYLE_E2E) === "1") return;
  pillHotRect = rect;
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  if (!rect) {
    stopPillHotPoll();
    win.setIgnoreMouseEvents(false);
    return;
  }
  win.setIgnoreMouseEvents(true, { forward: process.platform !== "linux" });
  if (pillHotPollTimer) return;
  pillHotPollTimer = setInterval(() => {
    const w = mainWindow;
    const hot = pillHotRect;
    if (!w || w.isDestroyed() || !hot || !w.isVisible()) return;
    const bounds = w.getBounds();
    const cursor = screen.getCursorScreenPoint();
    const inside =
      cursor.x >= bounds.x + hot.x &&
      cursor.x <= bounds.x + hot.x + hot.width &&
      cursor.y >= bounds.y + hot.y &&
      cursor.y <= bounds.y + hot.y + hot.height;
    if (!inside) return;
    pillHotRect = null;
    stopPillHotPoll();
    w.setIgnoreMouseEvents(false);
    w.webContents.send("pill:hot-enter");
  }, 120);
}

/**
 * Send one IPC message to the pill window and the settings window. The
 * channel must be a string literal, so the preload drift test can find it.
 */
function broadcastToWindows(channel: string, ...args: unknown[]): void {
  mainWindow?.webContents.send(channel, ...args);
  settingsWindow?.webContents.send(channel, ...args);
}

/**
 * Broadcast a server target change (URL/token) to all renderer windows so they
 * re-point their API clients and refetch, without an app restart.
 */
function broadcastServerChanged(): void {
  broadcastToWindows("server:changed");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let httpServer: any = null;
let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
// In-flight settings-window creation. createSettingsWindow awaits an onboarding
// probe before it assigns settingsWindow, so this serializes concurrent opens
// to avoid spawning a second window during that gap.
let settingsWindowCreating: Promise<void> | null = null;
let tray: Tray | null = null;
let keyListener: NativeKeyListener | null = null;
// Latching flag: records that the native key listener started successfully.
// It persists while the listener is temporarily torn down for hotkey recording,
// but is never used to override the current macOS Accessibility trust result.
let accessibilityConfirmed = false;
let hotkeyPressed = false;
let currentHotkeyAccel: string | null = null;
let hotkeyActivationMode: "hold" | "toggle" = "hold";
let hotkeyRecorder: HotkeyRecorder | null = null;
/** Own listener process — native binaries only take one accelerator each. */
let remixKeyListener: NativeKeyListener | null = null;
let remixPressed = false;
/** Per-language dictation hotkeys: lang code -> its native listener. */
const languageKeyListeners = new Map<string, NativeKeyListener>();
/** Lang code -> normalized accelerator currently registered for it. */
const languageHotkeyAccels = new Map<string, string>();
/** Which hotkey (if any) started the in-progress dictation session. */
let activeDictationLanguage: string | null = null;
/** User-configured accel (may differ from what's listening while parked/off). */
let remixHotkeyPreference: string | undefined;
let currentRemixAccel: string | null = null;
/** False until server settings are read once (don't spawn on defaults). */
let remixInitialized = false;
/** Onboarding practice: allow Remix to target Openstyle's own window. */
let remixPracticeTarget = false;
const audioPlaybackController = new AudioPlaybackController();
/** Meeting Mode recorder (created on whenReady; darwin >= 14.4 only). */
let meetingRecorder: MeetingRecorder | null = null;
/**
 * Cached `meetings` feature flag. Flags are server-owned (config.freestyle.json
 * behind GET /api/config/flags/:key — see apps/server/src/lib/config.ts), so
 * the tray reads this cache and refreshes it in the background: the tray menu
 * template must be built synchronously.
 */
let meetingsFlagEnabled = false;

function refreshMeetingsFlag(): void {
  void serverFetch("/config/flags/meetings")
    .then(async (res) => {
      if (!res.ok) return;
      const body = (await res.json()) as { value?: boolean };
      meetingsFlagEnabled = body.value === true;
    })
    .catch(() => {
      // server not up yet — keep the cached value
    });
}

function stopHotkeyRecorderProcess(): void {
  hotkeyRecorder?.stop();
  hotkeyRecorder = null;
}

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

function registerAppProtocol(): void {
  protocol.handle("app", (request) => {
    const url = new URL(request.url);
    let filePath = join(
      __dirname,
      "../renderer",
      decodeURIComponent(url.pathname),
    );

    // If the path has no file extension, serve the dashboard SPA fallback.
    // pill.html is loaded directly by its full path and doesn't need a fallback.
    if (!filePath.match(/\.\w+$/)) {
      filePath = join(__dirname, "../renderer/index.html");
    }

    return net.fetch(pathToFileURL(filePath).toString());
  });
}

/**
 * Hidden mic-capture window for meeting recordings. Loads the minimal
 * meeting-capture entry (PCM AudioWorklet -> `meeting:mic-chunk` IPC). The
 * configured mic device id is a server-owned setting, so the URL is resolved
 * asynchronously after creation; capture starts on page load.
 */
function createMeetingCaptureWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      // Capture must keep flowing while the hidden window is occluded.
      backgroundThrottling: false,
    },
  });

  void (async () => {
    let deviceParam = "";
    try {
      const res = await serverFetch(`/settings/${SETTINGS_KEYS.micDeviceId}`);
      if (res.ok) {
        const { value } = (await res.json()) as { value?: string };
        if (value) deviceParam = `?device=${encodeURIComponent(value)}`;
      }
    } catch {
      // no configured device — use the default mic
    }
    if (!win.isDestroyed()) {
      void win.loadURL(`${getMeetingCaptureURL()}${deviceParam}`);
    }
  })();

  return win;
}

// Tracks the exact coordinates of the last programmatic setPosition call.
// The move listener compares reported coords against this target and ignores
// matching events, eliminating the fixed-timeout race condition.
let programmaticTarget: { x: number; y: number } | null = null;
let programmaticCleanupTimer: NodeJS.Timeout | null = null;

function markProgrammaticTarget(x: number, y: number): void {
  programmaticTarget = { x, y };
  if (programmaticCleanupTimer) clearTimeout(programmaticCleanupTimer);
  // Safety: clear the target after 1s in case the OS never delivers a settle event.
  programmaticCleanupTimer = setTimeout(() => {
    programmaticTarget = null;
    programmaticCleanupTimer = null;
  }, 1000);
}

/**
 * How far the window's origin has been pushed out to make room for the
 * expanded card, so the pill itself doesn't move. Zero while collapsed.
 *
 * Everything else in this file works in *slot* coordinates — where the
 * collapsed 160x60 pill sits — and this offset is applied at the two places
 * that touch real window coordinates: `setProgrammaticPosition` on the way
 * out, and the `move` listener on the way in. Latching it at expand time
 * (rather than recomputing it) guarantees the collapse lands exactly where
 * the expand started, even if the anchor preference changed in between.
 */
let pillExpandOffset = { dx: 0, dy: 0 };
/** Which expanded size `pillExpandOffset` was computed for. */
let pillExpansion: PillExpansion = "card";

function setProgrammaticPosition(
  win: BrowserWindow,
  x: number,
  y: number,
): void {
  const tx = x - pillExpandOffset.dx;
  const ty = y - pillExpandOffset.dy;
  markProgrammaticTarget(tx, ty);
  win.setPosition(tx, ty);
  const [ax, ay] = win.getPosition();
  if (ax !== tx || ay !== ty) markProgrammaticTarget(ax, ay);
}

/** Which capsule edge stays pinned when the window grows around the pill. */
function getPillAnchor(): { side: "center" | "right"; edge: "top" | "bottom" } {
  const position = (readSettings().pillPosition as string) || "bottom-center";
  if (position === "custom") {
    return {
      side: "center",
      edge: getPillAlignmentForCustom() === "custom-top" ? "top" : "bottom",
    };
  }
  return {
    side: position.endsWith("right") ? "right" : "center",
    edge: position.startsWith("top") ? "top" : "bottom",
  };
}

/**
 * Grow/shrink the pill window around the pill, keeping the capsule's anchored
 * edge fixed on screen. The renderer drives this: it asks for the room a beat
 * before it animates the card in, and gives it back once the card is gone.
 */
function setPillExpanded(
  expanded: boolean,
  expansion: PillExpansion = "card",
): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  const isExpanded = pillExpandOffset.dx !== 0 || pillExpandOffset.dy !== 0;
  // No-op if already collapsed/same size; re-run on size change to keep anchor.
  if (expanded === isExpanded && !expanded) return;
  if (expanded && isExpanded && expansion === pillExpansion) {
    const size = pillExpansionSize(expansion);
    const bounds = win.getBounds();
    if (bounds.width === size.width && bounds.height === size.height) return;
  }
  if (expanded) pillExpansion = expansion;

  const previousOffset = pillExpandOffset;
  const [x, y] = win.getPosition();
  let target: { x: number; y: number; width: number; height: number };

  if (expanded) {
    const { side, edge } = getPillAnchor();
    const { width, height } = pillExpansionSize(expansion);
    pillExpandOffset = {
      dx:
        side === "right"
          ? width - APP_WIDTH
          : Math.round((width - APP_WIDTH) / 2),
      dy: edge === "top" ? 0 : height - APP_HEIGHT,
    };
    // Offset is from the collapsed slot; rebase before applying (may already be expanded).
    const slotX = x + previousOffset.dx;
    const slotY = y + previousOffset.dy;
    target = {
      x: slotX - pillExpandOffset.dx,
      y: slotY - pillExpandOffset.dy,
      width,
      height,
    };
  } else {
    target = {
      x: x + pillExpandOffset.dx,
      y: y + pillExpandOffset.dy,
      width: APP_WIDTH,
      height: APP_HEIGHT,
    };
    pillExpandOffset = { dx: 0, dy: 0 };
    // The collapsed capsule is a plain interactive window again.
    setPillHotRect(null);
  }

  markProgrammaticTarget(target.x, target.y);
  // The window is created non-resizable, which on some platforms also pins
  // its size against setBounds. Lift the constraint just for this call.
  win.setResizable(true);
  win.setBounds(target);
  win.setResizable(false);
  updatePillEscape();
}

// Returns the pill alignment token for a custom position, using the actual
// display the window resides on — safe for multi-monitor setups.
function getPillAlignmentForCustom(): "custom-top" | "custom-bottom" {
  if (!mainWindow) return "custom-bottom";
  const [wx, wy] = mainWindow.getPosition();
  const display = screen.getDisplayMatching({
    x: wx,
    y: wy,
    width: APP_WIDTH,
    height: APP_HEIGHT,
  });
  const midY = display.workArea.y + display.workArea.height / 2;
  return wy < midY ? "custom-top" : "custom-bottom";
}

// Preset positions follow the display under the cursor so the pill appears
// on whichever monitor the user is working on. Custom positions can be on
// any display. They are saved as absolute screen coordinates and
// bounds-checked on restore. An off-screen custom slot resets to the default,
// so this function writes settings in that case.
function resolveAppWindowPosition(preferredDisplay?: Electron.Display | null): {
  x: number;
  y: number;
} {
  // Anchor preset positions to the focused window's display when known,
  // otherwise the display containing the cursor rather than the primary
  // display, so multi-monitor users see the pill where they are working.
  const activeDisplay =
    preferredDisplay ??
    screen.getDisplayNearestPoint(screen.getCursorScreenPoint());

  // Read pill position preference
  const position = (readSettings().pillPosition as string) || "bottom-center";

  if (position === "custom") {
    const { pos, offscreen } = resolveCustomPosition(
      readSettings().pillCustomPosition as { x: number; y: number } | undefined,
      activeDisplay,
      (rect) => screen.getDisplayMatching(rect),
    );
    if (offscreen) {
      // Saved position is off-screen; reset to default.
      writeSettings({
        pillPosition: "bottom-center",
        pillCustomPosition: undefined,
      });
    }
    return pos;
  }

  return presetPositionForDisplay(activeDisplay, position);
}

function createAppWindow(): void {
  const { x, y } = resolveAppWindowPosition();

  // Mark the initial position as programmatic so the move listener ignores it.
  markProgrammaticTarget(x, y);

  mainWindow = new BrowserWindow({
    width: APP_WIDTH,
    height: APP_HEIGHT,
    x,
    y,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    roundedCorners: true,
    autoHideMenuBar: true,
    focusable: false,
    ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
    ...(process.platform === "linux" ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      // The pill is a transparent always-on-top overlay; Chromium's occlusion
      // tracker misreads it (notably under Xvfb) and stops producing frames,
      // freezing rAF-driven morphs mid-animation. Keep its renderer ticking.
      backgroundThrottling: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, "screen-saver");
  mainWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
  });

  let moveTimeout: NodeJS.Timeout | null = null;
  let moveBurst = 0;
  let userMoved = false;
  mainWindow.on("will-move", () => {
    userMoved = true;
  });
  mainWindow.on("move", () => {
    if (!mainWindow) return;
    const [rawX, rawY] = mainWindow.getPosition();

    // Ignore events that match the programmatic target (the window settling
    // after a setProgrammaticPosition call). Clear the target once we see
    // the first matching position so subsequent real drags are captured.
    if (
      programmaticTarget &&
      rawX === programmaticTarget.x &&
      rawY === programmaticTarget.y
    ) {
      if (programmaticCleanupTimer) clearTimeout(programmaticCleanupTimer);
      programmaticTarget = null;
      programmaticCleanupTimer = null;
      return;
    }

    // If programmaticTarget is set but coords don't match yet, the window is
    // still mid-animation — ignore until it settles.
    if (programmaticTarget) return;

    // Work in slot coordinates: while the status card is up the window origin
    // sits outside the capsule, and saving *that* as the custom position would
    // walk the pill across the screen on every expand/collapse cycle.
    const nx = rawX + pillExpandOffset.dx;
    const ny = rawY + pillExpandOffset.dy;

    // Ignore sub-threshold moves so accidental bumps don't override the preset.
    const currentSetting = readSettings().pillPosition as string;
    if (currentSetting !== "custom") {
      // Compare against the preset slot on the display the window is actually
      // on — not the cursor's display. Using the cursor here let a trailing
      // settle event (fired after the cursor had moved to another monitor)
      // look like a manual drag, which latched pillPosition to "custom" and
      // froze the pill on one screen.
      const windowDisplay = screen.getDisplayMatching({
        x: nx,
        y: ny,
        width: APP_WIDTH,
        height: APP_HEIGHT,
      });
      const presetPos = presetPositionForDisplay(windowDisplay, currentSetting);
      if (Math.abs(nx - presetPos.x) < 10 && Math.abs(ny - presetPos.y) < 10)
        return;
    }

    moveBurst++;
    if (moveTimeout) clearTimeout(moveTimeout);
    moveTimeout = setTimeout(() => {
      const burst = moveBurst;
      const dragged = userMoved;
      moveBurst = 0;
      userMoved = false;
      if (!mainWindow || (burst < 3 && !dragged)) return;
      const [fx, fy] = mainWindow.getPosition();
      writeSettings({
        pillPosition: "custom",
        pillCustomPosition: {
          x: fx + pillExpandOffset.dx,
          y: fy + pillExpandOffset.dy,
        },
      });
      const alignment = getPillAlignmentForCustom();
      broadcastToWindows("settings:pill-position-changed", alignment);
    }, 200);
  });

  mainWindow.on("closed", () => {
    if (moveTimeout) {
      clearTimeout(moveTimeout);
      moveTimeout = null;
    }
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  mainWindow.loadURL(getPillURL());

  // Dev: mirror remix tool-executor console into the main log; optional pill DevTools.
  if (is.dev) {
    // Electron has shipped this event with both positional args and a
    // details object across versions; accept either shape.
    mainWindow.webContents.on("console-message", (_event, level, message) => {
      const second = level as unknown;
      const text =
        typeof message === "string"
          ? message
          : second !== null && typeof second === "object" && "message" in second
            ? String((second as { message: unknown }).message)
            : null;
      if (text?.startsWith("[remix]")) hotkeyLog.info(text);
    });
    if (
      (process.env.OPENSTYLE_PILL_DEVTOOLS ??
        process.env.FREESTYLE_PILL_DEVTOOLS) === "1"
    ) {
      mainWindow.webContents.openDevTools({ mode: "detach" });
    }
  }
}

function createSettingsWindow(initialPath?: string): Promise<void> {
  // Serialize concurrent opens: the first call owns creation, the rest await it.
  if (settingsWindowCreating) return settingsWindowCreating;
  if (settingsWindow) return Promise.resolve();
  const creation = buildSettingsWindow(initialPath).finally(() => {
    settingsWindowCreating = null;
  });
  settingsWindowCreating = creation;
  return creation;
}

async function buildSettingsWindow(initialPath?: string): Promise<void> {
  // Resolve the initial route BEFORE creating the window. The onboarding probe
  // is an async server call; doing it first means there's no await gap between
  // assigning `settingsWindow` and using it, so a close (or a concurrent open)
  // during the probe can't null-deref or show a half-loaded window.
  const startPath = (await isOnboardingActive())
    ? "/onboarding"
    : (initialPath ?? "/today");

  settingsWindow = new BrowserWindow({
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
    },
  });

  settingsWindow.on("ready-to-show", () => {
    if (process.platform === "darwin") {
      app.dock?.show();
      app.focus({ steal: true });
    }
    settingsWindow!.show();
    settingsWindow!.focus();
  });

  settingsWindow.on("closed", () => {
    if (hotkeyRecorder) {
      stopHotkeyRecorderProcess();
      scheduleHotkeyRegistration(currentHotkeyAccel ?? undefined);
    }
    remixPracticeTarget = false;
    settingsWindow = null;
  });

  // Backstop: a full-page navigation tears the onboarding renderer down
  // without running its unmount cleanup.
  settingsWindow.webContents.on("did-navigate", () => {
    remixPracticeTarget = false;
  });

  settingsWindow.on("enter-full-screen", () => {
    settingsWindow?.webContents.send("fullscreen:changed", true);
  });

  settingsWindow.on("leave-full-screen", () => {
    settingsWindow?.webContents.send("fullscreen:changed", false);
  });

  settingsWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  settingsWindow.loadURL(getDashboardURL(startPath));
}

/**
 * Resolves once a freshly-created pill window has finished loading and is
 * visible.  `null` when no deferred show is in progress.
 */
let pillReadyPromise: Promise<void> | null = null;

function showPill(): void {
  // Already waiting for a freshly-created pill to finish loading.
  if (pillReadyPromise) return;

  remixBarWindow?.hide();

  if (!mainWindow) {
    createAppWindow();
    // createAppWindow() synchronously assigns mainWindow, but TypeScript
    // cannot track mutations through function calls.  Re-read and bail
    // out if the assignment unexpectedly failed.
    const win = mainWindow as BrowserWindow | null;
    if (!win) return;

    // The window was just created with `show: false` and is still loading.
    // Defer showing until the renderer finishes loading so IPC messages
    // (e.g. hotkey:down) sent immediately after are not lost.
    pillReadyPromise = new Promise<void>((resolve) => {
      const cleanup = (): void => {
        pillReadyPromise = null;
        resolve();
      };

      // If the window is closed before it finishes loading, resolve the
      // promise so deferred IPC calls are not stuck forever.
      win.once("closed", cleanup);

      win.webContents.once("did-finish-load", () => {
        win.removeListener("closed", cleanup);
        pillReadyPromise = null;
        if (!mainWindow) {
          resolve();
          return;
        }
        const { x, y } = resolveAppWindowPosition();
        setProgrammaticPosition(mainWindow, x, y);
        mainWindow.showInactive();
        updateRemixBar();
        updatePillEscape();
        anchorPillToFocusedDisplay();
        resolve();
      });
    });
    return;
  }

  if (!mainWindow.isVisible()) {
    const { x, y } = resolveAppWindowPosition();
    setProgrammaticPosition(mainWindow, x, y);
    mainWindow.showInactive();
    updateRemixBar();
  }
  updatePillEscape();
  anchorPillToFocusedDisplay();
}

/**
 * Re-anchor the pill to the display the user is actually typing on once we can
 * learn it from the focused window (an async native call). Shown immediately on
 * the cursor's display; this quietly corrects the monitor when the mouse rests
 * on a different one than the keyboard focus. No-op for custom (dragged)
 * positions and while the pill is expanded, so it never fights a card
 * animation or overrides a user-placed slot.
 */
function anchorPillToFocusedDisplay(): void {
  const position = (readSettings().pillPosition as string) || "bottom-center";
  if (position === "custom") return;

  void getFocusedWindowDisplay().then((focusedDisplay) => {
    if (!focusedDisplay || !mainWindow || mainWindow.isDestroyed()) return;
    if (!mainWindow.isVisible()) return;
    // Don't move the window out from under an in-progress card expansion.
    if (pillExpandOffset.dx !== 0 || pillExpandOffset.dy !== 0) return;

    const [curX, curY] = mainWindow.getPosition();
    const currentDisplay = screen.getDisplayMatching({
      x: curX,
      y: curY,
      width: APP_WIDTH,
      height: APP_HEIGHT,
    });
    if (currentDisplay.id === focusedDisplay.id) return;

    const { x, y } = resolveAppWindowPosition(focusedDisplay);
    setProgrammaticPosition(mainWindow, x, y);
  });
}

function updatePillEscape(): void {
  const chatLike = pillExpansion === "remix-chat";
  const isExpanded = pillExpandOffset.dx !== 0 || pillExpandOffset.dy !== 0;
  if (mainWindow?.isVisible() && !(chatLike && isExpanded)) {
    if (!globalShortcut.isRegistered("Escape")) {
      globalShortcut.register("Escape", () => {
        if (mainWindow?.isVisible()) {
          mainWindow.webContents.send("pill:cancel");
        }
      });
    }
  } else {
    try {
      globalShortcut.unregister("Escape");
    } catch {}
  }
}

function hidePill(): void {
  if (mainWindow?.isVisible()) {
    mainWindow.hide();
    lastPillHideAt = Date.now();
  }
  // The next session starts as a bare capsule, so give the extra room back
  // now — the renderer's own collapse only runs when it animates a card away.
  setPillExpanded(false);
  // Session ended (cancel, error, or paste complete). Clear latched hotkey
  // state so the next press starts fresh — e.g. after ESC while still
  // holding the dictation key.
  hotkeyPressed = false;
  clearHotkeyStuckWatchdog();
  remixPressed = false;
  clearRemixStuckWatchdog();
  setRemixRouteKeys(false);
  // Chat may have set focusable; clear it when hiding.
  try {
    mainWindow?.setFocusable(false);
  } catch {}
  updateRemixBar();
  // Unregister Escape shortcut when pill is hidden
  try {
    globalShortcut.unregister("Escape");
  } catch {}
}

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

function resetOnboarding(): void {
  writeSettings({ onboardingComplete: false });
  remixBarHeldForOnboarding = true;
  updateRemixBar();
  showSettingsWindow("/onboarding");
}

/**
 * Matches the route decision in buildSettingsWindow. Existing users who have
 * configured models are treated as onboarded even if the lightweight setting
 * predates onboardingComplete.
 */
async function isOnboardingActive(): Promise<boolean> {
  if (readSettings().onboardingComplete === true) return false;
  return (await getConfiguredModelCount()) === 0;
}

// Dev-only: reset every sector tone to off and cleanup intensity to medium.
async function resetToneConfiguration(): Promise<void> {
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
  if (!settingsWindow) {
    void createSettingsWindow(tonePath);
    return;
  }

  const url = getDashboardURL(tonePath);
  const current = settingsWindow.webContents.getURL();
  if (current.includes(tonePath)) {
    settingsWindow.webContents.reloadIgnoringCache();
  } else {
    void settingsWindow.loadURL(url);
  }
  if (process.platform === "darwin") {
    app.dock?.show();
    app.focus({ steal: true });
  }
  settingsWindow.show();
  settingsWindow.focus();
}

async function factoryReset(): Promise<void> {
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

    if (keyListener) {
      keyListener.stop();
      keyListener = null;
    }
    if (process.platform === "win32") {
      globalShortcut.unregisterAll();
    }

    try {
      closeDb();
    } catch {}

    if (httpServer) {
      httpServer.close();
      httpServer = null;
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

function showSettingsWindow(path?: string): void {
  if (!settingsWindow) {
    void createSettingsWindow(path);
    return;
  }
  if (path) {
    void settingsWindow.loadURL(getDashboardURL(path));
  }
  if (process.platform === "darwin") {
    app.dock?.show();
    app.focus({ steal: true });
  }
  settingsWindow.show();
  settingsWindow.focus();
}

const ACCESSIBILITY_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility";
const MICROPHONE_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Microphone";

function hasCurrentAccessibilityPermission(): boolean {
  if (process.platform !== "darwin") return true;
  const state = resolveAccessibilityPermission(
    process.platform,
    systemPreferences.isTrustedAccessibilityClient(false),
    accessibilityConfirmed,
  );
  if (accessibilityConfirmed && !state.accessibilityConfirmed) {
    hotkeyLog.warn("macOS Accessibility permission is no longer available.");
  }
  accessibilityConfirmed = state.accessibilityConfirmed;
  return state.granted;
}

function getMissingDictationPermission(): DictationPermission | null {
  const microphoneStatus = getCurrentMicrophonePermission();
  return missingDictationPermission(
    process.platform,
    hasCurrentAccessibilityPermission(),
    microphoneStatus,
  );
}

function getCurrentMicrophonePermission(): string {
  return process.platform === "darwin" || process.platform === "win32"
    ? systemPreferences.getMediaAccessStatus("microphone")
    : "unknown";
}

function openAccessibilitySettings(): void {
  if (process.platform !== "darwin") return;
  // Passing true adds Openstyle to the Accessibility list and shows the native
  // prompt; macOS still requires the user to enable the toggle themselves.
  systemPreferences.isTrustedAccessibilityClient(true);
  void shell.openExternal(ACCESSIBILITY_SETTINGS_URL);
}

function openMicrophoneSettings(): void {
  if (process.platform === "darwin") {
    void shell.openExternal(MICROPHONE_SETTINGS_URL);
  } else if (process.platform === "win32") {
    void shell.openExternal("ms-settings:privacy-microphone");
  }
}

let permissionDialogPromise: Promise<void> | null = null;

function showRequiredPermissionDialog(
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

function isRunningFromReadOnlyLocation(): boolean {
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

const READ_ONLY_UPDATE_RE = /EROFS|EACCES|read[- ]only|permission denied/i;

const RELEASES_PAGE_URL =
  "https://github.com/Maheidem/openstyle/releases/latest";

let readOnlyDialogShown = false;

function showMoveToApplicationsDialog(): void {
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

function restartAndUpdate(): void {
  if (process.platform === "darwin" && selfUpdater.isReadyToInstall) {
    // Self-update path (see self-updater.ts): quitAndInstall() would hand
    // this off to Squirrel.Mac, which rejects our ad-hoc-signed downloads.
    // Extraction/swap can take a few seconds, so isUpdaterQuitting is only
    // set right before installUpdate() actually calls app.quit() (via the
    // onBeforeQuit callback) — not here — so a manual quit mid-install still
    // goes through normal before-quit cleanup instead of being mistaken for
    // the updater's own quit.
    void selfUpdater
      .installUpdate(() => {
        isUpdaterQuitting = true;
      })
      .catch((err) => {
        updateDownloadState = "idle";
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`Self-update install failed: ${msg}`);
        settingsWindow?.webContents.send("updater:error", { message: msg });
      });
    return;
  }
  // Kept for non-macOS platforms / future signed macOS builds, where
  // Squirrel's own install flow works.
  isUpdaterQuitting = true;
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
  // never starts a download. Always run a fresh check.
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
  return updateDownloadState === "downloaded"
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

function buildTrayContextMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: "Settings",
      click: () => showSettingsWindow("/settings"),
    },
    {
      label: "Help",
      click: () => showSettingsWindow("/help"),
    },
    buildUpdateMenuItem(),
    // Meeting Mode: feature-flagged ("meetings") and darwin >= 14.4 only.
    ...(meetingsFlagEnabled &&
    isSystemAudioCaptureSupported() &&
    meetingRecorder
      ? [
          { type: "separator" as const },
          meetingRecorder.status === "idle"
            ? {
                label: "Start meeting recording",
                click: (): void => {
                  void meetingRecorder?.start().catch((err) => {
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
                enabled: meetingRecorder.status === "recording",
                click: (): void => {
                  void meetingRecorder?.stop();
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

function createTray(): void {
  const trayImage = nativeImage.createFromPath(trayIconPath);
  // Mark as template so macOS adapts to menu bar light/dark
  trayImage.setTemplateImage(true);

  tray = new Tray(trayImage);
  tray.setToolTip("Openstyle");

  if (process.platform === "linux") {
    // Linux desktop panels often don't fire the right-click event, so
    // assign the menu natively so the OS can register it via DBusMenu.
    tray.setContextMenu(buildTrayContextMenu());
  } else {
    // macOS/Windows: left-click opens settings, right-click shows menu.
    // Using setContextMenu on macOS would override the click handler.
    tray.on("right-click", () => {
      // Opportunistic background refresh — the menu template is synchronous,
      // so a flag flip shows up on the next open.
      refreshMeetingsFlag();
      tray!.popUpContextMenu(buildTrayContextMenu());
    });
  }

  tray.on("click", () => {
    showSettingsWindow();
  });
}

// Rebuild the application menu so update-related labels stay current.
function rebuildMenus(): void {
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
    tray?.setContextMenu(buildTrayContextMenu());
  }
}

// Prevent multiple instances.  If another instance already holds the lock,
// quit immediately and let the primary instance handle activation.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

app.on("second-instance", () => {
  if (settingsWindow) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
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
    await audioPlaybackController.prepare(mode);
  });

  ipcMain.handle("audio:restore", async () => {
    await audioPlaybackController.restore();
  });

  // Settings → Data: aggregate disk usage (UX-08) — async walk in the main
  // process, so the settings window never touches the filesystem.
  registerDiskUsageIpc();

  // --- Import screen ---------------------------------------------------------
  registerJobAbortIpc();
  registerImportIpc({
    serverFetch,
    getParentWindow: () => mainWindow,
    onTranscribed: ({ fileName }) => notifyImportComplete(fileName),
  });

  // Meeting import (specs/meeting-import.md §4.4): same picker/upload shape
  // as the dictation Import screen, but the upload lands in
  // POST /api/meetings/import as a full meeting record.
  registerMeetingImportIpc({
    serverFetch,
    getParentWindow: () => mainWindow,
  });

  // --- Meeting Mode ---------------------------------------------------------
  meetingRecorder = new MeetingRecorder({
    serverFetch,
    createCaptureWindow: createMeetingCaptureWindow,
    broadcastLevel: (event) => {
      broadcastToWindows("meeting:level", event);
    },
    broadcastStatus: (status) => {
      broadcastToWindows("meeting:status-changed", status);
      // Linux keeps a static tray menu; elsewhere it rebuilds on right-click.
      if (process.platform === "linux") {
        tray?.setContextMenu(buildTrayContextMenu());
      }
    },
  });

  registerMeetingIpc({
    getMeetingRecorder: () => meetingRecorder,
    serverClient,
  });

  // IPC: broadcast output mode changes to pill window
  ipcMain.on("settings:output-mode-changed", (_event, mode: string) => {
    mainWindow?.webContents.send("settings:output-mode-changed", mode);
  });

  // IPC: broadcast the sound setting to the pill window
  ipcMain.on("settings:sound-enabled-changed", (_event, enabled: unknown) => {
    mainWindow?.webContents.send(
      "settings:sound-enabled-changed",
      enabled === true,
    );
  });

  ipcMain.on("settings:pill-cancel-mode-changed", (_event, mode: unknown) => {
    mainWindow?.webContents.send(
      "settings:pill-cancel-mode-changed",
      normalizePillCancelMode(mode),
    );
  });

  ipcMain.on("settings:audio-playback-mode-changed", (_event, mode: string) => {
    mainWindow?.webContents.send("settings:audio-playback-mode-changed", mode);
  });

  // IPC: relay cleanup-context changes (llm_cleanup / cleanup tones) from the
  // dashboard to the pill so it refreshes its cached routing decision instead
  // of re-fetching /api/settings on every recording start.
  ipcMain.on("settings:cleanup-context-changed", () => {
    mainWindow?.webContents.send("settings:cleanup-context-changed");
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
    settingsWindow?.webContents.send("audio:level", level);
  });

  // IPC: pill notifies that a transcription has finished + been pasted, so
  // history-driven views (Today, History) can refetch without polling.
  ipcMain.on("transcription:done", () => {
    settingsWindow?.webContents.send("transcription:done");
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
      remixPracticeTarget = false;
      remixBarHeldForOnboarding = false;
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
    if (remixKeyListener) {
      remixKeyListener.stop();
      remixKeyListener = null;
      remixPressed = false;
    }
    // Pause the active hotkey listener so it doesn't fire during recording
    if (keyListener) {
      keyListener.stop();
      keyListener = null;
    }
    globalShortcut.unregisterAll();

    stopHotkeyRecorderProcess();
    const target =
      settingsWindow?.webContents ?? mainWindow?.webContents ?? null;
    if (!target) return;

    hotkeyRecorder = new HotkeyRecorder({
      onCancel: () => {
        stopHotkeyRecorderProcess();
        scheduleHotkeyRegistration(currentHotkeyAccel ?? undefined);
      },
      onError: (message) => {
        hotkeyRecorderLog.warn(message);
      },
    });
    hotkeyRecorder.start(target);
  });

  ipcMain.on("hotkey-record:stop", (_event, hotkey?: string) => {
    stopHotkeyRecorderProcess();
    scheduleHotkeyRegistration(
      typeof hotkey === "string" && hotkey.length > 0
        ? hotkey
        : (currentHotkeyAccel ?? undefined),
    );
  });

  // Set database path for the server before any API calls. Server code reads
  // the OPENSTYLE_ name first and falls back to the old FREESTYLE_ name, so
  // only the OPENSTYLE_ name is set here.
  const dbPath = join(app.getPath("userData"), "freestyle.db");
  process.env.OPENSTYLE_DB_PATH = dbPath;

  if (!is.dev) {
    process.env.OPENSTYLE_MLX_ASR_RELEASE_TAG ||= app.getVersion();
  }

  // Run non-critical server startup tasks now that the DB path is set. This is
  // deferred off the boot critical path: reconcileUnsupportedMlxVoiceDefault can
  // synchronously probe Python/MLX (execFileSync) on Apple Silicon without a
  // managed runtime, which would otherwise block window creation. It is
  // idempotent and also runs lazily via getDefaultModels() on first use, so
  // deferring it by a tick is safe. Local ASR servers (whisper/mlx) are no
  // longer pre-warmed at boot — they warm on recording start via the
  // /api/transcribe/pre-warm endpoint, and start lazily at submission as a
  // fallback.
  setImmediate(() => {
    reconcileUnsupportedMlxVoiceDefault();
  });

  // Start the Hono HTTP server with WebSocket support (or reuse an existing one)
  const startServer = (port: number): void => {
    startOpenstyleServer({ port, host: "127.0.0.1" })
      .then(({ server, port: boundPort }) => {
        httpServer = server;
        setServerPort(boundPort);
        log.info(`Server running on http://localhost:${boundPort}`);
      })
      .catch((err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && port === DEFAULT_SERVER_PORT) {
          log.warn(
            `Port ${DEFAULT_SERVER_PORT} in use, falling back to random port`,
          );
          startServer(0);
        } else {
          log.error(`Server failed to start: ${err}`);
        }
      });
  };

  // Check if a Openstyle server is already running on the default port. The
  // 1.5s bound matters: a normal cold start fast-fails with ECONNREFUSED, but
  // without a timeout a half-open socket on the port could hang window/tray
  // creation indefinitely.
  const existingServer = await probeServerHealth(
    `http://127.0.0.1:${DEFAULT_SERVER_PORT}`,
    1500,
  );

  if (existingServer) {
    setServerPort(DEFAULT_SERVER_PORT);
    log.info(
      `Reusing existing Openstyle server on http://localhost:${DEFAULT_SERVER_PORT}`,
    );
  } else {
    startServer(DEFAULT_SERVER_PORT);
  }

  if (!is.dev) {
    void activateManagedMlxRuntimeForAppVersion(app.getVersion()).catch(
      (err) => {
        log.warn(
          `Failed to activate MLX runtime for app ${app.getVersion()}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      },
    );
  }

  createTray();

  createAppWindow();

  // Meeting Mode boot tasks, deferred until the in-process server is up:
  // cache the feature flag for the tray and sweep meetings a crash left in
  // 'recording' (finalize WAV headers, mark 'interrupted') or 'transcribing'
  // (job died with the process — mark 'failed', partial transcript kept).
  setTimeout(() => {
    refreshMeetingsFlag();
    void meetingRecorder?.sweepOrphans();
  }, 3000);

  // Onboarding already has dedicated permission cards. Existing users instead
  // get one actionable warning once a user-facing window can be shown.
  void isOnboardingActive().then((onboardingActive) => {
    remixBarHeldForOnboarding = onboardingActive;
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
    if (!mainWindow) return;
    const before = readSettings().pillPosition as string;
    const { x, y } = resolveAppWindowPosition();
    setProgrammaticPosition(mainWindow, x, y);
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

  // -- Auto-update helpers --
  const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  let updateCheckTimer: ReturnType<typeof setInterval> | null = null;

  // autoDownload is always false, so checkForUpdates() only checks the feed
  // and never starts a download. The selfUpdater "downloaded" handler shows
  // the completion notification.
  function runUpdateCheck(): void {
    autoUpdater.checkForUpdates().catch((err) => {
      log.warn(
        `Update check failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  function startUpdateCheckInterval(): void {
    if (updateCheckTimer) return;
    updateCheckTimer = setInterval(runUpdateCheck, UPDATE_CHECK_INTERVAL_MS);
  }

  // -- Auto-updater with IPC notifications --
  // Track versions we already notified about so periodic checks don't spam.
  // Separate flags for "available" vs "downloaded" because both events fire
  // for the same version and each deserves one notification.
  let notifiedAvailableVersion: string | null = null;
  let notifiedDownloadedVersion: string | null = null;

  if (!is.dev) {
    const autoUpdateEnabled = readSettings().autoUpdate !== false;
    // Every build is ad-hoc signed (no paid Apple Developer identity yet).
    // Squirrel.Mac deterministically rejects ad-hoc-signed updates AFTER
    // downloading them ("Code signature ... did not pass validation"), so we
    // still use electron-updater only to *check* the release feed. On
    // macOS, downloading and installing goes through selfUpdater (see
    // self-updater.ts) instead of Squirrel.Mac; other platforms open the
    // releases page. autoDownload is always false, so electron-updater never
    // itself downloads the (Squirrel-incompatible) update artifact.
    autoUpdater.autoDownload = false;
    // Honour the same preference on quit. Upstream hardcoded this to true, so a
    // single manual "Check for Updates" could stage a release that then
    // installed itself on the next quit even with auto-update turned off.
    autoUpdater.autoInstallOnAppQuit = autoUpdateEnabled;
    autoUpdater.logger = createAppLogger("updater");

    autoUpdater.on("update-available", (info) => {
      settingsWindow?.webContents.send("updater:available", {
        version: info.version,
      });
      // electron-updater never auto-downloads (autoDownload is always false
      // — see above); the in-app banner/notification drives the actual
      // download via updater:download.
      if (notifiedAvailableVersion !== info.version) {
        notifiedAvailableVersion = info.version;
        notify(
          "Openstyle Update Available",
          `Version ${info.version} is available.`,
          "/settings",
        );
      }
    });

    selfUpdater.on("progress", (p) => {
      settingsWindow?.webContents.send("updater:downloading", p);
    });

    selfUpdater.on("downloaded", (info) => {
      updateDownloadState = "downloaded";
      settingsWindow?.webContents.send("updater:downloaded", {
        version: info.version,
      });
      if (notifiedDownloadedVersion !== info.version) {
        notifiedDownloadedVersion = info.version;
        notify(
          "Update Ready to Install",
          `Version ${info.version} has been downloaded. Restart to update.`,
          "/settings",
        );
      }
      if (updateCheckTimer) {
        clearInterval(updateCheckTimer);
        updateCheckTimer = null;
      }
      rebuildMenus();
      void prefetchManagedMlxRuntimeForAppRelease(info.version).catch((err) => {
        log.warn(
          `Failed to stage MLX runtime for ${info.version}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    });

    autoUpdater.on("error", (err) => {
      if (updateDownloadState === "downloading") {
        updateDownloadState = "idle";
      }
      const msg = err?.message ?? "Update failed";
      if (READ_ONLY_UPDATE_RE.test(msg) && isRunningFromReadOnlyLocation()) {
        showMoveToApplicationsDialog();
        settingsWindow?.webContents.send("updater:error", {
          message:
            "Openstyle is running from a read-only location. Move it to Applications and relaunch.",
        });
      } else {
        settingsWindow?.webContents.send("updater:error", { message: msg });
      }
    });

    if (isRunningFromReadOnlyLocation()) {
      notify(
        "Move Openstyle to Applications",
        "Openstyle can\u2019t update from this location. Move it to your Applications folder and relaunch.",
        "/settings",
      );
    } else if (autoUpdateEnabled) {
      // Only poll when auto-update is actually on. Upstream polled every 5
      // minutes regardless of the setting, so turning auto-update off still
      // talked to the release feed and still raised update notifications.
      runUpdateCheck();
      startUpdateCheckInterval();
    }
  }

  ipcMain.on("updater:download", () => {
    // Every build is ad-hoc signed, so Squirrel.Mac would reject a download
    // done through electron-updater's own downloadUpdate() (see the
    // autoDownload=false comment above). On a packaged macOS build we
    // instead download + verify the release zip ourselves via selfUpdater
    // (self-updater.ts) and skip Squirrel entirely. Everywhere else (dev
    // builds, other platforms, or if self-update can't run here) we fall
    // back to sending the user to the releases page.
    const reason = selfUpdater.unavailableReason();
    if (reason) {
      log.warn(`Self-update unavailable (${reason}); opening releases page`);
      void shell.openExternal(RELEASES_PAGE_URL);
      return;
    }
    updateDownloadState = "downloading";
    settingsWindow?.webContents.send("updater:downloading", {
      percent: 0,
      transferred: 0,
      total: 0,
    });
    selfUpdater.downloadUpdate().catch((err) => {
      updateDownloadState = "idle";
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(
        `Self-update download failed, falling back to releases page: ${msg}`,
      );
      settingsWindow?.webContents.send("updater:error", { message: msg });
      void shell.openExternal(RELEASES_PAGE_URL);
    });
  });

  ipcMain.on("updater:install", () => {
    restartAndUpdate();
  });

  ipcMain.handle("updater:check", async () => {
    if (is.dev) return null;
    try {
      const result = await autoUpdater.checkForUpdates();
      const latest = result?.updateInfo?.version;
      if (!latest) return null;
      // Only report an update when the remote version is actually newer
      if (latest === app.getVersion()) return null;
      return { version: latest, downloadState: updateDownloadState };
    } catch {
      return null;
    }
  });

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
    if (mainWindow) {
      const { x, y } = resolveAppWindowPosition();
      setProgrammaticPosition(mainWindow, x, y);
    }
    // For custom, resolve the live alignment; for presets, send as-is.
    const broadcast =
      position === "custom" ? getPillAlignmentForCustom() : position;
    broadcastToWindows("settings:pill-position-changed", broadcast);
  });

  // Register the hold-to-record hotkey immediately with the default accelerator
  // so a press right after launch is never dropped. Pass DEFAULT_HOTKEY
  // explicitly so this doesn't fire a settings request at the not-yet-ready
  // server. Once the server answers, re-register with the configured
  // accelerator + activation mode (only if they differ, to avoid a needless
  // native-listener rebuild).
  scheduleHotkeyRegistration(DEFAULT_HOTKEY);
  void waitForServerReady().then(async () => {
    // One request for both keys, instead of a read per key. Skip if the server
    // never answered — the default registered above stands.
    const settings = await getServerSettings();
    if (!settings) return;
    hotkeyActivationMode = hotkeyModeFromSettings(settings);
    const configured = hotkeyFromSettings(settings);
    const accel = configured
      ? normalizeAccelerator(configured)
      : DEFAULT_HOTKEY;
    if (accel !== currentHotkeyAccel) scheduleHotkeyRegistration(configured);
    // Wait for server settings — don't spawn a listener just to tear it down.
    applyRemixSettings(settings);
    applyLanguageHotkeySettings(settings);
  });

  ipcMain.on("hotkey:set-mode", (_event, mode: string) => {
    hotkeyActivationMode = mode === "toggle" ? "toggle" : "hold";
    hotkeyPressed = false;
    clearHotkeyStuckWatchdog();
    scheduleHotkeyRegistration(currentHotkeyAccel ?? undefined);
  });

  // Remix: the settings UI writes the setting, then tells us to re-read it.
  ipcMain.on("remix-hotkey:reload", () => {
    void getServerSettings().then((settings) => {
      if (!settings) return;
      applyRemixSettings(settings);
    });
  });

  // Language hotkeys: the settings UI pushes the whole map directly (no
  // reload round-trip needed — it already has the value it just persisted).
  ipcMain.on(
    "language-hotkeys:update",
    (_event, map: Record<string, string>) => {
      scheduleLanguageHotkeysRegistration(map);
    },
  );

  // Paste over selection — not deliverOutput (no trailing space).
  ipcMain.handle("remix:paste", async (_event, text: string) => {
    if (typeof text !== "string" || !text.trim()) return false;
    if (await isSecureInputActive()) {
      notifyPasteFailed();
      hotkeyLog.warn("Remix paste refused: secure input is active.");
      return false;
    }
    try {
      await pasteIntoFocusedApp(
        text,
        async () => {
          hidePill();
          await wait(0);
        },
        { trailingSpace: false },
      );
      return true;
    } catch (err) {
      notifyPasteFailed();
      hotkeyLog.error(`Remix paste failed: ${err}`);
      return false;
    }
  });

  // Remix primitives — focus the document before injecting keystrokes.

  ipcMain.handle("remix:get-context", async () => {
    if (await isSecureInputActive()) {
      return { ok: false, reason: "secure-input" };
    }
    const pill = mainWindow;
    if (pill && !pill.isDestroyed() && pill.isFocused()) {
      pill.blur();
      await wait(140);
    }
    const front = await getFrontmostContext();
    const ours = getOpenstyleAppExclusions();
    if (!isRemixTargetAllowed(front.appName, ours, remixPracticeTarget)) {
      return { ok: false, reason: "document-not-in-front" };
    }
    remixAnchor = { ...front, capturedAt: Date.now() };
    const [selection, caps] = await Promise.all([
      copySelectionFromFocusedApp().catch(() => null),
      runMacAxCaps(),
    ]);
    hotkeyLog.info(
      `remix get-context: "${front.appName}"${selection ? ` · ${selection.length} chars selected` : " · no selection"} · precise=${caps?.settable ?? false}`,
    );
    const preview = clipboardPreviewFields();
    return {
      ok: true,
      appName: front.appName,
      windowTitle: front.windowTitle,
      url: front.url,
      selection,
      preciseSelection: caps?.settable ?? false,
      docLength: caps && caps.length >= 0 ? caps.length : null,
      clipboardPreview: preview.clipboard,
      clipboardLength: preview.clipboardLength,
    };
  });

  // AX read keeps the highlight; canvas editors return unsupported.
  ipcMain.handle("remix:read-document", async () => {
    return withFocusedAnchor(async () => {
      const ax = await runMacAxRead();
      if (!ax?.text) return { ok: false, reason: "unsupported" };
      hotkeyLog.info(
        `remix read-document: ${ax.text.length} chars via accessibility`,
      );
      return {
        ok: true,
        text: ax.text.slice(0, 60_000),
        truncated: ax.text.length > 60_000,
        selStart: ax.selStart,
        selLen: ax.selLen,
      };
    });
  });

  ipcMain.handle("remix:select-all", async () => {
    return withFocusedAnchor(async () => {
      if (!(await sendSelectAllToFocusedApp())) {
        return { ok: false, reason: "inject-failed" };
      }
      return { ok: true };
    });
  });

  ipcMain.handle("remix:collapse-selection", async () => {
    return withFocusedAnchor(async () => {
      if (
        !(await runMacAxKey(124)) &&
        !(await runKeystrokeScript(["key code 124"]))
      ) {
        return { ok: false, reason: "inject-failed" };
      }
      return { ok: true };
    });
  });

  ipcMain.handle("remix:copy", async () => {
    return withFocusedAnchor(async () => {
      // Whole-document copy after select_all can be slow in rich editors.
      const text = await copySelectionFromFocusedApp({
        timeoutsMs: [600, 2_000],
      }).catch(() => null);
      if (text === null) return { ok: false, reason: "nothing-copied" };
      return {
        ok: true,
        text: text.slice(0, 60_000),
        truncated: text.length > 60_000,
      };
    });
  });

  ipcMain.handle("remix:set-clipboard", (_event, text: unknown) => {
    if (
      typeof text !== "string" ||
      !text ||
      text.length > REMIX_CLIPBOARD_LIMIT
    ) {
      return { ok: false, reason: "bad-text" };
    }
    clipboard.writeText(text);
    hotkeyLog.info(`remix set-clipboard: ${text.length} chars`);
    return { ok: true };
  });

  ipcMain.handle("remix:set-clipboard-image", async (_event, url: unknown) => {
    if (typeof url !== "string" || !url)
      return { ok: false, reason: "bad-url" };
    const image = await fetchRemixImage(url);
    if (!image) return { ok: false, reason: "fetch-failed" };
    clipboard.writeImage(image);
    return { ok: true };
  });

  ipcMain.handle("remix:paste-clipboard", async () => {
    return withFocusedAnchor(async () => {
      // Log length only — distinguishes empty clipboard from inject failure.
      hotkeyLog.info(
        `remix paste: injecting (clipboard: ${clipboard.readText().length} chars)`,
      );
      try {
        await pasteClipboardIntoFocusedApp();
        if (remixPracticeTarget) {
          settingsWindow?.webContents.send("remix:practice-delivered");
        }
        return { ok: true };
      } catch (err) {
        hotkeyLog.error(`Remix paste failed: ${err}`);
        return { ok: false, reason: "paste-failed" };
      }
    });
  });

  ipcMain.handle(
    "remix:select-text",
    async (_event, text: unknown, occurrence: unknown) => {
      if (typeof text !== "string" || !text.trim() || text.length > 20_000) {
        return { ok: false, reason: "failed" };
      }
      const wanted =
        typeof occurrence === "number" &&
        Number.isInteger(occurrence) &&
        occurrence >= 1
          ? occurrence
          : null;
      return withFocusedAnchor(async () => {
        const ax = await runMacAxRead();
        if (!ax?.text || !ax.settable) {
          return { ok: false, reason: "unsupported" };
        }
        // Ambiguous matches error unless occurrence is named — wrong twin corrupts text.
        const positions: number[] = [];
        for (
          let at = ax.text.indexOf(text);
          at >= 0 && positions.length <= 50;
          at = ax.text.indexOf(text, at + 1)
        ) {
          positions.push(at);
        }
        if (positions.length === 0) return { ok: false, reason: "not-found" };
        if (wanted === null && positions.length > 1) {
          return { ok: false, reason: "ambiguous", matches: positions.length };
        }
        const index = positions[(wanted ?? 1) - 1];
        if (index === undefined) {
          return { ok: false, reason: "not-found", matches: positions.length };
        }
        if (!(await runMacAxSelect(index, text.length))) {
          return { ok: false, reason: "failed" };
        }
        if (remixAnchor) remixAnchor.capturedAt = Date.now();
        return { ok: true };
      });
    },
  );

  // Undo/redo via native chord binary (non-QWERTY-safe); osascript fallback.
  ipcMain.handle("remix:undo", async () => {
    return withFocusedAnchor(async () => {
      if (!(await sendChordToFocusedApp("z", false))) {
        return { ok: false, reason: "inject-failed" };
      }
      return { ok: true };
    });
  });

  ipcMain.handle("remix:redo", async () => {
    return withFocusedAnchor(async () => {
      if (!(await sendChordToFocusedApp("z", true))) {
        return { ok: false, reason: "inject-failed" };
      }
      return { ok: true };
    });
  });

  ipcMain.handle(
    "remix:press-key",
    async (_event, key: unknown, times: unknown) => {
      const code =
        typeof key === "string" ? REMIX_PRESSABLE_KEYS[key] : undefined;
      if (code === undefined) return { ok: false, reason: "bad-key" };
      const count =
        typeof times === "number" && Number.isInteger(times)
          ? Math.min(Math.max(times, 1), 50)
          : 1;
      return withFocusedAnchor(async () => {
        for (let i = 0; i < count; i++) {
          if (
            !(await runMacAxKey(code)) &&
            !(await runKeystrokeScript([`key code ${code}`]))
          ) {
            return { ok: false, reason: "inject-failed", pressed: i };
          }
          if (count > 1) await wait(25);
        }
        return { ok: true };
      });
    },
  );

  ipcMain.handle("remix:get-clipboard", () => {
    const text = clipboard.readText();
    return {
      ok: true,
      text: text.slice(0, 60_000),
      truncated: text.length > 60_000,
    };
  });

  // Preset chips: replace selection, preserve clipboard.
  ipcMain.handle("remix:paste-text", async (_event, text: unknown) => {
    if (typeof text !== "string" || !text.trim()) {
      return { ok: false, reason: "bad-text" };
    }
    return withFocusedAnchor(async () => {
      try {
        await pasteIntoFocusedApp(text, undefined, { trailingSpace: false });
        if (remixPracticeTarget) {
          settingsWindow?.webContents.send("remix:practice-delivered");
        }
        return { ok: true };
      } catch (err) {
        hotkeyLog.error(`Remix paste-text failed: ${err}`);
        return { ok: false, reason: "paste-failed" };
      }
    });
  });

  // Re-read selection for typed follow-ups (document may have changed).
  ipcMain.handle("remix:recapture", async () => {
    // Pill may be key window while typing — yield before Copy or we read our own input.
    const pill = mainWindow;
    if (pill && !pill.isDestroyed() && pill.isFocused()) {
      pill.blur();
      await wait(140);
    }
    const front = await getFrontmostContext();
    const ours = getOpenstyleAppExclusions();
    const inDocument = isRemixTargetAllowed(
      front.appName,
      ours,
      remixPracticeTarget,
    );
    if (inDocument) {
      remixAnchor = { ...front, capturedAt: Date.now() };
      const selection = (await isSecureInputActive())
        ? null
        : await copySelectionFromFocusedApp().catch(() => null);
      hotkeyLog.info(
        `remix recapture: ${selection ? `${selection.length} chars` : "no selection"} in "${front.appName}"`,
      );
      return {
        selection,
        ...clipboardPreviewFields(),
        ...remixAnchor,
        stale: false,
      };
    }
    hotkeyLog.info("remix recapture: document not in front; keeping anchor");
    return {
      selection: null,
      appName: remixAnchor?.appName ?? null,
      windowTitle: remixAnchor?.windowTitle ?? null,
      url: remixAnchor?.url ?? null,
      ...clipboardPreviewFields(),
      capturedAt: remixAnchor?.capturedAt ?? Date.now(),
      stale: true,
    };
  });

  // Onboarding practice: allow targeting Openstyle's own window.
  ipcMain.on("remix:set-practice-target", (event, active: unknown) => {
    if (event.sender !== settingsWindow?.webContents) return;
    remixPracticeTarget = active === true;
    hotkeyLog.info(`remix practice target: ${remixPracticeTarget}`);
  });

  if ((process.env.OPENSTYLE_E2E ?? process.env.FREESTYLE_E2E) === "1") {
    ipcMain.handle("e2e:remix-practice-target", () => remixPracticeTarget);
  }

  // Chat card releases digit routes while open.
  ipcMain.on("remix:set-route-keys", (_event, open: unknown) => {
    setRemixRouteKeys(open === true);
  });

  // The persistent bar was hovered: open the Remix chat where the user is.
  ipcMain.on("remix:bar-hover", () => {
    handleRemixBarOpen();
  });

  // Exception to focusable:false — allow focus only while the chat card is up.
  ipcMain.on("remix:set-chat-focus", (_event, focus: unknown) => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    if (focus === true) {
      if (!win.isFocusable()) win.setFocusable(true);
    } else {
      if (win.isFocused()) win.blur();
      if (win.isFocusable()) win.setFocusable(false);
    }
  });
});

/** Clipboard preview after selection capture restores what Copy borrowed. */
function clipboardPreviewFields(): {
  clipboard: string | null;
  clipboardLength: number;
} {
  const text = clipboard.readText();
  return {
    clipboard: text ? text.slice(0, REMIX_CLIPBOARD_PREVIEW_LIMIT) : null,
    clipboardLength: text.length,
  };
}

let remixAnchor: {
  appName: string | null;
  windowTitle: string | null;
  url: string | null;
  capturedAt: number;
} | null = null;

const REMIX_ANCHOR_MAX_AGE_MS = 5 * 60 * 1000;

/** Whitelist of bare keycodes press_key may inject (no modifier chords). */
const REMIX_PRESSABLE_KEYS: Record<string, number> = {
  enter: 36,
  tab: 48,
  escape: 53,
  backspace: 51,
  delete: 117,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  home: 115,
  end: 119,
};

/** Run fn only if the document can take injected input; else report it is not in front. */
async function withFocusedAnchor<T>(
  fn: () => Promise<T>,
): Promise<T | { ok: false; reason: "document-not-in-front" }> {
  if (!(await focusAnchorForInjection())) {
    return { ok: false, reason: "document-not-in-front" };
  }
  return fn();
}

/** Yield key focus to the document before injecting; false if it can't. */
async function focusAnchorForInjection(): Promise<boolean> {
  const anchor = remixAnchor;
  if (
    !anchor?.appName ||
    Date.now() - anchor.capturedAt > REMIX_ANCHOR_MAX_AGE_MS
  ) {
    return false;
  }
  if (await isSecureInputActive()) {
    hotkeyLog.warn("Remix injection refused: secure input is active.");
    return false;
  }
  const pill = mainWindow;
  if (pill && !pill.isDestroyed() && pill.isFocused()) {
    pill.blur();
    await wait(140);
  }
  let front = await getFrontmostContext();
  const ours = getOpenstyleAppExclusions();
  // Practice mode: don't osascript-activate Openstyle (we're already there).
  if (
    front.appName &&
    !isRemixTargetAllowed(front.appName, ours, remixPracticeTarget)
  ) {
    await activateAnchorApp(anchor.appName);
    front = await getFrontmostContext();
  }
  return front.appName === anchor.appName;
}

const REMIX_IMAGE_MAX_BYTES = 15 * 1024 * 1024;
const REMIX_IMAGE_TIMEOUT_MS = 15_000;

async function fetchRemixImage(
  url: string,
): Promise<Electron.NativeImage | null> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    const res = await fetch(url, {
      signal: AbortSignal.timeout(REMIX_IMAGE_TIMEOUT_MS),
      redirect: "follow",
    });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength === 0 || buffer.byteLength > REMIX_IMAGE_MAX_BYTES) {
      return null;
    }
    const image = nativeImage.createFromBuffer(buffer);
    return image.isEmpty() ? null : image;
  } catch (err) {
    hotkeyLog.warn(`Remix image fetch failed: ${err}`);
    return null;
  }
}

// Remix bar — bottom-edge sliver; hides while the pill is up.

let remixBarWindow: BrowserWindow | null = null;
let remixBarEnabled = true;
// Held during onboarding; seeded from settings, corrected by startup probe.
let remixBarHeldForOnboarding = readSettings().onboardingComplete !== true;
let remixBarFollowTimer: NodeJS.Timeout | null = null;
/** Last display we placed on (follow timer ignores OS Y drift). */
let remixBarPlacedDisplay: number | null = null;
const REMIX_BAR_WIDTH = 120;
const REMIX_BAR_HEIGHT = 18;
const REMIX_BAR_FOLLOW_MS = 3_000;
/** Window hangs past work area so the drawn sliver meets the screen edge. */
const REMIX_BAR_EDGE_OVERHANG = 6;
/** Delay before measuring OS Dock constraint after placement. */
const REMIX_BAR_CALIBRATE_MS = 48;
const REMIX_BAR_REOPEN_COOLDOWN_MS = 700;
const REMIX_BAR_RESHOW_DELAY_MS = 400;
let lastPillHideAt = 0;
let remixBarShowTimer: NodeJS.Timeout | null = null;

/** Per-display Y offset: macOS Dock relocates the panel off the work-area edge.
 *  Measured (not hard-coded); absolute so remixBarLearn is idempotent. */
const remixBarAdjust = new Map<number, number>();

function remixBarBasePosition(): { x: number; y: number; displayId: number } {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = display.workArea;
  return {
    x: wa.x + Math.round((wa.width - REMIX_BAR_WIDTH) / 2),
    y: wa.y + wa.height - REMIX_BAR_HEIGHT + REMIX_BAR_EDGE_OVERHANG,
    displayId: display.id,
  };
}

function remixBarPosition(): { x: number; y: number; displayId: number } {
  const base = remixBarBasePosition();
  return { ...base, y: base.y + (remixBarAdjust.get(base.displayId) ?? 0) };
}

/** Learn OS Y offset from unadjusted position (absolute, idempotent). */
function remixBarLearn(): void {
  setTimeout(() => {
    const win = remixBarWindow;
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    const base = remixBarBasePosition();
    remixBarAdjust.set(base.displayId, win.getBounds().y - base.y);
  }, REMIX_BAR_CALIBRATE_MS);
}

function createRemixBarWindow(): void {
  if (remixBarWindow) return;
  const { x, y } = remixBarPosition();
  const win = new BrowserWindow({
    width: REMIX_BAR_WIDTH,
    height: REMIX_BAR_HEIGHT,
    x,
    y,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    autoHideMenuBar: true,
    focusable: false,
    ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      // Same transparent-overlay caveat as the pill window: occlusion
      // misdetection would freeze its animations.
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.on("closed", () => {
    remixBarWindow = null;
  });
  void win.loadURL(getRemixBarURL());
  remixBarWindow = win;
}

/** First show at opacity 0, learn Dock offset, then become visible. */
let remixBarCalibrating = false;

function calibrateThenShow(bar: BrowserWindow, displayId: number): void {
  if (remixBarCalibrating) {
    bar.showInactive();
    return;
  }
  remixBarCalibrating = true;
  bar.setOpacity(0);
  bar.showInactive();
  const base = remixBarBasePosition();
  setTimeout(() => {
    remixBarCalibrating = false;
    const live = remixBarWindow;
    if (!live || live.isDestroyed()) return;
    try {
      remixBarAdjust.set(displayId, live.getBounds().y - base.y);
      const next = remixBarPosition();
      live.setBounds({
        x: next.x,
        y: next.y,
        width: REMIX_BAR_WIDTH,
        height: REMIX_BAR_HEIGHT,
      });
    } finally {
      // Whatever happened above, the bar must not be left invisible.
      live.setOpacity(1);
    }
    // Re-learn after correction in case the display needs another pass.
    remixBarLearn();
  }, REMIX_BAR_CALIBRATE_MS);
}

function updateRemixBar(): void {
  const shouldShow =
    remixBarEnabled && !remixBarHeldForOnboarding && !mainWindow?.isVisible();
  if (!shouldShow) {
    if (remixBarShowTimer) {
      clearTimeout(remixBarShowTimer);
      remixBarShowTimer = null;
    }
    if (remixBarFollowTimer) {
      clearInterval(remixBarFollowTimer);
      remixBarFollowTimer = null;
    }
    remixBarWindow?.hide();
    return;
  }
  const sinceHide = Date.now() - lastPillHideAt;
  if (!remixBarWindow?.isVisible() && sinceHide < REMIX_BAR_RESHOW_DELAY_MS) {
    if (!remixBarShowTimer) {
      remixBarShowTimer = setTimeout(() => {
        remixBarShowTimer = null;
        updateRemixBar();
      }, REMIX_BAR_RESHOW_DELAY_MS - sinceHide);
    }
    return;
  }
  if (!remixBarWindow) createRemixBarWindow();
  const win = remixBarWindow;
  if (!win) return;
  const place = (): void => {
    const bar = remixBarWindow;
    if (!bar || bar.isDestroyed()) return;
    if (
      !remixBarEnabled ||
      remixBarHeldForOnboarding ||
      mainWindow?.isVisible()
    )
      return;
    const { x, y, displayId } = remixBarPosition();
    bar.setBounds({ x, y, width: REMIX_BAR_WIDTH, height: REMIX_BAR_HEIGHT });
    remixBarPlacedDisplay = displayId;

    if (bar.isVisible() || remixBarAdjust.has(displayId)) {
      if (!bar.isVisible()) bar.showInactive();
      remixBarLearn();
      return;
    }
    calibrateThenShow(bar, displayId);
  };
  if (win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", place);
  } else {
    place();
  }
  if (!remixBarFollowTimer) {
    remixBarFollowTimer = setInterval(() => {
      const bar = remixBarWindow;
      if (!bar || bar.isDestroyed() || !bar.isVisible()) return;
      // Compare display id, not Y — OS holds the window off the computed position.
      const { x, y, displayId } = remixBarPosition();
      if (displayId === remixBarPlacedDisplay) return;
      bar.setBounds({ x, y, width: REMIX_BAR_WIDTH, height: REMIX_BAR_HEIGHT });
      remixBarPlacedDisplay = displayId;
      remixBarLearn();
    }, REMIX_BAR_FOLLOW_MS);
  }
}

function handleRemixBarOpen(): void {
  if (!remixBarEnabled) return;
  if (mainWindow?.isVisible()) return;
  if (Date.now() - lastPillHideAt < REMIX_BAR_REOPEN_COOLDOWN_MS) return;
  remixSelectionRequested = false;
  captureRemixSelection();
  showPill();
  sendToPill("remix:open-chat");
  updateRemixBar();
}

function applyRemixSettings(settings: Record<string, string>): void {
  // Absent means on.
  remixBarEnabled = settings[SETTINGS_KEYS.remixBarEnabled] !== "false";
  remixInitialized = true;
  updateRemixBar();
  const configured = settings[SETTINGS_KEYS.remixHotkey];
  scheduleRemixHotkeyRegistration(
    configured && isValidAccelerator(configured) ? configured : undefined,
  );
}

const DEFAULT_HOTKEY = getDefaultHotkey();
const DEFAULT_REMIX_HOTKEY = getDefaultRemixHotkey();
/** The configured hotkey accelerator from a settings map, if valid. */
function hotkeyFromSettings(
  settings: Record<string, string>,
): string | undefined {
  const value = settings[SETTINGS_KEYS.hotkey];
  return value && isValidAccelerator(value) ? value : undefined;
}

/** The hotkey activation mode from a settings map (defaults to "hold"). */
function hotkeyModeFromSettings(
  settings: Record<string, string>,
): "hold" | "toggle" {
  return settings[SETTINGS_KEYS.hotkeyMode] === "toggle" ? "toggle" : "hold";
}

function sendHotkeyDown(language?: string | null): void {
  const missingPermission = getMissingDictationPermission();
  if (missingPermission) {
    hotkeyPressed = false;
    activeDictationLanguage = null;
    clearHotkeyStuckWatchdog();
    void showRequiredPermissionDialog(missingPermission);
    return;
  }
  showPill();
  const payload = language ? { language } : undefined;
  if (pillReadyPromise) {
    // The pill window is still loading — defer IPC until it can receive it.
    void pillReadyPromise.then(() => {
      broadcastToWindows("hotkey:down", payload);
    });
    return;
  }
  broadcastToWindows("hotkey:down", payload);
}

function sendHotkeyUp(): void {
  if (pillReadyPromise) {
    // Preserve IPC ordering: hotkey:up must arrive after hotkey:down.
    void pillReadyPromise.then(() => {
      broadcastToWindows("hotkey:up");
    });
    return;
  }
  broadcastToWindows("hotkey:up");
}

/** Send to the pill, deferring until it exists so bursty IPC stays ordered. */
function sendToPill(channel: string, payload?: unknown): void {
  if (pillReadyPromise) {
    void pillReadyPromise.then(() => {
      mainWindow?.webContents.send(channel, payload);
    });
    return;
  }
  mainWindow?.webContents.send(channel, payload);
}

/** False if the remix chord includes C — injected Cmd/Ctrl+C collides with the held key. */
function canCopySelectionWhileHeld(): boolean {
  const parts = currentRemixAccel?.split("+") ?? [];
  return !parts.some((part) => part.trim().toLowerCase() === "c");
}

let remixSelectionRequested = false;

function captureRemixSelection(): void {
  if (remixSelectionRequested) return;
  remixSelectionRequested = true;

  void Promise.allSettled([
    isSecureInputActive().then((secure) =>
      secure
        ? Promise.reject(new Error("secure-input"))
        : copySelectionFromFocusedApp(),
    ),
    getFrontmostContext(),
  ]).then(([sel, front]) => {
    const context =
      front.status === "fulfilled"
        ? front.value
        : { appName: null, windowTitle: null, url: null };
    remixAnchor = { ...context, capturedAt: Date.now() };
    if (sel.status === "rejected") {
      hotkeyLog.warn(`Selection capture failed: ${sel.reason}`);
    }
    sendToPill("remix:selection", {
      text: sel.status === "fulfilled" ? sel.value : null,
      ...clipboardPreviewFields(),
      ...remixAnchor,
    });
  });
}

/** The remix hotkey went down: put the pill up straight away. */
function handleRemixHotkeyDown(): void {
  if (remixPressed) return;
  remixPressed = true;

  // Fn+Control shares Fn with dictation; a slow press starts a rogue recording.
  // Cancel on the remix channel — ordinary cancel would hide the pill we need.
  if (hotkeyPressed) {
    hotkeyPressed = false;
    clearHotkeyStuckWatchdog();
    sendToPill("remix:supersede");
  }

  setRemixRouteKeys(true);
  armRemixStuckWatchdog();
  remixSelectionRequested = false;
  showPill();
  sendToPill("remix:down");
  // Mirror to dashboard (onboarding keycaps / Remix demo).
  settingsWindow?.webContents.send("remix:down");

  // Read selection on press so empty highlight is known before voice starts.
  if (canCopySelectionWhileHeld()) captureRemixSelection();
}

function handleRemixHotkeyUp(): void {
  if (!remixPressed) return;
  remixPressed = false;
  clearRemixStuckWatchdog();
  sendToPill("remix:up");
  settingsWindow?.webContents.send("remix:up");
  captureRemixSelection();
}

let remixStuckTimer: NodeJS.Timeout | null = null;

function clearRemixStuckWatchdog(): void {
  if (remixStuckTimer) {
    clearTimeout(remixStuckTimer);
    remixStuckTimer = null;
  }
}

function armRemixStuckWatchdog(): void {
  clearRemixStuckWatchdog();
  remixStuckTimer = setTimeout(() => {
    remixStuckTimer = null;
    if (!remixPressed) return;
    hotkeyLog.warn(
      "Remix hotkey saw no key-up for 5 minutes; forcing release.",
    );
    handleRemixHotkeyUp();
  }, HOTKEY_STUCK_TIMEOUT_MS);
}

/** Remix chord + digit routes; claimed while the card is up. Spell modifiers
 *  (Control is physically down); Fn isn't expressible as an accelerator. */
const REMIX_ROUTE_MODIFIER =
  process.platform === "darwin" ? "Control" : "Control+Alt";
const REMIX_ROUTE_DIGITS = ["1", "2", "3"];
let remixRouteKeysHeld = false;

function setRemixRouteKeys(open: boolean): void {
  if (open === remixRouteKeysHeld) return;
  remixRouteKeysHeld = open;

  for (const [index, digit] of REMIX_ROUTE_DIGITS.entries()) {
    const accel = `${REMIX_ROUTE_MODIFIER}+${digit}`;
    if (!open) {
      try {
        globalShortcut.unregister(accel);
      } catch {}
      continue;
    }
    try {
      const claimed = globalShortcut.register(accel, () => {
        if (mainWindow?.isVisible()) {
          mainWindow.webContents.send("remix:route", index);
        }
      });
      // Log when the OS already owns the chord.
      if (!claimed) {
        hotkeyLog.warn(`Route shortcut "${accel}" is already taken.`);
      }
    } catch (err) {
      hotkeyLog.warn(`Could not claim "${accel}" for a remix route: ${err}`);
    }
  }
}

function scheduleRemixHotkeyRegistration(hotkey?: string): void {
  void registerRemixHotkey(hotkey).catch((err) => {
    hotkeyLog.error(
      `Remix hotkey registration failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

/** Start the remix native listener. No globalShortcut fallback (needs hold/tap). */
async function registerRemixHotkey(hotkey?: string): Promise<void> {
  if (remixKeyListener) {
    remixKeyListener.stop();
    remixKeyListener = null;
  }
  remixPressed = false;

  remixHotkeyPreference = hotkey ?? remixHotkeyPreference;
  const configured = hotkey ?? remixHotkeyPreference;
  const normalized =
    configured && isValidAccelerator(configured)
      ? normalizeAccelerator(configured)
      : null;
  const accel = normalized ?? DEFAULT_REMIX_HOTKEY;

  // Dictation wins on chord clash; remix stays off until Settings resolves it.
  if (currentHotkeyAccel && accel === currentHotkeyAccel) {
    hotkeyLog.warn(
      `Remix hotkey "${accel}" is already the dictation hotkey; remix disabled.`,
    );
    return;
  }

  currentRemixAccel = accel;

  const listener = new NativeKeyListener({
    hotkey: accel,
    onKeyDown: handleRemixHotkeyDown,
    onKeyUp: handleRemixHotkeyUp,
    onError: (error) => {
      hotkeyLog.error(`Remix key listener error: ${error}`);
    },
    onReady: () => {
      hotkeyLog.debug(`Remix key listener ready for "${accel}"`);
    },
    onPermanentFailure: () => {
      if (remixKeyListener !== listener) return;
      hotkeyLog.error("Remix key listener permanently failed; remix off.");
      listener.stop();
      remixKeyListener = null;
    },
  });
  remixKeyListener = listener;

  const started = await listener.start();
  if (remixKeyListener !== listener) {
    listener.stop();
    return;
  }
  if (!started) {
    hotkeyLog.warn(
      `Remix key listener unavailable for "${accel}"; remix are off.`,
    );
    listener.stop();
    remixKeyListener = null;
  }
}

const HOTKEY_STUCK_TIMEOUT_MS = 5 * 60 * 1000;
let hotkeyStuckTimer: NodeJS.Timeout | null = null;

function clearHotkeyStuckWatchdog(): void {
  if (hotkeyStuckTimer) {
    clearTimeout(hotkeyStuckTimer);
    hotkeyStuckTimer = null;
  }
}

function armHotkeyStuckWatchdog(): void {
  clearHotkeyStuckWatchdog();
  hotkeyStuckTimer = setTimeout(() => {
    hotkeyStuckTimer = null;
    if (!hotkeyPressed) return;
    hotkeyLog.warn(
      "Hold-mode hotkey saw no key-up for 5 minutes; forcing release.",
    );
    hotkeyPressed = false;
    activeDictationLanguage = null;
    sendHotkeyUp();
  }, HOTKEY_STUCK_TIMEOUT_MS);
}

/**
 * Shared press state machine for every dictation-starting hotkey — the
 * default hotkey (`language` undefined) and every per-language hotkey
 * (§5, specs/dictation-language-hotkeys.md) alike. `hotkeyPressed` remains
 * the single flag gating whether a dictation session is in progress, so only
 * one can run at a time regardless of which hotkey started it.
 */
function handleDictationHotkeyDown(language?: string): void {
  if (hotkeyActivationMode === "toggle") {
    if (!hotkeyPressed) {
      hotkeyPressed = true;
      activeDictationLanguage = language ?? null;
      sendHotkeyDown(activeDictationLanguage);
    } else {
      hotkeyPressed = false;
      activeDictationLanguage = null;
      sendHotkeyUp();
    }
    return;
  }

  if (!hotkeyPressed) {
    hotkeyPressed = true;
    activeDictationLanguage = language ?? null;
    armHotkeyStuckWatchdog();
    sendHotkeyDown(activeDictationLanguage);
  }
  // hotkeyPressed already true: a second hotkey (default or another
  // language) pressed mid-recording is a no-op in hold mode, same as today's
  // "press the same hotkey twice" case — only one dictation session at a
  // time, matching the single hotkeyPressed flag's existing semantics.
}

function handleDictationHotkeyUp(language?: string): void {
  if (hotkeyActivationMode === "toggle") return;

  // Only the hotkey that started the session ends it — a stray key-up from a
  // *different* language hotkey (e.g. the user's finger slipped) is ignored
  // rather than ending someone else's hold.
  if (hotkeyPressed && (language ?? null) === activeDictationLanguage) {
    hotkeyPressed = false;
    activeDictationLanguage = null;
    clearHotkeyStuckWatchdog();
    sendHotkeyUp();
  }
}

// Notify once per session when hold-to-talk degrades to toggle mode, so the
// user isn't left wondering why holding the hotkey stopped working.
let hotkeyDegradedNotified = false;
function notifyHotkeyDegraded(accel: string, nativeError: string): void {
  if (hotkeyDegradedNotified || hotkeyActivationMode !== "hold") return;
  hotkeyDegradedNotified = true;
  let fix = "";
  if (
    process.platform === "linux" &&
    nativeError.includes("No accessible input devices")
  ) {
    fix =
      " To enable hold-to-talk, run: sudo usermod -aG input $USER — then log out and back in.";
  }
  const body = `Hold-to-talk isn't available, so "${accel}" now toggles recording on and off.${fix}`;
  hotkeyLog.warn(body);
  notify("Openstyle is in toggle mode", body);
}

// Shows one native notification. A click opens the settings window on
// `route`. Without a route, a click does nothing.
function notify(title: string, body: string, route?: string): void {
  if (!Notification.isSupported()) return;
  const note = new Notification({ title, body });
  if (route) note.on("click", () => showSettingsWindow(route));
  note.show();
}

// Import completion (UX-04 / UX-A4, specs/lean-audit-2026-09.md §4): the
// update flow's native-notification pattern, reused so an import that lands
// while the user looked away is no longer silent. English-only copy from
// main, exactly like the update notifications — the renderer-localized
// surface is the Import page itself. Click focuses the app on Today, where
// the new transcript sits at the top of history.
function notifyImportComplete(fileName: string): void {
  // Counted before the Notification.isSupported() guard so e2e (where the
  // OS may suppress notifications) can still assert the completion fired.
  if ((process.env.OPENSTYLE_E2E ?? process.env.FREESTYLE_E2E) === "1") {
    const g = globalThis as {
      __openstyleE2E?: { importNotifications?: number };
    };
    g.__openstyleE2E ??= {};
    g.__openstyleE2E.importNotifications =
      (g.__openstyleE2E.importNotifications ?? 0) + 1;
  }
  notify("Transcript ready", `“${fileName}” has been transcribed.`, "/today");
}

// Rate-limited so a broken paste backend doesn't fire a notification per
// dictation.
const PASTE_FAILED_NOTIFY_INTERVAL_MS = 30_000;
let lastPasteFailedNotifyAt = 0;
function notifyPasteFailed(): void {
  const now = Date.now();
  if (now - lastPasteFailedNotifyAt < PASTE_FAILED_NOTIFY_INTERVAL_MS) return;
  lastPasteFailedNotifyAt = now;
  const shortcut = process.platform === "darwin" ? "Cmd+V" : "Ctrl+V";
  let hint = "";
  if (process.platform === "linux") {
    if (isWaylandSession()) {
      const desktop = (process.env.XDG_CURRENT_DESKTOP ?? "").toLowerCase();
      hint = desktop.includes("gnome")
        ? " If a permission dialog appears on the next paste, allow Openstyle to control input."
        : " If a permission dialog appears on the next paste, allow it — or install wtype (e.g. sudo apt install wtype).";
    } else {
      hint =
        " Installing xdotool may fix this (e.g. sudo apt install xdotool).";
    }
  }
  notify(
    "Openstyle couldn't paste",
    `Your transcript is on the clipboard — press ${shortcut} to paste it.${hint}`,
  );
}

/** Electron globalShortcut rejects some combos (e.g. Alt+Super on Linux). */
const LINUX_GLOBAL_SHORTCUT_FALLBACK = "F9";

function registerGlobalShortcutToggle(accel: string): string | null {
  const onToggle = (): void => {
    if (!hotkeyPressed) {
      hotkeyPressed = true;
      sendHotkeyDown();
    } else {
      hotkeyPressed = false;
      sendHotkeyUp();
    }
  };

  const candidates =
    process.platform === "linux" && /super/i.test(accel)
      ? [accel, LINUX_GLOBAL_SHORTCUT_FALLBACK]
      : [accel];

  for (const candidate of candidates) {
    try {
      if (globalShortcut.register(candidate, onToggle)) {
        if (candidate !== accel) {
          hotkeyLog.warn(
            `globalShortcut does not support "${accel}"; using "${candidate}" instead.`,
          );
        }
        return candidate;
      }
    } catch (err) {
      hotkeyLog.warn(
        `globalShortcut.register failed for "${candidate}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return null;
}

function scheduleHotkeyRegistration(hotkey?: string): void {
  void registerHotkey(hotkey).catch((err) => {
    hotkeyLog.error(
      `Hotkey registration failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

async function registerHotkey(hotkey?: string): Promise<void> {
  try {
    // Tear down previous listener
    if (keyListener) {
      keyListener.stop();
      keyListener = null;
    }
    hotkeyPressed = false;
    activeDictationLanguage = null;
    clearHotkeyStuckWatchdog();
    globalShortcut.unregisterAll();

    if (!hotkey) {
      // Unreachable server yields no map; registration falls back to the
      // default accelerator below.
      hotkey = hotkeyFromSettings((await getServerSettings()) ?? {});
    }

    const normalized =
      hotkey && isValidAccelerator(hotkey)
        ? normalizeAccelerator(hotkey)
        : null;
    const accel = normalized ?? DEFAULT_HOTKEY;
    currentHotkeyAccel = accel;

    // Try native key listener binary first (all platforms)
    let nativeError = "";
    const listener = new NativeKeyListener({
      hotkey: accel,
      onKeyDown: () => handleDictationHotkeyDown(),
      onKeyUp: () => handleDictationHotkeyUp(),
      onError: (error) => {
        nativeError = error;
        hotkeyLog.error(`Native key listener error: ${error}`);
      },
      onReady: () => {
        hotkeyLog.debug(`Native key listener ready for "${accel}"`);
      },
      onPermanentFailure: () => {
        if (keyListener !== listener) return;
        hotkeyLog.error(
          "Native key listener permanently failed; falling back to Electron globalShortcut (toggle mode).",
        );
        listener.stop();
        keyListener = null;
        if (hotkeyPressed) {
          hotkeyPressed = false;
          clearHotkeyStuckWatchdog();
          sendHotkeyUp();
        }
        const registeredAccel = registerGlobalShortcutToggle(accel);
        if (registeredAccel) {
          notifyHotkeyDegraded(accel, nativeError);
        } else {
          const errorPayload = {
            message: `The hotkey listener stopped working and "${accel}" could not be re-registered. Restart Openstyle or pick a different combination in Settings.`,
          };
          broadcastToWindows("hotkey:error", errorPayload);
        }
      },
    });
    keyListener = listener;

    const started = await listener.start();

    // Another registerHotkey call may have replaced keyListener while we
    // were awaiting — if so, abandon this attempt.
    if (keyListener !== listener) {
      listener.stop();
      return;
    }

    if (started) {
      accessibilityConfirmed = true;
      hotkeyDegradedNotified = false;
      // Dictation hotkey moved — re-resolve remix (may free or steal a chord).
      if (remixInitialized) scheduleRemixHotkeyRegistration();
    } else {
      hotkeyLog.warn(
        "Native key listener unavailable, falling back to Electron globalShortcut (toggle mode).",
      );
      listener.stop();
      keyListener = null;

      // Fallback: globalShortcut has no key-up — always use toggle semantics
      const registeredAccel = registerGlobalShortcutToggle(accel);
      if (registeredAccel) {
        // Do NOT latch accessibilityConfirmed here. Registering a global
        // shortcut requires no Accessibility permission on macOS, so a
        // successful registration proves nothing about whether the app can
        // post CGEvents / send Apple Events. Latching it here would make
        // permissions:check-accessibility report a false positive, hide the
        // "grant Accessibility" prompt during onboarding, and leave paste
        // silently broken in the notarized prod build. Only the native key
        // listener starting (above) is real proof of Accessibility.
        notifyHotkeyDegraded(accel, nativeError);
      } else {
        let message = `Could not register hotkey "${accel}". Try a different key combination in Settings.`;
        if (
          process.platform === "linux" &&
          nativeError.includes("No accessible input devices")
        ) {
          message = `Hotkey "${accel}" requires access to input devices. Run: sudo usermod -aG input $USER — then log out and back in.`;
        }
        const errorPayload = { message };
        broadcastToWindows("hotkey:error", errorPayload);
      }
    }
  } catch (err) {
    hotkeyLog.error(
      `registerHotkey failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Reconcile the running per-language hotkey listeners against a desired
 * language→accelerator map (§5, specs/dictation-language-hotkeys.md). Same
 * pattern as `registerHotkey` — "stop, then rebuild" — scaled to a map
 * instead of a single instance, via `diffLanguageHotkeys` (hotkey-utils.ts).
 */
async function registerLanguageHotkeys(
  map: Record<string, string> | undefined,
): Promise<void> {
  const desired = map ?? {};
  const { toRemove, toAdd } = diffLanguageHotkeys(
    desired,
    languageHotkeyAccels,
  );

  for (const lang of toRemove) {
    languageKeyListeners.get(lang)?.stop();
    languageKeyListeners.delete(lang);
    languageHotkeyAccels.delete(lang);
    if (activeDictationLanguage === lang) {
      activeDictationLanguage = null;
      if (hotkeyPressed) {
        hotkeyPressed = false;
        clearHotkeyStuckWatchdog();
        sendHotkeyUp();
      }
    }
  }

  for (const [lang, hotkey] of toAdd) {
    const normalized = isValidAccelerator(hotkey)
      ? normalizeAccelerator(hotkey)
      : null;
    if (!normalized) continue; // invalid stored value; skip silently (§8)

    const taken = isLanguageHotkeyTaken(normalized, {
      dictationAccel: currentHotkeyAccel,
      remixAccel: currentRemixAccel,
      claimedLanguageAccels: languageHotkeyAccels.values(),
    });
    if (taken) {
      hotkeyLog.warn(
        `Language hotkey "${normalized}" for "${lang}" conflicts with an existing binding; disabled.`,
      );
      continue;
    }

    const listener = new NativeKeyListener({
      hotkey: normalized,
      onKeyDown: () => handleDictationHotkeyDown(lang),
      onKeyUp: () => handleDictationHotkeyUp(lang),
      onError: (error) =>
        hotkeyLog.error(`Language hotkey listener error (${lang}): ${error}`),
      onPermanentFailure: () => {
        if (languageKeyListeners.get(lang) !== listener) return;
        hotkeyLog.error(
          `Language hotkey listener for "${lang}" permanently failed; disabled.`,
        );
        listener.stop();
        languageKeyListeners.delete(lang);
        languageHotkeyAccels.delete(lang);
        if (activeDictationLanguage === lang) {
          activeDictationLanguage = null;
          if (hotkeyPressed) {
            hotkeyPressed = false;
            clearHotkeyStuckWatchdog();
            sendHotkeyUp();
          }
        }
      },
    });
    languageKeyListeners.set(lang, listener);
    languageHotkeyAccels.set(lang, normalized);

    const started = await listener.start();
    // Another registerLanguageHotkeys call may have replaced this entry
    // while we were awaiting — if so, abandon this attempt.
    if (languageKeyListeners.get(lang) !== listener) {
      listener.stop();
      continue;
    }
    if (!started) {
      hotkeyLog.warn(
        `Language hotkey listener unavailable for "${lang}"; disabled.`,
      );
      listener.stop();
      languageKeyListeners.delete(lang);
      languageHotkeyAccels.delete(lang);
    }
  }
}

function scheduleLanguageHotkeysRegistration(
  map: Record<string, string> | undefined,
): void {
  void registerLanguageHotkeys(map).catch((err) => {
    hotkeyLog.error(
      `Language hotkey registration failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

/** Parse the `language_hotkeys` setting and reconcile the listeners against it. */
function applyLanguageHotkeySettings(settings: Record<string, string>): void {
  const raw = settings[SETTINGS_KEYS.languageHotkeys];
  let map: Record<string, string> = {};
  try {
    if (raw) map = JSON.parse(raw);
  } catch {
    map = {};
  }
  scheduleLanguageHotkeysRegistration(map);
}

// Keep app running in background when windows are closed (tray stays active)
app.on("window-all-closed", () => {
  // Stay alive for the tray. Quit only through the tray menu.
});

// Re-open the dashboard when the app is activated (e.g. clicking the dock
// icon or relaunching) and no dashboard window is currently open.
app.on("activate", () => {
  showSettingsWindow();
});

let isUpdaterQuitting = false;
let isQuitting = false;

let updateDownloadState: "idle" | "downloading" | "downloaded" = "idle";

// Stop every native child process and timer. The before-quit handler runs
// this on a normal quit and on an updater quit. A normal quit then calls
// app.exit(0), which skips will-quit.
function cleanupBeforeQuit(): void {
  // Finalize any in-flight meeting recording's WAV headers before the process
  // exits; the boot-time orphan sweep settles the DB row next launch.
  meetingRecorder?.stopSync();
  audioPlaybackController.restoreSync();
  stopLinuxPasteHelper();
  stopWhisperServer().catch(() => {});
  stopMlxServer().catch(() => {});
  if (keyListener) {
    keyListener.stop();
    keyListener = null;
  }
  if (remixKeyListener) {
    remixKeyListener.stop();
    remixKeyListener = null;
  }
  for (const listener of languageKeyListeners.values()) {
    listener.stop();
  }
  languageKeyListeners.clear();
  languageHotkeyAccels.clear();
  if (remixBarFollowTimer) {
    clearInterval(remixBarFollowTimer);
    remixBarFollowTimer = null;
  }
  stopHotkeyRecorderProcess();
  globalShortcut.unregisterAll();
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
}

// A signal ends the process with no "exit" event unless a handler runs.
// Quit through Electron so the exit hooks that stop the whisper and MLX child
// servers run. The before-quit handler always ends with app.exit(0).
process.on("SIGINT", () => app.quit());
process.on("SIGTERM", () => app.quit());

app.on("before-quit", (event) => {
  if (isUpdaterQuitting) {
    try {
      cleanupBeforeQuit();
    } catch (err) {
      log.warn(
        `cleanup before updater quit failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return;
  }
  if (isQuitting) return;
  isQuitting = true;
  event.preventDefault();
  // We preventDefault above, so `app.exit(0)` is the only thing that ends the
  // process. Keep it in a `finally` — if any cleanup step throws (a native
  // listener already torn down, a dead child process), the app would otherwise
  // stay alive forever with no windows, which is what a hung quit looks like.
  try {
    cleanupBeforeQuit();
  } catch (err) {
    log.warn(
      `cleanup before quit failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  } finally {
    app.exit(0);
  }
});
