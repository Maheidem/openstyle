import { SETTINGS_KEYS } from "./settings-keys";

export type AudioPlaybackMode = "off" | "duck" | "pause";
export type ActiveAudioPlaybackMode = Exclude<AudioPlaybackMode, "off">;

export function normalizeAudioPlaybackMode(
  value: string | null | undefined,
): AudioPlaybackMode {
  return value === "duck" || value === "pause" ? value : "off";
}

// Resolve the saved mode from a settings snapshot. The new key wins. Then the
// old pause flag, then the old duck flag. No key set means "off".
export function resolveAudioPlaybackMode(
  settings: Record<string, string | undefined>,
): AudioPlaybackMode {
  const mode = settings[SETTINGS_KEYS.audioPlaybackMode];
  if (mode) return normalizeAudioPlaybackMode(mode);
  if (settings[SETTINGS_KEYS.pausePlaybackWhileRecording] === "true") {
    return "pause";
  }
  return settings[SETTINGS_KEYS.audioDuckingEnabled] === "true"
    ? "duck"
    : "off";
}

export function isActiveAudioPlaybackMode(
  value: unknown,
): value is ActiveAudioPlaybackMode {
  return value === "duck" || value === "pause";
}
