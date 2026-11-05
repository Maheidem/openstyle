import { Button } from "@renderer/components/ui/button";
import { formatBytes } from "@renderer/lib/models";
import { availableModelsQueryOptions } from "@renderer/lib/query";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Loader2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CloudForm,
  ServerForm,
  SourcePills,
  TextMacRows,
  VoiceMacRows,
} from "./model-sources";
import { StepHeading } from "./shared";
import { StepHeader } from "./step-header";
import type { OnboardingModels, Source } from "./use-onboarding-models";
import { cloudModelFor } from "./use-remote-source";

// ---------------------------------------------------------------------------
// Step 2 — Model. One suggestion for this Mac and one button. "Choose another"
// opens the other sources, for the voice and the text model each.
// ---------------------------------------------------------------------------
export function ModelStep({
  models,
  counter,
  commitError,
  onBack,
  onContinue,
  onDecideLater,
}: {
  models: OnboardingModels;
  counter: { index: number; total: number };
  /** An error text of the last press, or null. */
  commitError: string | null;
  onBack: () => void;
  onContinue: () => void;
  onDecideLater: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  // The long view opens when the user left the suggestion in an earlier visit.
  const [chooseOpen, setChooseOpen] = useState(
    models.voiceSource !== "mac" ||
      models.textSource !== "mac" ||
      models.voicePick !== null ||
      models.textPick !== null,
  );
  const [voiceExpanded, setVoiceExpanded] = useState(false);
  const [textExpanded, setTextExpanded] = useState(false);
  const { data: available } = useQuery(availableModelsQueryOptions());

  const total = models.plan.total;
  const button =
    total > 0
      ? t("onboarding.model.downloadAndContinue", { size: formatBytes(total) })
      : t("common.continue");
  const disabled = models.loading || models.committing || models.blocked;

  const header = (
    <StepHeader
      index={counter.index}
      total={counter.total}
      label={t("onboarding.stepName.model")}
    />
  );

  const errorLine = commitError && (
    <p
      role="alert"
      data-testid="onboarding-model-error"
      className="bg-destructive/10 text-destructive mt-3 rounded-[10px] px-3 py-2.5 text-[12.5px]"
    >
      {t(`onboarding.model.errors.${commitError}`, {
        defaultValue: t("onboarding.model.errors.failed"),
      })}
    </p>
  );

  const disk = models.diskWarning && (
    <p
      data-testid="onboarding-disk-warning"
      className="mt-3 rounded-[10px] bg-amber-500/10 px-3 py-2.5 text-[12.5px] text-amber-900 dark:text-amber-200"
    >
      {t("onboarding.model.diskWarning", {
        need: formatBytes(models.diskWarning.need),
        have: formatBytes(models.diskWarning.have),
      })}
    </p>
  );

  const nav = (
    <div className="mt-6 flex items-center justify-between gap-3">
      <Button variant="outline" onClick={onBack}>
        {t("common.back")}
      </Button>
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={onDecideLater}
          disabled={models.committing}
          className="text-muted-foreground h-auto px-2 py-1 text-[12px] underline"
          data-testid="onboarding-decide-later"
        >
          {t("onboarding.model.decideLater")}
        </Button>
        <Button
          onClick={onContinue}
          disabled={disabled}
          data-testid="onboarding-model-continue"
        >
          {models.committing && (
            <Loader2 data-icon="inline-start" className="animate-spin" />
          )}
          {button}
          <ArrowRight data-icon="inline-end" />
        </Button>
      </div>
    </div>
  );

  if (!chooseOpen) {
    const voice = models.recommendedVoice;
    const text = models.recommendedText;
    return (
      <div className="w-full max-w-[560px]" data-testid="onboarding-model-rec">
        {header}
        <StepHeading title={t("onboarding.model.title")} />
        <div className="border-border bg-card flex items-center gap-3 rounded-[12px] border px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-4 py-1.5">
              <span className="mono text-muted-foreground w-12 shrink-0 text-[10.5px] tracking-[0.1em] uppercase">
                {t("onboarding.model.voice")}
              </span>
              <span
                className="text-foreground text-[15px] font-semibold"
                data-testid="onboarding-rec-voice"
              >
                {voice?.name ?? "…"}
              </span>
            </div>
            <div className="flex items-baseline gap-4 py-1.5">
              <span className="mono text-muted-foreground w-12 shrink-0 text-[10.5px] tracking-[0.1em] uppercase">
                {t("onboarding.model.text")}
              </span>
              <span
                className="text-foreground text-[15px] font-semibold"
                data-testid="onboarding-rec-text"
              >
                {text?.name ?? t("onboarding.model.notSet")}
              </span>
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setChooseOpen(true)}
            data-testid="onboarding-choose-another"
          >
            {t("onboarding.model.chooseAnother")}
          </Button>
        </div>
        {disk}
        {errorLine}
        {nav}
      </div>
    );
  }

  const sourceOptions = (local: string): { id: Source; label: string }[] => [
    { id: "mac", label: local },
    { id: "server", label: t("onboarding.model.sources.server") },
    { id: "cloud", label: t("onboarding.model.sources.cloud") },
  ];
  const voiceModel = cloudModelFor(
    available ?? [],
    "voice",
    models.voiceRemote.provider,
  );
  const textModel = cloudModelFor(
    available ?? [],
    "llm",
    models.textRemote.provider,
  );
  const profile = models.profile;
  const selectedVoice = models.chosenVoice;

  return (
    <div className="w-full max-w-[560px]" data-testid="onboarding-model-choose">
      {header}
      <StepHeading title={t("onboarding.model.chooseTitle")} />
      <div className="-mt-3 mb-4">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            models.useRecommendation();
            setChooseOpen(false);
          }}
          data-testid="onboarding-use-recommendation"
        >
          {t("onboarding.model.useRecommendation")}
        </Button>
      </div>

      <div className="mono text-muted-foreground mb-2 text-[10.5px] tracking-[0.1em] uppercase">
        {t("onboarding.model.voiceSection")}
      </div>
      <SourcePills
        testId="onboarding-voice-source"
        value={models.voiceSource === "later" ? "mac" : models.voiceSource}
        options={sourceOptions(t("onboarding.model.sources.mac"))}
        onChange={(s) => models.setVoiceSource(s)}
      />
      <div className="mt-3">
        {models.voiceSource === "mac" || models.voiceSource === "later" ? (
          <>
            <VoiceMacRows
              items={models.voiceItems}
              selectedKey={selectedVoice?.key ?? null}
              recommendedKey={models.recommendedVoice?.key}
              fit={profile?.voiceFit}
              expanded={voiceExpanded}
              onToggleExpanded={() => setVoiceExpanded((v) => !v)}
              onPick={(item) =>
                models.pickVoice({
                  engine: item.localEngine === "mlx" ? "mlx" : "whisper",
                  defId: item.defId ?? "",
                })
              }
              workerBytes={profile?.mlxWorkerBytes ?? 0}
            />
            {models.qwenWarning && (
              <p
                data-testid="onboarding-qwen-warning"
                className="mt-2 rounded-[10px] bg-amber-500/10 px-3 py-2.5 text-[12.5px] text-amber-900 dark:text-amber-200"
              >
                {t("onboarding.model.qwenWarning")}
              </p>
            )}
          </>
        ) : models.voiceSource === "server" ? (
          <ServerForm kind="voice" remote={models.voiceRemote} />
        ) : (
          <CloudForm
            kind="voice"
            remote={models.voiceRemote}
            providers={models.voiceProviders}
            modelName={voiceModel?.model_name}
          />
        )}
      </div>

      <div className="border-border mt-6 border-t pt-4">
        <div className="mono text-muted-foreground mb-1 text-[10.5px] tracking-[0.1em] uppercase">
          {t("onboarding.model.textSection")}
        </div>
        <p className="text-muted-foreground mt-0 mb-2 text-[12.5px]">
          {t("onboarding.model.textSectionDesc")}
        </p>
        <SourcePills
          testId="onboarding-text-source"
          value={models.textSource}
          options={sourceOptions(t("onboarding.model.sources.mac"))}
          onChange={(s) => models.setTextSource(s)}
        />
        <div className="mt-3">
          {models.textSource === "mac" ? (
            <TextMacRows
              items={models.llmItems}
              selectedDefId={
                models.chosenText?.defId ??
                models.recommendedText?.defId ??
                null
              }
              recommendedDefId={models.recommendedText?.defId}
              none={models.textPick === "none"}
              expanded={textExpanded}
              onToggleExpanded={() => setTextExpanded((v) => !v)}
              onPick={(pick) => {
                models.pickText(pick);
                setTextExpanded(false);
              }}
            />
          ) : models.textSource === "server" ? (
            <ServerForm kind="llm" remote={models.textRemote} />
          ) : (
            <CloudForm
              kind="llm"
              remote={models.textRemote}
              providers={models.textProviders}
              modelName={textModel?.model_name}
            />
          )}
        </div>
      </div>
      {disk}
      {errorLine}
      {nav}
    </div>
  );
}
