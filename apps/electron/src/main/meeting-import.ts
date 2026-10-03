/**
 * Meeting-import main-process plumbing (specs/meeting-import.md §4.4): pick
 * an audio file via the native dialog and upload it to
 * `POST /api/meetings/import`, which normalizes it to 16 kHz mono PCM16 at
 * `<userData>/meetings/<id>/system.wav` and inserts a `meetings` row in
 * `recorded` status. This file mirrors `import-audio.ts` (dictation Import
 * screen). The renderer sees only a path string. The bytes stream from disk
 * here. Client-side extension and size checks fail fast, before any upload.
 *
 * The `audio_dir` uses the same root as `meeting-recorder.ts`
 * (`join(app.getPath("userData"), MEETINGS_DIR_NAME, id)`). Because of this,
 * the server DELETE containment check and the retention sweep treat an
 * imported meeting like a recorded meeting.
 *
 * `started_at` comes from the file's mtime so an imported back-catalog file
 * lands at its recorded date in the timeline (spec §7.1's preferred option).
 */

import { randomUUID } from "node:crypto";
import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { createAppLogger, errorMessage } from "@openstyle/utils";
import {
  IMPORT_EXTENSIONS,
  MAX_IMPORT_BYTES,
  MEETINGS_DIR_NAME,
  type MeetingDetail,
  type MeetingImportResult,
} from "@openstyle/validations";
import { app, type BrowserWindow, dialog, ipcMain } from "electron";
import type { ServerFetch } from "../shared/server-auth";

const log = createAppLogger("meeting-import");

function isE2E(): boolean {
  return (process.env.OPENSTYLE_E2E ?? process.env.FREESTYLE_E2E) === "1";
}

function extensionOf(path: string): string {
  return extname(path).replace(/^\./, "").toLowerCase();
}

interface RegisterMeetingImportIpcOptions {
  serverFetch: ServerFetch;
  getParentWindow: () => BrowserWindow | null;
}

export function registerMeetingImportIpc({
  serverFetch,
  getParentWindow,
}: RegisterMeetingImportIpcOptions): void {
  ipcMain.handle(
    "meeting-import:pick-file",
    async (): Promise<string | null> => {
      if (isE2E() && process.env.OPENSTYLE_E2E_MEETING_IMPORT_FILE) {
        return process.env.OPENSTYLE_E2E_MEETING_IMPORT_FILE;
      }

      const parent = getParentWindow();
      const { canceled, filePaths } = parent
        ? await dialog.showOpenDialog(parent, {
            properties: ["openFile"],
            filters: [{ name: "Audio", extensions: [...IMPORT_EXTENSIONS] }],
          })
        : await dialog.showOpenDialog({
            properties: ["openFile"],
            filters: [{ name: "Audio", extensions: [...IMPORT_EXTENSIONS] }],
          });

      return canceled || filePaths.length === 0 ? null : filePaths[0];
    },
  );

  ipcMain.handle(
    "meeting-import:transcribe",
    async (
      _event,
      path: string,
      opts?: { title?: string },
    ): Promise<MeetingImportResult> => {
      if (isE2E()) {
        const g = globalThis as {
          __openstyleE2E?: { meetingImportCalls?: number };
        };
        g.__openstyleE2E ??= {};
        g.__openstyleE2E.meetingImportCalls =
          (g.__openstyleE2E.meetingImportCalls ?? 0) + 1;
      }

      const ext = extensionOf(path);
      if (!(IMPORT_EXTENSIONS as readonly string[]).includes(ext)) {
        return {
          ok: false,
          status: 415,
          code: "UNSUPPORTED_MEDIA_TYPE",
          error: `Unsupported format: .${ext || "unknown"}`,
        };
      }

      let size: number;
      let startedAt: number;
      try {
        const info = await stat(path);
        size = info.size;
        startedAt = Math.round(info.mtimeMs);
      } catch (err) {
        log.debug("meeting-import:transcribe stat failed", {
          ext,
          message: errorMessage(err),
        });
        return {
          ok: false,
          status: 404,
          code: "FILE_NOT_FOUND",
          error: "File not found",
        };
      }

      if (size > MAX_IMPORT_BYTES) {
        return {
          ok: false,
          status: 413,
          code: "PAYLOAD_TOO_LARGE",
          error: "File too large",
        };
      }

      // Same id/dir contract the recorder produces: the server requires
      // `basename(audio_dir) === id`, and DELETE/retention only treat dirs
      // under `<userData>/meetings` as meeting-owned audio.
      const id = randomUUID();
      const audioDir = join(app.getPath("userData"), MEETINGS_DIR_NAME, id);

      try {
        const blob = await openAsBlob(path);
        const form = new FormData();
        form.append("audio", blob, basename(path));
        form.append("id", id);
        form.append("audio_dir", audioDir);
        // Optional explicit title; when absent the server falls back to the
        // filename stem (its `title ?? stem(filename)` rule).
        const title = opts?.title?.trim();
        if (title) form.append("title", title);
        form.append("started_at", String(startedAt));

        const response = await serverFetch("/meetings/import", {
          method: "POST",
          body: form,
        });

        const json = (await response.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;

        log.debug("meeting-import:transcribe response", {
          ext,
          bytes: size,
          status: response.status,
        });

        if (response.ok) {
          return {
            ok: true,
            meeting: json as unknown as MeetingDetail,
          };
        }
        // Surface the server's message verbatim (localized-enough: these are
        // fixed strings like "File too large"), with a generic fallback when
        // the body isn't JSON.
        return {
          ok: false,
          status: response.status,
          error:
            typeof json.error === "string" && json.error
              ? json.error
              : "Import failed",
          detail: typeof json.detail === "string" ? json.detail : undefined,
          code: typeof json.code === "string" ? json.code : undefined,
        };
      } catch (err) {
        const message = errorMessage(err);
        log.debug("meeting-import:transcribe fetch failed", {
          ext,
          bytes: size,
          message,
        });
        return { ok: false, error: "Server unreachable", detail: message };
      }
    },
  );
}
