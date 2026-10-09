// Hidden window that captures microphone audio for meeting recordings.
// The main process creates it. The renderer sends PCM chunks over IPC.
import { join } from "node:path";
import { BrowserWindow } from "electron";
import { SETTINGS_KEYS } from "../../shared/settings-keys";
import { getMeetingCaptureURL } from "../renderer-urls";
import { serverFetch } from "../server-target";

/**
 * Hidden mic-capture window for meeting recordings. Loads the minimal
 * meeting-capture entry (PCM AudioWorklet -> `meeting:mic-chunk` IPC). The
 * configured mic device id is a server-owned setting, so the URL is resolved
 * asynchronously after creation; capture starts on page load.
 */
export function createMeetingCaptureWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      // Capture must keep flowing while the hidden window is occluded.
      backgroundThrottling: false,
    },
  });

  void (async () => {
    let deviceParam = "";
    try {
      const res = await serverFetch(`/settings/${SETTINGS_KEYS.micDeviceId}`);
      if (res.ok) {
        const { value } = (await res.json()) as { value?: string };
        if (value) deviceParam = `?device=${encodeURIComponent(value)}`;
      }
    } catch {
      // no configured device — use the default mic
    }
    if (!win.isDestroyed()) {
      void win.loadURL(`${getMeetingCaptureURL()}${deviceParam}`);
    }
  })();

  return win;
}
