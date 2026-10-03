import type { ElectronAPI } from "@electron-toolkit/preload";
import type {
  ImportAudioResult,
  ImportedMeeting,
  MeetingImportResult,
} from "../shared/import-types";
import type { OpenstyleApi } from "./index";

export type { ImportAudioResult, ImportedMeeting, MeetingImportResult };

declare global {
  interface Window {
    /** Raw IPC bridge. It exists only when `api.isE2E` is true. */
    electron: ElectronAPI;
    /** The type comes from the `api` object in index.ts. */
    api: OpenstyleApi;
  }
}
