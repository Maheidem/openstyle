import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

// ---------------------------------------------------------------------------
// settings.json helpers — single source for read/write of the lightweight
// JSON file the main process uses for settings it needs before the server
// is available (pillPosition, onboardingComplete, autoUpdate).
// ---------------------------------------------------------------------------

let settingsCache: Record<string, unknown> | null = null;

export function readSettings(): Record<string, unknown> {
  if (settingsCache) return settingsCache;
  try {
    const settingsPath = join(app.getPath("userData"), "settings.json");
    settingsCache = JSON.parse(readFileSync(settingsPath, "utf-8"));
    return settingsCache!;
  } catch {
    settingsCache = {};
    return settingsCache;
  }
}

export function writeSettings(patch: Record<string, unknown>): void {
  try {
    const settingsPath = join(app.getPath("userData"), "settings.json");
    const data = { ...readSettings(), ...patch };
    writeFileSync(settingsPath, JSON.stringify(data, null, 2));
    settingsCache = data;
  } catch {
    // ignore
  }
}

/** Drop the cached copy so the next read goes back to disk. */
export function clearSettingsCache(): void {
  settingsCache = null;
}
