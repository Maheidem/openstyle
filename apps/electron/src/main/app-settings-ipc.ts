/**
 * App-level IPC handlers: server target, log folder, external links, error
 * dialog and the launch-time settings. The handler bodies come from the
 * `whenReady` block in `index.ts`. The channel names and return values are
 * the same. `ipc/core-ipc.ts` builds the deps. State from `main-state.ts` reaches this file through the
 * `deps` functions.
 */

import { createAppLogger } from "@openstyle/utils";
import { serverUrlSchema } from "@openstyle/validations";
import { app, dialog, ipcMain, shell } from "electron";
import * as linuxAutostart from "./linux-autostart";

const log = createAppLogger("electron");

interface RegisterAppSettingsIpcOptions {
  getServerPort: () => number;
  getServerUrl: () => string;
  getServerToken: () => string;
  readSettings: () => Record<string, unknown>;
  writeSettings: (patch: Record<string, unknown>) => void;
  broadcastServerChanged: () => void;
  /** Folder of the diagnostic log file. An empty string means no folder. */
  logsDir: string;
}

export function registerAppSettingsIpc({
  getServerPort,
  getServerUrl,
  getServerToken,
  readSettings,
  writeSettings,
  broadcastServerChanged,
  logsDir,
}: RegisterAppSettingsIpcOptions): void {
  // IPC: expose the server port to the renderer
  ipcMain.handle("server:port", () => getServerPort());

  // IPC: read the configured server URL ("" = use the local server).
  ipcMain.handle("server:url", () => getServerUrl());

  // IPC: persist the server URL. The local server keeps running regardless, so
  // switching between local and a configured URL takes effect immediately —
  // renderers re-point their clients on the "server:changed" broadcast and on
  // the next transcription's refreshApiBase(). Invalid values are ignored.
  ipcMain.handle("server:set-url", (_event, url: unknown) => {
    const parsed = serverUrlSchema.safeParse(url);
    if (parsed.success) {
      writeSettings({ serverUrl: parsed.data });
      broadcastServerChanged();
    }
    return getServerUrl();
  });

  // IPC: read/persist the optional bearer token for a configured server.
  ipcMain.handle("server:token", () => getServerToken());
  ipcMain.handle("server:set-token", (_event, token: unknown) => {
    writeSettings({
      serverToken: typeof token === "string" ? token.trim() : "",
    });
    broadcastServerChanged();
    return getServerToken();
  });

  // IPC: reveal the diagnostic log folder so users can share openstyle.log.
  ipcMain.handle("logs:open-folder", async () => {
    if (!logsDir) return false;
    try {
      const result = await shell.openPath(logsDir);
      if (result) {
        log.error(`Failed to open logs folder: ${result}`);
        return false;
      }
      return true;
    } catch (err) {
      log.error(`Failed to open logs folder: ${String(err)}`);
      return false;
    }
  });

  ipcMain.handle("open:external", async (_event, url: unknown) => {
    if (typeof url !== "string") return false;
    try {
      const parsed = new URL(url);
      // mailto: is allowed for support links; everything else must be http(s).
      if (
        parsed.protocol !== "https:" &&
        parsed.protocol !== "http:" &&
        parsed.protocol !== "mailto:"
      ) {
        return false;
      }
      await shell.openExternal(parsed.toString());
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle(
    "dialog:show-error",
    async (_event, title: string, detail: string) => {
      await dialog.showMessageBox({
        type: "error",
        title,
        message: title,
        detail,
        buttons: ["OK"],
      });
    },
  );

  // -- Auto-update setting IPC --
  ipcMain.handle("settings:auto-update", () => {
    return readSettings().autoUpdate !== false;
  });

  ipcMain.on("settings:set-auto-update", (_event, enabled: boolean) => {
    // autoDownload stays false in all cases (see the updater setup in
    // updater.ts). This setting only controls whether periodic update checks run.
    writeSettings({ autoUpdate: enabled });
  });

  // -- Launch at startup setting IPC --
  ipcMain.handle("settings:launch-at-startup", () => {
    if (process.platform === "linux") return linuxAutostart.isEnabled();
    return app.getLoginItemSettings().openAtLogin;
  });

  ipcMain.on("settings:set-launch-at-startup", (_event, enabled: boolean) => {
    if (process.platform === "linux") {
      linuxAutostart.setEnabled(enabled);
      return;
    }
    app.setLoginItemSettings({ openAtLogin: enabled });
  });

  // -- Show dashboard on launch setting IPC --
  ipcMain.handle("settings:show-dashboard-on-launch", () => {
    return readSettings().showDashboardOnLaunch !== false;
  });

  ipcMain.on(
    "settings:set-show-dashboard-on-launch",
    (_event, enabled: boolean) => {
      writeSettings({ showDashboardOnLaunch: enabled });
    },
  );
}
