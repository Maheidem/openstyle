// Hotkey watchdog timers and remix route keys.
// This file must stay a leaf module. It must not import any pill,
// dictation or remix module, or an import cycle appears.
import { createAppLogger } from "@openstyle/utils";
import { globalShortcut } from "electron";
import { state } from "../main-state";

const hotkeyLog = createAppLogger("hotkey");

export const HOTKEY_STUCK_TIMEOUT_MS = 5 * 60 * 1000;

export function clearHotkeyStuckWatchdog(): void {
  if (state.hotkeyStuckTimer) {
    clearTimeout(state.hotkeyStuckTimer);
    state.hotkeyStuckTimer = null;
  }
}

export function clearRemixStuckWatchdog(): void {
  if (state.remixStuckTimer) {
    clearTimeout(state.remixStuckTimer);
    state.remixStuckTimer = null;
  }
}

/** Remix chord + digit routes; claimed while the card is up. Spell modifiers
 *  (Control is physically down); Fn isn't expressible as an accelerator. */
const REMIX_ROUTE_MODIFIER =
  process.platform === "darwin" ? "Control" : "Control+Alt";
const REMIX_ROUTE_DIGITS = ["1", "2", "3"];
let remixRouteKeysHeld = false;

export function setRemixRouteKeys(open: boolean): void {
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
        if (state.mainWindow?.isVisible()) {
          state.mainWindow.webContents.send("remix:route", index);
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
