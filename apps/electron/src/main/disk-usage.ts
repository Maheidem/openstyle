/**
 * Settings → Data disk usage (UX-08, specs/lean-audit-2026-09.md T1-5).
 *
 * Sizes the two things that actually grow on a user's disk — meeting audio
 * under `<userData>/meetings` and the local-model caches — with a fully
 * asynchronous walk. Everything runs on the main process's libuv thread pool
 * behind an `ipcMain.handle`, so the settings renderer only ever awaits an
 * IPC round-trip and can never jank, no matter how many gigabytes are being
 * walked.
 */

import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { getLocalModelCacheDirs } from "@openstyle/server";
import { app, ipcMain } from "electron";

export interface DiskUsageResult {
  /** Bytes under <userData>/meetings (0 when no meetings are stored). */
  meetingsBytes: number;
  /** Bytes across the local-model cache dirs (whisper, MLX, HF repos). */
  modelsBytes: number;
}

/** du-style recursive size of one directory; unreadable entries count 0. */
async function dirSize(path: string): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return 0; // missing dir or unreadable — nothing to count
  }
  let total = 0;
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      total += await dirSize(child);
    } else if (entry.isFile()) {
      try {
        total += (await stat(child)).size;
      } catch {
        // vanished mid-walk — skip it
      }
    }
  }
  return total;
}

export function registerDiskUsageIpc(): void {
  ipcMain.handle("data:get-disk-usage", async (): Promise<DiskUsageResult> => {
    const meetingsRoot = join(app.getPath("userData"), "meetings");
    const [meetingsBytes, ...modelSizes] = await Promise.all([
      dirSize(meetingsRoot),
      ...getLocalModelCacheDirs().map((dir) => dirSize(dir)),
    ]);
    return {
      meetingsBytes,
      modelsBytes: modelSizes.reduce((a, b) => a + b, 0),
    };
  });
}
