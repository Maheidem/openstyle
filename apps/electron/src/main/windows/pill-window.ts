// Pill window: the small floating window that shows dictation status.
// It owns the window position and expansion.
// Other modules call the exported functions. This file must not import
// dictation or notifications. That import would make a cycle.
import { join } from "node:path";
import { is } from "@electron-toolkit/utils";
import { BrowserWindow, globalShortcut, screen, shell } from "electron";
import icon from "../../../resources/icon.png?asset";
import { getFocusedWindowDisplay } from "../active-window";
import { clearHotkeyStuckWatchdog } from "../hotkeys/stuck-release";
import { readSettings, writeSettings } from "../local-settings";
import { broadcastToWindows, state } from "../main-state";
import {
  APP_HEIGHT,
  APP_WIDTH,
  presetPositionForDisplay,
  resolveCustomPosition,
} from "../pill-position";
import { getPillURL } from "../renderer-urls";

/**
 * The window is grown to this while the renderer shows its expanded status
 * card (a failure the user has to answer — see `pill:set-expanded`). The extra
 * area is transparent and empty, so it stays collapsed the rest of the time
 * rather than sitting over the user's screen as a dead zone.
 */
const PILL_CARD_WIDTH = 340;
const PILL_CARD_HEIGHT = 144;

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

/**
 * True from a dictation hotkey press until the renderer hides the pill. The
 * Escape shortcut cancels a dictation, so it is registered only while this
 * is true. The meeting Recording state never registers Escape.
 */
let dictationOwnsPill = false;

function meetingRecording(): boolean {
  return state.meetingRecorder?.status === "recording";
}

export function setProgrammaticPosition(
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
export function setPillExpanded(expanded: boolean): void {
  const win = state.mainWindow;
  if (!win || win.isDestroyed()) return;
  const isExpanded = pillExpandOffset.dx !== 0 || pillExpandOffset.dy !== 0;
  // No-op if already collapsed/same size; re-run on size change to keep anchor.
  if (expanded === isExpanded && !expanded) return;
  if (expanded && isExpanded) {
    const bounds = win.getBounds();
    if (
      bounds.width === PILL_CARD_WIDTH &&
      bounds.height === PILL_CARD_HEIGHT
    ) {
      return;
    }
  }

  const previousOffset = pillExpandOffset;
  const [x, y] = win.getPosition();
  let target: { x: number; y: number; width: number; height: number };

  if (expanded) {
    const { side, edge } = getPillAnchor();
    const width = PILL_CARD_WIDTH;
    const height = PILL_CARD_HEIGHT;
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
export function getPillAlignmentForCustom(): "custom-top" | "custom-bottom" {
  if (!state.mainWindow) return "custom-bottom";
  const [wx, wy] = state.mainWindow.getPosition();
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
export function resolveAppWindowPosition(
  preferredDisplay?: Electron.Display | null,
): {
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

export function createAppWindow(): void {
  const { x, y } = resolveAppWindowPosition();

  // Mark the initial position as programmatic so the move listener ignores it.
  markProgrammaticTarget(x, y);

  state.mainWindow = new BrowserWindow({
    width: APP_WIDTH,
    height: APP_HEIGHT,
    x,
    y,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    // Quiet E2E: never always-on-top.
    alwaysOnTop: !state.quietE2E,
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

  // Quiet E2E: no always-on-top. setVisibleOnAllWorkspaces also toggles the
  // macOS process type, which would bring the dock icon back.
  if (!state.quietE2E) {
    state.mainWindow.setAlwaysOnTop(true, "screen-saver");
    state.mainWindow.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
    });
  }

  let moveTimeout: NodeJS.Timeout | null = null;
  let moveBurst = 0;
  let userMoved = false;
  state.mainWindow.on("will-move", () => {
    userMoved = true;
  });
  state.mainWindow.on("move", () => {
    if (!state.mainWindow) return;
    const [rawX, rawY] = state.mainWindow.getPosition();

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
      if (!state.mainWindow || (burst < 3 && !dragged)) return;
      const [fx, fy] = state.mainWindow.getPosition();
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

  state.mainWindow.on("closed", () => {
    if (moveTimeout) {
      clearTimeout(moveTimeout);
      moveTimeout = null;
    }
    state.mainWindow = null;
  });

  state.mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  state.mainWindow.loadURL(getPillURL());

  // Dev: optional pill DevTools.
  if (is.dev) {
    if (
      (process.env.OPENSTYLE_PILL_DEVTOOLS ??
        process.env.FREESTYLE_PILL_DEVTOOLS) === "1"
    ) {
      state.mainWindow.webContents.openDevTools({ mode: "detach" });
    }
  }
}

/** Show the pill for a dictation. Escape then cancels the dictation. */
export function showPill(): void {
  dictationOwnsPill = true;
  presentPill();
}

/**
 * Show the pill in the meeting Recording state while a meeting records
 * (`recording`). When the meeting stops, hide the pill, but only when no
 * dictation uses it. A dictation hides the pill itself when it ends.
 */
export function setPillMeetingRecording(recording: boolean): void {
  if (recording) {
    presentPill();
    return;
  }
  if (!dictationOwnsPill && state.mainWindow?.isVisible()) {
    state.mainWindow.hide();
  }
}

function presentPill(): void {
  // Already waiting for a freshly-created pill to finish loading.
  if (state.pillReadyPromise) return;

  if (!state.mainWindow) {
    createAppWindow();
    // createAppWindow() synchronously assigns mainWindow, but TypeScript
    // cannot track mutations through function calls.  Re-read and bail
    // out if the assignment unexpectedly failed.
    const win = state.mainWindow as BrowserWindow | null;
    if (!win) return;

    // The window was just created with `show: false` and is still loading.
    // Defer showing until the renderer finishes loading so IPC messages
    // (e.g. hotkey:down) sent immediately after are not lost.
    state.pillReadyPromise = new Promise<void>((resolve) => {
      const cleanup = (): void => {
        state.pillReadyPromise = null;
        resolve();
      };

      // If the window is closed before it finishes loading, resolve the
      // promise so deferred IPC calls are not stuck forever.
      win.once("closed", cleanup);

      win.webContents.once("did-finish-load", () => {
        win.removeListener("closed", cleanup);
        state.pillReadyPromise = null;
        if (!state.mainWindow) {
          resolve();
          return;
        }
        const { x, y } = resolveAppWindowPosition();
        setProgrammaticPosition(state.mainWindow, x, y);
        state.mainWindow.showInactive();
        updatePillEscape();
        anchorPillToFocusedDisplay();
        resolve();
      });
    });
    return;
  }

  if (!state.mainWindow.isVisible()) {
    const { x, y } = resolveAppWindowPosition();
    setProgrammaticPosition(state.mainWindow, x, y);
    state.mainWindow.showInactive();
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
    if (!focusedDisplay || !state.mainWindow || state.mainWindow.isDestroyed())
      return;
    if (!state.mainWindow.isVisible()) return;
    // Don't move the window out from under an in-progress card expansion.
    if (pillExpandOffset.dx !== 0 || pillExpandOffset.dy !== 0) return;

    const [curX, curY] = state.mainWindow.getPosition();
    const currentDisplay = screen.getDisplayMatching({
      x: curX,
      y: curY,
      width: APP_WIDTH,
      height: APP_HEIGHT,
    });
    if (currentDisplay.id === focusedDisplay.id) return;

    const { x, y } = resolveAppWindowPosition(focusedDisplay);
    setProgrammaticPosition(state.mainWindow, x, y);
  });
}

function updatePillEscape(): void {
  if (dictationOwnsPill && state.mainWindow?.isVisible()) {
    if (!globalShortcut.isRegistered("Escape")) {
      globalShortcut.register("Escape", () => {
        if (state.mainWindow?.isVisible()) {
          state.mainWindow.webContents.send("pill:cancel");
        }
      });
    }
  } else {
    try {
      globalShortcut.unregister("Escape");
    } catch {}
  }
}

export function hidePill(): void {
  dictationOwnsPill = false;
  // While a meeting records, the pill stays up and goes back to the meeting
  // Recording state.
  if (!meetingRecording() && state.mainWindow?.isVisible()) {
    state.mainWindow.hide();
  }
  // The next session starts as a bare capsule, so give the extra room back
  // now — the renderer's own collapse only runs when it animates a card away.
  setPillExpanded(false);
  // Session ended (cancel, error, or paste complete). Clear latched hotkey
  // state so the next press starts fresh — e.g. after ESC while still
  // holding the dictation key.
  state.hotkeyPressed = false;
  clearHotkeyStuckWatchdog();
  // Reset focusable when hiding.
  try {
    state.mainWindow?.setFocusable(false);
  } catch {}
  // Unregister Escape shortcut when pill is hidden
  try {
    globalShortcut.unregister("Escape");
  } catch {}
}

/** Send to the pill, deferring until it exists so bursty IPC stays ordered. */
export function sendToPill(channel: string, payload?: unknown): void {
  if (state.pillReadyPromise) {
    void state.pillReadyPromise.then(() => {
      state.mainWindow?.webContents.send(channel, payload);
    });
    return;
  }
  state.mainWindow?.webContents.send(channel, payload);
}
