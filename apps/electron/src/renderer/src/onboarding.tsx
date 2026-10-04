import { normalizeLanguageList } from "@openstyle/validations";
import { defaultLanguage } from "@renderer/lib/languages";
import {
  pollUntil,
  requestMicAccess,
  resolveMicStatus,
} from "@renderer/lib/permissions";
import { IS_LINUX } from "@renderer/lib/platform";
import { settingsQueryOptions } from "@renderer/lib/query";
import { putSetting } from "@renderer/lib/settings";
import { DraftStep } from "@renderer/pages/onboarding/draft-step";
import { LanguageStep } from "@renderer/pages/onboarding/language-step";
import {
  type LinuxSetup,
  PermissionsStep,
} from "@renderer/pages/onboarding/permissions-step";
import { RemixStep } from "@renderer/pages/onboarding/remix-step";
import { useOnboardingModel } from "@renderer/pages/onboarding/use-onboarding-model";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { getDefaultHotkey } from "../../shared/hotkey-defaults";
import { getDefaultRemixHotkey } from "../../shared/remix";
import { SETTINGS_KEYS } from "../../shared/settings-keys";

type Step = "permissions" | "language" | "draft" | "remix";

const DEFAULT_HOTKEY =
  (typeof window !== "undefined" && window.api?.defaultHotkey) ||
  getDefaultHotkey();

const DEFAULT_REMIX_HOTKEY =
  (typeof window !== "undefined" && window.api?.defaultRemixHotkey) ||
  getDefaultRemixHotkey();

export default function OnboardingPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("permissions");
  const model = useOnboardingModel();

  // Permissions state
  const [micStatus, setMicStatus] = useState<string>("unknown");
  const [accessibilityStatus, setAccessibilityStatus] = useState(false);
  const [linuxSetup, setLinuxSetup] = useState<LinuxSetup | null>(null);
  const cancelMicPollRef = useRef<(() => void) | null>(null);
  const cancelAccessibilityPollRef = useRef<(() => void) | null>(null);

  // Language state
  const [languages, setLanguages] = useState<string[]>(() => {
    // Seed from the OS language when it's a real code; "auto" starts empty.
    const guess = defaultLanguage();
    return guess === "auto" ? [] : [guess];
  });

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
            localModel={model.localModel}
            onDownloadLocal={model.download}
            onRetryLocal={model.download}
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
            localModel={model.localModel}
            onDownloadLocal={model.download}
            onRetryLocal={model.download}
            blockedReason={model.blockedReason}
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
