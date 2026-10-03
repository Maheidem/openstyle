/**
 * Meeting Mode IPC handlers: record control, mic chunk intake, system-audio
 * probe and reveal-in-Finder. The handler bodies come from the `whenReady`
 * block in `index.ts`. The channel names and return values are the same.
 * `index.ts` still builds the `MeetingRecorder`. This file reads it through
 * `getMeetingRecorder`, because `index.ts` sets it after boot.
 */

import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { AppType } from "@openstyle/server";
import { createAppLogger } from "@openstyle/utils";
import { MEETINGS_DIR_NAME } from "@openstyle/validations";
import { app, ipcMain, shell } from "electron";
import type { hc } from "hono/client";
import type { MeetingRecorder } from "./meeting-recorder";
import { isSystemAudioCaptureSupported } from "./system-audio-capture";
import {
  openAudioCaptureSettings,
  probeSystemAudio,
} from "./system-audio-probe";

const log = createAppLogger("electron");

interface RegisterMeetingIpcOptions {
  getMeetingRecorder: () => MeetingRecorder | null;
  /** Typed client for the in-process server. */
  serverClient: () => ReturnType<typeof hc<AppType>>;
}

export function registerMeetingIpc({
  getMeetingRecorder,
  serverClient,
}: RegisterMeetingIpcOptions): void {
  ipcMain.handle("meeting:start", async () => {
    try {
      const id = await getMeetingRecorder()!.start();
      return { ok: true, id };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle("meeting:stop", async () => {
    await getMeetingRecorder()?.stop();
    return { ok: true };
  });

  ipcMain.handle("meeting:status", () => {
    const meetingRecorder = getMeetingRecorder();
    return {
      status: meetingRecorder?.status ?? "idle",
      meetingId: meetingRecorder?.currentMeetingId ?? null,
      supported: isSystemAudioCaptureSupported(),
    };
  });

  // Mic PCM16 chunks from the hidden capture window. Only that window's
  // webContents may feed the recorder — chunks from any other renderer
  // (main window, settings) are dropped.
  ipcMain.on("meeting:mic-chunk", (event, chunk: unknown) => {
    const meetingRecorder = getMeetingRecorder();
    if (event.sender.id !== meetingRecorder?.captureWebContentsId) return;
    if (chunk instanceof ArrayBuffer) {
      meetingRecorder.handleMicChunk(Buffer.from(chunk));
    } else if (ArrayBuffer.isView(chunk)) {
      meetingRecorder.handleMicChunk(
        Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength),
      );
    }
  });

  ipcMain.on("meeting:capture-error", (event, message: unknown) => {
    if (event.sender.id !== getMeetingRecorder()?.captureWebContentsId) return;
    log.error(`Meeting mic capture error: ${String(message)}`);
  });

  // TCC probe: run the real system-audio pipeline briefly to detect the
  // silent-denial mode (denied taps deliver zero-filled buffers with success
  // codes — there is no preflight API). Meeting-scoped and lazy by design:
  // dictation-only users must never see this (startupPermissionWarning in
  // permission-checks.ts intentionally knows nothing about meetings).
  ipcMain.handle("meeting:probe-system-audio", async () => {
    // A running recording already proves the pipeline; don't spawn a second
    // helper under it.
    if (getMeetingRecorder()?.status !== "idle") return "ok";
    return probeSystemAudio();
  });

  ipcMain.on("meeting:open-audio-capture-settings", () => {
    openAudioCaptureSettings();
  });

  // Reveal a meeting's audio directory in Finder. The audio_dir path comes
  // from the server-owned DB row, so mirror the same containment check the
  // server's DELETE route applies before it removes a meeting's audio dir —
  // never call shell.showItemInFolder on a path outside <userData>/meetings/.
  ipcMain.handle("meeting:reveal-in-finder", async (_event, id: unknown) => {
    if (typeof id !== "string" || !id) return false;
    try {
      const res = await serverClient().api.meetings[":id"].$get({
        param: { id },
      });
      if (!res.ok) return false;
      const row = (await res.json()) as { audio_dir: string | null };
      if (!row.audio_dir) return false;
      const dir = resolve(row.audio_dir);
      const root = resolve(join(app.getPath("userData"), MEETINGS_DIR_NAME));
      if (!dir.startsWith(root + sep)) return false;
      if (!existsSync(dir)) return false;
      shell.showItemInFolder(dir);
      return true;
    } catch (err) {
      log.error(`Failed to reveal meeting ${id} in Finder: ${String(err)}`);
      return false;
    }
  });
}
