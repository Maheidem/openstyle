import { useCoachPress } from "@renderer/components/hotkey-demo";
import { CoachStrip } from "@renderer/components/onboarding/coach-strip";
import { EmailDraft } from "@renderer/components/onboarding/email-draft";
import { Button } from "@renderer/components/ui/button";
import { formatAcceleratorKeys } from "@renderer/hooks/use-hotkey-recorder";
import { getClient } from "@renderer/lib/api";
import type { ConfiguredModel } from "@renderer/lib/models";
import { queryKeys, settingsQueryOptions } from "@renderer/lib/query";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { HotkeyRebindControl, StepHeading } from "./shared";

// ---------------------------------------------------------------------------
// Step 5 — Remix the draft. Interactive when an LLM default exists: the real
// Remix pipeline runs against our own window via main's practice-target mode.
// Otherwise a scripted preview of a remix pass.
// ---------------------------------------------------------------------------
const REMIX_IN_FLIGHT_GRACE_MS = 30_000;

export function RemixStep({
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
