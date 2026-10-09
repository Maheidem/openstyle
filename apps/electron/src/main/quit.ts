// Quit handlers for the Electron main process.
// Register once at startup. Cleanup stops native children, listeners and timers.
// A normal quit ends the process with app.exit(0) in a finally block.

import { stopMlxServer, stopWhisperServer } from "@openstyle/server";
import { createAppLogger } from "@openstyle/utils";
import { app, globalShortcut } from "electron";
import {
  cancelDictationRetries,
  cancelLanguageRetries,
} from "./hotkeys/dictation";
import { state, stopHotkeyRecorderProcess } from "./main-state";
import { stopLinuxPasteHelper } from "./paste";
import { cancelRemixRetries } from "./remix/hotkey";
import { showSettingsWindow } from "./windows/settings-window";

const log = createAppLogger("electron");

export function registerQuitHandlers(): void {
  // Keep app running in background when windows are closed (tray stays active)
  app.on("window-all-closed", () => {
    // Stay alive for the tray. Quit only through the tray menu.
  });

  // Re-open the dashboard when the app is activated (e.g. clicking the dock
  // icon or relaunching) and no dashboard window is currently open.
  app.on("activate", () => {
    showSettingsWindow();
  });

  let isQuitting = false;

  // Stop every native child process and timer. The before-quit handler runs
  // this on a normal quit and on an updater quit. A normal quit then calls
  // app.exit(0), which skips will-quit.
  function cleanupBeforeQuit(): void {
    // Finalize any in-flight meeting recording's WAV headers before the process
    // exits; the boot-time orphan sweep settles the DB row next launch.
    state.meetingRecorder?.stopSync();
    state.audioPlaybackController.restoreSync();
    stopLinuxPasteHelper();
    stopWhisperServer().catch(() => {});
    stopMlxServer().catch(() => {});
    cancelDictationRetries();
    cancelRemixRetries();
    cancelLanguageRetries();
    if (state.keyListener) {
      state.keyListener.stop();
      state.keyListener = null;
    }
    if (state.remixKeyListener) {
      state.remixKeyListener.stop();
      state.remixKeyListener = null;
    }
    for (const listener of state.languageKeyListeners.values()) {
      listener.stop();
    }
    state.languageKeyListeners.clear();
    state.languageHotkeyAccels.clear();
    if (state.remixBarFollowTimer) {
      clearInterval(state.remixBarFollowTimer);
      state.remixBarFollowTimer = null;
    }
    stopHotkeyRecorderProcess();
    globalShortcut.unregisterAll();
    if (state.httpServer) {
      state.httpServer.close();
      state.httpServer = null;
    }
  }

  // A signal ends the process with no "exit" event unless a handler runs.
  // Quit through Electron so the exit hooks that stop the whisper and MLX child
  // servers run. The before-quit handler always ends with app.exit(0).
  process.on("SIGINT", () => app.quit());
  process.on("SIGTERM", () => app.quit());

  app.on("before-quit", (event) => {
    if (state.isUpdaterQuitting) {
      try {
        cleanupBeforeQuit();
      } catch (err) {
        log.warn(
          `cleanup before updater quit failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return;
    }
    if (isQuitting) return;
    isQuitting = true;
    event.preventDefault();
    // We preventDefault above, so `app.exit(0)` is the only thing that ends the
    // process. Keep it in a `finally` — if any cleanup step throws (a native
    // listener already torn down, a dead child process), the app would otherwise
    // stay alive forever with no windows, which is what a hung quit looks like.
    try {
      cleanupBeforeQuit();
    } catch (err) {
      log.warn(
        `cleanup before quit failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      app.exit(0);
    }
  });
}
