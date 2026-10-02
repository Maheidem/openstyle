import { electronAPI } from "@electron-toolkit/preload";
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  ActiveAudioPlaybackMode,
  AudioPlaybackMode,
} from "../shared/audio-playback";
import { getDefaultHotkey } from "../shared/hotkey-defaults";
import type { OpenAppCandidate } from "../shared/open-apps";
import {
  normalizePillCancelMode,
  type PillCancelMode,
} from "../shared/pill-cancel";
import {
  getDefaultRemixHotkey,
  type RemixContextResult,
  type RemixCopyResult,
  type RemixPrimitiveResult,
  type RemixReadDocumentResult,
  type RemixRecapturePayload,
  type RemixSelectionPayload,
  type RemixSelectResult,
} from "../shared/remix";

// Result of an import-audio upload; kept structural so it can also be
// declared (without a runtime import) in `index.d.ts`.
type ImportAudioResult =
  | {
      ok: true;
      raw: string;
      cleaned: string;
      model: string;
      audioDurationMs?: number;
      durationMs?: number;
    }
  | {
      ok: false;
      status?: number;
      error: string;
      detail?: string;
      code?: string;
      reason?: string;
    };

// A freshly imported meeting in the exact `GET /api/meetings/:id` response
// shape (see main/meeting-import.ts); kept structural so it can also be
// declared (without a runtime import) in `index.d.ts`.
type ImportedMeeting = {
  id: string;
  title: string | null;
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number | null;
  status: string;
  language: string | null;
  error: string | null;
  created_at: number | null;
  stt_provider: string | null;
  stt_model: string | null;
  audio_dir: string | null;
  context: string | null;
  job: { done: number; total: number; failed: number } | null;
  /** Last background-job failure for this meeting (GET /:id shape). Always
   * null on a fresh import — nothing has run yet. */
  job_error: string | null;
  segment_counts: { total: number; failed: number };
  summary: {
    markdown: string | null;
    llm_provider: string | null;
    llm_model: string | null;
    cost_usd: number | null;
    created_at: number | null;
  } | null;
};

type MeetingImportResult =
  | { ok: true; meeting: ImportedMeeting }
  | {
      ok: false;
      status?: number;
      error: string;
      detail?: string;
      code?: string;
    };

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
  defaultRemixHotkey: getDefaultRemixHotkey(),
  pasteText: (text: string): Promise<void> =>
    ipcRenderer.invoke("paste:text", text),
  copyText: (text: string): Promise<void> =>
    ipcRenderer.invoke("copy:text", text),
  prepareSystemAudio: (mode: ActiveAudioPlaybackMode): Promise<void> =>
    ipcRenderer.invoke("audio:prepare", mode),
  duckSystemAudio: (): Promise<void> => ipcRenderer.invoke("audio:duck"),
  restoreSystemAudio: (): Promise<void> => ipcRenderer.invoke("audio:restore"),
  updateHotkey: (hotkey: string): void =>
    ipcRenderer.send("hotkey:update", hotkey),
  reloadHotkey: (): void => ipcRenderer.send("hotkey:reload"),
  setHotkeyMode: (mode: "hold" | "toggle"): void =>
    ipcRenderer.send("hotkey:set-mode", mode),
  hidePill: (): void => ipcRenderer.send("pill:hide"),
  // Ask the pill window to grow around the capsule (or shrink back) so the
  // expanded status card has somewhere to render.
  setPillExpanded: (
    expanded: boolean,
    expansion?: "card" | "remix-chat",
  ): void => ipcRenderer.send("pill:set-expanded", expanded, expansion),
  // The held remix room shows only a small surface — keep the window
  // click-through outside this rect (null restores full interactivity).
  setPillHotRect: (
    rect: { x: number; y: number; width: number; height: number } | null,
  ): void => ipcRenderer.send("pill:set-hot-rect", rect),
  onPillHotEnter: listen("pill:hot-enter"),
  // --- Meeting Mode ---
  /** Mic PCM16 chunk from the hidden capture window's AudioWorklet. */
  meetingSendMicChunk: (chunk: ArrayBuffer): void =>
    ipcRenderer.send("meeting:mic-chunk", chunk),
  /** Fatal mic-capture error from the hidden capture window. */
  meetingCaptureError: (message: string): void =>
    ipcRenderer.send("meeting:capture-error", message),
  startMeetingRecording: (): Promise<{
    ok: boolean;
    id?: string;
    error?: string;
  }> => ipcRenderer.invoke("meeting:start"),
  stopMeetingRecording: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("meeting:stop"),
  getMeetingStatus: (): Promise<{
    status: "idle" | "recording" | "finalizing";
    meetingId: string | null;
    supported: boolean;
  }> => ipcRenderer.invoke("meeting:status"),
  /** TCC probe: briefly run the system-audio pipeline to detect denial. */
  probeMeetingSystemAudio: (): Promise<
    "ok" | "silent" | "unsupported" | "error"
  > => ipcRenderer.invoke("meeting:probe-system-audio"),
  /** Open System Settings > Privacy > Screen & System Audio Recording. */
  openAudioCaptureSettings: (): void =>
    ipcRenderer.send("meeting:open-audio-capture-settings"),
  /** Reveal a meeting's audio directory in Finder. False when unavailable. */
  revealMeetingInFinder: (id: string): Promise<boolean> =>
    ipcRenderer.invoke("meeting:reveal-in-finder", id),
  /** Mic/system level meter events while a meeting records. */
  onMeetingLevel:
    listen<
      [event: { meetingId: string; source: "mic" | "system"; rms: number }]
    >("meeting:level"),
  onMeetingStatusChanged: listen<[status: "idle" | "recording" | "finalizing"]>(
    "meeting:status-changed",
  ),
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
  reloadLanguageHotkeys: (): void =>
    ipcRenderer.send("language-hotkeys:reload"),
  onHotkeyUp: listen("hotkey:up"),
  // --- Remix ---
  reloadRemixHotkey: (): void => ipcRenderer.send("remix-hotkey:reload"),
  /** Replace the user's selection with the remix's result. */
  pasteRemixResult: (text: string): Promise<boolean> =>
    ipcRenderer.invoke("remix:paste", text),
  onRemixDown: listen("remix:down"),
  onRemixUp: listen("remix:up"),
  /** The captured selection plus the anchor it was captured in. */
  onRemixSelection: (
    callback: (payload: RemixSelectionPayload) => void,
  ): (() => void) => {
    const handler = (_: unknown, payload: RemixSelectionPayload): void =>
      callback(
        payload ?? {
          text: null,
          appName: null,
          windowTitle: null,
          capturedAt: Date.now(),
        },
      );
    ipcRenderer.on("remix:selection", handler);
    return () => ipcRenderer.removeListener("remix:selection", handler);
  },
  /** Re-read the selection + frontmost app (fast-lane preset refresh). */
  remixRecapture: (): Promise<RemixRecapturePayload> =>
    ipcRenderer.invoke("remix:recapture"),
  // --- Remix primitives (the agent's tools; workflow lives in its prompt) ---
  remixGetContext: (): Promise<RemixContextResult> =>
    ipcRenderer.invoke("remix:get-context"),
  remixReadDocument: (): Promise<RemixReadDocumentResult> =>
    ipcRenderer.invoke("remix:read-document"),
  remixSelectAll: (): Promise<RemixPrimitiveResult> =>
    ipcRenderer.invoke("remix:select-all"),
  remixSelectText: (
    text: string,
    occurrence?: number,
  ): Promise<RemixSelectResult> =>
    ipcRenderer.invoke("remix:select-text", text, occurrence),
  remixCollapseSelection: (): Promise<RemixPrimitiveResult> =>
    ipcRenderer.invoke("remix:collapse-selection"),
  remixCopy: (): Promise<RemixCopyResult> => ipcRenderer.invoke("remix:copy"),
  remixSetClipboard: (text: string): Promise<RemixPrimitiveResult> =>
    ipcRenderer.invoke("remix:set-clipboard", text),
  remixSetClipboardImage: (url: string): Promise<RemixPrimitiveResult> =>
    ipcRenderer.invoke("remix:set-clipboard-image", url),
  remixPasteClipboard: (): Promise<RemixPrimitiveResult> =>
    ipcRenderer.invoke("remix:paste-clipboard"),
  remixUndo: (): Promise<RemixPrimitiveResult> =>
    ipcRenderer.invoke("remix:undo"),
  remixRedo: (): Promise<RemixPrimitiveResult> =>
    ipcRenderer.invoke("remix:redo"),
  remixPressKey: (key: string, times?: number): Promise<RemixPrimitiveResult> =>
    ipcRenderer.invoke("remix:press-key", key, times),
  remixGetClipboard: (): Promise<RemixCopyResult> =>
    ipcRenderer.invoke("remix:get-clipboard"),
  /** Fast-lane replace for the preset chips; clipboard preserved. */
  remixPasteText: (text: string): Promise<RemixPrimitiveResult> =>
    ipcRenderer.invoke("remix:paste-text", text),
  /** The chat card's input needs the keyboard; focusability follows it. */
  setRemixChatFocus: (focus: boolean): void =>
    ipcRenderer.send("remix:set-chat-focus", focus),
  /**
   * Release (or re-claim) the digit route shortcuts. The chat card holds no
   * routes, so keeping Control+1..3 claimed for its whole lifetime would take
   * them from the rest of the system.
   */
  setRemixRouteKeys: (open: boolean): void =>
    ipcRenderer.send("remix:set-route-keys", open),
  /** The persistent bar was hovered; main opens the chat. */
  remixBarHover: (): void => ipcRenderer.send("remix:bar-hover"),
  /** Onboarding practice: allow Remix to target our own window while true. */
  setRemixPracticeTarget: (active: boolean): void =>
    ipcRenderer.send("remix:set-practice-target", active),
  /** Remix delivered text into the practice draft (paste succeeded). */
  onRemixPracticeDelivered: listen("remix:practice-delivered"),
  /** Main wants the chat card open (bar hover) — no instruction attached. */
  onRemixOpenChat: listen("remix:open-chat"),
  /** A route shortcut (chord + digit) fired; zero-based index. */
  onRemixRoute: listen<[index: number]>("remix:route"),
  /**
   * A dictation started on the shared home key and the remix chord is
   * taking over. Drop the recording but leave the pill window alone — the
   * remix card is about to use it.
   */
  onRemixSupersede: listen("remix:supersede"),

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
  getOnboardingComplete: (): Promise<boolean> =>
    ipcRenderer.invoke("onboarding:complete"),
  setOnboardingComplete: (): void =>
    ipcRenderer.send("onboarding:set-complete"),
  startHotkeyRecording: (): void => ipcRenderer.send("hotkey-record:start"),
  pauseHotkeyRecording: (): void =>
    ipcRenderer.send("hotkey-record:pause-recorder"),
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
  sendAudioDuckingChanged: (enabled: boolean): void =>
    ipcRenderer.send("settings:audio-ducking-changed", enabled),
  onAudioDuckingChanged: listen<[enabled: boolean]>(
    "settings:audio-ducking-changed",
  ),
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
};

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electron", electronAPI);
    contextBridge.exposeInMainWorld("api", api);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-expect-error (define in dts)
  window.electron = electronAPI;
  // @ts-expect-error (define in dts)
  window.api = api;
}
