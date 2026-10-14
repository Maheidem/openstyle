/**
 * Calendar IPC (specs/calendar-eventkit.md). The renderer asks for the
 * permission status, requests access when the user turns the toggle on, and
 * lists today's events for the "Change" picker. Link and unlink go from the
 * renderer straight to the server.
 */

import { ipcMain, shell } from "electron";
import type { ServerFetch } from "../shared/server-auth";
import {
  calendarAuthStatus,
  isCalendarEnabled,
  listTodayEvents,
  requestCalendarAccess,
} from "./calendar";

const CALENDARS_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Calendars";

export function registerCalendarIpc({
  serverFetch,
}: {
  serverFetch: ServerFetch;
}): void {
  // Never shows a dialog. It starts the helper, so the Settings screen calls
  // it only after the user turned the toggle on.
  ipcMain.handle("calendar:status", () => calendarAuthStatus());

  // The only call that shows the macOS dialog.
  ipcMain.handle("calendar:request", () => requestCalendarAccess());

  ipcMain.handle("calendar:list-today", async () => {
    const events = await listTodayEvents({
      isEnabled: () => isCalendarEnabled(serverFetch),
    });
    return events.map(({ isAllDay: _isAllDay, ...event }) => event);
  });

  ipcMain.on("calendar:open-settings", () => {
    if (process.platform !== "darwin") return;
    void shell.openExternal(CALENDARS_SETTINGS_URL);
  });
}
