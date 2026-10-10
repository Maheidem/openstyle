/**
 * Map a Chromium mic device id to a device label.
 *
 * The Settings page stores `mic_device_id` as a Chromium
 * `MediaDeviceInfo.deviceId`. Core Audio does not know this id. The label of
 * the same device is the Core Audio device name, so the helper can find it.
 * Only a renderer can run `enumerateDevices()`. So this function asks an
 * open renderer and returns null when no renderer can answer.
 */

import { createAppLogger } from "@openstyle/utils";
import type { BrowserWindow } from "electron";

const log = createAppLogger("meeting-mic-label");

/** A stuck renderer must not block the start of a recording. */
const LABEL_TIMEOUT_MS = 2000;

async function labelFromWindow(
  win: BrowserWindow,
  deviceId: string,
): Promise<string | null> {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return null;
  if (win.webContents.isLoading()) return null;
  const script = `navigator.mediaDevices.enumerateDevices().then((devices) => {
    const found = devices.find((d) => d.kind === "audioinput" && d.deviceId === ${JSON.stringify(deviceId)});
    return found ? found.label : "";
  })`;
  const label: unknown = await Promise.race([
    win.webContents.executeJavaScript(script),
    new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), LABEL_TIMEOUT_MS),
    ),
  ]);
  return typeof label === "string" && label.length > 0 ? label : null;
}

/**
 * Ask each window in order. Return the first non-empty label, or null.
 * An empty label means that the renderer has no mic permission yet.
 */
export async function resolveMicLabel(
  deviceId: string,
  windows: (BrowserWindow | null)[],
): Promise<string | null> {
  for (const win of windows) {
    if (!win) continue;
    try {
      const label = await labelFromWindow(win, deviceId);
      if (label) return label;
    } catch (err) {
      log.debug(`Mic label lookup failed in one window: ${String(err)}`);
    }
  }
  return null;
}
