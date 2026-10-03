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

/** Clock-drift journal written by the recorder. Imported meetings do not have it. */
export const SYNC_JSON = "sync.json";
