// Remix bar window: a thin sliver on the bottom screen edge.
// Shown while the pill is hidden. State is held in main-state.
import { join } from "node:path";
import { BrowserWindow, screen } from "electron";
import { state } from "../main-state";
import { getRemixBarURL } from "../renderer-urls";

// Remix bar — bottom-edge sliver; hides while the pill is up.

/** Last display we placed on (follow timer ignores OS Y drift). */
let remixBarPlacedDisplay: number | null = null;
const REMIX_BAR_WIDTH = 120;
const REMIX_BAR_HEIGHT = 18;
const REMIX_BAR_FOLLOW_MS = 3_000;
/** Window hangs past work area so the drawn sliver meets the screen edge. */
const REMIX_BAR_EDGE_OVERHANG = 6;
/** Delay before measuring OS Dock constraint after placement. */
const REMIX_BAR_CALIBRATE_MS = 48;
export const REMIX_BAR_REOPEN_COOLDOWN_MS = 700;
const REMIX_BAR_RESHOW_DELAY_MS = 400;

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
    const win = state.remixBarWindow;
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    const base = remixBarBasePosition();
    remixBarAdjust.set(base.displayId, win.getBounds().y - base.y);
  }, REMIX_BAR_CALIBRATE_MS);
}

function createRemixBarWindow(): void {
  if (state.remixBarWindow) return;
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
    // Quiet E2E: never always-on-top.
    alwaysOnTop: !state.quietE2E,
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
  // Quiet E2E: no always-on-top and no process-type toggle (see the pill).
  if (!state.quietE2E) {
    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  win.on("closed", () => {
    state.remixBarWindow = null;
  });
  void win.loadURL(getRemixBarURL());
  state.remixBarWindow = win;
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
    const live = state.remixBarWindow;
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
      // Quiet E2E: every window stays at opacity 0.
      if (!state.quietE2E) live.setOpacity(1);
    }
    // Re-learn after correction in case the display needs another pass.
    remixBarLearn();
  }, REMIX_BAR_CALIBRATE_MS);
}

export function updateRemixBar(): void {
  const shouldShow =
    state.remixBarEnabled &&
    !state.remixBarHeldForOnboarding &&
    !state.mainWindow?.isVisible();
  if (!shouldShow) {
    if (remixBarShowTimer) {
      clearTimeout(remixBarShowTimer);
      remixBarShowTimer = null;
    }
    if (state.remixBarFollowTimer) {
      clearInterval(state.remixBarFollowTimer);
      state.remixBarFollowTimer = null;
    }
    state.remixBarWindow?.hide();
    return;
  }
  const sinceHide = Date.now() - state.lastPillHideAt;
  if (
    !state.remixBarWindow?.isVisible() &&
    sinceHide < REMIX_BAR_RESHOW_DELAY_MS
  ) {
    if (!remixBarShowTimer) {
      remixBarShowTimer = setTimeout(() => {
        remixBarShowTimer = null;
        updateRemixBar();
      }, REMIX_BAR_RESHOW_DELAY_MS - sinceHide);
    }
    return;
  }
  if (!state.remixBarWindow) createRemixBarWindow();
  const win = state.remixBarWindow;
  if (!win) return;
  const place = (): void => {
    const bar = state.remixBarWindow;
    if (!bar || bar.isDestroyed()) return;
    if (
      !state.remixBarEnabled ||
      state.remixBarHeldForOnboarding ||
      state.mainWindow?.isVisible()
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
  if (!state.remixBarFollowTimer) {
    state.remixBarFollowTimer = setInterval(() => {
      const bar = state.remixBarWindow;
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
