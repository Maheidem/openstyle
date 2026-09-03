/**
 * Meeting-import main-process plumbing (specs/meeting-import.md §4.4): pick
 * an audio file via the native dialog and upload it to
 * `POST /api/meetings/import`, which normalizes it to 16 kHz mono PCM16 at
 * `<userData>/meetings/<id>/system.wav` and inserts a `meetings` row in
 * `recorded` status. Mirrors `import-audio.ts` (dictation Import screen):
 * the renderer only ever sees a path string, the bytes stream from disk
 * here, and client-side extension/size checks fail fast before any upload.
 *
 * The `audio_dir` is computed with the same root `meeting-recorder.ts` uses
 * (`join(app.getPath("userData"), "meetings", id)`) — that's what makes
 * server-side DELETE containment and the retention sweep treat an imported
 * meeting exactly like a recorded one.
 *
 * `started_at` comes from the file's mtime so an imported back-catalog file
 * lands at its recorded date in the timeline (spec §7.1's preferred option).
 */

import { randomUUID } from "node:crypto";
import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { createAppLogger } from "@openstyle/utils";
import { app, type BrowserWindow, dialog, ipcMain } from "electron";

const log = createAppLogger("meeting-import");

// Kept local rather than imported from @openstyle/server: the server package
// only exports its root (see apps/server/package.json `exports`), and
// duplicating the two checks is the established precedent in import-audio.ts.
const IMPORT_EXTENSIONS = ["wav", "mp3", "m4a", "aac", "ogg", "mp4"] as const;
const MAX_IMPORT_BYTES = 1024 * 1024 * 1024; // 1 GiB

function isE2E(): boolean {
  return (process.env.OPENSTYLE_E2E ?? process.env.FREESTYLE_E2E) === "1";
}

function extensionOf(path: string): string {
  return extname(path).replace(/^\./, "").toLowerCase();
}

/**
 * A freshly imported meeting in the exact `GET /api/meetings/:id` response
 * shape (row + `job`/`segment_counts`/`summary`, constructed by the route).
 * Kept structural so it can be mirrored (without a runtime import) in
 * `preload/index.ts` and `preload/index.d.ts`, like `ImportAudioResult`.
 */
export interface ImportedMeeting {
  id: string;
  title: string | null;
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number | null;
  status: string;
  language: string | null;
  error: string | null;
  created_at: number | null;
  stt_provider: string | null;
  stt_model: string | null;
  audio_dir: string | null;
  context: string | null;
  job: { done: number; total: number; failed: number } | null;
  segment_counts: { total: number; failed: number };
  summary: {
    markdown: string | null;
    llm_provider: string | null;
    llm_model: string | null;
    cost_usd: number | null;
    created_at: number | null;
  } | null;
}

export type MeetingImportResult =
  | { ok: true; meeting: ImportedMeeting }
  | {
      ok: false;
      status?: number;
      error: string;
      detail?: string;
      code?: string;
    };

interface RegisterMeetingImportIpcOptions {
  getServerBaseUrl: () => string;
  getServerAuthHeaders: () => Record<string, string>;
  getParentWindow: () => BrowserWindow | null;
}

export function registerMeetingImportIpc({
  getServerBaseUrl,
  getServerAuthHeaders,
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

      // Same id/dir contract the recorder produces: the server requires
      // `basename(audio_dir) === id`, and DELETE/retention only treat dirs
      // under `<userData>/meetings` as meeting-owned audio.
      const id = randomUUID();
      const audioDir = join(app.getPath("userData"), "meetings", id);

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

        const response = await fetch(
          `${getServerBaseUrl()}/api/meetings/import`,
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

        log.debug("meeting-import:transcribe response", {
          ext,
          bytes: size,
          status: response.status,
        });

        if (response.ok) {
          return {
            ok: true,
            meeting: json as unknown as ImportedMeeting,
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
        const message = err instanceof Error ? err.message : String(err);
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
