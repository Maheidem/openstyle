import { ElectronAPI } from "@electron-toolkit/preload";
import type {
  ActiveAudioPlaybackMode,
  AudioPlaybackMode,
} from "../shared/audio-playback";
import type {
  ImportAudioResult,
  ImportedMeeting,
  MeetingImportResult,
} from "../shared/import-types";
import type { OpenAppCandidate } from "../shared/open-apps";
import type { PillCancelMode } from "../shared/pill-cancel";
import type {
  RemixContextResult,
  RemixCopyResult,
  RemixPrimitiveResult,
  RemixReadDocumentResult,
  RemixRecapturePayload,
  RemixSelectionPayload,
  RemixSelectResult,
} from "../shared/remix";

export type { ImportAudioResult, ImportedMeeting, MeetingImportResult };

declare global {
  interface Window {
    electron: ElectronAPI;
    api: {
      platform: string;
      isE2E: boolean;
      defaultHotkey: string;
      defaultRemixHotkey: string;
      pasteText: (text: string) => Promise<void>;
      copyText: (text: string) => Promise<void>;
      prepareSystemAudio: (mode: ActiveAudioPlaybackMode) => Promise<void>;
      restoreSystemAudio: () => Promise<void>;
      setHotkeyMode: (mode: "hold" | "toggle") => void;
      hidePill: () => void;
      setPillExpanded: (
        expanded: boolean,
        expansion?: "card" | "remix-chat",
      ) => void;
      setPillHotRect: (
        rect: { x: number; y: number; width: number; height: number } | null,
      ) => void;
      onPillHotEnter: (callback: () => void) => () => void;
      meetingSendMicChunk: (chunk: ArrayBuffer) => void;
      meetingCaptureError: (message: string) => void;
      startMeetingRecording: () => Promise<{
        ok: boolean;
        id?: string;
        error?: string;
      }>;
      stopMeetingRecording: () => Promise<{ ok: boolean }>;
      getMeetingStatus: () => Promise<{
        status: "idle" | "recording" | "finalizing";
        meetingId: string | null;
        supported: boolean;
      }>;
      probeMeetingSystemAudio: () => Promise<
        "ok" | "silent" | "unsupported" | "error"
      >;
      openAudioCaptureSettings: () => void;
      revealMeetingInFinder: (id: string) => Promise<boolean>;
      onMeetingLevel: (
        callback: (event: {
          meetingId: string;
          source: "mic" | "system";
          rms: number;
        }) => void,
      ) => () => void;
      onMeetingStatusChanged: (
        callback: (status: "idle" | "recording" | "finalizing") => void,
      ) => () => void;
      showErrorDialog: (title: string, message: string) => Promise<void>;
      getServerPort: () => Promise<number>;
      // Import screen: resolve a dropped `File`'s on-disk path, open a
      // native file picker, or upload a chosen file for transcription.
      // `{ id }` opts pair with `abortJob(id)` — the cancel seam.
      getPathForFile: (file: File) => string;
      pickImportFile: () => Promise<{ path: string; size: number } | null>;
      importAudioFile: (
        path: string,
        opts?: { id?: string },
      ) => Promise<ImportAudioResult>;
      /** Abort an in-flight cancellable job started with the same id. */
      abortJob: (id: string) => void;
      // Meeting import (specs/meeting-import.md §4.4).
      pickMeetingAudioFile: () => Promise<string | null>;
      importMeetingAudio: (
        path: string,
        opts?: { title?: string },
      ) => Promise<MeetingImportResult>;
      getServerUrl: () => Promise<string>;
      setServerUrl: (url: string) => Promise<string>;
      getServerToken: () => Promise<string>;
      setServerToken: (token: string) => Promise<string>;
      onServerChanged: (callback: () => void) => () => void;
      openLogsFolder: () => Promise<boolean>;
      // Settings → Data: aggregate meetings/models disk usage.
      getDiskUsage: () => Promise<{
        meetingsBytes: number;
        modelsBytes: number;
      }>;
      openExternal: (url: string) => Promise<boolean>;
      onHotkeyDown: (
        callback: (payload?: { language?: string }) => void,
      ) => () => void;
      onHotkeyUp: (callback: () => void) => () => void;
      onPillCancel: (callback: () => void) => () => void;
      updateLanguageHotkeys: (map: Record<string, string>) => void;
      reloadRemixHotkey: () => void;
      pasteRemixResult: (text: string) => Promise<boolean>;
      onRemixDown: (callback: () => void) => () => void;
      onRemixUp: (callback: () => void) => () => void;
      onRemixSelection: (
        callback: (payload: RemixSelectionPayload) => void,
      ) => () => void;
      onRemixRoute: (callback: (index: number) => void) => () => void;
      onRemixSupersede: (callback: () => void) => () => void;
      remixRecapture: () => Promise<RemixRecapturePayload>;
      remixGetContext: () => Promise<RemixContextResult>;
      remixReadDocument: () => Promise<RemixReadDocumentResult>;
      remixSelectAll: () => Promise<RemixPrimitiveResult>;
      remixSelectText: (
        text: string,
        occurrence?: number,
      ) => Promise<RemixSelectResult>;
      remixCollapseSelection: () => Promise<RemixPrimitiveResult>;
      remixCopy: () => Promise<RemixCopyResult>;
      remixSetClipboard: (text: string) => Promise<RemixPrimitiveResult>;
      remixSetClipboardImage: (url: string) => Promise<RemixPrimitiveResult>;
      remixPasteClipboard: () => Promise<RemixPrimitiveResult>;
      remixUndo: () => Promise<RemixPrimitiveResult>;
      remixRedo: () => Promise<RemixPrimitiveResult>;
      remixPressKey: (
        key: string,
        times?: number,
      ) => Promise<RemixPrimitiveResult>;
      remixGetClipboard: () => Promise<RemixCopyResult>;
      remixPasteText: (text: string) => Promise<RemixPrimitiveResult>;
      setRemixChatFocus: (focus: boolean) => void;
      setRemixRouteKeys: (open: boolean) => void;
      remixBarHover: () => void;
      setRemixPracticeTarget: (active: boolean) => void;
      onRemixPracticeDelivered: (callback: () => void) => () => void;
      onRemixOpenChat: (callback: () => void) => () => void;
      checkMicPermission: () => Promise<string>;
      requestMicPermission: () => Promise<string>;
      checkAccessibilityPermission: () => Promise<boolean>;
      checkLinuxSetup: () => Promise<{
        wayland: boolean;
        inputAccess: boolean;
        uinputAccess: boolean;
        pasteToolRequired: string;
        pasteTool: string | null;
      } | null>;
      openAccessibilitySettings: () => void;
      openMicSettings: () => void;
      setOnboardingComplete: () => void;
      startHotkeyRecording: () => void;
      stopHotkeyRecording: (hotkey?: string) => void;
      onHotkeyRecordModifiers: (
        callback: (modifiers: string[]) => void,
      ) => () => void;
      onHotkeyRecordCaptured: (
        callback: (combo: { modifiers: string[]; key: string }) => void,
      ) => () => void;
      onHotkeyRecordReleased: (callback: () => void) => () => void;
      onHotkeyRecordCancel: (callback: () => void) => () => void;
      // Auto-updater
      checkForUpdate: () => Promise<{
        version: string;
        downloadState: string;
      } | null>;
      downloadUpdate: () => void;
      installUpdate: () => void;
      onUpdateAvailable: (
        callback: (info: { version: string }) => void,
      ) => () => void;
      onUpdateDownloaded: (
        callback: (info: { version: string }) => void,
      ) => () => void;
      onUpdateDownloading: (
        callback: (progress: {
          percent: number;
          transferred: number;
          total: number;
        }) => void,
      ) => () => void;
      onUpdateError: (
        callback: (info: { message: string }) => void,
      ) => () => void;
      // Auto-update setting
      getAutoUpdate: () => Promise<boolean>;
      setAutoUpdate: (enabled: boolean) => void;
      // Launch at startup setting
      getLaunchAtStartup: () => Promise<boolean>;
      setLaunchAtStartup: (enabled: boolean) => void;
      // Show dashboard on launch setting
      getShowDashboardOnLaunch: () => Promise<boolean>;
      setShowDashboardOnLaunch: (enabled: boolean) => void;
      // Context-aware dictation
      getFrontmostApp: () => Promise<string | null>;
      getOpenAppCandidates: () => Promise<OpenAppCandidate[]>;
      // Pill position
      getPillPosition: () => Promise<string>;
      setPillPosition: (position: string) => void;
      onPillPositionChanged: (
        callback: (position: string) => void,
      ) => () => void;
      // Output mode
      sendOutputModeChanged: (mode: string) => void;
      onOutputModeChanged: (callback: (mode: string) => void) => () => void;
      // Sound setting
      sendSoundEnabledChanged: (enabled: boolean) => void;
      onSoundEnabledChanged: (
        callback: (enabled: boolean) => void,
      ) => () => void;
      // Pill cancel button
      sendPillCancelModeChanged: (mode: PillCancelMode) => void;
      onPillCancelModeChanged: (
        callback: (mode: PillCancelMode) => void,
      ) => () => void;
      sendAudioPlaybackModeChanged: (mode: AudioPlaybackMode) => void;
      onAudioPlaybackModeChanged: (
        callback: (mode: AudioPlaybackMode) => void,
      ) => () => void;
      // Cleanup context changes (llm_cleanup / cleanup tones)
      sendCleanupContextChanged: () => void;
      onCleanupContextChanged: (callback: () => void) => () => void;
      // Hotkey error notifications
      onHotkeyError: (
        callback: (error: { message: string }) => void,
      ) => () => void;
      // Audio level stream
      sendAudioLevel: (level: number) => void;
      onAudioLevel: (callback: (level: number) => void) => () => void;
      // Transcription completion broadcast
      sendTranscriptionDone: () => void;
      onTranscriptionDone: (callback: () => void) => () => void;
      // Fullscreen state
      onFullscreenChanged: (
        callback: (isFullscreen: boolean) => void,
      ) => () => void;
    };
  }
}
