// The image and tooltip of the tray icon. Recording, job and update states
// (issue #317). This file imports no window module, so the menus, the IPC
// and the tray popover can all call refreshTrayIcon without an import cycle.
import type { JobsResponse } from "@openstyle/validations";
import { nativeImage } from "electron";
import trayJobIconPath from "../../resources/tray/logoJobTemplate.png?asset";
import trayRecordingIconPath from "../../resources/tray/logoRecording.png?asset";
import trayIconPath from "../../resources/tray/logoTemplate.png?asset";
import trayUpdateIconPath from "../../resources/tray/logoUpdateTemplate.png?asset";
import { state } from "./main-state";
import { serverFetch } from "./server-target";
import { type TrayAppearance, trayAppearance } from "./tray-appearance";

/** How often main asks the server for jobs, for the ring icon. */
const JOB_WATCH_MS = 5000;

const ICON_PATHS: Record<TrayAppearance["icon"], string> = {
  default: trayIconPath,
  recording: trayRecordingIconPath,
  job: trayJobIconPath,
  update: trayUpdateIconPath,
};

let jobRunning = false;
let jobWatch: NodeJS.Timeout | null = null;

/** The look for the current state of main. */
export function currentTrayAppearance(): TrayAppearance {
  return trayAppearance({
    recording: state.meetingRecorder?.status === "recording",
    job: jobRunning,
    updateReady: state.updateDownloadState === "downloaded",
  });
}

export function trayImage(look: TrayAppearance): Electron.NativeImage {
  // createFromPath also loads the @2x file next to the path.
  const image = nativeImage.createFromPath(ICON_PATHS[look.icon]);
  // A template image follows the light/dark menu bar on macOS.
  image.setTemplateImage(look.template);
  return image;
}

/**
 * Set the tray image and tooltip from the current state. It does nothing
 * when there is no tray (quiet E2E mode without OPENSTYLE_E2E_TRAY).
 */
export function refreshTrayIcon(): void {
  if (!state.tray) return;
  const look = currentTrayAppearance();
  state.tray.setImage(trayImage(look));
  state.tray.setToolTip(look.tooltip);
}

/** True when a meeting job or a model download or load runs or waits. */
export function hasActiveJob(jobs: JobsResponse): boolean {
  return (
    jobs.meetings.length > 0 ||
    jobs.models.some(
      (m) => m.status === "downloading" || m.status === "loading",
    )
  );
}

/**
 * Read GET /api/jobs every few seconds for the ring icon. The jobs start in
 * the server (a click in the app), so main has no event for them. The route
 * is in-process and read only.
 */
export function startTrayJobWatch(): void {
  if (jobWatch) return;
  const check = async (): Promise<void> => {
    try {
      const res = await serverFetch("/jobs");
      if (!res.ok) return;
      const running = hasActiveJob((await res.json()) as JobsResponse);
      if (running === jobRunning) return;
      jobRunning = running;
      refreshTrayIcon();
    } catch {
      // The server is not up yet. The next check tries again.
    }
  };
  jobWatch = setInterval(() => void check(), JOB_WATCH_MS);
  jobWatch.unref?.();
  void check();
}
