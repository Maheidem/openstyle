import { normalizeLanguageList } from "@openstyle/validations";
import { getClient } from "@renderer/lib/api";
import { defaultLanguage } from "@renderer/lib/languages";
import type { ConfiguredModel } from "@renderer/lib/models";
import {
  pollUntil,
  requestMicAccess,
  resolveMicStatus,
} from "@renderer/lib/permissions";
import { IS_LINUX } from "@renderer/lib/platform";
import {
  configQueryOptions,
  queryKeys,
  settingsQueryOptions,
} from "@renderer/lib/query";
import { putSetting } from "@renderer/lib/settings";
import { llmScopeLabel } from "@renderer/pages/meetings/enhance-prompt-dialog";
import { DraftStep } from "@renderer/pages/onboarding/draft-step";
import { EnhanceStep } from "@renderer/pages/onboarding/enhance-step";
import { LanguageStep } from "@renderer/pages/onboarding/language-step";
import { NameStep } from "@renderer/pages/onboarding/name-step";
import {
  type LinuxSetup,
  PermissionsStep,
} from "@renderer/pages/onboarding/permissions-step";
import { useOnboardingModel } from "@renderer/pages/onboarding/use-onboarding-model";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { getDefaultHotkey } from "../../shared/hotkey-defaults";
import { SETTINGS_KEYS } from "../../shared/settings-keys";

type Step = "permissions" | "language" | "draft" | "name" | "enhance";

const DEFAULT_HOTKEY =
  (typeof window !== "undefined" && window.api?.defaultHotkey) ||
  getDefaultHotkey();

export default function OnboardingPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("permissions");
  const model = useOnboardingModel();

  // The default LLM the enhance step names (specs/meeting-transcription-v2.md
  // §3.2). null when none is configured: the step then shows the unnamed
  // variant of the text.
  const { data: modelConfigs } = useQuery({
    queryKey: queryKeys.models.configured,
    queryFn: async () => {
      const res = await getClient().api.models.configured.$get();
      if (!res.ok) throw new Error("Failed to load configured models");
      return (await res.json()) as ConfiguredModel[];
    },
  });
  const defaultLlm = (modelConfigs ?? []).find(
    (m) => m.type === "llm" && m.is_default === 1,
  );
  const enhanceLlmScope = llmScopeLabel(defaultLlm?.provider);
  const enhanceModel =
    defaultLlm && enhanceLlmScope
      ? { name: defaultLlm.model_name, scope: enhanceLlmScope }
      : null;

  // The name and auto-Enhance onboarding steps only make sense when Meeting
  // Mode is on — the same `flags?.meetings === true` gate the app shell uses
  // to show the Meetings nav item (shell.tsx). When the flag is off there is
  // no Meetings feature, so onboarding finishes right after the draft step.
  const { data: config } = useQuery(configQueryOptions());
  const meetingsEnabled = config?.flags?.meetings === true;

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

  // Hotkey recorder state (draft step).
  const [hotkey, setHotkey] = useState(DEFAULT_HOTKEY);

  // The practice email body, lifted so it survives the draft→enhance step
  // transition (and Back).
  const [draftBody, setDraftBody] = useState("");

  // The owner name field of the name step, lifted so it survives Back.
  // null until the user types: the stored value (if any) shows until then.
  const [ownerName, setOwnerName] = useState<string | null>(null);

  const handleHotkeyRecorded = useCallback((accelerator: string) => {
    setHotkey(accelerator);
    void putSetting(SETTINGS_KEYS.hotkey, accelerator);
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

  // The name step writes `owner_name` only when Continue changes it. Skip
  // writes nothing, so a missing row keeps meaning "no name".
  const storedOwnerName = settingsData?.[SETTINGS_KEYS.ownerName] ?? "";
  const handleNameDone = useCallback(
    async (name: string | null) => {
      if (name !== null && name !== storedOwnerName) {
        await putSetting(SETTINGS_KEYS.ownerName, name);
      }
      setStep("enhance");
    },
    [storedOwnerName],
  );

  // Specs/meeting-transcription-v2.md §3.2: turn on and not now both write
  // the auto-run setting (explicit off included); Skip writes only the seen
  // flag, so a missing row keeps meaning off.
  const handleEnhanceChoice = useCallback(
    async (choice: "on" | "off" | "skip") => {
      if (choice === "on") {
        await putSetting(SETTINGS_KEYS.meetingEnhanceAutoRun, "true");
      } else if (choice === "off") {
        await putSetting(SETTINGS_KEYS.meetingEnhanceAutoRun, "false");
      }
      await putSetting(SETTINGS_KEYS.meetingEnhancePromptSeen, "true");
      finishSetup();
    },
    [finishSetup],
  );

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
            onContinue={() => {
              // Meeting Mode flag off → no name or Enhance step, finish here.
              if (meetingsEnabled) setStep("name");
              else finishSetup();
            }}
            isLastStep={!meetingsEnabled}
          />
        )}

        {step === "name" && (
          <NameStep
            name={ownerName ?? storedOwnerName}
            onNameChange={setOwnerName}
            onDone={(name) => void handleNameDone(name)}
            onBack={() => setStep("draft")}
          />
        )}

        {step === "enhance" && (
          <EnhanceStep
            model={enhanceModel}
            onChoose={(choice) => void handleEnhanceChoice(choice)}
            onBack={() => setStep("name")}
          />
        )}
      </div>
    </div>
  );
}
