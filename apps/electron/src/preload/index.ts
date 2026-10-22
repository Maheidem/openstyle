import { electronAPI } from "@electron-toolkit/preload";
import type {
  CalendarAuthStatus,
  CalendarEvent,
  MeetingImportResult,
} from "@openstyle/validations";
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  ActiveAudioPlaybackMode,
  AudioPlaybackMode,
} from "../shared/audio-playback";
import { getDefaultHotkey } from "../shared/hotkey-defaults";
import type { ImportAudioResult } from "../shared/import-types";
import type {
  ConfirmedDevices,
  MeetingDevicePlan,
} from "../shared/meeting-devices";
import type { OpenAppCandidate } from "../shared/open-apps";
import {
  normalizePillCancelMode,
  type PillCancelMode,
} from "../shared/pill-cancel";
import type {
  TrayPopoverState,
  TrayPopoverTarget,
} from "../shared/tray-popover";

// Build an `on*` member for one main-to-renderer channel. `A` is the payload
// tuple the callback receives. Pass it by hand: the compiler cannot infer it.
// The member returns a function that removes the listener.
const listen =
  <A extends unknown[] = []>(channel: string) =>
  (callback: (...args: A) => void): (() => void) => {
    const handler = (_event: unknown, ...args: A): void => callback(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };

// Custom APIs for renderer
const api = {
  // The renderer can't reach process.platform reliably (navigator.platform
  // is deprecated); expose it once here so all platform checks agree.
  platform: process.platform as string,
  isE2E: (process.env.OPENSTYLE_E2E ?? process.env.FREESTYLE_E2E) === "1",
  defaultHotkey: getDefaultHotkey(),
  pasteText: (text: string): Promise<void> =>
    ipcRenderer.invoke("paste:text", text),
  copyText: (text: string): Promise<void> =>
    ipcRenderer.invoke("copy:text", text),
  prepareSystemAudio: (mode: ActiveAudioPlaybackMode): Promise<void> =>
    ipcRenderer.invoke("audio:prepare", mode),
  restoreSystemAudio: (): Promise<void> => ipcRenderer.invoke("audio:restore"),
  setHotkeyMode: (mode: "hold" | "toggle"): void =>
    ipcRenderer.send("hotkey:set-mode", mode),
  hidePill: (): void => ipcRenderer.send("pill:hide"),
  // The meeting capsule ended its exit after a stop; main hides the pill.
  meetingPillExitDone: (): void => ipcRenderer.send("pill:meeting-exit-done"),
  // Ask the pill window to grow around the capsule (or shrink back) so the
  // expanded status card has somewhere to render.
  setPillExpanded: (expanded: boolean): void =>
    ipcRenderer.send("pill:set-expanded", expanded),
  // --- Meeting Mode ---
  /** Mic PCM16 chunk from the hidden capture window's AudioWorklet. */
  meetingSendMicChunk: (chunk: ArrayBuffer): void =>
    ipcRenderer.send("meeting:mic-chunk", chunk),
  /** Fatal mic-capture error from the hidden capture window. */
  meetingCaptureError: (message: string): void =>
    ipcRenderer.send("meeting:capture-error", message),
  /**
   * Start a recording. When the devices differ from the previous meeting,
   * it returns `devices` and does not start. Call it again with the
   * confirmed device keys (`planKeys`).
   */
  startMeetingRecording: (
    confirmed?: ConfirmedDevices,
    folderId?: string | null,
  ): Promise<{
    ok: boolean;
    id?: string;
    error?: string;
    devices?: MeetingDevicePlan;
    code?: "invalid_folder";
  }> => ipcRenderer.invoke("meeting:start", confirmed, folderId),
  /** The mic and output that the next recording uses, or null. */
  getMeetingDevices: (): Promise<MeetingDevicePlan | null> =>
    ipcRenderer.invoke("meeting:devices"),
  stopMeetingRecording: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("meeting:stop"),
  getMeetingStatus: (): Promise<{
    status: "idle" | "recording" | "finalizing";
    meetingId: string | null;
    /** Recording start time (epoch ms) while recording, else null. */
    startedAt: number | null;
    supported: boolean;
  }> => ipcRenderer.invoke("meeting:status"),
  /** TCC probe: briefly run the system-audio pipeline to detect denial. */
  probeMeetingSystemAudio: (): Promise<
    "ok" | "silent" | "unsupported" | "error"
  > => ipcRenderer.invoke("meeting:probe-system-audio"),
  /** Open System Settings > Privacy > Screen & System Audio Recording. */
  openAudioCaptureSettings: (): void =>
    ipcRenderer.send("meeting:open-audio-capture-settings"),
  /** Calendar link (specs/calendar-eventkit.md). Permission status, no dialog. */
  calendarStatus: (): Promise<CalendarAuthStatus | null> =>
    ipcRenderer.invoke("calendar:status"),
  /** Shows the macOS Calendars dialog. Call it when the toggle goes on. */
  calendarRequest: (): Promise<CalendarAuthStatus | null> =>
    ipcRenderer.invoke("calendar:request"),
  /** Today's events for the "Change" picker. [] while the toggle is off. */
  calendarListToday: (): Promise<CalendarEvent[]> =>
    ipcRenderer.invoke("calendar:list-today"),
  /** Open System Settings > Privacy > Calendars. */
  calendarOpenSettings: (): void => ipcRenderer.send("calendar:open-settings"),
  /** Reveal a meeting's audio directory in Finder. False when unavailable. */
  revealMeetingInFinder: (id: string): Promise<boolean> =>
    ipcRenderer.invoke("meeting:reveal-in-finder", id),
  /** Mic/system level meter events while a meeting records. */
  onMeetingLevel:
    listen<
      [event: { meetingId: string; source: "mic" | "system"; rms: number }]
    >("meeting:level"),
  /** `startedAt` is the recording start time (epoch ms) while recording. */
  onMeetingStatusChanged: listen<
    [status: "idle" | "recording" | "finalizing", startedAt: number | null]
  >("meeting:status-changed"),
  showErrorDialog: (title: string, message: string): Promise<void> =>
    ipcRenderer.invoke("dialog:show-error", title, message),
  getServerPort: (): Promise<number> => ipcRenderer.invoke("server:port"),
  // Import screen: resolve a dropped `File`'s on-disk path, open a native
  // file picker, or upload a chosen file for transcription. The optional
  // `{ id }` opts pair with `abortJob(id)` — the renderer-owned cancel seam
  // (see main/abortable-jobs.ts).
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  pickImportFile: (): Promise<{ path: string; size: number } | null> =>
    ipcRenderer.invoke("import:pick-file"),
  importAudioFile: (
    path: string,
    opts?: { id?: string },
  ): Promise<ImportAudioResult> =>
    ipcRenderer.invoke("import:transcribe-file", path, opts),
  /** Abort an in-flight cancellable job started with the same id. */
  abortJob: (id: string): void => ipcRenderer.send("job:abort", id),
  // Meeting import (specs/meeting-import.md §4.4): same picker/upload shape
  // as the dictation import above, but the upload creates a meeting.
  pickMeetingAudioFile: (): Promise<string | null> =>
    ipcRenderer.invoke("meeting-import:pick-file"),
  importMeetingAudio: (
    path: string,
    opts?: { title?: string },
  ): Promise<MeetingImportResult> =>
    ipcRenderer.invoke("meeting-import:transcribe", path, opts),
  // Configured external server URL/token ("" = built-in local server / no auth).
  getServerUrl: (): Promise<string> => ipcRenderer.invoke("server:url"),
  setServerUrl: (url: string): Promise<string> =>
    ipcRenderer.invoke("server:set-url", url),
  getServerToken: (): Promise<string> => ipcRenderer.invoke("server:token"),
  setServerToken: (token: string): Promise<string> =>
    ipcRenderer.invoke("server:set-token", token),
  onServerChanged: listen("server:changed"),
  // Reveal the diagnostic logs folder (openstyle.log) in the OS file manager.
  openLogsFolder: (): Promise<boolean> =>
    ipcRenderer.invoke("logs:open-folder"),
  // Settings → Data: aggregate meetings/models disk usage (async main-side
  // walk — the renderer never touches the filesystem).
  getDiskUsage: (): Promise<{
    meetingsBytes: number;
    modelsBytes: number;
  }> => ipcRenderer.invoke("data:get-disk-usage"),
  openExternal: (url: string): Promise<boolean> =>
    ipcRenderer.invoke("open:external", url),
  onHotkeyDown: listen<[payload?: { language?: string }]>("hotkey:down"),
  updateLanguageHotkeys: (map: Record<string, string>): void =>
    ipcRenderer.send("language-hotkeys:update", map),
  onHotkeyUp: listen("hotkey:up"),
  onPillCancel: listen("pill:cancel"),
  checkMicPermission: (): Promise<string> =>
    ipcRenderer.invoke("permissions:check-mic"),
  requestMicPermission: (): Promise<string> =>
    ipcRenderer.invoke("permissions:request-mic"),
  checkAccessibilityPermission: (): Promise<boolean> =>
    ipcRenderer.invoke("permissions:check-accessibility"),
  checkLinuxSetup: (): Promise<{
    wayland: boolean;
    inputAccess: boolean;
    uinputAccess: boolean;
    pasteToolRequired: string;
    pasteTool: string | null;
  } | null> => ipcRenderer.invoke("permissions:check-linux-setup"),
  openAccessibilitySettings: (): void =>
    ipcRenderer.send("permissions:open-accessibility"),
  openMicSettings: (): void =>
    ipcRenderer.send("permissions:open-mic-settings"),
  setOnboardingComplete: (): void =>
    ipcRenderer.send("onboarding:set-complete"),
  startHotkeyRecording: (): void => ipcRenderer.send("hotkey-record:start"),
  stopHotkeyRecording: (hotkey?: string): void =>
    ipcRenderer.send("hotkey-record:stop", hotkey),
  onHotkeyRecordModifiers: listen<[modifiers: string[]]>(
    "hotkey-record:modifiers",
  ),
  onHotkeyRecordCaptured: listen<[combo: { modifiers: string[]; key: string }]>(
    "hotkey-record:captured",
  ),
  onHotkeyRecordReleased: listen("hotkey-record:released"),
  onHotkeyRecordCancel: listen("hotkey-record:cancel"),
  // Auto-updater
  checkForUpdate: (): Promise<{
    version: string;
    downloadState: string;
  } | null> => ipcRenderer.invoke("updater:check"),
  downloadUpdate: (): void => ipcRenderer.send("updater:download"),
  installUpdate: (): void => ipcRenderer.send("updater:install"),
  onUpdateAvailable: listen<[info: { version: string }]>("updater:available"),
  onUpdateDownloaded: listen<[info: { version: string }]>("updater:downloaded"),
  onUpdateDownloading: listen<
    [progress: { percent: number; transferred: number; total: number }]
  >("updater:downloading"),
  onUpdateError: listen<[info: { message: string }]>("updater:error"),
  // Auto-update setting
  getAutoUpdate: (): Promise<boolean> =>
    ipcRenderer.invoke("settings:auto-update"),
  setAutoUpdate: (enabled: boolean): void =>
    ipcRenderer.send("settings:set-auto-update", enabled),
  // Launch at startup setting
  getLaunchAtStartup: (): Promise<boolean> =>
    ipcRenderer.invoke("settings:launch-at-startup"),
  setLaunchAtStartup: (enabled: boolean): void =>
    ipcRenderer.send("settings:set-launch-at-startup", enabled),
  // Show dashboard on launch setting
  getShowDashboardOnLaunch: (): Promise<boolean> =>
    ipcRenderer.invoke("settings:show-dashboard-on-launch"),
  setShowDashboardOnLaunch: (enabled: boolean): void =>
    ipcRenderer.send("settings:set-show-dashboard-on-launch", enabled),
  // Context-aware dictation
  getFrontmostApp: (): Promise<string | null> =>
    ipcRenderer.invoke("system:frontmost-app"),
  getOpenAppCandidates: (): Promise<OpenAppCandidate[]> =>
    ipcRenderer.invoke("system:open-app-candidates"),
  // Pill position
  getPillPosition: (): Promise<string> =>
    ipcRenderer.invoke("settings:pill-position"),
  setPillPosition: (position: string): void =>
    ipcRenderer.send("settings:set-pill-position", position),
  onPillPositionChanged: listen<[position: string]>(
    "settings:pill-position-changed",
  ),
  // Output mode
  sendOutputModeChanged: (mode: string): void =>
    ipcRenderer.send("settings:output-mode-changed", mode),
  onOutputModeChanged: listen<[mode: string]>("settings:output-mode-changed"),
  // Sound setting
  sendSoundEnabledChanged: (enabled: boolean): void =>
    ipcRenderer.send("settings:sound-enabled-changed", enabled),
  onSoundEnabledChanged: listen<[enabled: boolean]>(
    "settings:sound-enabled-changed",
  ),
  // Pill cancel button
  sendPillCancelModeChanged: (mode: PillCancelMode): void =>
    ipcRenderer.send("settings:pill-cancel-mode-changed", mode),
  onPillCancelModeChanged: (
    callback: (mode: PillCancelMode) => void,
  ): (() => void) => {
    const handler = (_: unknown, mode: unknown): void =>
      callback(normalizePillCancelMode(mode));
    ipcRenderer.on("settings:pill-cancel-mode-changed", handler);
    return () =>
      ipcRenderer.removeListener("settings:pill-cancel-mode-changed", handler);
  },
  sendAudioPlaybackModeChanged: (mode: AudioPlaybackMode): void =>
    ipcRenderer.send("settings:audio-playback-mode-changed", mode),
  onAudioPlaybackModeChanged: listen<[mode: AudioPlaybackMode]>(
    "settings:audio-playback-mode-changed",
  ),
  // Cleanup context — the dashboard notifies the pill when a cleanup-relevant
  // setting (llm_cleanup or a cleanup tone) changes so the pill can refresh its
  // cached "needs frontmost app for routing" decision instead of re-fetching
  // /api/settings on every single recording start.
  sendCleanupContextChanged: (): void =>
    ipcRenderer.send("settings:cleanup-context-changed"),
  onCleanupContextChanged: listen("settings:cleanup-context-changed"),
  // Hotkey error notifications
  onHotkeyError: listen<[error: { message: string }]>("hotkey:error"),
  // Audio level stream — pill broadcasts per-frame mic amplitude (0..1) so
  // other windows (the Today tutorial demo) can render a live waveform.
  sendAudioLevel: (level: number): void =>
    ipcRenderer.send("audio:level", level),
  onAudioLevel: listen<[level: number]>("audio:level"),
  // Fired by the pill after a successful transcription + paste, so other
  // windows (Today, History) can refetch without polling.
  sendTranscriptionDone: (): void => ipcRenderer.send("transcription:done"),
  onTranscriptionDone: listen("transcription:done"),
  // Fullscreen state
  onFullscreenChanged: listen<[isFullscreen: boolean]>("fullscreen:changed"),
  // --- Tray popover (main/windows/tray-popover-window.ts) ---
  getTrayPopoverState: (): Promise<TrayPopoverState> =>
    ipcRenderer.invoke("tray-popover:state"),
  /** The popover shows. Read the data again. */
  onTrayPopoverShown: listen("tray-popover:shown"),
  /** The height of the popover content, so main can size the window. */
  setTrayPopoverHeight: (height: number): void =>
    ipcRenderer.send("tray-popover:set-height", height),
  /** The popover hides. Stop the jobs poll. */
  onTrayPopoverHidden: listen("tray-popover:hidden"),
  hideTrayPopover: (): void => ipcRenderer.send("tray-popover:hide"),
  /** Close the popover and show a page in the main window. */
  openFromTrayPopover: (target: TrayPopoverTarget): void =>
    ipcRenderer.send("tray-popover:open", target),
  /** Close the popover and open a meeting in the main window. */
  openMeetingFromTrayPopover: (id: string): void =>
    ipcRenderer.send("tray-popover:open-meeting", id),
  quitFromTrayPopover: (): void => ipcRenderer.send("tray-popover:quit"),
};

// The renderer types read `Window.api` from this type (see index.d.ts).
export type OpenstyleApi = typeof api;

// The renderer gets the named `api` members only. The raw `electronAPI`
// (generic ipcRenderer) is for the E2E tests, so only E2E runs expose it.
try {
  contextBridge.exposeInMainWorld("api", api);
  if (api.isE2E) contextBridge.exposeInMainWorld("electron", electronAPI);
} catch (error) {
  console.error(error);
}
