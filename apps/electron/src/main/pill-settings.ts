// Settings that the pill window caches. The Settings page (IPC relays in
// ipc/core-ipc.ts) and an agent change through MCP (agent-changes.ts) call
// these functions, so both paths send the same message.
import { normalizePillCancelMode } from "../shared/pill-cancel";
import { state } from "./main-state";

export function sendOutputModeToPill(mode: string): void {
  state.mainWindow?.webContents.send("settings:output-mode-changed", mode);
}

export function sendSoundEnabledToPill(enabled: boolean): void {
  state.mainWindow?.webContents.send("settings:sound-enabled-changed", enabled);
}

export function sendPillCancelModeToPill(mode: unknown): void {
  state.mainWindow?.webContents.send(
    "settings:pill-cancel-mode-changed",
    normalizePillCancelMode(mode),
  );
}

export function sendAudioPlaybackModeToPill(mode: string): void {
  state.mainWindow?.webContents.send(
    "settings:audio-playback-mode-changed",
    mode,
  );
}

/**
 * llm_cleanup or a cleanup tone changed. The pill reads its cached routing
 * decision again, so a recording start does not fetch /api/settings.
 */
export function sendCleanupContextChangedToPill(): void {
  state.mainWindow?.webContents.send("settings:cleanup-context-changed");
}
