/**
 * Names of the meeting files on disk. The Electron recorder writes them and
 * the server reads them, so the names exist in one place only.
 * Each meeting has a folder `<userData>/<MEETINGS_DIR_NAME>/<id>`.
 */

/** Folder under the user data directory that holds all meeting folders. */
export const MEETINGS_DIR_NAME = "meetings";

/** Microphone channel ("Me"). Imported meetings do not have it. */
export const MIC_WAV = "mic.wav";

/** System audio channel ("Them"). Imported meetings have only this file. */
export const SYSTEM_WAV = "system.wav";

/**
 * The system track as it was recorded, kept when the server repairs a
 * sample-rate mismatch of `system.wav` (issue #170). The audio retention
 * sweep deletes it with the other WAV files.
 */
export const SYSTEM_ORIGINAL_WAV = "system.original.wav";

/** Clock-drift journal written by the recorder. Imported meetings do not have it. */
export const SYNC_JSON = "sync.json";

/**
 * The system track must have about as many samples as the mic track. Both
 * channels come from one clock, so a ratio outside this band means that one
 * channel ran at the wrong speed (issue #170: a 16 kHz Bluetooth call-mode
 * stream converted as 48 kHz gave 0.333).
 */
export const TRACK_RATIO_MIN = 0.95;
export const TRACK_RATIO_MAX = 1.05;

/** Shorter recordings are not checked. The start of each channel can vary. */
const TRACK_RATIO_MIN_SECONDS = 30;

/**
 * Returns `systemSamples / micSamples` when the ratio is outside
 * TRACK_RATIO_MIN..TRACK_RATIO_MAX. Returns null when the ratio is good, or
 * when it cannot be checked: a count is missing or 0, or both tracks are
 * shorter than 30 s. The values come from `sync.json`.
 */
export function trackRatioWarning(
  micSamples: unknown,
  systemSamples: unknown,
  sampleRate: unknown,
): number | null {
  if (
    typeof micSamples !== "number" ||
    typeof systemSamples !== "number" ||
    typeof sampleRate !== "number" ||
    !(micSamples > 0) ||
    !(systemSamples > 0) ||
    !(sampleRate > 0)
  ) {
    return null;
  }
  if (
    Math.max(micSamples, systemSamples) <
    TRACK_RATIO_MIN_SECONDS * sampleRate
  ) {
    return null;
  }
  const ratio = systemSamples / micSamples;
  return ratio < TRACK_RATIO_MIN || ratio > TRACK_RATIO_MAX ? ratio : null;
}
