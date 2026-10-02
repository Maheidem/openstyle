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
  if (settings.audio_playback_mode) {
    return normalizeAudioPlaybackMode(settings.audio_playback_mode);
  }
  if (settings.pause_playback_while_recording === "true") return "pause";
  return settings.audio_ducking_enabled === "true" ? "duck" : "off";
}

export function isActiveAudioPlaybackMode(
  value: unknown,
): value is ActiveAudioPlaybackMode {
  return value === "duck" || value === "pause";
}
