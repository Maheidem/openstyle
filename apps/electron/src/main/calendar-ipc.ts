/**
 * Calendar IPC (specs/calendar-eventkit.md). The renderer asks for the
 * permission status, requests access when the user turns the toggle on,
 * lists today's events for the "Change" picker, and lists the events of one
 * day for the import dialog. Link and unlink go from the renderer straight
 * to the server.
 */

import type { CalendarEvent } from "@openstyle/validations";
import { ipcMain, shell } from "electron";
import type { ServerFetch } from "../shared/server-auth";
import {
  calendarAuthStatus,
  clampEvent,
  isCalendarEnabled,
  type ListedEvent,
  listRangeEvents,
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
  // Never shows a dialog. It answers null and starts no helper while the
  // setting is off.
  ipcMain.handle("calendar:status", async () =>
    (await isCalendarEnabled(serverFetch)) ? calendarAuthStatus() : null,
  );

  // The only call that shows the macOS dialog.
  ipcMain.handle("calendar:request", () => requestCalendarAccess());

  ipcMain.handle("calendar:list-today", async () => {
    const events = await listTodayEvents({
      isEnabled: () => isCalendarEnabled(serverFetch),
    });
    return events.map(({ isAllDay: _isAllDay, ...event }) => event);
  });

  // The import dialog (issue #445): the events of one day. Null when the
  // setting is off or access is not fullAccess, so the renderer imports
  // with no dialog. Events are clamped to the server limits.
  ipcMain.handle(
    "calendar:list-range",
    async (
      _event,
      range: { from: number; to: number },
    ): Promise<CalendarEvent[] | null> => {
      const { from, to } = range ?? {};
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
        return null;
      }
      const events = await listRangeEvents(
        { isEnabled: () => isCalendarEnabled(serverFetch) },
        from,
        to,
      );
      return (
        events?.map(({ isAllDay: _isAllDay, ...event }: ListedEvent) =>
          clampEvent(event),
        ) ?? null
      );
    },
  );

  ipcMain.on("calendar:open-settings", () => {
    if (process.platform !== "darwin") return;
    void shell.openExternal(CALENDARS_SETTINGS_URL);
  });
}
