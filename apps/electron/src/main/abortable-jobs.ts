/**
 * Registry of in-flight, user-cancellable main-process jobs.
 *
 * `AbortSignal`s cannot cross the IPC boundary, so jobs that the renderer can
 * cancel (import uploads today; the streamed-import rework and meeting-import
 * later) adopt this seam instead: the renderer owns a job id, passes it in the
 * options of the invoke that starts the job, and later sends `job:abort` with
 * the same id. The handler-side pattern:
 *
 *   const controller = claimAbortableJob(id);
 *   try { await fetch(url, { signal: controller.signal }) }
 *   finally { releaseAbortableJob(id) }
 *
 * Aborting only severs the main-process side of the wait (the fetch and
 * anything downstream of it) — it is not a server-side cancellation.
 */

import { ipcMain } from "electron";

const jobs = new Map<string, AbortController>();

/** Register (or replace) the controller for a job id and hand it to the job. */
export function claimAbortableJob(id: string): AbortController {
  const existing = jobs.get(id);
  if (existing) return existing;
  const controller = new AbortController();
  jobs.set(id, controller);
  return controller;
}

/** Drop a finished job's controller. Safe to call for unknown ids. */
export function releaseAbortableJob(id: string): void {
  jobs.delete(id);
}

/** Wire the renderer-side cancel channel. Call once at boot. */
export function registerJobAbortIpc(): void {
  ipcMain.on("job:abort", (_event, id: unknown) => {
    if (typeof id === "string" && id) jobs.get(id)?.abort();
  });
}
