import { normalizeLanguageList } from "@openstyle/validations";
import { Button } from "@renderer/components/ui/button";
import { formatAcceleratorKeys } from "@renderer/hooks/use-hotkey-recorder";
import { defaultLanguage } from "@renderer/lib/languages";
import { displayProviderName, formatBytes } from "@renderer/lib/models";
import {
  type FlowOptions,
  nextStep,
  prevStep,
  resumeStep,
  STEP,
  stepCounter,
} from "@renderer/lib/onboarding";
import { configQueryOptions, settingsQueryOptions } from "@renderer/lib/query";
import { putSetting } from "@renderer/lib/settings";
import { DownloadFooter } from "@renderer/pages/onboarding/download-footer";
import { EnhanceStep } from "@renderer/pages/onboarding/enhance-step";
import { LanguageStep } from "@renderer/pages/onboarding/language-step";
import { ModelStep } from "@renderer/pages/onboarding/model-step";
import { NameStep } from "@renderer/pages/onboarding/name-step";
import { PermissionsStep } from "@renderer/pages/onboarding/permissions-step";
import {
  type ReadyChip,
  ReadyStep,
} from "@renderer/pages/onboarding/ready-step";
import { hotkeyWords, TryStep } from "@renderer/pages/onboarding/try-step";
import { useOnboardingModels } from "@renderer/pages/onboarding/use-onboarding-models";
import { usePermissions } from "@renderer/pages/onboarding/use-permissions";
import { WelcomeStep } from "@renderer/pages/onboarding/welcome-step";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router";
import { getDefaultHotkey } from "../../shared/hotkey-defaults";
import type { OnboardingState } from "../../shared/onboarding";
import { SETTINGS_KEYS } from "../../shared/settings-keys";

const DEFAULT_HOTKEY =
  (typeof window !== "undefined" && window.api?.defaultHotkey) ||
  getDefaultHotkey();

// The saved step and draft come from the main process. Nothing renders before
// they are there, so the first screen is the right one after a quit.
export default function OnboardingPage(): React.JSX.Element | null {
  const [saved, setSaved] = useState<OnboardingState | null>(null);
  const [params] = useSearchParams();
  // "Run setup again": the safe replay (specs/onboarding.md section 11).
  const replay = params.get("replay") === "1";
  const { data: config } = useQuery(configQueryOptions());
  const { data: settings } = useQuery(settingsQueryOptions());

  useEffect(() => {
    if (replay) return;
    let cancelled = false;
    void (window.api?.getOnboardingState() ?? Promise.resolve(null))
      .catch(() => null)
      .then((state) => {
        if (!cancelled) setSaved(state ?? { step: 0, draft: {} });
      });
    return () => {
      cancelled = true;
    };
  }, [replay]);

  if (!config || !settings) return null;
  if (replay) {
    return (
      <OnboardingFlow
        key="replay"
        replay
        saved={{
          step: STEP.language,
          draft: { languages: storedLanguages(settings) },
        }}
        meetings={config.flags?.meetings === true}
        storedOwnerName={settings[SETTINGS_KEYS.ownerName] ?? ""}
        storedHotkey={settings[SETTINGS_KEYS.hotkey]}
        storedEnhance={settings[SETTINGS_KEYS.meetingEnhanceAutoRun] === "true"}
        storedLanguages={storedLanguages(settings)}
      />
    );
  }
  if (!saved) return null;
  return (
    <OnboardingFlow
      saved={saved}
      meetings={config.flags?.meetings === true}
      storedOwnerName={settings[SETTINGS_KEYS.ownerName] ?? ""}
      storedHotkey={settings[SETTINGS_KEYS.hotkey]}
      storedEnhance={false}
      storedLanguages={[]}
    />
  );
}

/** The saved language list of the settings (a JSON array of codes). */
function storedLanguages(settings: Record<string, string>): string[] {
  try {
    const value = JSON.parse(settings[SETTINGS_KEYS.languages] ?? "[]");
    return Array.isArray(value)
      ? value.filter((c): c is string => typeof c === "string")
      : [];
  } catch {
    return [];
  }
}

function OnboardingFlow({
  saved,
  meetings,
  storedOwnerName,
  storedHotkey,
  storedEnhance,
  storedLanguages: savedLanguages,
  replay = false,
}: {
  saved: OnboardingState;
  meetings: boolean;
  storedOwnerName: string;
  storedHotkey: string | undefined;
  /** Setup again: the saved state of the auto Enhance setting. */
  storedEnhance: boolean;
  /** Setup again: the saved language list. */
  storedLanguages: string[];
  /** Setup again: change nothing until the user saves at the end. */
  replay?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();

  // ---- Choices of the user ------------------------------------------------
  const [languages, setLanguages] = useState<string[]>(() => {
    if (saved.draft.languages) return saved.draft.languages;
    // Seed from the OS language when it is a real code; "auto" starts empty.
    const guess = defaultLanguage();
    return guess === "auto" ? [] : [guess];
  });
  const [osLanguage] = useState<string | null>(() => {
    if (replay) return null;
    const guess = defaultLanguage();
    return guess === "auto" ? null : guess;
  });
  const [languagesTouched, setLanguagesTouched] = useState(
    saved.draft.languages !== undefined,
  );
  const [downloadStarted, setDownloadStarted] = useState(
    saved.draft.downloadStarted === true,
  );
  const [hotkey, setHotkey] = useState(storedHotkey ?? DEFAULT_HOTKEY);
  const [body, setBody] = useState("");
  const [ownerName, setOwnerName] = useState<string | null>(null);
  const [enhance, setEnhance] = useState<boolean | null>(
    replay ? storedEnhance : (saved.draft.enhance ?? null),
  );
  const [dictated, setDictated] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const models = useOnboardingModels(
    languages,
    saved.draft,
    downloadStarted,
    replay,
  );
  const voiceLater = models.voiceSource === "later";
  // Setup again does not test dictation (the hotkey would save at once).
  const flow: FlowOptions = { meetings, voiceLater: voiceLater || replay };

  const [step, setStep] = useState<number>(() =>
    replay
      ? STEP.language
      : resumeStep(saved.step, {
          meetings,
          voiceLater: saved.draft.voiceSource === "later",
        }),
  );

  const permissions = usePermissions(
    step === STEP.permissions || step === STEP.tryIt || step === STEP.ready,
  );
  const permsOk =
    permissions.micStatus === "granted" &&
    (window.api?.platform !== "darwin" || permissions.accessibilityStatus);

  // The finished dictation: the pill reports it after it delivered the text.
  useEffect(() => {
    if (step !== STEP.tryIt) return;
    return window.api?.onTranscriptionDone(() => setDictated(true));
  }, [step]);

  // Back on the model step after "Decide later": the voice source is open again.
  useEffect(() => {
    if (step === STEP.model && models.voiceSource === "later") {
      models.setVoiceSource("mac");
    }
  }, [step, models.voiceSource, models.setVoiceSource]);

  const go = useCallback(
    (
      to: number,
      draft?: Parameters<typeof window.api.setOnboardingState>[0]["draft"],
    ) => {
      setStep(to);
      // Setup again saves nothing on the way.
      if (!replay) void window.api?.setOnboardingState({ step: to, draft });
    },
    [replay],
  );

  const draftNow = useCallback(
    () => ({
      ...models.toDraft(),
      languages,
      downloadStarted,
      enhance: enhance ?? undefined,
    }),
    [models, languages, downloadStarted, enhance],
  );

  // ---- Language -----------------------------------------------------------
  const toggleLanguage = (code: string): void => {
    setLanguagesTouched(true);
    setLanguages((prev) =>
      prev.includes(code)
        ? prev.filter((c) => c !== code)
        : normalizeLanguageList([...prev, code]),
    );
  };

  const continueLanguage = (): void => {
    // The transcribe path reads this setting for each request. Setup again
    // writes it at the end.
    if (!replay) {
      void putSetting(SETTINGS_KEYS.languages, JSON.stringify(languages));
    }
    go(nextStep(step, flow), { ...draftNow(), languages });
  };

  // ---- Model --------------------------------------------------------------
  const continueModel = async (): Promise<void> => {
    setCommitError(null);
    if (replay) {
      // Setup again saves and downloads at the end, when the user saves.
      go(nextStep(step, flow));
      return;
    }
    const error = await models.commit();
    if (error) {
      setCommitError(error);
      return;
    }
    const local = !!models.chosenVoice || !!models.chosenText;
    if (local) setDownloadStarted(true);
    go(nextStep(step, flow), {
      ...draftNow(),
      downloadStarted: local || downloadStarted,
    });
  };

  const decideLater = async (): Promise<void> => {
    // Nothing downloads and no voice model stays saved.
    try {
      await models.clearVoiceDefault();
    } catch {
      setCommitError("failed");
      return;
    }
    models.setVoiceSource("later");
    setDownloadStarted(false);
    const draft = {
      ...draftNow(),
      voiceSource: "later" as const,
      downloadStarted: false,
    };
    // The footer also offers "Decide later" on later steps. Only the Model
    // step moves on. Another step stays where it is.
    if (step === STEP.model) {
      go(nextStep(step, { meetings, voiceLater: true }), draft);
    } else {
      void window.api?.setOnboardingState({ step, draft });
    }
  };

  const chooseOtherAfterStop = (): void => {
    setCommitError(null);
    go(STEP.model, draftNow());
  };

  // ---- Name and Enhance ---------------------------------------------------
  const finishName = async (name: string | null): Promise<void> => {
    if (!replay && name !== null && name !== storedOwnerName) {
      await putSetting(SETTINGS_KEYS.ownerName, name);
    }
    go(nextStep(step, flow), draftNow());
  };

  const hasTextModel = models.defaultLlm != null;
  const enhanceOn = enhance ?? hasTextModel;
  const enhanceDownload =
    enhanceOn && !hasTextModel && models.recommendedText
      ? {
          name: models.recommendedText.name,
          size: formatBytes(models.recommendedText.sizeBytes),
        }
      : null;

  const finishEnhance = async (): Promise<void> => {
    if (replay) {
      go(nextStep(step, flow));
      return;
    }
    setBusy(true);
    try {
      if (enhanceOn && !hasTextModel && models.recommendedText) {
        await models.startRecommendedText();
        setDownloadStarted(true);
      }
      await putSetting(
        SETTINGS_KEYS.meetingEnhanceAutoRun,
        enhanceOn ? "true" : "false",
      );
      await putSetting(SETTINGS_KEYS.meetingEnhancePromptSeen, "true");
      go(nextStep(step, flow), { ...draftNow(), enhance: enhanceOn });
    } catch {
      setCommitError("failed");
    } finally {
      setBusy(false);
    }
  };

  const finishSetup = (): void => {
    window.api?.setOnboardingComplete();
    navigate("/today", { replace: true });
  };

  // ---- Setup again --------------------------------------------------------
  // Cancel and close change nothing. The user saves at the end. Only what the
  // user changed is written. Nothing is deleted.
  const cancelReplay = (): void => {
    void navigate("/settings", { replace: true });
  };

  const applyReplay = async (): Promise<void> => {
    setBusy(true);
    setCommitError(null);
    try {
      if (JSON.stringify(languages) !== JSON.stringify(savedLanguages)) {
        await putSetting(SETTINGS_KEYS.languages, JSON.stringify(languages));
      }
      const error = await models.commit();
      if (error) {
        setCommitError(error);
        return;
      }
      if (ownerName !== null && ownerName !== storedOwnerName) {
        await putSetting(SETTINGS_KEYS.ownerName, ownerName);
      }
      if (enhance !== null && enhance !== storedEnhance) {
        if (enhance && !hasTextModel && models.textSource === "keep") {
          await models.startRecommendedText();
        }
        await putSetting(
          SETTINGS_KEYS.meetingEnhanceAutoRun,
          enhance ? "true" : "false",
        );
      }
      navigate("/settings", { replace: true });
    } catch {
      setCommitError("failed");
    } finally {
      setBusy(false);
    }
  };

  // ---- Ready screen -------------------------------------------------------
  const readyChips: ReadyChip[] = [];
  const where = (provider: string | undefined, isLocal: boolean): string =>
    isLocal
      ? t("onboarding.ready.thisMac")
      : provider === "server"
        ? t("onboarding.ready.ownServer")
        : displayProviderName(provider ?? "");
  const voiceProvider = models.defaultVoice?.provider;
  // Setup again: a changed choice shows as it will be after the save.
  const changedVoice = replay && models.voiceSource !== "keep";
  const changedText = replay && models.textSource !== "keep";
  if (changedVoice && models.voiceSource !== "later") {
    const src = models.voiceSource;
    readyChips.push({
      id: "voice",
      label: t("onboarding.ready.voice", {
        where:
          src === "mac"
            ? t("onboarding.ready.thisMac")
            : src === "server"
              ? t("onboarding.ready.ownServer")
              : displayProviderName(models.voiceRemote.provider),
      }),
      tone:
        src === "mac" && models.chosenVoice?.status !== "ready" ? "warn" : "ok",
    });
  }
  if (models.defaultVoice && !voiceLater && !changedVoice) {
    const local =
      voiceProvider === "local-mlx" || voiceProvider === "local-whisper";
    // A model on a server or a provider is ready, unless the key test could
    // not reach the provider ("not tested").
    const ready = local
      ? models.defaultVoiceItem?.status === "ready"
      : models.voiceRemote.keyTest.state !== "offline";
    readyChips.push({
      id: "voice",
      label: t("onboarding.ready.voice", {
        where: where(voiceProvider, local),
      }),
      tone: ready ? "ok" : "warn",
    });
  }
  if (changedText && !(models.textSource === "mac" && !models.chosenText)) {
    const src = models.textSource;
    readyChips.push({
      id: "text",
      label: t("onboarding.ready.text", {
        where:
          src === "mac"
            ? t("onboarding.ready.thisMac")
            : src === "server"
              ? t("onboarding.ready.ownServer")
              : displayProviderName(models.textRemote.provider),
      }),
      tone:
        src === "mac" && models.chosenText?.status !== "ready" ? "warn" : "ok",
    });
  }
  if (models.defaultLlm && !changedText) {
    const provider = models.defaultLlm.provider;
    const local = provider === "local-mlx-llm";
    const ready = local
      ? models.defaultTextItem?.status === "ready"
      : models.textRemote.keyTest.state !== "offline";
    readyChips.push({
      id: "text",
      label: t("onboarding.ready.text", { where: where(provider, local) }),
      tone: ready ? "ok" : "warn",
    });
  }
  if (permissions.micStatus === "granted") {
    readyChips.push({
      id: "mic",
      label: t("onboarding.permissions.microphone.title"),
      tone: "ok",
    });
  }
  if (permissions.accessibilityStatus) {
    readyChips.push({
      id: "accessibility",
      label: t("onboarding.permissions.accessibility.title"),
      tone: "ok",
    });
  }
  if (meetings && enhanceOn && step === STEP.ready) {
    readyChips.push({
      id: "enhance",
      label: t("onboarding.enhance.switch"),
      tone: "ok",
    });
  }

  const words = hotkeyWords(formatAcceleratorKeys(hotkey));
  const voiceDownloading =
    models.defaultVoiceItem && models.defaultVoiceItem.status !== "ready";
  const readyLine = replay
    ? t("onboarding.replay.line")
    : voiceLater || !models.defaultVoice
      ? t("onboarding.ready.lineLater")
      : voiceDownloading
        ? t("onboarding.ready.lineDownloading", { keys: words })
        : t("onboarding.ready.line", { keys: words });

  const counter = stepCounter(step, flow);
  const showFooter = !replay && step >= STEP.model && step <= STEP.ready;

  return (
    <div className="glass-window-shell glass-content flex h-screen flex-col">
      <div
        className="flex h-9 shrink-0 items-center justify-end px-4"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        {replay && (
          <Button
            variant="ghost"
            size="sm"
            onClick={cancelReplay}
            disabled={busy}
            data-testid="onboarding-cancel"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            {t("common.cancel")}
          </Button>
        )}
      </div>

      <div
        className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-auto px-6 py-8"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        data-testid="onboarding-root"
        data-step={step}
      >
        {step === STEP.welcome && (
          <WelcomeStep onStart={() => go(nextStep(step, flow), draftNow())} />
        )}

        {step === STEP.language && counter && (
          <LanguageStep
            languages={languages}
            osLanguage={osLanguage}
            touched={languagesTouched}
            counter={counter}
            onToggle={toggleLanguage}
            onClear={() => {
              setLanguagesTouched(true);
              setLanguages([]);
            }}
            onBack={() => (replay ? cancelReplay() : go(prevStep(step, flow)))}
            onContinue={continueLanguage}
          />
        )}

        {step === STEP.model && counter && (
          <ModelStep
            models={models}
            counter={counter}
            commitError={commitError}
            replay={replay}
            onBack={() => go(prevStep(step, flow), draftNow())}
            onContinue={() => void continueModel()}
            onDecideLater={() => void decideLater()}
          />
        )}

        {step === STEP.permissions && counter && (
          <PermissionsStep
            counter={counter}
            micStatus={permissions.micStatus}
            accessibilityStatus={permissions.accessibilityStatus}
            accessibilityWaiting={permissions.accessibilityWaiting}
            linuxSetup={permissions.linuxSetup}
            onRequestMic={() => void permissions.requestMic()}
            onOpenMicSettings={permissions.openMicSettings}
            onOpenAccessibility={permissions.openAccessibility}
            onCheckAgain={() => void permissions.checkAgain()}
            onRecheckLinuxSetup={() => void permissions.recheckLinuxSetup()}
            onBack={() => go(prevStep(step, flow))}
            onContinue={() => go(nextStep(step, flow))}
          />
        )}

        {step === STEP.tryIt && counter && (
          <TryStep
            counter={counter}
            hotkey={hotkey}
            onHotkeyRecorded={(accelerator) => {
              setHotkey(accelerator);
              void putSetting(SETTINGS_KEYS.hotkey, accelerator);
            }}
            body={body}
            onBodyChange={setBody}
            dictated={dictated}
            permissionsMissing={!permsOk}
            modelWait={
              models.downloads.current?.kind === "voice" &&
              (models.downloads.state === "running" ||
                models.downloads.state === "failed")
                ? {
                    percent: models.downloads.percent,
                    secondsLeft: models.downloads.secondsLeft,
                  }
                : null
            }
            onFixPermissions={() => go(STEP.permissions)}
            onBack={() => go(prevStep(step, flow))}
            onContinue={() => go(nextStep(step, flow))}
            onSkip={() => go(nextStep(step, flow))}
          />
        )}

        {step === STEP.name && counter && (
          <NameStep
            counter={counter}
            name={ownerName ?? storedOwnerName}
            onNameChange={setOwnerName}
            onDone={(name) => void finishName(name)}
            onBack={() => go(prevStep(step, flow))}
          />
        )}

        {step === STEP.enhance && counter && (
          <EnhanceStep
            counter={counter}
            enabled={enhanceOn}
            onToggle={setEnhance}
            download={enhanceDownload}
            busy={busy}
            onBack={() => go(prevStep(step, flow))}
            onContinue={() => void finishEnhance()}
          />
        )}

        {step === STEP.ready && (
          <ReadyStep
            chips={readyChips}
            line={readyLine}
            onFinish={replay ? () => void applyReplay() : finishSetup}
            buttonLabel={replay ? t("onboarding.replay.save") : undefined}
            busy={busy}
            error={
              replay && commitError ? t("onboarding.model.errors.failed") : null
            }
          />
        )}
      </div>

      {showFooter && (
        <DownloadFooter
          summary={models.downloads}
          onRetry={() => void models.retryDownloads()}
          onChooseOther={chooseOtherAfterStop}
          onDecideLater={() => void decideLater()}
        />
      )}
    </div>
  );
}
