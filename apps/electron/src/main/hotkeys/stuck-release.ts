// Hotkey watchdog timers.
// This file must stay a leaf module. It must not import any pill or
// dictation module, or an import cycle appears.
import { state } from "../main-state";

export const HOTKEY_STUCK_TIMEOUT_MS = 5 * 60 * 1000;

export function clearHotkeyStuckWatchdog(): void {
  if (state.hotkeyStuckTimer) {
    clearTimeout(state.hotkeyStuckTimer);
    state.hotkeyStuckTimer = null;
  }
}
