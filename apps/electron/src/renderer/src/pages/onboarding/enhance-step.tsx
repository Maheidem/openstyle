import { Button } from "@renderer/components/ui/button";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StepHeading } from "./shared";

/**
 * Onboarding step for the auto-Enhance choice (specs/meeting-transcription-v2.md
 * §3.2). New users pick it here instead of seeing the one-time prompt on the
 * Meetings page. Same text and same two choices as the prompt
 * (`llmScopeLabel` in pages/meetings/enhance-prompt-dialog.tsx labels the
 * default LLM); the parent writes the settings:
 * - Turn on: `meeting_enhance_auto_run` = "true" + the seen flag
 * - Not now: `meeting_enhance_auto_run` = "false" + the seen flag
 * - Skip: the seen flag only (off stays the default for a missing row)
 */
export function EnhanceStep({
  model,
  onChoose,
  onBack,
}: {
  /** The default LLM to name, or null when none is configured yet. */
  model: { name: string; scope: string } | null;
  onChoose: (choice: "on" | "off" | "skip") => void;
  onBack: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  const choose = (choice: "on" | "off" | "skip") => {
    if (busy) return;
    setBusy(true);
    onChoose(choice);
  };

  return (
    <div className="w-full max-w-[520px]">
      <StepHeading title={t("meetings.enhancePromptTitle")} />
      <p className="text-muted-foreground m-0 text-[14px] leading-relaxed">
        {model
          ? t("meetings.enhancePromptDesc", {
              model: model.name,
              scope: t(`meetings.enhancePromptScope.${model.scope}`),
            })
          : t("meetings.enhancePromptNoLlm")}
      </p>
      <div className="mt-7 flex items-center justify-between gap-3">
        <Button variant="outline" onClick={onBack} disabled={busy}>
          {t("common.back")}
        </Button>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => choose("off")}
            disabled={busy}
            data-testid="onboarding-enhance-not-now"
          >
            {t("meetings.enhancePromptNotNow")}
          </Button>
          <Button
            variant="ink"
            onClick={() => choose("on")}
            disabled={busy}
            data-testid="onboarding-enhance-turn-on"
          >
            {t("meetings.enhancePromptTurnOn")}
          </Button>
        </div>
      </div>
      <div className="mt-3 flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => choose("skip")}
          disabled={busy}
          data-testid="onboarding-enhance-skip"
        >
          {t("onboarding.enhance.skip")}
        </Button>
      </div>
    </div>
  );
}
