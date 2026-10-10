// Native notifications for the main process.
// Each function shows one OS notification.
// Quiet E2E mode (state.quietE2E) hides every banner.
import { Notification } from "electron";
import { isWaylandSession } from "./linux-session";
import { state } from "./main-state";
import { showSettingsWindow } from "./windows/settings-window";

// Shows one native notification. A click opens the settings window on
// `route`. Without a route, a click does nothing.
export function notify(title: string, body: string, route?: string): void {
  // Quiet E2E: no notification banner on the screen.
  if (state.quietE2E || !Notification.isSupported()) return;
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
export function notifyImportComplete(fileName: string): void {
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
export function notifyPasteFailed(): void {
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
