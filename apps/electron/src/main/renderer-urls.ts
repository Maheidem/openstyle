import { is } from "@electron-toolkit/utils";

/** In dev the renderer comes from the Vite server. Packaged builds use the app:// scheme. */
function rendererUrl(path: string): string {
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    return `${process.env.ELECTRON_RENDERER_URL}${path}`;
  }
  return `app://renderer${path}`;
}

export function getPillURL(): string {
  return rendererUrl("/pill.html");
}

export function getRemixBarURL(): string {
  return rendererUrl("/bar.html");
}

export function getMeetingCaptureURL(): string {
  return rendererUrl("/meeting-capture.html");
}

export function getDashboardURL(path = "/"): string {
  return rendererUrl(path);
}
