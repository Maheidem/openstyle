// The app-shell settings for an agent (specs/mcp.md 6.4). The server asks
// main with { type: "app-settings-request", id, patch } over the utility
// process port (server-host.ts). This file reads or changes the settings
// with the same functions as the Settings IPC handlers, and builds the
// answer { type: "app-settings-result", id, ok, settings | error }.
// It never reads or returns `serverToken` or any other key of settings.json.
import { createAppLogger } from "@openstyle/utils";
import { app } from "electron";
import { isLaunchAtLogin, setLaunchAtLogin } from "./app-settings-ipc";
import { applyPillPosition } from "./ipc/core-ipc";
import { readSettings, writeSettings } from "./local-settings";
import {
  isUpdateChannel,
  resolveChannel,
  runningVersion,
} from "./update-channel";
import { switchUpdateChannel } from "./updater";

const log = createAppLogger("electron");

const PILL_PRESETS = new Set([
  "top-center",
  "top-right",
  "bottom-center",
  "bottom-right",
]);

export interface AppSettingsRequestMessage {
  type: "app-settings-request";
  id: number;
  patch: Record<string, unknown> | null;
}

export type AppSettingsResultMessage =
  | {
      type: "app-settings-result";
      id: number;
      ok: true;
      settings: AgentAppSettings;
    }
  | { type: "app-settings-result"; id: number; ok: false; error: string };

export interface AgentAppSettings {
  /** A preset, or "custom" after the user dragged the pill. */
  pill_position: string;
  auto_update: boolean;
  update_channel: "stable" | "dev";
  launch_at_login: boolean;
}

function currentSettings(): AgentAppSettings {
  const saved = readSettings();
  const pill = typeof saved.pillPosition === "string" ? saved.pillPosition : "";
  return {
    pill_position: pill.startsWith("custom")
      ? "custom"
      : pill || "bottom-center",
    auto_update: saved.autoUpdate !== false,
    update_channel: resolveChannel(
      saved.updateChannel,
      runningVersion(app.getVersion()),
    ),
    launch_at_login: isLaunchAtLogin(),
  };
}

/** Check the whole patch first, so a bad field changes nothing. */
function patchProblem(patch: Record<string, unknown>): string | null {
  const known = [
    "pill_position",
    "auto_update",
    "update_channel",
    "launch_at_login",
  ];
  for (const key of Object.keys(patch)) {
    if (!known.includes(key)) return `Unknown app setting: ${key}`;
  }
  const { pill_position, auto_update, update_channel, launch_at_login } = patch;
  if (
    pill_position !== undefined &&
    !(typeof pill_position === "string" && PILL_PRESETS.has(pill_position))
  ) {
    return "pill_position must be top-center, top-right, bottom-center or bottom-right";
  }
  if (auto_update !== undefined && typeof auto_update !== "boolean") {
    return "auto_update must be true or false";
  }
  if (update_channel !== undefined && !isUpdateChannel(update_channel)) {
    return "update_channel must be stable or dev";
  }
  if (launch_at_login !== undefined && typeof launch_at_login !== "boolean") {
    return "launch_at_login must be true or false";
  }
  return null;
}

/** Read (patch null) or change the app-shell settings, then answer. */
export function handleAppSettingsRequest(
  request: AppSettingsRequestMessage,
): AppSettingsResultMessage {
  const { id, patch } = request;
  try {
    if (patch) {
      const problem = patchProblem(patch);
      if (problem) {
        return { type: "app-settings-result", id, ok: false, error: problem };
      }
      if (typeof patch.pill_position === "string") {
        applyPillPosition(patch.pill_position);
      }
      // The body of the settings:set-auto-update handler.
      if (typeof patch.auto_update === "boolean") {
        writeSettings({ autoUpdate: patch.auto_update });
      }
      if (typeof patch.launch_at_login === "boolean") {
        setLaunchAtLogin(patch.launch_at_login);
      }
      if (isUpdateChannel(patch.update_channel)) {
        // The switch saves the channel at once, then checks the feed. The
        // answer does not wait for the check (it can take longer than the
        // 5 s wait of the server).
        void switchUpdateChannel(patch.update_channel).catch((err) =>
          log.warn(`Agent channel switch failed: ${String(err)}`),
        );
      }
      log.info(`Agent changed app settings: ${Object.keys(patch).join(", ")}`);
    }
    return {
      type: "app-settings-result",
      id,
      ok: true,
      settings: currentSettings(),
    };
  } catch (err) {
    return {
      type: "app-settings-result",
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
