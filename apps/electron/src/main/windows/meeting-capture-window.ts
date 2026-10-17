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
 *
 * `micLabel` is the name of the mic that replaces a transient Bluetooth
 * default input (#169). The page then opens the device with that label.
 */
export function createMeetingCaptureWindow(
  micLabel?: string | null,
): BrowserWindow {
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
    const params = new URLSearchParams();
    if (micLabel) params.set("label", micLabel);
    try {
      const res = await serverFetch(`/settings/${SETTINGS_KEYS.micDeviceId}`);
      if (res.ok) {
        const { value } = (await res.json()) as { value?: string };
        if (value) params.set("device", value);
      }
    } catch {
      // no configured device — use the default mic
    }
    const query = params.size > 0 ? `?${params.toString()}` : "";
    if (!win.isDestroyed()) {
      void win.loadURL(`${getMeetingCaptureURL()}${query}`);
    }
  })();

  return win;
}
