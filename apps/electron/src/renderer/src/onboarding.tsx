import { MAX_LANGUAGES, normalizeLanguageList } from "@openstyle/validations";
import { useCoachPress } from "@renderer/components/hotkey-demo";
import { KeyComboDisplay } from "@renderer/components/key-combo";
import {
  LanguageMultiPickerDialog,
  useLanguageOptions,
} from "@renderer/components/language-combobox";
import { ModelSetupPanel } from "@renderer/components/model-setup-panel";
import { CoachStrip } from "@renderer/components/onboarding/coach-strip";
import { EmailDraft } from "@renderer/components/onboarding/email-draft";
import { Button } from "@renderer/components/ui/button";
import {
  acceleratorsEqual,
  comboDisplayKeys,
  formatAcceleratorKeys,
  keyDisplayLabel,
  useHotkeyRecorder,
} from "@renderer/hooks/use-hotkey-recorder";
import { getClient } from "@renderer/lib/api";
import { defaultLanguage } from "@renderer/lib/languages";
import { buildVoiceItems, type VoiceItem } from "@renderer/lib/models";
import {
  pollUntil,
  requestMicAccess,
  resolveMicStatus,
} from "@renderer/lib/permissions";
import { IS_LINUX, IS_MAC, IS_WINDOWS } from "@renderer/lib/platform";
import {
  mlxStatusQueryOptions,
  queryKeys,
  settingsQueryOptions,
  whisperStatusQueryOptions,
} from "@renderer/lib/query";
import { putSetting } from "@renderer/lib/settings";
import { cn } from "@renderer/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  ClipboardPaste,
  Keyboard,
  Loader2,
  Mic,
  Shield,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { getDefaultHotkey } from "../../shared/hotkey-defaults";
import { getDefaultRemixHotkey } from "../../shared/remix";
import { SETTINGS_KEYS } from "../../shared/settings-keys";
import type { ConfiguredModel } from "./pages/models/types";

type Step = "permissions" | "language" | "draft" | "remix";

const DEFAULT_HOTKEY =
  (typeof window !== "undefined" && window.api?.defaultHotkey) ||
  getDefaultHotkey();

const DEFAULT_REMIX_HOTKEY =
  (typeof window !== "undefined" && window.api?.defaultRemixHotkey) ||
  getDefaultRemixHotkey();

// Linux system-setup state reported by the main process (input-group access
// for the hotkey listener, xdotool/wtype for the paste fallback).
type LinuxSetup = NonNullable<
  Awaited<ReturnType<Window["api"]["checkLinuxSetup"]>>
>;

// The opinionated on-device pick, in order of preference. Qwen3 ASR (MLX)
// is the hero when the machine can run it; whisper.cpp's Balanced model is
// the universal fallback (it builds its own binary, no Python required).
// It downloads in the background while the user picks a language and a
// hotkey — first-time users never choose a model.
const RECOMMENDED_MLX_DEF = "qwen3-0.6b-8bit";
const RECOMMENDED_WHISPER_DEF = "small-q5_1";

export default function OnboardingPage(): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>("permissions");

  // Permissions state
  const [micStatus, setMicStatus] = useState<string>("unknown");
  const [accessibilityStatus, setAccessibilityStatus] = useState(false);
  const [linuxSetup, setLinuxSetup] = useState<LinuxSetup | null>(null);
  const cancelMicPollRef = useRef<(() => void) | null>(null);
  const cancelAccessibilityPollRef = useRef<(() => void) | null>(null);

  // Voice model state
  // The on-device model the user picked (auto-picked at first).
  const [picked, setPicked] = useState<{
    defId: string;
    engine: "whisper" | "mlx";
  } | null>(null);
  const [languages, setLanguages] = useState<string[]>(() => {
    // Seed from the OS language when it's a real code; "auto" starts empty.
    const guess = defaultLanguage();
    return guess === "auto" ? [] : [guess];
  });
  const autoPicked = useRef(false);
  const warmed = useRef(false);

  // Hotkey recorder state (draft step); the remix hotkey lives here too so
  // each step can refuse a combo already taken by the other.
  const [hotkey, setHotkey] = useState(DEFAULT_HOTKEY);
  const [remixHotkey, setRemixHotkey] = useState(DEFAULT_REMIX_HOTKEY);

  // The practice email body, lifted so it survives the draft→remix step
  // transition (and Back).
  const [draftBody, setDraftBody] = useState("");

  const handleHotkeyRecorded = useCallback((accelerator: string) => {
    setHotkey(accelerator);
    void putSetting(SETTINGS_KEYS.hotkey, accelerator);
  }, []);

  // Like Settings: main re-reads the remix accelerator from settings, so the
  // listener reload has to wait for the write to land.
  const handleRemixHotkeyRecorded = useCallback((accelerator: string) => {
    setRemixHotkey(accelerator);
    putSetting(SETTINGS_KEYS.remixHotkey, accelerator)
      .then(() => window.api?.reloadRemixHotkey())
      .catch(() => {});
  }, []);

  // Load permissions
  useEffect(() => {
    resolveMicStatus()
      .then(setMicStatus)
      .catch(() => {});
    window.api
      ?.checkAccessibilityPermission()
      .then(setAccessibilityStatus)
      .catch(() => {});
    if (IS_LINUX) {
      window.api
        ?.checkLinuxSetup()
        .then((setup) => setup && setLinuxSetup(setup))
        .catch(() => {});
    }
  }, []);

  // Saved hotkey, read from the shared settings cache (deduped with every other
  // settings consumer instead of a dedicated GET /api/settings/:key).
  const { data: settingsData } = useQuery(settingsQueryOptions());
  useEffect(() => {
    const value = settingsData?.[SETTINGS_KEYS.hotkey];
    if (value) setHotkey(value);
    const remixValue = settingsData?.[SETTINGS_KEYS.remixHotkey];
    if (remixValue) setRemixHotkey(remixValue);
  }, [settingsData]);

  // Whisper / MLX status via React Query. refetchInterval replaces the manual
  // 500ms setInterval polling: it polls only while a download/verify is active
  // and stops automatically once everything settles.
  const whisperQuery = useQuery(whisperStatusQueryOptions());
  const mlxQuery = useQuery(mlxStatusQueryOptions());

  const whisperStatus = whisperQuery.data ?? null;
  const mlxStatus = mlxQuery.data ?? null;
  // True once we know whether MLX can run — the auto-pick waits for the
  // Qwen-vs-Whisper decision instead of settling on Whisper Base while the MLX
  // probe is in flight. Non-Mac has nothing to wait for.
  const mlxResolved = !IS_MAC || mlxQuery.isFetched;

  const requestMic = useCallback(async () => {
    const status = await requestMicAccess();
    if (status) setMicStatus(status);
  }, []);

  const recheckLinuxSetup = useCallback(async () => {
    const setup = await window.api?.checkLinuxSetup();
    if (setup) setLinuxSetup(setup);
  }, []);

  const openMicSettings = useCallback(() => {
    window.api?.openMicSettings();
    cancelMicPollRef.current?.();
    cancelMicPollRef.current = pollUntil(
      async () => (await window.api?.checkMicPermission()) === "granted",
      () => setMicStatus("granted"),
    );
  }, []);

  const openAccessibility = useCallback(() => {
    window.api?.openAccessibilitySettings();
    cancelAccessibilityPollRef.current?.();
    cancelAccessibilityPollRef.current = pollUntil(
      async () => !!(await window.api?.checkAccessibilityPermission()),
      () => setAccessibilityStatus(true),
    );
  }, []);

  // Stop any permission poll when the page unmounts.
  useEffect(
    () => () => {
      cancelMicPollRef.current?.();
      cancelAccessibilityPollRef.current?.();
    },
    [],
  );

  // Onboarding shows on-device models only, so there are no cloud rows.
  const allVoiceItems = buildVoiceItems([], whisperStatus, mlxStatus, {
    selectedProvider:
      picked?.engine === "mlx"
        ? "local-mlx"
        : picked
          ? "local-whisper"
          : undefined,
    selectedWhisperModelId:
      picked?.engine === "whisper" ? picked.defId : undefined,
    selectedMlxModelId: picked?.engine === "mlx" ? picked.defId : undefined,
    keyProviders: new Set(),
  });

  // Resolve the opinionated recommendation: Qwen3 on-device when MLX can run,
  // otherwise whisper.cpp Base (universal).
  const mlxQwen = allVoiceItems.find(
    (v) => v.localEngine === "mlx" && v.defId === RECOMMENDED_MLX_DEF,
  );
  const whisperBase = allVoiceItems.find(
    (v) => v.localEngine === "whisper" && v.defId === RECOMMENDED_WHISPER_DEF,
  );
  const recommended: VoiceItem | undefined =
    mlxQwen && mlxStatus?.canRun ? mlxQwen : (whisperBase ?? mlxQwen);

  // Auto-setup: once the MLX capability check settles, commit a default
  // on-device model. Download starts from the setup panel when the user taps
  // Download.
  useEffect(() => {
    if (
      autoPicked.current ||
      !mlxResolved ||
      !recommended?.defId ||
      !recommended.localEngine
    )
      return;
    autoPicked.current = true;
    const { defId, localEngine } = recommended;
    setPicked({ defId, engine: localEngine });
    const provider = localEngine === "mlx" ? "local-mlx" : "local-whisper";
    getClient()
      .api.models.configured.$post({
        json: {
          provider,
          model_id: `${provider}/${defId}`,
          model_name: recommended.name,
          type: "voice",
          is_default: true,
        },
      })
      .catch(() => {});
  }, [recommended, mlxResolved]);

  // The model the setup panel shows: the pick, falling back to the
  // recommendation before the auto-pick runs.
  const localSetupModel = allVoiceItems.find((v) => v.selected) ?? recommended;

  // Pre-warm the local engine the moment its download lands, so the first
  // dictation in the tutorial is fast.
  useEffect(() => {
    if (
      warmed.current ||
      localSetupModel?.status !== "ready" ||
      !localSetupModel.defId
    )
      return;
    warmed.current = true;
    if (localSetupModel.localEngine === "mlx") {
      getClient()
        .api["mlx-asr"].server.start.$post({
          json: { modelId: localSetupModel.defId },
        })
        .catch(() => {});
    } else {
      getClient()
        .api.whisper.server.start.$post({
          json: { modelId: localSetupModel.defId },
        })
        .catch(() => {});
    }
  }, [localSetupModel]);

  // Persist the language list (the transcribe path reads it per request).
  const persistLanguages = useCallback((next: string[]) => {
    void putSetting(SETTINGS_KEYS.languages, JSON.stringify(next));
  }, []);

  const toggleLanguage = useCallback(
    (code: string) => {
      setLanguages((prev) => {
        const next = prev.includes(code)
          ? prev.filter((c) => c !== code)
          : normalizeLanguageList([...prev, code]);
        persistLanguages(next);
        return next;
      });
    },
    [persistLanguages],
  );

  const clearLanguages = useCallback(() => {
    setLanguages([]);
    persistLanguages([]);
  }, [persistLanguages]);

  const finishSetup = useCallback(() => {
    window.api?.setOnboardingComplete();
    navigate("/today", { replace: true });
  }, [navigate]);

  const mustHaveLocalReady =
    !!localSetupModel && localSetupModel.status !== "ready";
  const localSetupActive =
    localSetupModel?.status === "downloading" ||
    localSetupModel?.status === "verifying" ||
    localSetupModel?.state?.phase === "building_binary";

  const downloadPicked = useCallback(async () => {
    if (!localSetupModel?.defId || window.api?.isE2E) return;
    if (localSetupModel.localEngine === "mlx") {
      await getClient().api["mlx-asr"].models[":model"].download.$post({
        param: { model: localSetupModel.defId },
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.mlxStatus });
    } else {
      await getClient().api.whisper.models[":model"].download.$post({
        param: { model: localSetupModel.defId },
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.whisperStatus });
    }
  }, [localSetupModel, queryClient]);

  return (
    <div className="glass-window-shell glass-content flex h-screen flex-col">
      <div
        className="h-9 shrink-0"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      />

      <div
        className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-auto px-6 py-8"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        {step === "permissions" && (
          <PermissionsStep
            micStatus={micStatus}
            accessibilityStatus={accessibilityStatus}
            linuxSetup={linuxSetup}
            onRequestMic={requestMic}
            onOpenMicSettings={openMicSettings}
            onOpenAccessibility={openAccessibility}
            onRecheckLinuxSetup={recheckLinuxSetup}
            onContinue={() => {
              setStep("language");
            }}
          />
        )}

        {step === "language" && (
          <LanguageStep
            languages={languages}
            onToggle={toggleLanguage}
            onClear={clearLanguages}
            localModel={localSetupModel}
            onDownloadLocal={downloadPicked}
            onRetryLocal={downloadPicked}
            onBack={() => {
              setStep("permissions");
            }}
            onContinue={() => {
              // Persist even when the pre-selected locale was never toggled.
              persistLanguages(languages);
              setStep("draft");
            }}
          />
        )}

        {step === "draft" && (
          <DraftStep
            hotkey={hotkey}
            remixHotkey={remixHotkey}
            onHotkeyRecorded={handleHotkeyRecorded}
            localModel={localSetupModel}
            onDownloadLocal={downloadPicked}
            onRetryLocal={downloadPicked}
            canContinue={!mustHaveLocalReady || !!window.api?.isE2E}
            continueBlockedReason={
              mustHaveLocalReady
                ? localSetupActive
                  ? "downloading"
                  : "notReady"
                : null
            }
            body={draftBody}
            onBodyChange={setDraftBody}
            onBack={() => {
              setStep("language");
            }}
            onContinue={() => setStep("remix")}
          />
        )}

        {step === "remix" && (
          <RemixStep
            body={draftBody}
            onBodyChange={setDraftBody}
            remixHotkey={remixHotkey}
            dictationHotkey={hotkey}
            onRemixHotkeyRecorded={handleRemixHotkeyRecorded}
            onBack={() => setStep("draft")}
            onFinish={finishSetup}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — Permissions
// ---------------------------------------------------------------------------
function PermissionsStep({
  micStatus,
  accessibilityStatus,
  linuxSetup,
  onRequestMic,
  onOpenMicSettings,
  onOpenAccessibility,
  onRecheckLinuxSetup,
  onContinue,
}: {
  micStatus: string;
  accessibilityStatus: boolean;
  linuxSetup: LinuxSetup | null;
  onRequestMic: () => void;
  onOpenMicSettings: () => void;
  onOpenAccessibility: () => void;
  onRecheckLinuxSetup: () => void;
  onContinue: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const micGranted = micStatus === "granted";
  // On Wayland there is no hotkey fallback without /dev/input access, so
  // missing input access blocks. On X11 the Electron globalShortcut still
  // works (toggle mode), so the card only warns.
  const linuxBlocked = !!linuxSetup?.wayland && !linuxSetup.inputAccess;
  // Accessibility is macOS-only; elsewhere the mic alone unblocks.
  // E2E runs on machines that can't grant OS permissions.
  const allGranted =
    (micGranted && (!IS_MAC || accessibilityStatus) && !linuxBlocked) ||
    !!window.api?.isE2E;
  // macOS and Windows can deep-link to the OS mic privacy settings.
  const canOpenMicSettings = IS_MAC || IS_WINDOWS;

  return (
    <div className="w-full max-w-[440px]">
      <div className="flex flex-col gap-2.5">
        <PermCard
          icon={Mic}
          title={t("onboarding.permissions.microphone.title")}
          desc={t("onboarding.permissions.microphone.desc")}
          granted={micGranted}
          action={
            micStatus === "denied" && canOpenMicSettings ? (
              <PermButton onClick={onOpenMicSettings}>
                {t("common.openSettings")}
              </PermButton>
            ) : (
              <PermButton onClick={onRequestMic}>
                {t("common.allow")}
              </PermButton>
            )
          }
        />

        {IS_MAC && (
          <PermCard
            icon={Shield}
            title={t("onboarding.permissions.accessibility.title")}
            desc={t("onboarding.permissions.accessibility.desc")}
            granted={accessibilityStatus}
            action={
              <PermButton onClick={onOpenAccessibility}>
                {t("common.openSettings")}
              </PermButton>
            }
          />
        )}

        {IS_LINUX && linuxSetup && (
          <PermCard
            icon={Keyboard}
            title={t("onboarding.permissions.keyboardAccess.title")}
            desc={
              linuxSetup.inputAccess ? (
                t("onboarding.permissions.keyboardAccess.descGranted")
              ) : (
                <>
                  <Trans
                    i18nKey="onboarding.permissions.keyboardAccess.descDenied"
                    components={{ code: <code className="text-foreground" /> }}
                  />
                  {!linuxSetup.wayland &&
                    t("onboarding.permissions.keyboardAccess.toggleNote")}
                </>
              )
            }
            granted={linuxSetup.inputAccess}
            action={
              <PermButton onClick={onRecheckLinuxSetup}>
                {t("common.recheck")}
              </PermButton>
            }
          />
        )}

        {IS_LINUX &&
          linuxSetup &&
          !linuxSetup.pasteTool &&
          !(linuxSetup.wayland && linuxSetup.uinputAccess) && (
            <PermCard
              icon={ClipboardPaste}
              title={t("onboarding.permissions.pasteTool.title")}
              desc={
                <Trans
                  i18nKey="onboarding.permissions.pasteTool.desc"
                  values={{ tool: linuxSetup.pasteToolRequired }}
                  components={{ code: <code className="text-foreground" /> }}
                />
              }
              granted={false}
              action={
                <PermButton onClick={onRecheckLinuxSetup}>
                  {t("common.recheck")}
                </PermButton>
              }
            />
          )}
      </div>

      <div className="mt-7 flex items-center justify-end gap-3.5">
        <div className="flex items-center gap-3.5">
          {!allGranted && (
            <span className="mono text-muted-foreground text-[10.5px] tracking-[0.1em] uppercase">
              {IS_MAC
                ? t("onboarding.permissions.grantBoth")
                : t("onboarding.permissions.grantAccess")}
            </span>
          )}
          <Button variant="ink" disabled={!allGranted} onClick={onContinue}>
            {t("common.continue")}
            <ArrowRight data-icon="inline-end" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function PermCard({
  icon: Icon,
  title,
  desc,
  granted,
  action,
}: {
  icon: typeof Mic;
  title: string;
  desc: React.ReactNode;
  granted: boolean;
  action: React.ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="border-border bg-card flex items-center gap-3.5 rounded-[10px] border p-4">
      <div
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] border",
          granted
            ? "bg-accent border-primary/20"
            : "bg-background border-border",
        )}
      >
        <Icon
          size={16}
          className={
            granted ? "text-accent-foreground" : "text-muted-foreground"
          }
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-foreground text-[14px] font-medium">{title}</div>
        <div className="text-muted-foreground mt-0.5 text-[12.5px] leading-snug">
          {desc}
        </div>
      </div>
      {granted ? (
        <span className="mono text-accent-foreground inline-flex items-center gap-1.5 text-[10.5px] tracking-[0.14em] uppercase">
          <Check size={13} strokeWidth={2.2} />
          {t("common.granted")}
        </span>
      ) : (
        action
      )}
    </div>
  );
}

function PermButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Button variant="ink" size="sm" onClick={onClick} className="shrink-0">
      {children}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Language (the model sets itself up in the background)
// ---------------------------------------------------------------------------
function LanguageStep({
  languages,
  onToggle,
  onClear,
  localModel,
  onDownloadLocal,
  onRetryLocal,
  onBack,
  onContinue,
}: {
  languages: string[];
  onToggle: (id: string) => void;
  onClear: () => void;
  localModel: VoiceItem | undefined;
  onDownloadLocal: () => void;
  onRetryLocal: () => void;
  onBack: () => void;
  onContinue: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const options = useLanguageOptions();
  const [showAll, setShowAll] = useState(false);

  const selectedSet = useMemo(() => new Set(languages), [languages]);
  const atCap = languages.length >= MAX_LANGUAGES;

  // Show a handful of region-relevant languages as pills; the rest live behind
  // "See all". "auto" gets its own pill below, so exclude it from the top set.
  const PILL_COUNT = 12;
  const pills = useMemo(
    () => options.filter((l) => l.code !== "auto").slice(0, PILL_COUNT),
    [options],
  );

  // Selected languages picked via "See all" may fall outside the top pills;
  // surface them as extra pills so every selection stays visible.
  const selectedOutside = useMemo(
    () =>
      languages
        .filter((code) => !pills.some((l) => l.code === code))
        .map((code) => options.find((l) => l.code === code))
        .filter((l): l is (typeof options)[number] => Boolean(l)),
    [languages, pills, options],
  );

  return (
    <div className="w-full max-w-[560px]">
      <h1 className="display text-foreground m-0 mb-7 text-center text-[56px] leading-[0.95] font-normal tracking-[-0.025em]">
        {t("onboarding.language.titlePrefix")}
        {t("onboarding.language.titleEmphasis")}
      </h1>

      <div className="flex flex-wrap justify-center gap-2">
        <Button
          variant={languages.length === 0 ? "default" : "outline"}
          size="sm"
          onClick={onClear}
          className="rounded-full px-4 text-[13.5px]"
        >
          {t("onboarding.language.autoDetect")}
        </Button>
        {pills.map((l) => {
          const active = selectedSet.has(l.code);
          return (
            <Button
              key={l.code}
              variant={active ? "default" : "outline"}
              size="sm"
              disabled={!active && atCap}
              onClick={() => onToggle(l.code)}
              className="rounded-full px-4 text-[13.5px]"
            >
              {l.label}
            </Button>
          );
        })}
        {selectedOutside.map((l) => (
          <Button
            key={l.code}
            variant="default"
            size="sm"
            onClick={() => onToggle(l.code)}
            className="rounded-full px-4 text-[13.5px]"
          >
            {l.label}
          </Button>
        ))}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowAll(true)}
          className="rounded-full px-4 text-[13.5px]"
        >
          {t("onboarding.language.seeAll") || "See all"}
        </Button>
      </div>

      <LanguageMultiPickerDialog
        open={showAll}
        onOpenChange={setShowAll}
        values={languages}
        onToggle={onToggle}
        options={options}
      />

      <ModelSetupPanel
        model={localModel}
        onDownload={onDownloadLocal}
        onRetry={onRetryLocal}
      />

      <div className="mt-7 flex items-center justify-between">
        <Button variant="outline" onClick={onBack}>
          {t("common.back")}
        </Button>
        <Button variant="ink" onClick={onContinue}>
          {t("common.continue")}
          <ArrowRight data-icon="inline-end" />
        </Button>
      </div>
    </div>
  );
}

function StepHeading({ title }: { title: string }): React.JSX.Element {
  return (
    <h1 className="display text-foreground m-0 mb-6 text-[30px] leading-[1.1] font-medium">
      {title}
    </h1>
  );
}

// ---------------------------------------------------------------------------
// Hotkey rebind — a single minimal control, shared by the draft (dictation
// hotkey) and remix (remix hotkey) steps.
// ---------------------------------------------------------------------------
function HotkeyRebindControl({
  hotkey,
  target,
  conflictHotkey,
  conflictNotice,
  onRecorded,
  onStartRecording,
}: {
  hotkey: string;
  target: "dictation" | "remix";
  /** The other feature's hotkey — recording it here is refused. */
  conflictHotkey?: string;
  conflictNotice?: string;
  onRecorded: (accelerator: string) => void;
  onStartRecording?: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const {
    state: recorderState,
    liveModifiers,
    capturedCombo,
    canSaveRecording,
    needsModifierOrMouseButton,
    blockedNotice,
    startRecording,
    cancelRecording,
  } = useHotkeyRecorder(onRecorded, {
    target,
    isBlocked: conflictHotkey
      ? (accel) => acceleratorsEqual(accel, conflictHotkey)
      : undefined,
  });

  const liveKeys = liveModifiers.map(keyDisplayLabel);
  const draftKeys = capturedCombo ? comboDisplayKeys(capturedCombo) : liveKeys;
  const captureHint = needsModifierOrMouseButton
    ? "Add a modifier or side mouse button · Esc to cancel"
    : canSaveRecording
      ? "Release to save · Esc to cancel"
      : "Press a modifier or side mouse button… · Esc to cancel";

  return (
    <div className="mt-5 flex justify-start">
      {recorderState === "idle" ? (
        <div className="relative inline-flex">
          <Button
            variant="outline"
            onClick={() => {
              onStartRecording?.();
              startRecording();
            }}
            className="bg-card hover:bg-secondary h-auto gap-3 rounded-[10px] px-3.5 py-2.5"
          >
            <Keyboard className="text-muted-foreground shrink-0" />
            <KeyComboDisplay keys={formatAcceleratorKeys(hotkey)} />
            <span className="text-muted-foreground ml-1 text-[12.5px]">
              {t("common.change")}
            </span>
          </Button>
          {blockedNotice && conflictNotice && (
            <div className="bg-popover text-popover-foreground border-border shadow-soft absolute top-[calc(100%+6px)] left-0 z-20 whitespace-nowrap rounded-md border px-2.5 py-1.5 text-xs">
              {conflictNotice}
            </div>
          )}
        </div>
      ) : (
        <div className="border-primary bg-accent inline-flex items-center gap-3 rounded-[10px] border px-3.5 py-2.5">
          <Keyboard className="text-accent-foreground h-4 w-4 shrink-0" />
          {draftKeys.length > 0 ? (
            <KeyComboDisplay keys={draftKeys} variant="dim" />
          ) : null}
          <span className="text-accent-foreground text-[12px]">
            {captureHint}
          </span>
          <Button
            variant="outline"
            size="xs"
            onClick={cancelRecording}
            className="ml-1"
          >
            {t("common.cancel")}
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 4 — Dictate into the Gmail draft (replaces the old tutorial step:
// same model setup + hotkey rebind, new practice surface).
// ---------------------------------------------------------------------------
function DraftStep({
  hotkey,
  remixHotkey,
  onHotkeyRecorded,
  localModel,
  onDownloadLocal,
  onRetryLocal,
  canContinue,
  continueBlockedReason,
  body,
  onBodyChange,
  onBack,
  onContinue,
}: {
  hotkey: string;
  remixHotkey: string;
  onHotkeyRecorded: (accelerator: string) => void;
  localModel: VoiceItem | undefined;
  onDownloadLocal: () => void;
  onRetryLocal: () => void;
  canContinue: boolean;
  continueBlockedReason: "downloading" | "notReady" | null;
  body: string;
  onBodyChange: (text: string) => void;
  onBack: () => void;
  onContinue: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { phase, getLiveLevel } = useCoachPress("dictation");

  const statusLabel =
    phase === "pressed"
      ? t("onboarding.draft.statusListening")
      : phase === "result"
        ? t("onboarding.draft.statusLanded")
        : t("onboarding.draft.statusReady");

  return (
    <div className="w-full max-w-[1100px]">
      <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,560px)]">
        <div>
          <StepHeading title={t("onboarding.draft.title")} />

          <CoachStrip
            keys={formatAcceleratorKeys(hotkey)}
            phase={phase}
            instructionPrefix={t("onboarding.draft.instructionPrefix")}
            instructionSuffix={t("onboarding.draft.instructionSuffix")}
            sayText={t("onboarding.draft.sayText")}
            statusLabel={statusLabel}
            statusEmphasis={phase !== "idle"}
            getLiveLevel={getLiveLevel}
          />

          <ModelSetupPanel
            model={localModel}
            onDownload={onDownloadLocal}
            onRetry={onRetryLocal}
          />
        </div>

        <div className="flex justify-center lg:justify-end">
          <EmailDraft body={body} onBodyChange={onBodyChange} stage="dictate" />
        </div>
      </div>

      <HotkeyRebindControl
        hotkey={hotkey}
        target="dictation"
        conflictHotkey={remixHotkey}
        conflictNotice={t("settings.recording.conflict")}
        onRecorded={onHotkeyRecorded}
      />

      <div className="mt-7 flex items-center justify-between">
        <Button variant="outline" onClick={onBack}>
          {t("common.back")}
        </Button>
        <div className="flex flex-col items-end gap-1.5">
          {!canContinue && continueBlockedReason && (
            <p className="text-muted-foreground text-[11px]">
              {continueBlockedReason === "downloading"
                ? t("onboarding.modelSetup.waitingWhileDownloading")
                : t("onboarding.modelSetup.waitingToFinish")}
            </p>
          )}
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={onContinue}
              disabled={!canContinue}
              className="text-muted-foreground h-auto px-2 py-1 text-[12px]"
            >
              {t("onboarding.draft.skip")}
            </Button>
            <Button
              variant="ink"
              onClick={onContinue}
              disabled={!canContinue || !body.trim()}
            >
              {t("common.continue")}
              <ArrowRight data-icon="inline-end" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 5 — Remix the draft. Interactive when an LLM default exists: the real
// Remix pipeline runs against our own window via main's practice-target mode.
// Otherwise a scripted preview of a remix pass.
// ---------------------------------------------------------------------------
const REMIX_IN_FLIGHT_GRACE_MS = 30_000;

function RemixStep({
  body,
  onBodyChange,
  remixHotkey,
  dictationHotkey,
  onRemixHotkeyRecorded,
  onBack,
  onFinish,
}: {
  body: string;
  onBodyChange: (text: string) => void;
  remixHotkey: string;
  dictationHotkey: string;
  onRemixHotkeyRecorded: (accelerator: string) => void;
  onBack: () => void;
  onFinish: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { isFetched: settingsFetched } = useQuery(settingsQueryOptions());
  const configuredQuery = useQuery({
    queryKey: queryKeys.models.configured,
    queryFn: async () => {
      const res = await getClient().api.models.configured.$get();
      if (!res.ok) throw new Error("Failed to load configured models");
      return (await res.json()) as ConfiguredModel[];
    },
  });

  // The agent only hears what the user says, so the suggested instruction
  // must carry a concrete name.
  const signoffName = t("onboarding.remix.fallbackName");

  const llmDefault = (configuredQuery.data ?? []).find(
    (m) => m.type === "llm" && m.is_default === 1,
  );
  const ready = settingsFetched && configuredQuery.isFetched;
  const interactive = ready && !!llmDefault && !window.api?.isE2E;

  const [remixed, setRemixed] = useState(false);
  const [working, setWorking] = useState(false);
  const [deliveredCount, setDeliveredCount] = useState(0);
  const inFlightUntilRef = useRef(0);
  const lastDeliveredAtRef = useRef(0);
  const workingTimerRef = useRef<number | null>(null);

  // The one gate this feature opens: while this step is interactive, main
  // treats our own window as a legal Remix target. Unmount is the primary
  // off-switch; main clears it defensively too.
  useEffect(() => {
    if (!interactive) return;
    window.api?.setRemixPracticeTarget(true);
    return () => window.api?.setRemixPracticeTarget(false);
  }, [interactive]);

  const handleDelivered = useCallback(() => {
    // One paste can signal twice (IPC + the body-change fallback) — dedupe.
    const now = Date.now();
    if (now - lastDeliveredAtRef.current < 1500) return;
    lastDeliveredAtRef.current = now;
    inFlightUntilRef.current = 0;
    setDeliveredCount((count) => count + 1);
    setWorking(false);
    if (workingTimerRef.current !== null) {
      window.clearTimeout(workingTimerRef.current);
      workingTimerRef.current = null;
    }
    setRemixed(true);
  }, []);
  const handleDeliveredRef = useRef(handleDelivered);
  handleDeliveredRef.current = handleDelivered;

  useEffect(() => {
    if (!interactive) return;
    return window.api?.onRemixPracticeDelivered(() =>
      handleDeliveredRef.current(),
    );
  }, [interactive]);

  const { phase, getLiveLevel } = useCoachPress("remix", {
    onDown: () => {
      inFlightUntilRef.current = Number.MAX_SAFE_INTEGER;
    },
    onUp: () => {
      inFlightUntilRef.current = Date.now() + REMIX_IN_FLIGHT_GRACE_MS;
      setWorking(true);
      if (workingTimerRef.current !== null) {
        window.clearTimeout(workingTimerRef.current);
      }
      workingTimerRef.current = window.setTimeout(() => {
        setWorking(false);
      }, REMIX_IN_FLIGHT_GRACE_MS);
    },
  });

  // Belt-and-braces success detection: a body change while a remix session is
  // in flight counts as delivery even if a future path bypasses the two paste
  // handlers.
  useEffect(() => {
    if (!interactive || !body.trim()) return;
    if (Date.now() <= inFlightUntilRef.current) handleDeliveredRef.current();
  }, [body, interactive]);

  // Scripted fallback: an automated remix pass over the user's actual text.
  const [scriptPhase, setScriptPhase] = useState<"idle" | "pressed" | "result">(
    "idle",
  );
  const scripted = ready && !interactive;
  useEffect(() => {
    if (!scripted) return;
    const steps: ReadonlyArray<
      readonly ["idle" | "pressed" | "result", number]
    > = [
      ["idle", 2000],
      ["pressed", 3200],
      ["result", 3600],
    ];
    let index = 0;
    let timeout = 0;
    const tick = (): void => {
      const [name, dur] = steps[index % steps.length];
      setScriptPhase(name);
      index += 1;
      timeout = window.setTimeout(tick, dur);
    };
    tick();
    return () => window.clearTimeout(timeout);
  }, [scripted]);

  const scriptedBase = body.trim() || t("onboarding.remix.sampleDraft");
  const scriptedBody = scripted
    ? scriptPhase === "result"
      ? `${scriptedBase}\n\n${t("onboarding.remix.sampleSignoff", {
          name: signoffName,
        })}`
      : scriptedBase
    : null;

  // The strip follows real key presses when interactive, else the script.
  const stripPhase = interactive ? phase : scriptPhase;
  const stripWorking = interactive && working;
  const stripRemixed = interactive ? remixed : scriptPhase === "result";
  const statusLabel =
    stripPhase === "pressed"
      ? t("onboarding.remix.statusListening")
      : stripWorking
        ? t("onboarding.remix.statusWorking")
        : stripRemixed
          ? t("onboarding.remix.statusRemixed")
          : t("onboarding.remix.statusReady");

  const keys = formatAcceleratorKeys(remixHotkey);

  return (
    <div className="w-full max-w-[1100px]">
      <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,560px)]">
        <div>
          <StepHeading title={t("onboarding.remix.title")} />

          {!ready ? (
            <div className="flex justify-start">
              <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
            </div>
          ) : (
            <CoachStrip
              keys={keys}
              phase={stripPhase}
              lead={
                interactive
                  ? remixed
                    ? t("onboarding.remix.doneNote")
                    : t("onboarding.remix.highlightNote")
                  : undefined
              }
              instructionPrefix={t("onboarding.remix.instructionPrefix")}
              instructionSuffix={t("onboarding.remix.instructionSuffix")}
              sayText={t("onboarding.remix.sayText", { name: signoffName })}
              statusLabel={statusLabel}
              statusEmphasis={
                stripPhase === "pressed" || stripWorking || stripRemixed
              }
              getLiveLevel={interactive ? getLiveLevel : () => null}
            >
              {!interactive && (
                <p className="text-muted-foreground text-[14px] leading-relaxed">
                  {t("onboarding.remix.fallbackNote")}
                </p>
              )}
            </CoachStrip>
          )}
        </div>

        <div className="flex justify-center lg:justify-end">
          <EmailDraft
            body={body}
            onBodyChange={onBodyChange}
            stage="remix"
            scriptedBody={scriptedBody}
            highlightBody={interactive}
            highlightSignal={deliveredCount}
          />
        </div>
      </div>

      <HotkeyRebindControl
        hotkey={remixHotkey}
        target="remix"
        conflictHotkey={dictationHotkey}
        conflictNotice={t("settings.remix.conflict")}
        onRecorded={onRemixHotkeyRecorded}
      />

      <div className="mt-7 flex items-center justify-between">
        <Button variant="outline" onClick={onBack}>
          {t("common.back")}
        </Button>
        <Button variant="ink" onClick={onFinish}>
          {t("onboarding.tutorial.finish")}
          <ArrowRight data-icon="inline-end" />
        </Button>
      </div>
    </div>
  );
}
