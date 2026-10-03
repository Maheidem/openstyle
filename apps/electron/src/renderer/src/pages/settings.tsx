import { zodResolver } from "@hookform/resolvers/zod";
import {
  DEFAULT_MEETING_ENHANCE_TIMEOUT_SECONDS,
  DEFAULT_MEETING_SUMMARY_TIMEOUT_SECONDS,
  DEFAULT_SERVER_PORT,
  HISTORY_RETENTION_DAYS_MAX,
  MEETING_ENHANCE_TIMEOUT_SECONDS_MAX,
  MEETING_ENHANCE_TIMEOUT_SECONDS_MIN,
  MEETING_SUMMARY_TIMEOUT_SECONDS_MAX,
  MEETING_SUMMARY_TIMEOUT_SECONDS_MIN,
  type NetworkSettingsForm,
  networkSettingsFormSchema,
  normalizeLanguageList,
  parseMeetingEnhanceTimeoutSeconds,
  parseMeetingSummaryTimeoutSeconds,
  parseRetentionDays,
  parseStoredLanguageList,
  serverUrlSchema,
} from "@openstyle/validations";
import { DragSpacer } from "@renderer/components/drag-spacer";
import { KeyComboDisplay } from "@renderer/components/key-combo";
import {
  LanguageMultiSelect,
  useLanguageOptions,
} from "@renderer/components/language-combobox";
import { LanguageSelector } from "@renderer/components/language-selector";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import {
  InputGroup,
  InputGroupInput,
} from "@renderer/components/ui/input-group";
import { RevealToggle } from "@renderer/components/ui/reveal-toggle";
import {
  SegmentedControl,
  type SegmentedOption,
} from "@renderer/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { Switch } from "@renderer/components/ui/switch";
import {
  acceleratorsEqual,
  comboDisplayKeys,
  formatAcceleratorKeys,
  keyDisplayLabel,
  useHotkeyRecorder,
} from "@renderer/hooks/use-hotkey-recorder";
import {
  checkServerAuth,
  checkServerHealth,
  getClient,
  getLocalApiBase,
  refreshApiBase,
} from "@renderer/lib/api";
import { formatBytes } from "@renderer/lib/models";
import { requestMicAccess, resolveMicStatus } from "@renderer/lib/permissions";
import { IS_LINUX, IS_MAC, IS_WINDOWS } from "@renderer/lib/platform";
import {
  configQueryOptions,
  queryKeys,
  settingsQueryOptions,
} from "@renderer/lib/query";
import { putSetting } from "@renderer/lib/settings";
import { cn } from "@renderer/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ExternalLink,
  FolderOpen,
  Info,
  Keyboard,
  Loader2,
  Mic,
  Monitor,
  Moon,
  Pause,
  Sun,
  Trash2,
  Volume2,
  VolumeOff,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Controller,
  type ControllerRenderProps,
  useForm,
} from "react-hook-form";
import { Trans, useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import {
  type AudioPlaybackMode,
  normalizeAudioPlaybackMode,
  resolveAudioPlaybackMode,
} from "../../../shared/audio-playback";
import { getDefaultHotkey } from "../../../shared/hotkey-defaults";
import {
  normalizePillCancelMode,
  type PillCancelMode,
} from "../../../shared/pill-cancel";
import { getDefaultRemixHotkey } from "../../../shared/remix";
import { SETTINGS_KEYS } from "../../../shared/settings-keys";
import {
  type CommitTrigger,
  displayValueFor,
  inspectNumericDraft,
  resolveCommitIntent,
  sanitizeDigits,
} from "./settings-numeric-commit";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * 4, because the bound is 3600. Applied both here and as the input's
 * `maxLength` so a 5th digit is refused by the browser rather than dropped by
 * the renderer after the fact (defect D-3).
 */
const SUMMARY_TIMEOUT_MAX_DIGITS = String(
  MEETING_SUMMARY_TIMEOUT_SECONDS_MAX,
).length;

/**
 * The Enhance twin — same bound (3600), same rule: 4 digits, applied here AND
 * as the input's `maxLength` so a 5th digit is refused by the browser rather
 * than dropped by the renderer after the fact.
 */
const ENHANCE_TIMEOUT_MAX_DIGITS = String(
  MEETING_ENHANCE_TIMEOUT_SECONDS_MAX,
).length;

const themeOptions = [
  { value: "light", icon: Sun },
  { value: "dark", icon: Moon },
  { value: "system", icon: Monitor },
] as const;

const audioPlaybackOptions = [
  { value: "off", label: "Off", icon: VolumeOff },
  { value: "duck", label: "Duck", icon: Volume2 },
  { value: "pause", label: "Pause", icon: Pause },
] as const;

const settingsSectionIds = [
  "recording",
  "remix",
  "application",
  "display",
  "permissions",
  "data",
  "network",
] as const;

type SettingsSectionId = (typeof settingsSectionIds)[number];

// Network tab temporarily disabled.
const hiddenSettingsSectionIds: readonly SettingsSectionId[] = ["network"];

const visibleSettingsSectionIds = settingsSectionIds.filter(
  (id) => !hiddenSettingsSectionIds.includes(id),
);

function parseSettingsSection(hash: string): SettingsSectionId {
  const id = hash.replace(/^#/, "");
  return (visibleSettingsSectionIds as readonly string[]).includes(id)
    ? (id as SettingsSectionId)
    : "recording";
}

interface AudioDevice {
  deviceId: string;
  label: string;
}

function normalizePillPos(pos: string): string {
  return pos.startsWith("custom") ? "custom" : pos;
}

/**
 * Resolve the transcription-language list from a loaded settings map. Reads the
 * canonical `languages` JSON array, falling back to the legacy singular
 * `language` key for users who chose a language before the multi-language
 * migration so an existing choice is never dropped.
 */
function parseLanguagesSetting(s: Record<string, string>): string[] {
  return parseStoredLanguageList(
    s[SETTINGS_KEYS.languages],
    s[SETTINGS_KEYS.language],
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SettingsPage(): React.JSX.Element {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string>("");
  const [hotkey, setHotkey] = useState(
    window.api?.defaultHotkey ?? getDefaultHotkey(),
  );
  const [hotkeyMode, setHotkeyMode] = useState<"hold" | "toggle">("hold");
  const [remixBarEnabled, setRemixBarEnabled] = useState(true);
  const [remixHotkey, setRemixHotkey] = useState(
    window.api?.defaultRemixHotkey ?? getDefaultRemixHotkey(),
  );
  const [languages, setLanguages] = useState<string[]>([]);
  // Language code -> bound accelerator. Only languages with a bound hotkey
  // appear as keys (specs/dictation-language-hotkeys.md §7).
  const [languageHotkeys, setLanguageHotkeys] = useState<
    Record<string, string>
  >({});
  const [translateMode, setTranslateMode] = useState(false);
  const [outputMode, setOutputMode] = useState("paste");
  const [pillPosition, setPillPosition] = useState("bottom-center");
  const [pillCancel, setPillCancel] = useState<PillCancelMode>("hover");
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [historyPaused, setHistoryPaused] = useState(false);
  const [historyRetention, setHistoryRetention] = useState<
    "never" | "7" | "30" | "custom"
  >("never");
  const [customRetentionDays, setCustomRetentionDays] = useState("90");
  /**
   * Meeting-summary timeout, in seconds. `summaryTimeoutSeconds` mirrors what
   * the server holds — an unset setting means the default, so the field shows
   * the default too. `summaryTimeoutDraft` is the local-only text being
   * typed: it renders in the field and writes NOTHING. The PUT fires on an
   * explicit commit (blur or Enter), never mid-keystroke — a field that wrote
   * `36` while the user was still typing `3600` handed the summarize lane a
   * 36-second budget mid-edit, which is the exact failure this setting was
   * added to remove (defects D-1/D-2, `openstyle-evidence/summary-timeout/`).
   * An invalid draft on blur reverts to the saved value, never to a
   * truncated in-range prefix of what was typed. `summaryTimeoutStripped`
   * holds the characters the renderer dropped so the hint can name them
   * (D-3/D-4), and `summaryTimeoutSaveError` holds the server's real value
   * after a rejected write so a failure cannot look like a success (D-6).
   */
  const [summaryTimeoutSeconds, setSummaryTimeoutSeconds] = useState(
    String(DEFAULT_MEETING_SUMMARY_TIMEOUT_SECONDS),
  );
  const [summaryTimeoutDraft, setSummaryTimeoutDraft] = useState<null | string>(
    null,
  );
  const [summaryTimeoutStripped, setSummaryTimeoutStripped] = useState("");
  const [summaryTimeoutSaveError, setSummaryTimeoutSaveError] = useState<
    null | string
  >(null);
  /**
   * Meeting-**Enhance** timeout, in seconds — the exact twin of the block
   * above, and it exists because Enhance is the same shape of call (one
   * non-streaming generation per chunk) while its window was a hard-coded
   * 60 s nothing could widen. Same contract: the field shows what the server
   * holds, typing edits a LOCAL draft that writes nothing, the PUT fires on
   * blur / Enter / Reset only, an invalid draft reverts, and a failed write
   * shows the value the server actually kept. Bounds ONE call per chunk, not
   * the whole pass — which is what the helper copy says.
   */
  const [enhanceTimeoutSeconds, setEnhanceTimeoutSeconds] = useState(
    String(DEFAULT_MEETING_ENHANCE_TIMEOUT_SECONDS),
  );
  const [enhanceTimeoutDraft, setEnhanceTimeoutDraft] = useState<null | string>(
    null,
  );
  const [enhanceTimeoutStripped, setEnhanceTimeoutStripped] = useState("");
  const [enhanceTimeoutSaveError, setEnhanceTimeoutSaveError] = useState<
    null | string
  >(null);
  const [audioPlaybackMode, setAudioPlaybackMode] =
    useState<AudioPlaybackMode>("off");
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [launchAtStartup, setLaunchAtStartup] = useState(false);
  const [showOnLaunch, setShowOnLaunch] = useState(true);
  const [advancedMode, setAdvancedMode] = useState(false);
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(() =>
    parseSettingsSection(window.location.hash),
  );
  // Radix SelectItem cannot use an empty-string value, so the "system default"
  // microphone (stored as "") is represented by this sentinel at the Select
  // boundary only. Use an unlikely string to avoid colliding with a real
  // deviceId of "default".
  const SYSTEM_DEFAULT_MIC = "__system_default_mic__";
  const microphoneOptions = useMemo(
    () => [
      { value: "", label: t("settings.recording.microphoneDefault") },
      ...devices.map((d) => ({ value: d.deviceId, label: d.label })),
    ],
    [devices, t],
  );

  // Full transcription-language set from the cloud (all Soniox languages,
  // region-ordered), falling back to the bundled list when offline.
  const languageOptions = useLanguageOptions();

  // Translate mode enforces a single output language, so it only applies when
  // exactly one language is selected. Its label is that language's name.
  const singleLanguage = languages.length === 1 ? languages[0] : undefined;
  const languageLabel = useMemo(
    () =>
      singleLanguage
        ? (languageOptions.find((o) => o.code === singleLanguage)?.label ??
          singleLanguage)
        : "",
    [languageOptions, singleLanguage],
  );

  const retentionOptions = useMemo(
    () => [
      { value: "never", label: t("settings.data.autoDeleteNever") },
      { value: "7", label: t("settings.data.autoDelete7") },
      { value: "30", label: t("settings.data.autoDelete30") },
      { value: "custom", label: t("settings.data.autoDeleteCustom") },
    ],
    [t],
  );

  // Permissions
  type MicStatus =
    | "unknown"
    | "granted"
    | "denied"
    | "restricted"
    | "not-determined";
  const [micStatus, setMicStatus] = useState<MicStatus>("unknown");
  const [accessibilityStatus, setAccessibilityStatus] = useState<
    boolean | null
  >(null);
  const micPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const accessibilityPollRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const supportsBackgroundAudio = IS_MAC || IS_LINUX || IS_WINDOWS;
  // macOS and Windows can deep-link to the OS mic privacy settings.
  const canOpenMicSettings = IS_MAC || IS_WINDOWS;

  // System audio permission (meeting mode). Meeting-scoped: dictation-only
  // users must never see this row — same reasoning as the
  // meeting:probe-system-audio IPC handler (index.ts) and the meetings nav
  // entry (shell.tsx), both gated on the server-owned `meetings` flag.
  const { data: config } = useQuery(configQueryOptions());
  const meetingsEnabled = config?.flags?.meetings === true;
  // `supported` mirrors isSystemAudioCaptureSupported() (darwin >= 14.4),
  // read via the existing meeting:status IPC — cheap, no side effect.
  const [systemAudioSupported, setSystemAudioSupported] = useState(false);
  const showSystemAudioRow = meetingsEnabled && systemAudioSupported;
  // macOS has no preflight API for this TCC permission (see
  // system-audio-probe.ts): the only way to learn anything is to briefly run
  // the real capture pipeline. 'silent' is indeterminate (denied OR simply
  // nothing playing), so — like the meetings-page hint — we never render it
  // as a hard "needed" failure. It's also not "checking" forever once the
  // probe has actually returned: a finished-but-inconclusive result renders
  // as an honest "unknown" state instead (see PermissionControl/StatusDot
  // below), not a spinner that never resolves.
  const [systemAudioProbeResult, setSystemAudioProbeResult] = useState<
    "ok" | "silent" | "unsupported" | "error" | null
  >(null);
  const systemAudioProbeStartedRef = useRef(false);
  const systemAudioChecking = systemAudioProbeResult === null;
  const systemAudioGranted = systemAudioProbeResult === "ok";
  const systemAudioUnknown =
    systemAudioProbeResult !== null && systemAudioProbeResult !== "ok";

  const selectSection = useCallback((id: SettingsSectionId) => {
    setActiveSection(id);
    const nextHash = `#${id}`;
    if (window.location.hash !== nextHash) {
      window.history.replaceState(null, "", nextHash);
    }
  }, []);

  useEffect(() => {
    const onHashChange = () => {
      setActiveSection(parseSettingsSection(window.location.hash));
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const checkPermissions = useCallback(async () => {
    try {
      const mic = await resolveMicStatus();
      if (mic) setMicStatus(mic as MicStatus);
    } catch {}
    try {
      const acc = await window.api?.checkAccessibilityPermission();
      if (acc !== undefined) setAccessibilityStatus(acc);
    } catch {}
    try {
      const meetingStatus = await window.api?.getMeetingStatus();
      if (meetingStatus) setSystemAudioSupported(meetingStatus.supported);
    } catch {}
  }, []);

  const requestMic = useCallback(async () => {
    const status = await requestMicAccess();
    if (status) setMicStatus(status as MicStatus);
  }, []);

  const openMicSettings = useCallback(() => {
    window.api?.openMicSettings();
    if (micPollRef.current) clearInterval(micPollRef.current);
    micPollRef.current = setInterval(async () => {
      const mic = await window.api?.checkMicPermission();
      if (mic === "granted") {
        setMicStatus("granted");
        if (micPollRef.current) clearInterval(micPollRef.current);
        micPollRef.current = null;
      }
    }, 1000);
    setTimeout(() => {
      if (micPollRef.current) {
        clearInterval(micPollRef.current);
        micPollRef.current = null;
      }
    }, 30000);
  }, []);

  const openAccessibility = useCallback(() => {
    window.api?.openAccessibilitySettings();
    if (accessibilityPollRef.current)
      clearInterval(accessibilityPollRef.current);
    accessibilityPollRef.current = setInterval(async () => {
      const ok = await window.api?.checkAccessibilityPermission();
      if (ok) {
        setAccessibilityStatus(true);
        if (accessibilityPollRef.current)
          clearInterval(accessibilityPollRef.current);
        accessibilityPollRef.current = null;
      }
    }, 1000);
    setTimeout(() => {
      if (accessibilityPollRef.current) {
        clearInterval(accessibilityPollRef.current);
        accessibilityPollRef.current = null;
      }
    }, 30000);
  }, []);

  // No preflight/query API exists for this permission (see
  // system-audio-probe.ts) — nothing to poll after opening Settings, unlike
  // mic/accessibility above.
  const openSystemAudioSettings = useCallback(() => {
    window.api?.openAudioCaptureSettings?.();
  }, []);

  // Lazy by design (mirrors the meeting:probe-system-audio IPC handler's own
  // comment): only spawn the real capture pipeline once the user actually
  // opens the Permissions tab, not on every Settings window mount.
  useEffect(() => {
    if (activeSection !== "permissions") return;
    if (!showSystemAudioRow) return;
    if (systemAudioProbeStartedRef.current) return;
    systemAudioProbeStartedRef.current = true;
    if (typeof window.api?.probeMeetingSystemAudio !== "function") {
      // No preload bridge for this build/platform — nothing to wait on, so
      // don't leave the row stuck on "checking" forever.
      setSystemAudioProbeResult("unsupported");
      return;
    }
    void window.api
      .probeMeetingSystemAudio()
      .then((result) => {
        setSystemAudioProbeResult(result);
      })
      .catch(() => {
        // The probe call itself failed (not just an inconclusive "silent"
        // read) — still an honest "unknown" resting state, not a spinner
        // that never resolves.
        setSystemAudioProbeResult("error");
      });
  }, [activeSection, showSystemAudioRow]);

  const handleHotkeyModeChange = useCallback((mode: "hold" | "toggle") => {
    setHotkeyMode(mode);
    window.api?.setHotkeyMode(mode);
    void putSetting(SETTINGS_KEYS.hotkeyMode, mode);
  }, []);

  const handleHotkeyRecorded = useCallback((accelerator: string) => {
    setHotkey(accelerator);
    void putSetting(SETTINGS_KEYS.hotkey, accelerator);
  }, []);

  const handleRemixBarToggle = useCallback((enabled: boolean) => {
    setRemixBarEnabled(enabled);
    putSetting(SETTINGS_KEYS.remixBarEnabled, String(enabled))
      .then(() => window.api?.reloadRemixHotkey())
      .catch(() => {});
  }, []);

  // The remix listener re-reads its accelerator from the server rather than
  // being handed one, so the reload has to wait for the write to land.
  const handleRemixHotkeyRecorded = useCallback((accelerator: string) => {
    setRemixHotkey(accelerator);
    putSetting(SETTINGS_KEYS.remixHotkey, accelerator)
      .then(() => window.api?.reloadRemixHotkey())
      .catch(() => {});
  }, []);

  const {
    state: recorderState,
    liveModifiers,
    capturedCombo,
    canSaveRecording,
    needsModifierOrMouseButton,
    invalidReleaseNotice,
    blockedNotice,
    startRecording: startHotkeyRecording,
    cancelRecording: cancelHotkeyRecording,
  } = useHotkeyRecorder(handleHotkeyRecorded, {
    isBlocked: (accel) =>
      acceleratorsEqual(accel, remixHotkey) ||
      Object.values(languageHotkeys).some((a) => acceleratorsEqual(accel, a)),
  });

  const {
    state: remixRecorderState,
    liveModifiers: remixLiveModifiers,
    capturedCombo: remixCapturedCombo,
    canSaveRecording: remixCanSave,
    needsModifierOrMouseButton: remixNeedsModifier,
    blockedNotice: remixBlockedNotice,
    startRecording: startRemixHotkeyRecording,
    cancelRecording: cancelRemixHotkeyRecording,
  } = useHotkeyRecorder(handleRemixHotkeyRecorded, {
    target: "remix",
    isBlocked: (accel) =>
      acceleratorsEqual(accel, hotkey) ||
      Object.values(languageHotkeys).some((a) => acceleratorsEqual(accel, a)),
  });

  const queryClient = useQueryClient();

  // All persisted settings in one request (replaces ~10 individual GETs).
  const settingsQuery = useQuery(settingsQueryOptions());

  // Seed local form state from the batch once it first resolves. Handlers
  // persist changes directly, so we only seed once (guarded) to avoid
  // clobbering edits if the query is later invalidated.
  const settingsSeeded = useRef(false);
  useEffect(() => {
    const s = settingsQuery.data;
    if (!s || settingsSeeded.current) return;
    settingsSeeded.current = true;

    if (s[SETTINGS_KEYS.micDeviceId])
      setSelectedDevice(s[SETTINGS_KEYS.micDeviceId]);
    if (s[SETTINGS_KEYS.hotkey]) setHotkey(s[SETTINGS_KEYS.hotkey]);
    if (s[SETTINGS_KEYS.hotkeyMode] === "toggle") setHotkeyMode("toggle");
    if (s[SETTINGS_KEYS.remixHotkey])
      setRemixHotkey(s[SETTINGS_KEYS.remixHotkey]);
    setRemixBarEnabled(s[SETTINGS_KEYS.remixBarEnabled] !== "false");
    setLanguages(parseLanguagesSetting(s));
    if (s[SETTINGS_KEYS.languageHotkeys]) {
      try {
        setLanguageHotkeys(JSON.parse(s[SETTINGS_KEYS.languageHotkeys]));
      } catch {
        setLanguageHotkeys({});
      }
    }
    if (s[SETTINGS_KEYS.translateMode] === "true") setTranslateMode(true);
    if (s[SETTINGS_KEYS.outputMode]) setOutputMode(s[SETTINGS_KEYS.outputMode]);
    setPillCancel(normalizePillCancelMode(s[SETTINGS_KEYS.pillCancelButton]));
    if (s[SETTINGS_KEYS.soundEnabled] === "false") setSoundEnabled(false);
    if (s[SETTINGS_KEYS.historyPaused] === "true") setHistoryPaused(true);
    if (s[SETTINGS_KEYS.advancedMode] === "true") setAdvancedMode(true);

    const retentionDays = parseRetentionDays(
      s[SETTINGS_KEYS.historyRetentionDays],
    );
    if (retentionDays !== null) {
      if (retentionDays === 7 || retentionDays === 30) {
        setHistoryRetention(String(retentionDays) as "7" | "30");
      } else {
        setHistoryRetention("custom");
        setCustomRetentionDays(String(retentionDays));
      }
    }

    // Unset (or a legacy out-of-bounds row) → show the default, which is
    // exactly what the resolver uses.
    const summaryTimeout = parseMeetingSummaryTimeoutSeconds(
      s[SETTINGS_KEYS.meetingSummaryTimeoutSeconds],
    );
    if (summaryTimeout !== null) {
      setSummaryTimeoutSeconds(String(summaryTimeout));
    }

    // Same posture for the Enhance twin: unset or a legacy out-of-bounds row
    // shows the default, which is exactly what the resolver uses.
    const enhanceTimeout = parseMeetingEnhanceTimeoutSeconds(
      s[SETTINGS_KEYS.meetingEnhanceTimeoutSeconds],
    );
    if (enhanceTimeout !== null) {
      setEnhanceTimeoutSeconds(String(enhanceTimeout));
    }

    // Audio playback mode with legacy fallback chain (new key → paused → duck).
    setAudioPlaybackMode(resolveAudioPlaybackMode(s));
  }, [settingsQuery.data]);

  // Load available audio input devices
  useEffect(() => {
    (async () => {
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => {
          for (const t of s.getTracks()) t.stop();
        });
        const allDevices = await navigator.mediaDevices.enumerateDevices();
        setDevices(
          allDevices
            .filter((d) => d.kind === "audioinput")
            .map((d) => ({
              deviceId: d.deviceId,
              label: d.label || `Microphone ${d.deviceId.slice(0, 8)}`,
            })),
        );
      } catch {
        // ignore
      }
    })();
  }, []);

  // Load window/IPC-backed settings.
  // (Server-persisted settings are seeded from the batch query above.)
  useEffect(() => {
    window.api
      ?.getPillPosition()
      .then((pos) => setPillPosition(normalizePillPos(pos)))
      .catch(() => {});
    // Auto-update setting
    window.api
      ?.getAutoUpdate()
      .then((v) => setAutoUpdate(v))
      .catch(() => {});

    // Launch at startup setting
    window.api
      ?.getLaunchAtStartup()
      .then((v) => setLaunchAtStartup(v))
      .catch(() => {});

    // Show dashboard on launch setting
    window.api
      ?.getShowDashboardOnLaunch()
      .then((v) => setShowOnLaunch(v))
      .catch(() => {});

    // Pill position live changes
    const removePillPos = window.api?.onPillPositionChanged((pos) => {
      setPillPosition(normalizePillPos(pos));
    });

    checkPermissions();

    return () => {
      removePillPos?.();
      if (micPollRef.current) clearInterval(micPollRef.current);
      if (accessibilityPollRef.current)
        clearInterval(accessibilityPollRef.current);
    };
  }, [checkPermissions]);

  const handleDeviceChange = useCallback((deviceId: string) => {
    setSelectedDevice(deviceId);
    void putSetting(SETTINGS_KEYS.micDeviceId, deviceId);
  }, []);

  const handleThemeChange = useCallback(
    (value: string) => {
      setTheme(value);
      void putSetting(SETTINGS_KEYS.theme, value);
    },
    [setTheme],
  );

  const persistTranslateMode = useCallback((value: boolean) => {
    setTranslateMode(value);
    void putSetting(SETTINGS_KEYS.translateMode, String(value));
  }, []);

  // Pushes the map straight to the main process (no reload round-trip — this
  // is the value it just persisted) alongside the server write, mirroring
  // how the other Electron-only hotkey settings are wired.
  const persistLanguageHotkeys = useCallback((next: Record<string, string>) => {
    setLanguageHotkeys(next);
    void putSetting(SETTINGS_KEYS.languageHotkeys, JSON.stringify(next));
    window.api?.updateLanguageHotkeys(next);
  }, []);

  const handleLanguageHotkeyRecorded = useCallback(
    (code: string, accelerator: string) => {
      persistLanguageHotkeys({ ...languageHotkeys, [code]: accelerator });
    },
    [languageHotkeys, persistLanguageHotkeys],
  );

  const handleLanguageHotkeyClear = useCallback(
    (code: string) => {
      const { [code]: _removed, ...rest } = languageHotkeys;
      persistLanguageHotkeys(rest);
    },
    [languageHotkeys, persistLanguageHotkeys],
  );

  const handleLanguagesChange = useCallback(
    (next: string[]) => {
      const normalized = normalizeLanguageList(next);
      setLanguages(normalized);
      void putSetting(SETTINGS_KEYS.languages, JSON.stringify(normalized));
      // Translate mode requires exactly one language; disable it otherwise.
      if (normalized.length !== 1 && translateMode) persistTranslateMode(false);

      // Prune hotkeys bound to languages no longer configured — same
      // remove-implies-unset rule translate mode already follows above.
      const pruned = Object.fromEntries(
        Object.entries(languageHotkeys).filter(([code]) =>
          normalized.includes(code),
        ),
      );
      if (Object.keys(pruned).length !== Object.keys(languageHotkeys).length) {
        persistLanguageHotkeys(pruned);
      }
    },
    [
      translateMode,
      persistTranslateMode,
      languageHotkeys,
      persistLanguageHotkeys,
    ],
  );

  const handleOutputModeChange = useCallback((value: string) => {
    setOutputMode(value);
    window.api?.sendOutputModeChanged(value);
    void putSetting(SETTINGS_KEYS.outputMode, value);
  }, []);

  const handlePillPositionChange = useCallback((value: string) => {
    setPillPosition(value);
    window.api?.setPillPosition(value);
  }, []);

  const handlePillCancelChange = useCallback((value: string) => {
    const mode = normalizePillCancelMode(value);
    setPillCancel(mode);
    window.api?.sendPillCancelModeChanged(mode);
    void putSetting(SETTINGS_KEYS.pillCancelButton, mode);
  }, []);

  const handleAutoUpdateToggle = useCallback((enabled: boolean) => {
    setAutoUpdate(enabled);
    window.api?.setAutoUpdate(enabled);
  }, []);

  const handleLaunchAtStartupToggle = useCallback((enabled: boolean) => {
    setLaunchAtStartup(enabled);
    window.api?.setLaunchAtStartup(enabled);
  }, []);

  const handleShowOnLaunchToggle = useCallback((enabled: boolean) => {
    setShowOnLaunch(enabled);
    window.api?.setShowDashboardOnLaunch(enabled);
  }, []);

  const handleAdvancedModeToggle = useCallback(
    (enabled: boolean) => {
      setAdvancedMode(enabled);
      // Patch the shared settings cache so the sidebar (which reads the same
      // query) shows/hides the Models tab immediately, without a refetch.
      queryClient.setQueryData<Record<string, string>>(
        queryKeys.settings,
        (prev) => ({
          ...(prev ?? {}),
          [SETTINGS_KEYS.advancedMode]: String(enabled),
        }),
      );
      void putSetting(SETTINGS_KEYS.advancedMode, String(enabled));
    },
    [queryClient],
  );

  const clearHistory = useCallback(async () => {
    if (!confirm(t("settings.data.clearHistoryConfirm"))) {
      return;
    }
    await getClient().api.history.$delete();
    void queryClient.invalidateQueries({ queryKey: queryKeys.history.all });
  }, [t, queryClient]);

  const handleSoundToggle = useCallback((enabled: boolean) => {
    setSoundEnabled(enabled);
    window.api?.sendSoundEnabledChanged(enabled);
    void putSetting(SETTINGS_KEYS.soundEnabled, String(enabled));
  }, []);

  const handleHistoryPausedToggle = useCallback((paused: boolean) => {
    setHistoryPaused(paused);
    void putSetting(SETTINGS_KEYS.historyPaused, String(paused));
  }, []);

  const saveHistoryRetention = useCallback((days: string) => {
    void putSetting(SETTINGS_KEYS.historyRetentionDays, days);
  }, []);

  const handleHistoryRetentionChange = useCallback(
    (value: string) => {
      const preset = value as "never" | "7" | "30" | "custom";
      setHistoryRetention(preset);
      if (preset === "never") {
        saveHistoryRetention("");
      } else if (preset === "custom") {
        if (parseRetentionDays(customRetentionDays) !== null) {
          saveHistoryRetention(customRetentionDays);
        }
      } else {
        saveHistoryRetention(preset);
      }
    },
    [customRetentionDays, saveHistoryRetention],
  );

  const handleCustomRetentionDaysChange = useCallback(
    (raw: string) => {
      const digits = sanitizeDigits(raw, 4);
      const clamped =
        digits === ""
          ? ""
          : String(Math.min(Number(digits), HISTORY_RETENTION_DAYS_MAX));
      setCustomRetentionDays(clamped);
      if (parseRetentionDays(clamped) !== null) {
        saveHistoryRetention(clamped);
      }
    },
    [saveHistoryRetention],
  );

  /**
   * Read what the server ACTUALLY holds for this key. Used after a failed
   * write, so the field shows the budget the summarize lane will really get
   * rather than the number the user just typed. A failed read falls back to
   * the default — the same value `meetingSummaryTimeoutMs()` would use, so
   * even a double failure cannot put a fantasy number on screen.
   */
  const readSummaryTimeoutFromServer =
    useCallback(async (): Promise<string> => {
      const fallback = displayValueFor(
        null,
        DEFAULT_MEETING_SUMMARY_TIMEOUT_SECONDS,
        parseMeetingSummaryTimeoutSeconds,
      );
      try {
        const res = await getClient().api.settings[":key"].$get({
          param: { key: SETTINGS_KEYS.meetingSummaryTimeoutSeconds },
        });
        if (!res.ok) return fallback;
        const body = (await res.json()) as { value?: string | null };
        return displayValueFor(
          body.value ?? null,
          DEFAULT_MEETING_SUMMARY_TIMEOUT_SECONDS,
          parseMeetingSummaryTimeoutSeconds,
        );
      } catch {
        return fallback;
      }
    }, []);

  /**
   * The control's ONE write path, reachable only from blur, Enter and Reset —
   * never from `onChange`. `resolveCommitIntent` decides: in-bounds changed
   * draft → one PUT; unchanged or invalid draft → nothing, field reverts;
   * Reset → PUT `""`, which the resolver reads as the default (D-5 — clearing
   * the field cannot express this, an empty draft is invalid and invalid never
   * writes). A rejected write re-reads the key and shows the server's value
   * in the destructive hint, so a failure is never mistaken for a save.
   */
  const commitSummaryTimeout = useCallback(
    async (draft: string | null, trigger: CommitTrigger): Promise<void> => {
      const intent = resolveCommitIntent({
        trigger,
        draft,
        saved: summaryTimeoutSeconds,
        parse: parseMeetingSummaryTimeoutSeconds,
      });
      setSummaryTimeoutDraft(null);
      setSummaryTimeoutStripped("");
      setSummaryTimeoutSaveError(null);
      if (intent.kind !== "write" && intent.kind !== "reset") return;
      const value = intent.kind === "reset" ? "" : intent.value;
      if (await putSetting(SETTINGS_KEYS.meetingSummaryTimeoutSeconds, value)) {
        setSummaryTimeoutSeconds(
          displayValueFor(
            value,
            DEFAULT_MEETING_SUMMARY_TIMEOUT_SECONDS,
            parseMeetingSummaryTimeoutSeconds,
          ),
        );
        // Keep the shared settings cache honest — other readers of this key
        // must not see a value that was never committed.
        queryClient.setQueryData<Record<string, string>>(
          queryKeys.settings,
          (prev) => ({
            ...(prev ?? {}),
            [SETTINGS_KEYS.meetingSummaryTimeoutSeconds]: value,
          }),
        );
        return;
      }
      const held = await readSummaryTimeoutFromServer();
      setSummaryTimeoutSeconds(held);
      setSummaryTimeoutSaveError(held);
    },
    [queryClient, readSummaryTimeoutFromServer, summaryTimeoutSeconds],
  );

  /** Typing updates the LOCAL DRAFT only. This handler never writes. */
  const handleSummaryTimeoutChange = useCallback((raw: string) => {
    const draft = sanitizeDigits(raw, SUMMARY_TIMEOUT_MAX_DIGITS);
    setSummaryTimeoutDraft(draft);
    setSummaryTimeoutStripped(
      inspectNumericDraft(raw, SUMMARY_TIMEOUT_MAX_DIGITS).stripped,
    );
    setSummaryTimeoutSaveError(null);
  }, []);

  const handleSummaryTimeoutBlur = useCallback(
    (raw: string) => {
      void commitSummaryTimeout(
        sanitizeDigits(raw, SUMMARY_TIMEOUT_MAX_DIGITS),
        "blur",
      );
    },
    [commitSummaryTimeout],
  );

  const handleSummaryTimeoutKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void commitSummaryTimeout(event.currentTarget.value, "enter");
      }
    },
    [commitSummaryTimeout],
  );

  /**
   * Enhance twin of `readSummaryTimeoutFromServer` — read what the server
   * ACTUALLY holds, so after a failed write the field shows the window the
   * Enhance lane will really get. A failed read falls back to the default, the
   * same value `meetingEnhanceTimeoutMs()` would use.
   */
  const readEnhanceTimeoutFromServer =
    useCallback(async (): Promise<string> => {
      const fallback = displayValueFor(
        null,
        DEFAULT_MEETING_ENHANCE_TIMEOUT_SECONDS,
        parseMeetingEnhanceTimeoutSeconds,
      );
      try {
        const res = await getClient().api.settings[":key"].$get({
          param: { key: SETTINGS_KEYS.meetingEnhanceTimeoutSeconds },
        });
        if (!res.ok) return fallback;
        const body = (await res.json()) as { value?: string | null };
        return displayValueFor(
          body.value ?? null,
          DEFAULT_MEETING_ENHANCE_TIMEOUT_SECONDS,
          parseMeetingEnhanceTimeoutSeconds,
        );
      } catch {
        return fallback;
      }
    }, []);

  /** The Enhance control's ONE write path — blur, Enter, Reset only, never
   *  `onChange`. Same decision table as the summarize control's. */
  const commitEnhanceTimeout = useCallback(
    async (draft: string | null, trigger: CommitTrigger): Promise<void> => {
      const intent = resolveCommitIntent({
        trigger,
        draft,
        saved: enhanceTimeoutSeconds,
        parse: parseMeetingEnhanceTimeoutSeconds,
      });
      setEnhanceTimeoutDraft(null);
      setEnhanceTimeoutStripped("");
      setEnhanceTimeoutSaveError(null);
      if (intent.kind !== "write" && intent.kind !== "reset") return;
      const value = intent.kind === "reset" ? "" : intent.value;
      if (await putSetting(SETTINGS_KEYS.meetingEnhanceTimeoutSeconds, value)) {
        setEnhanceTimeoutSeconds(
          displayValueFor(
            value,
            DEFAULT_MEETING_ENHANCE_TIMEOUT_SECONDS,
            parseMeetingEnhanceTimeoutSeconds,
          ),
        );
        queryClient.setQueryData<Record<string, string>>(
          queryKeys.settings,
          (prev) => ({
            ...(prev ?? {}),
            [SETTINGS_KEYS.meetingEnhanceTimeoutSeconds]: value,
          }),
        );
        return;
      }
      const held = await readEnhanceTimeoutFromServer();
      setEnhanceTimeoutSeconds(held);
      setEnhanceTimeoutSaveError(held);
    },
    [queryClient, readEnhanceTimeoutFromServer, enhanceTimeoutSeconds],
  );

  /** Typing updates the LOCAL DRAFT only. This handler never writes. */
  const handleEnhanceTimeoutChange = useCallback((raw: string) => {
    const draft = sanitizeDigits(raw, ENHANCE_TIMEOUT_MAX_DIGITS);
    setEnhanceTimeoutDraft(draft);
    setEnhanceTimeoutStripped(
      inspectNumericDraft(raw, ENHANCE_TIMEOUT_MAX_DIGITS).stripped,
    );
    setEnhanceTimeoutSaveError(null);
  }, []);

  const handleEnhanceTimeoutBlur = useCallback(
    (raw: string) => {
      void commitEnhanceTimeout(
        sanitizeDigits(raw, ENHANCE_TIMEOUT_MAX_DIGITS),
        "blur",
      );
    },
    [commitEnhanceTimeout],
  );

  const handleEnhanceTimeoutKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void commitEnhanceTimeout(event.currentTarget.value, "enter");
      }
    },
    [commitEnhanceTimeout],
  );

  /** Mid-typing only: the persisted value is always in bounds. */
  const summaryTimeoutInvalid =
    summaryTimeoutDraft !== null &&
    parseMeetingSummaryTimeoutSeconds(summaryTimeoutDraft) === null;

  const enhanceTimeoutInvalid =
    enhanceTimeoutDraft !== null &&
    parseMeetingEnhanceTimeoutSeconds(enhanceTimeoutDraft) === null;

  /**
   * Hint precedence: a failed save (names what the server holds) beats an
   * out-of-bounds draft (names the bound), which beats a stripped entry
   * (names what the user typed vs what the field now holds — the renderer
   * turns `-45.7` into `457` where the server would answer 400, so it says
   * so instead of reinterpreting input in silence), which falls back to the
   * neutral range line.
   */
  const summaryTimeoutHint: { destructive: boolean; text: string } =
    summaryTimeoutSaveError !== null
      ? {
          destructive: true,
          text: t("settings.data.summaryTimeoutSaveFailed", {
            value: summaryTimeoutSaveError,
          }),
        }
      : summaryTimeoutInvalid
        ? {
            destructive: true,
            text: t("settings.data.summaryTimeoutInvalid", {
              min: MEETING_SUMMARY_TIMEOUT_SECONDS_MIN,
              max: MEETING_SUMMARY_TIMEOUT_SECONDS_MAX,
            }),
          }
        : summaryTimeoutStripped !== ""
          ? {
              destructive: true,
              text: t("settings.data.summaryTimeoutStripped", {
                dropped: summaryTimeoutStripped,
                value: summaryTimeoutDraft ?? "",
              }),
            }
          : {
              destructive: false,
              text: t("settings.data.summaryTimeoutRange", {
                min: MEETING_SUMMARY_TIMEOUT_SECONDS_MIN,
                max: MEETING_SUMMARY_TIMEOUT_SECONDS_MAX,
              }),
            };

  /** Same precedence for the Enhance control. */
  const enhanceTimeoutHint: { destructive: boolean; text: string } =
    enhanceTimeoutSaveError !== null
      ? {
          destructive: true,
          text: t("settings.data.enhanceTimeoutSaveFailed", {
            value: enhanceTimeoutSaveError,
          }),
        }
      : enhanceTimeoutInvalid
        ? {
            destructive: true,
            text: t("settings.data.enhanceTimeoutInvalid", {
              min: MEETING_ENHANCE_TIMEOUT_SECONDS_MIN,
              max: MEETING_ENHANCE_TIMEOUT_SECONDS_MAX,
            }),
          }
        : enhanceTimeoutStripped !== ""
          ? {
              destructive: true,
              text: t("settings.data.enhanceTimeoutStripped", {
                dropped: enhanceTimeoutStripped,
                value: enhanceTimeoutDraft ?? "",
              }),
            }
          : {
              destructive: false,
              text: t("settings.data.enhanceTimeoutRange", {
                min: MEETING_ENHANCE_TIMEOUT_SECONDS_MIN,
                max: MEETING_ENHANCE_TIMEOUT_SECONDS_MAX,
              }),
            };

  const handleAudioPlaybackModeChange = useCallback((value: string) => {
    const mode = normalizeAudioPlaybackMode(value);
    setAudioPlaybackMode(mode);
    window.api?.sendAudioPlaybackModeChanged(mode);
    void putSetting(SETTINGS_KEYS.audioPlaybackMode, mode);
    void putSetting(SETTINGS_KEYS.audioDuckingEnabled, String(mode === "duck"));
  }, []);

  // Build display keys for current recorder state
  const liveKeys = liveModifiers.map(keyDisplayLabel);
  const draftKeys = capturedCombo ? comboDisplayKeys(capturedCombo) : liveKeys;
  const remixLiveKeys = remixLiveModifiers.map(keyDisplayLabel);
  const remixDraftKeys = remixCapturedCombo
    ? comboDisplayKeys(remixCapturedCombo)
    : remixLiveKeys;
  const remixCaptureHint = remixNeedsModifier
    ? "Add a modifier or side mouse button · Esc to cancel"
    : remixCanSave
      ? "Release to save · Esc to cancel"
      : "Press a modifier or side mouse button... · Esc to cancel";
  const captureHint = needsModifierOrMouseButton
    ? "Add a modifier or side mouse button · Esc to cancel"
    : canSaveRecording
      ? "Release to save · Esc to cancel"
      : "Press a modifier or side mouse button... · Esc to cancel";

  const activeSectionLabel = t(`settings.sections.${activeSection}`);

  const positionOptions = useMemo<SegmentedOption[]>(() => {
    const opts: SegmentedOption[] = [
      { value: "top-center", label: t("settings.display.positionTopCenter") },
      { value: "top-right", label: t("settings.display.positionTopRight") },
      {
        value: "bottom-center",
        label: t("settings.display.positionBottomCenter"),
      },
      {
        value: "bottom-right",
        label: t("settings.display.positionBottomRight"),
      },
    ];
    if (pillPosition === "custom")
      opts.push({
        value: "custom",
        label: t("settings.display.positionCustom"),
      });
    return opts;
  }, [pillPosition, t]);

  const cancelButtonOptions = useMemo<SegmentedOption[]>(
    () => [
      { value: "hover", label: t("settings.display.cancelButtonHover") },
      { value: "always", label: t("settings.display.cancelButtonAlways") },
    ],
    [t],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DragSpacer />
      <div className="responsive-page-scroll grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] gap-x-10 gap-y-6 !pb-0 min-[900px]:grid-cols-[180px_minmax(0,1fr)]">
        <div className="min-[900px]:col-span-2">
          <div className="mb-7">
            <h1 className="display text-foreground m-0 text-[32px] font-medium leading-tight tracking-[-0.02em]">
              {t("settings.title")}
            </h1>
          </div>
        </div>

        <SettingsSidebar active={activeSection} onSelect={selectSection} />

        <div className="min-h-0 max-w-[694px] overflow-y-auto px-1 -mx-1">
          <h2 className="display text-foreground mb-6 text-[26px] font-medium tracking-[-0.02em]">
            {activeSectionLabel}
          </h2>

          {activeSection === "application" && (
            <SettingsPanel>
              <Row
                label={t("settings.interfaceLanguage.label")}
                desc={t("settings.interfaceLanguage.desc")}
              >
                <LanguageSelector />
              </Row>
              <Row
                label={t("settings.application.autoUpdate")}
                desc={t("settings.application.autoUpdateDesc")}
              >
                <Switch
                  checked={autoUpdate}
                  onCheckedChange={handleAutoUpdateToggle}
                />
              </Row>
              <Row
                label={t("settings.application.launchAtStartup")}
                desc={t("settings.application.launchAtStartupDesc")}
              >
                <Switch
                  checked={launchAtStartup}
                  onCheckedChange={handleLaunchAtStartupToggle}
                />
              </Row>
              <Row
                label={t("settings.application.showOnLaunch")}
                desc={t("settings.application.showOnLaunchDesc")}
              >
                <Switch
                  checked={showOnLaunch}
                  onCheckedChange={handleShowOnLaunchToggle}
                />
              </Row>
              <Row
                label={t("settings.application.advancedMode")}
                desc={t("settings.application.advancedModeDesc")}
              >
                <Switch
                  checked={advancedMode}
                  onCheckedChange={handleAdvancedModeToggle}
                />
              </Row>
              <Row
                label={t("settings.application.acknowledgments")}
                desc={t("settings.application.acknowledgmentsDesc")}
                stacked
                last
              >
                <p className="text-muted-foreground text-[12.5px] leading-[1.6]">
                  <Trans
                    i18nKey="settings.application.acknowledgmentsText"
                    components={{
                      pyannote: (
                        // biome-ignore lint/a11y/useAnchorContent: Trans injects the link text from the translated string at runtime, per the acknowledgmentsText key.
                        <a
                          href="https://huggingface.co/pyannote/speaker-diarization-community-1"
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary underline underline-offset-2"
                        />
                      ),
                      fluidaudio: (
                        // biome-ignore lint/a11y/useAnchorContent: Trans injects the link text from the translated string at runtime, per the acknowledgmentsText key.
                        <a
                          href="https://github.com/FluidInference/FluidAudio"
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary underline underline-offset-2"
                        />
                      ),
                    }}
                  />
                </p>
              </Row>
            </SettingsPanel>
          )}

          {activeSection === "recording" && (
            <SettingsPanel>
              <Row
                label={t("settings.recording.hotkey")}
                desc={
                  hotkeyMode === "toggle"
                    ? t("settings.recording.hotkeyDescToggle")
                    : t("settings.recording.hotkeyDescHold")
                }
              >
                {recorderState === "idle" ? (
                  <div className="relative inline-flex">
                    <Button
                      variant="outline"
                      onClick={startHotkeyRecording}
                      className="h-auto max-w-full flex-wrap gap-3 px-3.5 py-2"
                    >
                      <Keyboard className="text-muted-foreground size-4 shrink-0" />
                      <KeyComboDisplay keys={formatAcceleratorKeys(hotkey)} />
                      <span className="text-muted-foreground ml-1 text-xs">
                        {t("common.change")}
                      </span>
                    </Button>
                    {(invalidReleaseNotice || blockedNotice) && (
                      <div className="bg-popover text-popover-foreground border-border shadow-[0_4px_16px_rgba(29,33,41,.08)] absolute top-[calc(100%+6px)] right-0 z-20 whitespace-nowrap rounded-md border px-2.5 py-1.5 text-xs">
                        {blockedNotice
                          ? // isBlocked now covers remix AND every bound language
                            // hotkey (§7/§8 closed the reverse direction too), so
                            // this can no longer name one specific binding —
                            // generic copy, same reasoning as the language row's
                            // own conflict message.
                            t("settings.recording.languageHotkeyConflict")
                          : t("settings.recording.needsModifier")}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="border-border bg-secondary relative inline-flex max-w-full flex-wrap items-center gap-3 rounded-full border px-3.5 py-2">
                    <Keyboard className="text-primary h-4 w-4 shrink-0" />
                    {draftKeys.length > 0 ? (
                      <>
                        <KeyComboDisplay keys={draftKeys} variant="dim" />
                        <span className="text-muted-foreground text-xs">
                          {captureHint}
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground animate-pulse text-sm">
                        {captureHint}
                      </span>
                    )}
                    {invalidReleaseNotice && (
                      <div className="bg-popover text-popover-foreground border-border shadow-[0_4px_16px_rgba(29,33,41,.08)] absolute top-[calc(100%+6px)] right-0 z-20 whitespace-nowrap rounded-md border px-2.5 py-1.5 text-xs">
                        {t("settings.recording.needsModifier")}
                      </div>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={cancelHotkeyRecording}
                      className="ml-1"
                    >
                      {t("common.cancel")}
                    </Button>
                  </div>
                )}
              </Row>

              <Row
                label={t("settings.recording.activation")}
                desc={
                  hotkeyMode === "toggle"
                    ? t("settings.recording.activationDescToggle")
                    : t("settings.recording.activationDescHold")
                }
              >
                <SegmentedControl
                  value={hotkeyMode}
                  onValueChange={(v) =>
                    handleHotkeyModeChange(v as "hold" | "toggle")
                  }
                  options={[
                    {
                      value: "hold",
                      label: t("settings.recording.activationHold"),
                    },
                    {
                      value: "toggle",
                      label: t("settings.recording.activationToggle"),
                    },
                  ]}
                />
              </Row>

              <Row
                label={t("settings.recording.microphone")}
                desc={t("settings.recording.microphoneDesc")}
              >
                <Select
                  value={
                    selectedDevice === "" ? SYSTEM_DEFAULT_MIC : selectedDevice
                  }
                  onValueChange={(v) =>
                    handleDeviceChange(v === SYSTEM_DEFAULT_MIC ? "" : v)
                  }
                >
                  <SelectTrigger
                    id="settings-microphone"
                    className="w-full max-w-md"
                  >
                    <Mic className="text-muted-foreground size-4 shrink-0" />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {microphoneOptions.map((o) => (
                      <SelectItem
                        key={o.value}
                        value={o.value === "" ? SYSTEM_DEFAULT_MIC : o.value}
                      >
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Row>

              <Row
                label={t("settings.recording.language")}
                desc={
                  languages.length === 0
                    ? t("settings.recording.languageDescAuto")
                    : languages.length > 1
                      ? t("settings.recording.languageDescMulti")
                      : translateMode
                        ? t("settings.recording.languageDescEnforced", {
                            language: languageLabel,
                          })
                        : t("settings.recording.languageDescHint", {
                            language: languageLabel,
                          })
                }
              >
                <LanguageMultiSelect
                  id="settings-language"
                  values={languages}
                  onChange={handleLanguagesChange}
                  options={languageOptions}
                  className="w-full max-w-md"
                />
              </Row>

              <Row
                label={t("settings.recording.translateMode")}
                desc={t("settings.recording.translateModeDesc")}
              >
                <Switch
                  id="settings-translate-mode"
                  checked={translateMode && languages.length === 1}
                  disabled={languages.length !== 1}
                  onCheckedChange={persistTranslateMode}
                />
              </Row>

              {languages.length > 1 &&
                languages.map((code) => (
                  <LanguageHotkeyRow
                    key={code}
                    code={code}
                    label={
                      languageOptions.find((o) => o.code === code)?.label ??
                      code
                    }
                    value={languageHotkeys[code]}
                    isBlocked={(accel) =>
                      acceleratorsEqual(accel, hotkey) ||
                      acceleratorsEqual(accel, remixHotkey) ||
                      languages.some(
                        (other) =>
                          other !== code &&
                          languageHotkeys[other] &&
                          acceleratorsEqual(accel, languageHotkeys[other]),
                      )
                    }
                    onRecorded={handleLanguageHotkeyRecorded}
                    onClear={handleLanguageHotkeyClear}
                  />
                ))}

              <Row
                label={t("settings.recording.outputMode")}
                desc={t("settings.recording.outputModeDesc")}
              >
                <SegmentedControl
                  size="sm"
                  options={[
                    {
                      value: "paste",
                      label: t("settings.recording.outputModePaste"),
                    },
                    {
                      value: "clipboard",
                      label: t("settings.recording.outputModeClipboard"),
                    },
                  ]}
                  value={outputMode}
                  onValueChange={handleOutputModeChange}
                />
              </Row>

              <Row
                last={!supportsBackgroundAudio}
                label={t("settings.recording.sound")}
                desc={t("settings.recording.soundDesc")}
              >
                <div className="flex items-center gap-2.5">
                  {soundEnabled ? (
                    <Volume2 className="text-muted-foreground h-4 w-4 shrink-0" />
                  ) : (
                    <VolumeOff className="text-muted-foreground h-4 w-4 shrink-0" />
                  )}
                  <Switch
                    checked={soundEnabled}
                    onCheckedChange={handleSoundToggle}
                  />
                </div>
              </Row>

              {supportsBackgroundAudio ? (
                <Row
                  label="Background audio"
                  desc={
                    IS_LINUX
                      ? "Duck lowers system volume. Pause pauses MPRIS media and lowers volume."
                      : "Duck lowers volume. Pause pauses current media and lowers volume."
                  }
                  last
                >
                  <SegmentedControl
                    size="sm"
                    options={audioPlaybackOptions}
                    value={audioPlaybackMode}
                    onValueChange={handleAudioPlaybackModeChange}
                  />
                </Row>
              ) : null}
            </SettingsPanel>
          )}

          {activeSection === "remix" && (
            <SettingsPanel>
              <Row
                label={t("settings.remix.hotkey")}
                desc={
                  remixHotkey === hotkey
                    ? t("settings.remix.conflict")
                    : t("settings.remix.hotkeyDesc")
                }
              >
                {remixRecorderState === "idle" ? (
                  <div className="relative inline-flex">
                    <Button
                      variant="outline"
                      onClick={startRemixHotkeyRecording}
                      className="h-auto max-w-full flex-wrap gap-3 px-3.5 py-2"
                    >
                      <Keyboard className="text-muted-foreground size-4 shrink-0" />
                      <KeyComboDisplay
                        keys={formatAcceleratorKeys(remixHotkey)}
                      />
                      <span className="text-muted-foreground ml-1 text-xs">
                        {t("common.change")}
                      </span>
                    </Button>
                    {remixBlockedNotice && (
                      <div className="bg-popover text-popover-foreground border-border shadow-[0_4px_16px_rgba(29,33,41,.08)] absolute top-[calc(100%+6px)] right-0 z-20 whitespace-nowrap rounded-md border px-2.5 py-1.5 text-xs">
                        {/* isBlocked now covers dictation AND every bound
                            language hotkey, so this can no longer name one
                            specific binding — generic copy. */}
                        {t("settings.recording.languageHotkeyConflict")}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="border-border bg-secondary relative inline-flex max-w-full flex-wrap items-center gap-3 rounded-full border px-3.5 py-2">
                    <Keyboard className="text-primary h-4 w-4 shrink-0" />
                    {remixDraftKeys.length > 0 ? (
                      <>
                        <KeyComboDisplay keys={remixDraftKeys} variant="dim" />
                        <span className="text-muted-foreground text-xs">
                          {remixCaptureHint}
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground animate-pulse text-sm">
                        {remixCaptureHint}
                      </span>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={cancelRemixHotkeyRecording}
                      className="ml-1"
                    >
                      {t("common.cancel")}
                    </Button>
                  </div>
                )}
              </Row>

              <Row
                label={t("settings.remix.bar")}
                desc={t("settings.remix.barDesc")}
                last
              >
                <Switch
                  checked={remixBarEnabled}
                  onCheckedChange={handleRemixBarToggle}
                />
              </Row>
            </SettingsPanel>
          )}

          {activeSection === "display" && (
            <SettingsPanel>
              <Row
                label={t("settings.display.theme")}
                desc={t("settings.display.themeDesc")}
              >
                <SegmentedControl
                  options={themeOptions.map((o) => ({
                    value: o.value,
                    label: t(
                      `settings.display.theme${o.value.charAt(0).toUpperCase()}${o.value.slice(1)}`,
                    ),
                    icon: o.icon,
                  }))}
                  value={theme ?? "system"}
                  onValueChange={handleThemeChange}
                />
              </Row>
              <Row
                label={t("settings.display.widgetPosition")}
                desc={t("settings.display.widgetPositionDesc")}
              >
                <SegmentedControl
                  size="sm"
                  wrap
                  options={positionOptions}
                  value={pillPosition}
                  onValueChange={handlePillPositionChange}
                />
              </Row>
              <Row
                label={t("settings.display.cancelButton")}
                desc={t("settings.display.cancelButtonDesc")}
                last
              >
                <SegmentedControl
                  size="sm"
                  options={cancelButtonOptions}
                  value={pillCancel}
                  onValueChange={handlePillCancelChange}
                />
              </Row>
            </SettingsPanel>
          )}

          {activeSection === "permissions" && (
            <SettingsPanel>
              <Row
                label={t("settings.permissions.microphone")}
                desc={t("settings.permissions.microphoneDesc")}
              >
                <PermissionControl
                  granted={micStatus === "granted"}
                  checking={micStatus === "unknown"}
                  actionLabel={
                    micStatus === "denied" && canOpenMicSettings
                      ? t("common.openSettings")
                      : micStatus === "granted"
                        ? null
                        : t("common.allow")
                  }
                  external={micStatus === "denied" && canOpenMicSettings}
                  onAction={
                    micStatus === "denied" && canOpenMicSettings
                      ? openMicSettings
                      : requestMic
                  }
                  onManage={canOpenMicSettings ? openMicSettings : undefined}
                />
              </Row>
              <Row
                label={t("settings.permissions.accessibility")}
                desc={
                  IS_MAC
                    ? t("settings.permissions.accessibilityDescMac")
                    : t("settings.permissions.accessibilityDescOther")
                }
                last={!showSystemAudioRow}
              >
                <PermissionControl
                  granted={accessibilityStatus === true}
                  checking={accessibilityStatus === null}
                  actionLabel={
                    accessibilityStatus === true
                      ? null
                      : IS_MAC
                        ? t("common.openSettings")
                        : null
                  }
                  external={IS_MAC}
                  onAction={openAccessibility}
                  onManage={IS_MAC ? openAccessibility : undefined}
                  note={
                    !IS_MAC && accessibilityStatus !== true
                      ? t("settings.permissions.autoGranted")
                      : undefined
                  }
                />
              </Row>
              {showSystemAudioRow && (
                <Row
                  label={t("settings.permissions.systemAudio")}
                  desc={t("settings.permissions.systemAudioDesc")}
                  last
                >
                  <PermissionControl
                    granted={systemAudioGranted}
                    checking={systemAudioChecking}
                    unknown={systemAudioUnknown}
                    note={
                      systemAudioUnknown
                        ? t("settings.permissions.systemAudioUnknownNote")
                        : undefined
                    }
                    actionLabel={t("common.openSettings")}
                    external
                    onAction={openSystemAudioSettings}
                    onManage={openSystemAudioSettings}
                  />
                </Row>
              )}
            </SettingsPanel>
          )}
          {activeSection === "data" && (
            <SettingsPanel>
              <Row
                label={t("settings.data.pauseHistory")}
                desc={t("settings.data.pauseHistoryDesc")}
              >
                <Switch
                  checked={historyPaused}
                  onCheckedChange={handleHistoryPausedToggle}
                />
              </Row>
              <Row
                label={t("settings.data.autoDelete")}
                desc={t("settings.data.autoDeleteDesc")}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Select
                    value={historyRetention}
                    onValueChange={handleHistoryRetentionChange}
                  >
                    <SelectTrigger
                      id="settings-history-retention"
                      className="w-36"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {retentionOptions.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {historyRetention === "custom" && (
                    <>
                      <Input
                        inputMode="numeric"
                        value={customRetentionDays}
                        onChange={(e) =>
                          handleCustomRetentionDaysChange(e.target.value)
                        }
                        className="w-16 text-center"
                        aria-label={t("settings.data.autoDeleteDays")}
                      />
                      <span className="text-muted-foreground text-xs">
                        {t("settings.data.autoDeleteDays")}
                      </span>
                    </>
                  )}
                </div>
              </Row>
              <Row
                label={t("settings.data.summaryTimeout")}
                desc={t("settings.data.summaryTimeoutDesc")}
              >
                <div className="flex min-w-0 flex-col gap-1.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <Input
                      inputMode="numeric"
                      value={summaryTimeoutDraft ?? summaryTimeoutSeconds}
                      onChange={(e) =>
                        handleSummaryTimeoutChange(e.target.value)
                      }
                      onBlur={(e) => handleSummaryTimeoutBlur(e.target.value)}
                      onKeyDown={handleSummaryTimeoutKeyDown}
                      maxLength={SUMMARY_TIMEOUT_MAX_DIGITS}
                      className="w-20 text-center"
                      aria-label={t("settings.data.summaryTimeout")}
                      aria-invalid={summaryTimeoutInvalid}
                      data-testid="settings-summary-timeout"
                    />
                    <span className="text-muted-foreground text-xs">
                      {t("settings.data.summaryTimeoutSeconds")}
                    </span>
                    {/* D-5: 'reset to default' has to be an explicit act. Clearing
                        the field cannot express it — an empty draft is out of
                        bounds, and an out-of-bounds draft never writes. PUT `""`
                        is what the resolver reads as 600. */}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        void commitSummaryTimeout(summaryTimeoutDraft, "reset")
                      }
                      data-testid="settings-summary-timeout-reset"
                    >
                      {t("settings.data.summaryTimeoutReset", {
                        seconds: DEFAULT_MEETING_SUMMARY_TIMEOUT_SECONDS,
                      })}
                    </Button>
                  </div>
                  <span
                    className={cn(
                      "text-[11.5px]",
                      summaryTimeoutHint.destructive
                        ? "text-destructive"
                        : "text-muted-foreground",
                    )}
                    data-testid="settings-summary-timeout-hint"
                  >
                    {summaryTimeoutHint.text}
                  </span>
                </div>
              </Row>
              {/* The Enhance twin, directly beside it: two non-streaming LLM
                  tasks, two independent windows, one lane. Bound one CALL per
                  chunk — the helper copy says so, because the whole pass is
                  chunks × this number. */}
              <Row
                label={t("settings.data.enhanceTimeout")}
                desc={t("settings.data.enhanceTimeoutDesc")}
              >
                <div className="flex min-w-0 flex-col gap-1.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <Input
                      inputMode="numeric"
                      value={enhanceTimeoutDraft ?? enhanceTimeoutSeconds}
                      onChange={(e) =>
                        handleEnhanceTimeoutChange(e.target.value)
                      }
                      onBlur={(e) => handleEnhanceTimeoutBlur(e.target.value)}
                      onKeyDown={handleEnhanceTimeoutKeyDown}
                      maxLength={ENHANCE_TIMEOUT_MAX_DIGITS}
                      className="w-20 text-center"
                      aria-label={t("settings.data.enhanceTimeout")}
                      aria-invalid={enhanceTimeoutInvalid}
                      data-testid="settings-enhance-timeout"
                    />
                    <span className="text-muted-foreground text-xs">
                      {t("settings.data.enhanceTimeoutSeconds")}
                    </span>
                    {/* 'Reset to default' is an explicit act here too — an empty
                        draft is out of bounds, and out of bounds never writes. */}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        void commitEnhanceTimeout(enhanceTimeoutDraft, "reset")
                      }
                      data-testid="settings-enhance-timeout-reset"
                    >
                      {t("settings.data.enhanceTimeoutReset", {
                        seconds: DEFAULT_MEETING_ENHANCE_TIMEOUT_SECONDS,
                      })}
                    </Button>
                  </div>
                  <span
                    className={cn(
                      "text-[11.5px]",
                      enhanceTimeoutHint.destructive
                        ? "text-destructive"
                        : "text-muted-foreground",
                    )}
                    data-testid="settings-enhance-timeout-hint"
                  >
                    {enhanceTimeoutHint.text}
                  </span>
                </div>
              </Row>
              <Row
                label={t("settings.data.history")}
                desc={t("settings.data.historyDesc")}
              >
                <Button variant="destructive" size="sm" onClick={clearHistory}>
                  <Trash2 data-icon="inline-start" />
                  {t("settings.data.clearHistory")}
                </Button>
              </Row>
              <Row
                label={t("settings.data.logs")}
                desc={t("settings.data.logsDesc")}
              >
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void window.api.openLogsFolder();
                  }}
                >
                  <FolderOpen data-icon="inline-start" />
                  {t("settings.data.openLogs")}
                </Button>
              </Row>
              <Row
                label={t("settings.data.diskUsage")}
                desc={t("settings.data.diskUsageDesc")}
                last
              >
                <DiskUsageLine />
              </Row>
            </SettingsPanel>
          )}

          {activeSection === "network" && <NetworkPanel />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings → Data: disk usage (UX-08, specs/lean-audit-2026-09.md T1-5)
// ---------------------------------------------------------------------------

/**
 * One lazy, async line of aggregate disk truth: "Meetings audio: X GB ·
 * Local models: Y GB". The walk lives in the main process
 * (main/disk-usage.ts) behind an IPC round-trip, so the settings window
 * never touches the filesystem — a multi-GB meetings directory cannot jank
 * it. "Manage…" hops to the Models page (per-model "Remove from disk"),
 * reusing the shell's existing route.
 */
function DiskUsageLine(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: queryKeys.diskUsage,
    queryFn: () => window.api.getDiskUsage(),
    // Disk state changes slowly and the walk isn't free — fetch once per
    // settings visit instead of refetching on every window focus.
    staleTime: Infinity,
    retry: false,
  });

  return (
    <div className="flex min-h-[32px] flex-wrap items-center gap-x-4 gap-y-1">
      {data ? (
        <span
          data-testid="settings-disk-usage"
          className="text-foreground text-[13px]"
        >
          {t("settings.data.diskUsageLine", {
            meetings: formatBytes(data.meetingsBytes),
            models: formatBytes(data.modelsBytes),
          })}
        </span>
      ) : (
        <span
          data-testid="settings-disk-usage-loading"
          className="text-muted-foreground text-[13px]"
        >
          {t("settings.data.diskUsageLoading")}
        </span>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-[12.5px]"
        onClick={() => navigate("/settings/models")}
      >
        {t("settings.data.manage")}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout primitives — Section / Row pattern from r-settings.jsx GeneralP1
// ---------------------------------------------------------------------------

function SettingsSidebar({
  active,
  onSelect,
}: {
  active: SettingsSectionId;
  onSelect: (id: SettingsSectionId) => void;
}): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <nav className="border-border flex h-full min-h-0 shrink-0 gap-1 overflow-x-auto pb-1 min-[900px]:flex-col min-[900px]:overflow-visible min-[900px]:border-r min-[900px]:pr-4 min-[900px]:pb-0">
      {visibleSettingsSectionIds.map((id) => {
        const isActive = id === active;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onSelect(id)}
            className={cn(
              "shrink-0 rounded-[7px] border px-2.5 py-1.5 text-left text-[13px] transition-colors min-[900px]:w-full",
              isActive
                ? "border-border bg-card text-foreground font-medium"
                : "text-muted-foreground hover:bg-card/50 border-transparent font-normal",
            )}
          >
            {t(`settings.sections.${id}`)}
          </button>
        );
      })}
    </nav>
  );
}

function SettingsPanel({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col">{children}</div>;
}

function Row({
  label,
  desc,
  children,
  last,
  stacked,
}: {
  label: string;
  desc: string;
  children: React.ReactNode;
  last?: boolean;
  stacked?: boolean;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 items-start gap-3 py-[22px] min-[1080px]:grid-cols-[220px_minmax(0,1fr)] min-[1080px]:gap-8 min-[1280px]:grid-cols-[280px_minmax(0,1fr)] min-[1280px]:gap-9",
        stacked &&
          "min-[1080px]:grid-cols-1 min-[1080px]:gap-4 min-[1280px]:grid-cols-1 min-[1280px]:gap-4",
        !last && "border-border border-b",
      )}
    >
      <div>
        <div className="text-foreground text-[15px] font-medium">{label}</div>
        <p className="text-muted-foreground mt-0.5 text-[12.5px] leading-[1.5]">
          {desc}
        </p>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-language dictation hotkeys (specs/dictation-language-hotkeys.md §7)
// ---------------------------------------------------------------------------

/**
 * One row per configured language, shown only when the user has more than
 * one (§7). Each needs its own `useHotkeyRecorder` instance — a hook, so it
 * can't be called in a loop body — hence its own component.
 */
function LanguageHotkeyRow({
  code,
  label,
  value,
  isBlocked,
  onRecorded,
  onClear,
  last,
}: {
  code: string;
  label: string;
  value: string | undefined;
  isBlocked: (accelerator: string) => boolean;
  onRecorded: (code: string, accelerator: string) => void;
  onClear: (code: string) => void;
  last?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();

  const handleRecorded = useCallback(
    (accelerator: string) => onRecorded(code, accelerator),
    [code, onRecorded],
  );
  const {
    state: recorderState,
    liveModifiers,
    capturedCombo,
    canSaveRecording,
    needsModifierOrMouseButton,
    blockedNotice,
    startRecording: startLanguageHotkeyRecording,
    cancelRecording: cancelLanguageHotkeyRecording,
  } = useHotkeyRecorder(handleRecorded, { target: "language", isBlocked });

  const liveKeys = liveModifiers.map(keyDisplayLabel);
  const draftKeys = capturedCombo ? comboDisplayKeys(capturedCombo) : liveKeys;
  const captureHint = needsModifierOrMouseButton
    ? "Add a modifier or side mouse button · Esc to cancel"
    : canSaveRecording
      ? "Release to save · Esc to cancel"
      : "Press a modifier or side mouse button... · Esc to cancel";

  return (
    <Row
      last={last}
      label={t("settings.recording.languageHotkey", { language: label })}
      desc={t("settings.recording.languageHotkeyDesc", { language: label })}
    >
      {recorderState === "idle" ? (
        <div className="relative inline-flex items-center gap-2">
          <Button
            variant="outline"
            onClick={startLanguageHotkeyRecording}
            className="h-auto max-w-full flex-wrap gap-3 px-3.5 py-2"
          >
            <Keyboard className="text-muted-foreground size-4 shrink-0" />
            {value ? (
              <>
                <KeyComboDisplay keys={formatAcceleratorKeys(value)} />
                <span className="text-muted-foreground ml-1 text-xs">
                  {t("common.change")}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground text-sm">
                {t("common.change")}
              </span>
            )}
          </Button>
          {value && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onClear(code)}
              className="text-muted-foreground"
            >
              {t("common.clear")}
            </Button>
          )}
          {blockedNotice && (
            <div className="bg-popover text-popover-foreground border-border shadow-[0_4px_16px_rgba(29,33,41,.08)] absolute top-[calc(100%+6px)] left-0 z-20 whitespace-nowrap rounded-md border px-2.5 py-1.5 text-xs">
              {t("settings.recording.languageHotkeyConflict")}
            </div>
          )}
        </div>
      ) : (
        <div className="border-border bg-secondary relative inline-flex max-w-full flex-wrap items-center gap-3 rounded-full border px-3.5 py-2">
          <Keyboard className="text-primary h-4 w-4 shrink-0" />
          {draftKeys.length > 0 ? (
            <>
              <KeyComboDisplay keys={draftKeys} variant="dim" />
              <span className="text-muted-foreground text-xs">
                {captureHint}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground animate-pulse text-sm">
              {captureHint}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={cancelLanguageHotkeyRecording}
            className="ml-1"
          >
            {t("common.cancel")}
          </Button>
        </div>
      )}
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Network — enterprise proxy / custom CA configuration
// ---------------------------------------------------------------------------

/** Load a single string setting from the server ("" when unset/unreachable). */
function NetworkPanel(): React.JSX.Element {
  const { t } = useTranslation();
  // Single source of truth: the same zod schema the server enforces per-key,
  // so inline validation here matches exactly what the API will accept.
  const queryClient = useQueryClient();
  const {
    control,
    reset,
    trigger,
    getValues,
    formState: { errors },
  } = useForm<NetworkSettingsForm>({
    resolver: zodResolver(networkSettingsFormSchema),
    defaultValues: { proxyUrl: "", caCertPath: "" },
    mode: "onBlur",
  });
  const [savedField, setSavedField] = useState<
    keyof NetworkSettingsForm | null
  >(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track the last value that was actually persisted so we skip redundant saves
  // (and the "Saved" flash) when the user blurs without changing anything.
  const lastCommitted = useRef<NetworkSettingsForm>({
    proxyUrl: "",
    caCertPath: "",
  });

  // Hydrate from the shared settings cache (deduped with every other
  // ["settings-all"] consumer) instead of two dedicated single-key GETs.
  const { data: settings } = useQuery(settingsQueryOptions());

  // Seed the form once, when the settings first resolve. react-hook-form then
  // owns the state; later cache changes don't re-seed (mutations patch the
  // cache in place below, keeping it consistent without clobbering edits).
  const seededRef = useRef(false);
  useEffect(() => {
    if (!settings || seededRef.current) return;
    seededRef.current = true;
    const proxyUrl = settings[SETTINGS_KEYS.networkProxyUrl] ?? "";
    const caCertPath = settings[SETTINGS_KEYS.networkCaCertPath] ?? "";
    reset({ proxyUrl, caCertPath });
    lastCommitted.current = { proxyUrl, caCertPath };
  }, [settings, reset]);

  useEffect(
    () => () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    },
    [],
  );

  const flashSaved = useCallback((field: keyof NetworkSettingsForm) => {
    setSavedField(field);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSavedField(null), 1500);
  }, []);

  // Persist on blur — only when the value actually changed and passes the
  // shared schema, so we never send redundant or invalid requests.
  const persistField = useCallback(
    async (field: keyof NetworkSettingsForm, key: string) => {
      const value = getValues(field).trim();
      if (value === lastCommitted.current[field]) return;

      const valid = await trigger(field);
      if (!valid) return;
      // Network/API errors surface via the field's onChange retry; swallow.
      if (await putSetting(key, value)) {
        lastCommitted.current[field] = value;
        // Keep the shared settings cache truthful without a refetch.
        queryClient.setQueryData<Record<string, string>>(
          queryKeys.settings,
          (prev) => ({ ...(prev ?? {}), [key]: value }),
        );
        flashSaved(field);
      }
    },
    [trigger, getValues, flashSaved, queryClient],
  );

  return (
    <SettingsPanel>
      <p className="text-muted-foreground border-border border-b pb-5 text-[13px] leading-[1.6]">
        {t("settings.network.intro")}
      </p>
      <Row
        label={t("settings.network.proxy")}
        desc={t("settings.network.proxyDesc")}
        stacked
      >
        <Controller
          control={control}
          name="proxyUrl"
          render={({ field }) => (
            <NetworkField
              id="settings-network-proxy"
              field={field}
              placeholder={t("settings.network.proxyPlaceholder")}
              error={
                errors.proxyUrl ? t("settings.network.invalidProxy") : undefined
              }
              saved={savedField === "proxyUrl"}
              savedLabel={t("settings.network.saved")}
              onCommit={() =>
                persistField("proxyUrl", SETTINGS_KEYS.networkProxyUrl)
              }
            />
          )}
        />
      </Row>
      <Row
        label={t("settings.network.caCert")}
        desc={t("settings.network.caCertDesc")}
        stacked
        last
      >
        <Controller
          control={control}
          name="caCertPath"
          render={({ field }) => (
            <NetworkField
              id="settings-network-ca-cert"
              field={field}
              placeholder={t("settings.network.caCertPlaceholder")}
              error={
                errors.caCertPath
                  ? t("settings.network.invalidCaCert")
                  : undefined
              }
              saved={savedField === "caCertPath"}
              savedLabel={t("settings.network.saved")}
              onCommit={() =>
                persistField("caCertPath", SETTINGS_KEYS.networkCaCertPath)
              }
            />
          )}
        />
      </Row>
      <div className="border-border bg-secondary/40 text-muted-foreground mt-1 mb-4 flex items-start gap-2.5 rounded-[10px] border px-3.5 py-3 text-[12px] leading-[1.55]">
        <Info className="mt-px h-3.5 w-3.5 shrink-0 opacity-70" />
        <span>{t("settings.network.envNote")}</span>
      </div>
      <Row
        label={t("settings.network.server")}
        desc={t("settings.network.serverDesc")}
        stacked
        last
      >
        <ServerConnection />
      </Row>
    </SettingsPanel>
  );
}

/**
 * A single Network text setting: input + inline validation + a transient
 * "Saved" confirmation. Kept local so both rows share the exact same behavior.
 */
function NetworkField({
  id,
  field,
  placeholder,
  error,
  saved,
  savedLabel,
  onCommit,
}: {
  id: string;
  field: ControllerRenderProps<NetworkSettingsForm, keyof NetworkSettingsForm>;
  placeholder: string;
  error?: string;
  saved: boolean;
  savedLabel: string;
  onCommit: () => void;
}): React.JSX.Element {
  return (
    <div className="flex max-w-md flex-col gap-1.5">
      <Input
        id={id}
        type="text"
        spellCheck={false}
        autoComplete="off"
        name={field.name}
        ref={field.ref}
        value={field.value}
        onChange={field.onChange}
        onBlur={() => {
          field.onBlur();
          onCommit();
        }}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
      />
      <div className="flex min-h-[16px] items-center">
        {error ? (
          <span className="text-destructive text-xs">{error}</span>
        ) : saved ? (
          <span className="text-primary inline-flex items-center gap-1 text-xs">
            <Check className="h-3 w-3" />
            {savedLabel}
          </span>
        ) : null}
      </div>
    </div>
  );
}

type ServerTestState =
  | "idle"
  | "testing"
  | "ok"
  | "unreachable"
  | "unauthorized";

/**
 * Connect the desktop app to a self-hosted Openstyle server (or the built-in
 * local one). The URL/token live in the app's local settings.json (client-side
 * config — they can't live on the server they point at), read/written via IPC.
 *
 * Saving takes effect immediately without an app restart: this window re-points
 * its API client and refetches, and the main process broadcasts the change to
 * the pill window (which re-points on its next recording).
 */
function ServerConnection(): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [serverUrlInput, setServerUrlInput] = useState("");
  const [savedServerUrl, setSavedServerUrl] = useState("");
  const [serverTokenInput, setServerTokenInput] = useState("");
  const [savedServerToken, setSavedServerToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [serverUrlError, setServerUrlError] = useState<string | null>(null);
  const [serverTest, setServerTest] = useState<ServerTestState>("idle");

  useEffect(() => {
    window.api
      ?.getServerUrl()
      .then((url) => {
        setSavedServerUrl(url);
        setServerUrlInput(url);
      })
      .catch(() => {});
    window.api
      ?.getServerToken()
      .then((token) => {
        setSavedServerToken(token);
        setServerTokenInput(token);
      })
      .catch(() => {});
  }, []);

  const testServer = useCallback(async (rawUrl: string, token: string) => {
    const parsed = serverUrlSchema.safeParse(rawUrl);
    if (!parsed.success) {
      setServerUrlError(parsed.error.issues[0].message);
      setServerTest("idle");
      return;
    }
    const base = parsed.data || getLocalApiBase();
    setServerTest("testing");
    if (!(await checkServerHealth(base, 5000))) {
      setServerTest("unreachable");
      return;
    }
    // Always probe an authenticated endpoint so we catch both a wrong token and
    // a server that requires a token when none was entered.
    if (!(await checkServerAuth(base, token.trim(), 5000))) {
      setServerTest("unauthorized");
      return;
    }
    setServerTest("ok");
  }, []);

  // Persist the new target, re-point this window's client, and refetch every
  // query against the new server — all without an app restart. The main process
  // broadcasts "server:changed" so the pill window re-points too.
  const applyServerTarget = useCallback(
    async (url: string, token: string) => {
      const savedUrl = (await window.api?.setServerUrl(url)) ?? url;
      const savedToken =
        (await window.api?.setServerToken(token)) ?? token.trim();
      setSavedServerUrl(savedUrl);
      setServerUrlInput(savedUrl);
      setSavedServerToken(savedToken);
      setServerTokenInput(savedToken);
      await refreshApiBase();
      await queryClient.invalidateQueries();
      return { savedUrl, savedToken };
    },
    [queryClient],
  );

  const handleSaveServer = useCallback(async () => {
    const parsed = serverUrlSchema.safeParse(serverUrlInput);
    if (!parsed.success) {
      setServerUrlError(parsed.error.issues[0].message);
      return;
    }
    setServerUrlError(null);
    const { savedUrl, savedToken } = await applyServerTarget(
      parsed.data,
      serverTokenInput,
    );
    await testServer(savedUrl, savedToken);
  }, [serverUrlInput, serverTokenInput, applyServerTarget, testServer]);

  const handleResetServer = useCallback(async () => {
    await applyServerTarget("", "");
    setServerUrlError(null);
    setServerTest("idle");
  }, [applyServerTarget]);

  const urlChanged = serverUrlInput.trim() !== savedServerUrl.trim();
  const tokenChanged = serverTokenInput.trim() !== savedServerToken.trim();
  const dirty = urlChanged || tokenChanged;
  const canReset = !!savedServerUrl || !!savedServerToken || dirty;
  const testing = serverTest === "testing";

  return (
    <div className="max-w-md space-y-3">
      {/* URL + inline Test, mirroring the on-device LLM connect form. */}
      <div className="flex items-center gap-2">
        <Input
          id="settings-server-url"
          type="text"
          spellCheck={false}
          autoComplete="off"
          value={serverUrlInput}
          aria-invalid={serverUrlError ? true : undefined}
          onChange={(e) => {
            setServerUrlInput(e.target.value);
            setServerTest("idle");
            setServerUrlError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSaveServer();
          }}
          placeholder={`http://127.0.0.1:${DEFAULT_SERVER_PORT}`}
          className="min-w-0 flex-1"
        />
        <Button
          type="button"
          variant="secondary"
          size="default"
          className="shrink-0"
          onClick={() => testServer(serverUrlInput, serverTokenInput)}
          disabled={testing}
        >
          {testing ? (
            <span className="flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("settings.network.statusTesting")}
            </span>
          ) : (
            t("settings.network.testConnection")
          )}
        </Button>
      </div>

      <InputGroup className={cn(!serverUrlInput.trim() && "opacity-60")}>
        <InputGroupInput
          id="settings-server-token"
          type={showToken ? "text" : "password"}
          value={serverTokenInput}
          onChange={(e) => {
            setServerTokenInput(e.target.value);
            setServerTest("idle");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSaveServer();
          }}
          placeholder={t("settings.network.serverTokenPlaceholder")}
        />
        {serverTokenInput && (
          <RevealToggle
            revealed={showToken}
            onToggle={() => setShowToken((v) => !v)}
            label="token"
          />
        )}
      </InputGroup>

      {/* Inline status line, matching the on-device LLM connect messages. */}
      <div className="flex min-h-[16px] items-center">
        {serverUrlError ? (
          <span className="text-destructive text-[12px]">{serverUrlError}</span>
        ) : serverTest === "ok" ? (
          <span className="text-primary inline-flex items-center gap-1 text-[12px]">
            <Check className="h-3 w-3" />
            {t("settings.network.statusOk")}
          </span>
        ) : serverTest === "unreachable" ? (
          <span className="text-destructive text-[12px]">
            {t("settings.network.statusUnreachable")}
          </span>
        ) : serverTest === "unauthorized" ? (
          <span className="text-destructive text-[12px]">
            {t("settings.network.statusUnauthorized")}
          </span>
        ) : (
          <span className="text-muted-foreground text-[12px]">
            {savedServerUrl || t("settings.network.usingLocal")}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="ink"
          size="sm"
          onClick={handleSaveServer}
          disabled={!dirty}
        >
          {t("common.save")}
        </Button>
        {canReset && (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={handleResetServer}
          >
            {t("settings.network.resetToLocal")}
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reusable controls
// ---------------------------------------------------------------------------

function PermissionControl({
  granted,
  checking,
  unknown,
  actionLabel,
  external,
  onAction,
  onManage,
  note,
}: {
  granted: boolean;
  checking: boolean;
  // Distinct from `checking`: the probe already ran and came back
  // inconclusive (e.g. macOS gives no preflight API for this permission),
  // not still in flight. Rendering it as "checking" forever would be
  // dishonest — this is a resting state, not a transient one.
  unknown?: boolean;
  actionLabel: string | null;
  external?: boolean;
  onAction?: () => void;
  onManage?: () => void;
  note?: string;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center gap-3">
      <StatusDot granted={granted} checking={checking} unknown={unknown} />
      {granted ? (
        <>
          <Check className="text-primary h-4 w-4" />
          {onManage && (
            <Button variant="outline" size="sm" onClick={onManage}>
              {t("common.manage")}
              <ExternalLink data-icon="inline-end" />
            </Button>
          )}
        </>
      ) : (
        <>
          {note && (
            <span className="text-muted-foreground text-xs">{note}</span>
          )}
          {actionLabel && onAction && (
            <Button variant="ink" size="sm" onClick={onAction}>
              {actionLabel}
              {external && <ExternalLink data-icon="inline-end" />}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

function StatusDot({
  granted,
  checking,
  unknown,
}: {
  granted: boolean;
  checking: boolean;
  unknown?: boolean;
}) {
  const { t } = useTranslation();
  const label = granted
    ? t("common.granted")
    : checking
      ? t("common.checking")
      : unknown
        ? t("common.unknown")
        : t("common.needed");
  // "needed" (denied/actionable) is the only destructive state; checking
  // and unknown are both neutral resting states, just with different copy.
  const isDestructive = !granted && !checking && !unknown;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-[10px] font-medium tracking-wide uppercase",
        granted
          ? "text-primary"
          : isDestructive
            ? "text-destructive"
            : "text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "inline-block h-1.5 w-1.5 rounded-full",
          granted
            ? "bg-primary"
            : isDestructive
              ? "bg-destructive"
              : "bg-muted-foreground/40",
        )}
      />
      {label}
    </span>
  );
}
