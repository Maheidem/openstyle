import { useCoachPress } from "@renderer/components/hotkey-demo";
import { CoachStrip } from "@renderer/components/onboarding/coach-strip";
import { EmailDraft } from "@renderer/components/onboarding/email-draft";
import { Button } from "@renderer/components/ui/button";
import { Progress } from "@renderer/components/ui/progress";
import { formatAcceleratorKeys } from "@renderer/hooks/use-hotkey-recorder";
import { minutesLeft } from "@renderer/lib/onboarding";
import { ArrowRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { HotkeyRebindControl, StepHeading } from "./shared";
import { StepHeader } from "./step-header";

const MODIFIER_WORDS: Record<string, string> = {
  "⌃": "Control",
  "⌥": "Option",
  "⌘": "Command",
  "⇧": "Shift",
};

/** The hotkey as words ("Control + Option"). A key with no word keeps its label. */
export function hotkeyWords(keys: string[]): string {
  return keys.map((k) => MODIFIER_WORDS[k] ?? k).join(" + ");
}

// ---------------------------------------------------------------------------
// Step 4 — Try it. The user dictates once into a practice email. Continue
// unlocks when Openstyle reports a finished dictation. Skip is always on.
// ---------------------------------------------------------------------------
export function TryStep({
  counter,
  hotkey,
  onHotkeyRecorded,
  body,
  onBodyChange,
  dictated,
  permissionsMissing,
  modelWait,
  onFixPermissions,
  onBack,
  onContinue,
  onSkip,
}: {
  counter: { index: number; total: number };
  hotkey: string;
  onHotkeyRecorded: (accelerator: string) => void;
  body: string;
  onBodyChange: (text: string) => void;
  /** Openstyle reported a finished dictation while this step was open. */
  dictated: boolean;
  permissionsMissing: boolean;
  /** The voice model downloads: its progress, or null. */
  modelWait: { percent: number; secondsLeft: number | null } | null;
  onFixPermissions: () => void;
  onBack: () => void;
  onContinue: () => void;
  onSkip: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { phase, getLiveLevel } = useCoachPress();
  const keys = formatAcceleratorKeys(hotkey);
  const words = body.trim() ? body.trim().split(/\s+/).length : 0;
  const statusLabel =
    phase === "pressed"
      ? t("onboarding.draft.statusListening")
      : phase === "result"
        ? t("onboarding.draft.statusLanded")
        : t("onboarding.draft.statusReady");
  const minutes = minutesLeft(modelWait?.secondsLeft ?? null);

  return (
    <div className="w-full max-w-[1100px]">
      <div className="mx-auto max-w-[560px] lg:max-w-none">
        <StepHeader
          index={counter.index}
          total={counter.total}
          label={t("onboarding.stepName.try")}
        />
      </div>
      <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,560px)]">
        <div>
          <StepHeading title={t("onboarding.try.title")} />
          <CoachStrip
            keys={keys}
            phase={phase}
            instructionPrefix={t("onboarding.try.instructionPrefix")}
            instructionSuffix={t("onboarding.try.instructionSuffix", {
              words: hotkeyWords(keys),
            })}
            sayText={t("onboarding.try.sayText")}
            statusLabel={statusLabel}
            statusEmphasis={phase !== "idle"}
            getLiveLevel={getLiveLevel}
          />

          {dictated && (
            <p
              role="status"
              data-testid="onboarding-try-ok"
              className="mt-4 mb-0 rounded-[10px] bg-emerald-500/10 px-3 py-2.5 text-[12.5px] text-emerald-800 dark:text-emerald-300"
            >
              <strong>{t("onboarding.try.worked")}</strong>{" "}
              {words > 0 ? t("onboarding.try.typed", { count: words }) : ""}
            </p>
          )}
          {!dictated && modelWait && (
            <div
              data-testid="onboarding-try-wait"
              className="bg-card border-border mt-4 rounded-[10px] border px-3 py-2.5 text-[12.5px]"
            >
              {t("onboarding.try.modelWait")}{" "}
              {minutes != null &&
                t("onboarding.footer.minutesLeft", { count: minutes })}
              <Progress value={modelWait.percent} className="mt-2 h-[6px]" />
            </div>
          )}
          {!dictated && permissionsMissing && (
            <div
              role="alert"
              data-testid="onboarding-try-perms"
              className="bg-destructive/10 text-destructive mt-4 rounded-[10px] px-3 py-2.5 text-[12.5px]"
            >
              {t("onboarding.try.permissionsMissing")}
              <div className="mt-2">
                <Button size="sm" variant="outline" onClick={onFixPermissions}>
                  {t("onboarding.try.fix")}
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-center lg:justify-end">
          <EmailDraft body={body} onBodyChange={onBodyChange} />
        </div>
      </div>

      <HotkeyRebindControl
        hotkey={hotkey}
        target="dictation"
        onRecorded={onHotkeyRecorded}
      />

      <div className="mt-7 flex items-center justify-between">
        <Button variant="outline" onClick={onBack}>
          {t("common.back")}
        </Button>
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={onSkip}
            className="text-muted-foreground h-auto px-2 py-1 text-[12px] underline"
            data-testid="onboarding-try-skip"
          >
            {t("onboarding.try.skip")}
          </Button>
          <Button
            onClick={onContinue}
            disabled={!dictated}
            data-testid="onboarding-try-continue"
          >
            {t("common.continue")}
            <ArrowRight data-icon="inline-end" />
          </Button>
        </div>
      </div>
    </div>
  );
}
