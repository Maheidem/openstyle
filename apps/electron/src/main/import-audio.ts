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
import { claimAbortableJob, releaseAbortableJob } from "./abortable-jobs";

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

/** A picked import candidate: on-disk path plus its size in bytes. */
export interface PickedImportFile {
  path: string;
  size: number;
}

interface RegisterImportIpcOptions {
  getServerBaseUrl: () => string;
  getServerAuthHeaders: () => Record<string, string>;
  getParentWindow: () => BrowserWindow | null;
  /**
   * Fired when an upload finishes with a transcript (UX-04/UX-A4): the
   * caller raises the native "Transcript ready" completion notification.
   */
  onTranscribed?: (info: { fileName: string }) => void;
}

export function registerImportIpc({
  getServerBaseUrl,
  getServerAuthHeaders,
  getParentWindow,
  onTranscribed,
}: RegisterImportIpcOptions): void {
  ipcMain.handle(
    "import:pick-file",
    async (): Promise<PickedImportFile | null> => {
      let path: string | null = null;
      if (isE2E() && process.env.OPENSTYLE_E2E_IMPORT_FILE) {
        path = process.env.OPENSTYLE_E2E_IMPORT_FILE;
      } else {
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
        path = canceled || filePaths.length === 0 ? null : filePaths[0];
      }
      if (!path) return null;
      // Size for the pre-upload weight hint (UX-A3). The picker path has no
      // `File` object in the renderer, so stat here; unreadable still returns
      // the path with size 0 and lets the review card show honest copy.
      try {
        return { path, size: (await stat(path)).size };
      } catch {
        return { path, size: 0 };
      }
    },
  );

  ipcMain.handle(
    "import:transcribe-file",
    async (
      _event,
      path: string,
      opts?: { id?: string },
    ): Promise<ImportAudioResult> => {
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

      // Abort seam (UX-04): the renderer passes a job id it can later cancel
      // via `job:abort`; see abortable-jobs.ts. Aborting severs this fetch,
      // not the server-side pipeline.
      const jobId = typeof opts?.id === "string" && opts.id ? opts.id : null;
      const controller = jobId
        ? claimAbortableJob(jobId)
        : new AbortController();

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
            signal: controller.signal,
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
          onTranscribed?.({ fileName: basename(path) });
          return { ...json, ok: true } as ImportAudioResult;
        }
        return {
          ...json,
          ok: false,
          status: response.status,
        } as ImportAudioResult;
      } catch (err) {
        if (controller.signal.aborted) {
          log.debug("import:transcribe-file cancelled", { ext, bytes: size });
          return {
            ok: false,
            code: "CANCELLED",
            error: "Cancelled by user",
          };
        }
        const message = err instanceof Error ? err.message : String(err);
        log.debug("import:transcribe-file fetch failed", {
          ext,
          bytes: size,
          message,
        });
        return { ok: false, error: "Server unreachable", detail: message };
      } finally {
        if (jobId) releaseAbortableJob(jobId);
      }
    },
  );
}
