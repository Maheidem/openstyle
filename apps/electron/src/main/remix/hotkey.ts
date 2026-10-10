/**
 * Remix hotkey handling for the main process.
 * Shared values are read and written through the state object.
 */
import { createAppLogger } from "@openstyle/utils";
import { getDefaultRemixHotkey } from "../../shared/remix";
import { SETTINGS_KEYS } from "../../shared/settings-keys";
import { getFrontmostContext } from "../active-window";
import { isValidAccelerator, normalizeAccelerator } from "../hotkey-utils";
import { startNativeRetry } from "../hotkeys/native-retry";
import {
  clearHotkeyStuckWatchdog,
  clearRemixStuckWatchdog,
  HOTKEY_STUCK_TIMEOUT_MS,
  setRemixRouteKeys,
} from "../hotkeys/stuck-release";
import { NativeKeyListener } from "../key-listener";
import { isSecureInputActive } from "../mac-ax";
import { state } from "../main-state";
import { copySelectionFromFocusedApp } from "../paste";
import { sendToPill, showPill } from "../windows/pill-window";
import { REMIX_BAR_REOPEN_COOLDOWN_MS, updateRemixBar } from "./bar-window";
import { clipboardPreviewFields } from "./helpers";

const hotkeyLog = createAppLogger("hotkey");

const DEFAULT_REMIX_HOTKEY = getDefaultRemixHotkey();
/** User-configured accel (may differ from what's listening while parked/off). */
let remixHotkeyPreference: string | undefined;

/** False if the remix chord includes C — injected Cmd/Ctrl+C collides with the held key. */
function canCopySelectionWhileHeld(): boolean {
  const parts = state.currentRemixAccel?.split("+") ?? [];
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
    state.remixAnchor = { ...context, capturedAt: Date.now() };
    if (sel.status === "rejected") {
      hotkeyLog.warn(`Selection capture failed: ${sel.reason}`);
    }
    sendToPill("remix:selection", {
      text: sel.status === "fulfilled" ? sel.value : null,
      ...clipboardPreviewFields(),
      ...state.remixAnchor,
    });
  });
}

/** The remix hotkey went down: put the pill up straight away. */
function handleRemixHotkeyDown(): void {
  if (state.remixPressed) return;
  state.remixPressed = true;

  // Fn+Control shares Fn with dictation; a slow press starts a rogue recording.
  // Cancel on the remix channel — ordinary cancel would hide the pill we need.
  if (state.hotkeyPressed) {
    state.hotkeyPressed = false;
    clearHotkeyStuckWatchdog();
    sendToPill("remix:supersede");
  }

  setRemixRouteKeys(true);
  armRemixStuckWatchdog();
  remixSelectionRequested = false;
  showPill();
  sendToPill("remix:down");
  // Mirror to dashboard (onboarding keycaps / Remix demo).
  state.settingsWindow?.webContents.send("remix:down");

  // Read selection on press so empty highlight is known before voice starts.
  if (canCopySelectionWhileHeld()) captureRemixSelection();
}

function handleRemixHotkeyUp(): void {
  if (!state.remixPressed) return;
  state.remixPressed = false;
  clearRemixStuckWatchdog();
  sendToPill("remix:up");
  state.settingsWindow?.webContents.send("remix:up");
  captureRemixSelection();
}

function armRemixStuckWatchdog(): void {
  clearRemixStuckWatchdog();
  state.remixStuckTimer = setTimeout(() => {
    state.remixStuckTimer = null;
    if (!state.remixPressed) return;
    hotkeyLog.warn(
      "Remix hotkey saw no key-up for 5 minutes; forcing release.",
    );
    handleRemixHotkeyUp();
  }, HOTKEY_STUCK_TIMEOUT_MS);
}

export function scheduleRemixHotkeyRegistration(hotkey?: string): void {
  void registerRemixHotkey(hotkey).catch((err) => {
    hotkeyLog.error(
      `Remix hotkey registration failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

/** `quiet` is true while a retry attempt starts the listener (debug log only). */
function createRemixListener(
  accel: string,
  quiet: () => boolean = () => false,
): NativeKeyListener {
  const listener = new NativeKeyListener({
    hotkey: accel,
    onKeyDown: handleRemixHotkeyDown,
    onKeyUp: handleRemixHotkeyUp,
    onError: (error) => {
      if (quiet()) hotkeyLog.debug(`Remix key listener error: ${error}`);
      else hotkeyLog.error(`Remix key listener error: ${error}`);
    },
    onReady: () => {
      hotkeyLog.debug(`Remix key listener ready for "${accel}"`);
    },
    onPermanentFailure: () => {
      if (state.remixKeyListener !== listener) return;
      hotkeyLog.error(
        "Remix key listener permanently failed; retrying every 60 s.",
      );
      listener.stop();
      state.remixKeyListener = null;
      startRemixRetry(accel);
    },
  });
  return listener;
}

/** Cancels the pending native retry for the remix listener. */
let cancelRemixRetry: (() => void) | null = null;

/** Try the native listener again every 60 s. No fallback exists for Remix. */
function startRemixRetry(accel: string): void {
  cancelRemixRetry?.();
  cancelRemixRetry = startNativeRetry({
    label: "Remix",
    attempt: async () => {
      let attempting = true;
      const listener = createRemixListener(accel, () => attempting);
      state.remixKeyListener = listener;
      const started = await listener.start().finally(() => {
        attempting = false;
      });
      if (started && state.remixKeyListener === listener) return true;
      listener.stop();
      if (state.remixKeyListener === listener) state.remixKeyListener = null;
      return false;
    },
    onRecovered: () => {
      cancelRemixRetry = null;
    },
  });
}

/** Cancel the pending native retry of the Remix listener. */
export function cancelRemixRetries(): void {
  cancelRemixRetry?.();
  cancelRemixRetry = null;
}

/** Start the remix native listener. No globalShortcut fallback (needs hold/tap). */
async function registerRemixHotkey(hotkey?: string): Promise<void> {
  cancelRemixRetry?.();
  cancelRemixRetry = null;
  if (state.remixKeyListener) {
    state.remixKeyListener.stop();
    state.remixKeyListener = null;
  }
  state.remixPressed = false;

  remixHotkeyPreference = hotkey ?? remixHotkeyPreference;
  const configured = hotkey ?? remixHotkeyPreference;
  const normalized =
    configured && isValidAccelerator(configured)
      ? normalizeAccelerator(configured)
      : null;
  const accel = normalized ?? DEFAULT_REMIX_HOTKEY;

  // Dictation wins on chord clash; remix stays off until Settings resolves it.
  if (state.currentHotkeyAccel && accel === state.currentHotkeyAccel) {
    hotkeyLog.warn(
      `Remix hotkey "${accel}" is already the dictation hotkey; remix disabled.`,
    );
    return;
  }

  state.currentRemixAccel = accel;

  const listener = createRemixListener(accel);
  state.remixKeyListener = listener;

  const started = await listener.start();
  if (state.remixKeyListener !== listener) {
    listener.stop();
    return;
  }
  if (!started) {
    hotkeyLog.warn(
      `Remix key listener unavailable for "${accel}"; retrying every 60 s.`,
    );
    listener.stop();
    state.remixKeyListener = null;
    startRemixRetry(accel);
  }
}

export function handleRemixBarOpen(): void {
  if (!state.remixBarEnabled) return;
  if (state.mainWindow?.isVisible()) return;
  if (Date.now() - state.lastPillHideAt < REMIX_BAR_REOPEN_COOLDOWN_MS) return;
  remixSelectionRequested = false;
  captureRemixSelection();
  showPill();
  sendToPill("remix:open-chat");
  updateRemixBar();
}

export function applyRemixSettings(settings: Record<string, string>): void {
  // Absent means on.
  state.remixBarEnabled = settings[SETTINGS_KEYS.remixBarEnabled] !== "false";
  state.remixInitialized = true;
  updateRemixBar();
  const configured = settings[SETTINGS_KEYS.remixHotkey];
  scheduleRemixHotkeyRegistration(
    configured && isValidAccelerator(configured) ? configured : undefined,
  );
}
