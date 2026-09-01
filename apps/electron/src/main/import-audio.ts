/**
 * Import screen main-process plumbing: pick a file via the native dialog and
 * upload it to `POST /api/transcribe/file`. The renderer only ever sees a
 * path string (resolved via preload `webUtils.getPathForFile`) — the actual
 * bytes are streamed from disk here so a large recording never lives in
 * renderer memory.
 */

import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { createAppLogger } from "@openstyle/utils";
import { type BrowserWindow, dialog, ipcMain } from "electron";

const log = createAppLogger("import");

const IMPORT_EXTENSIONS = ["wav", "mp3", "m4a", "aac", "ogg", "mp4"] as const;
const MAX_IMPORT_BYTES = 1024 * 1024 * 1024; // 1 GiB

function isE2E(): boolean {
  return (process.env.OPENSTYLE_E2E ?? process.env.FREESTYLE_E2E) === "1";
}

function extensionOf(path: string): string {
  return extname(path).replace(/^\./, "").toLowerCase();
}

type ImportAudioResult =
  | {
      ok: true;
      raw: string;
      cleaned: string;
      model: string;
      audioDurationMs?: number;
      durationMs?: number;
    }
  | {
      ok: false;
      status?: number;
      error: string;
      detail?: string;
      code?: string;
      reason?: string;
    };

interface RegisterImportIpcOptions {
  getServerBaseUrl: () => string;
  getServerAuthHeaders: () => Record<string, string>;
  getParentWindow: () => BrowserWindow | null;
}

export function registerImportIpc({
  getServerBaseUrl,
  getServerAuthHeaders,
  getParentWindow,
}: RegisterImportIpcOptions): void {
  ipcMain.handle("import:pick-file", async (): Promise<string | null> => {
    if (isE2E() && process.env.OPENSTYLE_E2E_IMPORT_FILE) {
      return process.env.OPENSTYLE_E2E_IMPORT_FILE;
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
  });

  ipcMain.handle(
    "import:transcribe-file",
    async (_event, path: string): Promise<ImportAudioResult> => {
      if (isE2E()) {
        const g = globalThis as { __openstyleE2E?: { importCalls: number } };
        g.__openstyleE2E ??= { importCalls: 0 };
        g.__openstyleE2E.importCalls += 1;
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
      try {
        const info = await stat(path);
        size = info.size;
      } catch (err) {
        log.debug("import:transcribe-file stat failed", {
          ext,
          message: err instanceof Error ? err.message : String(err),
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

      try {
        const blob = await openAsBlob(path);
        const form = new FormData();
        form.append("audio", blob, basename(path));

        const response = await fetch(
          `${getServerBaseUrl()}/api/transcribe/file`,
          {
            method: "POST",
            headers: getServerAuthHeaders(),
            body: form,
          },
        );

        const json = (await response.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;

        log.debug("import:transcribe-file response", {
          ext,
          bytes: size,
          status: response.status,
        });

        if (response.ok) {
          return { ...json, ok: true } as ImportAudioResult;
        }
        return {
          ...json,
          ok: false,
          status: response.status,
        } as ImportAudioResult;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.debug("import:transcribe-file fetch failed", {
          ext,
          bytes: size,
          message,
        });
        return { ok: false, error: "Server unreachable", detail: message };
      }
    },
  );
}
