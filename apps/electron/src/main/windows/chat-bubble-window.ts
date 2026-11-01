// The Ask bubble: a small floating window that a global hotkey opens from any
// app (specs/meeting-chat-agent.md 11.6). The user types a question and reads
// a short answer. "Open in Ask" continues the thread on the Ask page.
//
// Unlike the tray popover, the bubble takes keyboard focus: the user types in
// it. Escape closes it and gives the focus back.
import { join } from "node:path";
import { createAppLogger } from "@openstyle/utils";
import { app, BrowserWindow, ipcMain, screen } from "electron";
import {
  type ChatBubbleScope,
  type ChatBubbleShown,
  parseBubbleId,
  parseBubbleScope,
} from "../../shared/chat-bubble";
import { state } from "../main-state";
import { getChatBubbleURL } from "../renderer-urls";
import { showSettingsWindow } from "./settings-window";

const log = createAppLogger("electron");

const BUBBLE_WIDTH = 560;
const INITIAL_HEIGHT = 168;
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 560;
/** The bubble sits this far from the top of the work area, as a share. */
const TOP_SHARE = 0.16;

let contentHeight = INITIAL_HEIGHT;
let openCount = 0;
/**
 * The last open. A page that mounts after the message (the first open loads
 * the page, and React mounts after the load event) asks for it.
 */
let lastShown: ChatBubbleShown | null = null;
/** When the bubble was shown last. A blur right after that is the activation, not a click away. */
let shownAt = 0;
const BLUR_GRACE_MS = 400;
/** Show the bubble when its page ends loading (a show before the load). */
let showAfterLoad: ChatBubbleShown | null = null;
/** The Openstyle window that had the focus when the bubble opened, if any. */
let returnTo: BrowserWindow | null = null;
/** True when no Openstyle window had the focus (another app had it). */
let openedFromOutside = false;

function createChatBubbleWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: BUBBLE_WIDTH,
    height: INITIAL_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: true,
    skipTaskbar: true,
    roundedCorners: true,
    autoHideMenuBar: true,
    // Quiet E2E: never always-on-top.
    alwaysOnTop: !state.quietE2E,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      // The window is hidden most of the time. Keep it on time when it shows,
      // and keep quiet E2E (opacity 0) rendering.
      backgroundThrottling: false,
    },
  });
  state.chatBubble = win;

  // Above full-screen apps and on every Space. Quiet E2E skips this:
  // setVisibleOnAllWorkspaces changes the macOS process type, which brings
  // back the dock icon (the same rule as the pill and the tray popover).
  if (!state.quietE2E) {
    win.setAlwaysOnTop(true, "floating");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  // The bubble opens no other window. A link goes through main (IPC).
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  win.webContents.on("did-finish-load", () => {
    const pending = showAfterLoad;
    showAfterLoad = null;
    if (pending) revealBubble(win, pending);
  });

  // Losing the focus to another window closes the bubble, like a spotlight.
  win.on("blur", () => {
    if (state.quietE2E) return;
    if (Date.now() - shownAt < BLUR_GRACE_MS) return;
    if (win.isVisible() && !win.webContents.isDevToolsOpened()) {
      hideChatBubble("blur", { restoreFocus: false });
    }
  });

  win.on("closed", () => {
    if (state.chatBubble === win) state.chatBubble = null;
    showAfterLoad = null;
  });

  void win.loadURL(getChatBubbleURL());
  return win;
}

export function isChatBubbleVisible(): boolean {
  return state.chatBubble?.isVisible() === true;
}

/** The scope the bubble takes now: the Meetings selection, else scope A. */
export function currentBubbleScope(): ChatBubbleScope {
  return state.chatSelection ?? { kind: "all" };
}

/**
 * Open the bubble with the scope of the Meetings selection. A second call
 * while it shows gives the input the focus again and resets the scope.
 */
export function openChatBubble(reason: string): void {
  const shown: ChatBubbleShown = {
    scope: currentBubbleScope(),
    openCount: ++openCount,
  };
  if (!isChatBubbleVisible()) {
    const focused = BrowserWindow.getFocusedWindow();
    returnTo = focused && focused !== state.chatBubble ? focused : null;
    openedFromOutside = returnTo === null;
  }
  const win = state.chatBubble ?? createChatBubbleWindow();
  if (win.webContents.isLoading()) {
    showAfterLoad = shown;
    return;
  }
  revealBubble(win, shown);
  log.info(`Chat bubble shown (${reason})`);
}

function revealBubble(win: BrowserWindow, shown: ChatBubbleShown): void {
  if (win.isDestroyed()) return;
  shownAt = Date.now();
  placeBubble(win);
  if (state.quietE2E) {
    // No focus, no app activation: the window stays quiet.
    win.showInactive();
  } else {
    if (process.platform === "darwin") app.focus({ steal: true });
    win.show();
    win.focus();
  }
  lastShown = shown;
  win.webContents.send("chat-bubble:shown", shown);
}

/**
 * Hide the bubble. `restoreFocus` gives the focus back: to the Openstyle
 * window that had it, or, when another app had it, to that app (the app hides
 * itself, and macOS activates the app that was in front).
 */
export function hideChatBubble(
  reason: string,
  options: { restoreFocus: boolean } = { restoreFocus: true },
): void {
  showAfterLoad = null;
  const win = state.chatBubble;
  if (!win?.isVisible()) return;
  win.hide();
  win.webContents.send("chat-bubble:hidden");
  log.info(`Chat bubble hidden (${reason})`);
  if (!options.restoreFocus || state.quietE2E) return;
  if (returnTo && !returnTo.isDestroyed()) {
    returnTo.focus();
  } else if (openedFromOutside && process.platform === "darwin") {
    app.hide();
  }
  returnTo = null;
}

function placeBubble(win: BrowserWindow): void {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display.workArea;
  const height = Math.max(
    MIN_HEIGHT,
    Math.min(contentHeight, MAX_HEIGHT, area.height - 40),
  );
  win.setBounds({
    x: Math.round(area.x + (area.width - BUBBLE_WIDTH) / 2),
    y: Math.round(area.y + area.height * TOP_SHARE),
    width: BUBBLE_WIDTH,
    height,
  });
}

/** True when the IPC message comes from the bubble page. */
function fromBubble(event: Electron.IpcMainEvent): boolean {
  return event.sender === state.chatBubble?.webContents;
}

/** IPC of the bubble page and of the Meetings page selection. */
export function registerChatBubbleIpc(): void {
  // The main window tells what the Meetings page selects. Any renderer window
  // may send it; the value is checked.
  ipcMain.on("chat:selection", (_event, value: unknown) => {
    state.chatSelection = value === null ? null : parseBubbleScope(value);
  });

  ipcMain.handle("chat-bubble:state", (event): ChatBubbleShown | null =>
    event.sender === state.chatBubble?.webContents && isChatBubbleVisible()
      ? lastShown
      : null,
  );

  ipcMain.on("chat-bubble:hide", (event) => {
    if (fromBubble(event)) hideChatBubble("escape");
  });

  ipcMain.on("chat-bubble:set-height", (event, height: unknown) => {
    if (!fromBubble(event) || typeof height !== "number") return;
    if (!Number.isFinite(height) || height <= 0) return;
    contentHeight = Math.ceil(height);
    const win = state.chatBubble;
    if (win?.isVisible()) placeBubble(win);
  });

  // Continue the thread on the Ask page of the main window.
  ipcMain.on("chat-bubble:open-in-ask", (event, threadId: unknown) => {
    if (!fromBubble(event)) return;
    const id = parseBubbleId(threadId);
    if (!id) return;
    hideChatBubble("open in ask", { restoreFocus: false });
    showSettingsWindow(`/ask?thread=${encodeURIComponent(id)}`);
  });

  // A cite chip opens the meeting on the Transcript tab at the cited time.
  ipcMain.on(
    "chat-bubble:open-cite",
    (event, meetingId: unknown, startMs: unknown) => {
      if (!fromBubble(event)) return;
      const id = parseBubbleId(meetingId);
      if (!id) return;
      hideChatBubble("open cite", { restoreFocus: false });
      const at =
        typeof startMs === "number" && Number.isFinite(startMs) && startMs >= 0
          ? `&tab=transcript&at=${Math.floor(startMs)}`
          : "";
      showSettingsWindow(`/meetings?meeting=${encodeURIComponent(id)}${at}`);
    },
  );

  if ((process.env.OPENSTYLE_E2E ?? process.env.FREESTYLE_E2E) === "1") {
    ipcMain.handle("e2e:chat-bubble-visible", () => isChatBubbleVisible());
    ipcMain.handle("e2e:chat-selection", () => state.chatSelection);
  }
}
