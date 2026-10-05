import { Eyebrow } from "@renderer/components/page-chrome";
import { Button } from "@renderer/components/ui/button";
import { Switch } from "@renderer/components/ui/switch";
import type { ConfiguredModel } from "@renderer/lib/models";
import { cn } from "@renderer/lib/utils";
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { providerLabel, type ServerView } from "./server-roles";

// ---------------------------------------------------------------------------
// PairCard — the current model pair: Voice (required) + cleanup model.
// Side-by-side layout; each "Change" opens the shared model modal. The cleanup
// side owns the on/off switch for post-processing (llm_cleanup).
// ---------------------------------------------------------------------------

export function PairCard({
  voice,
  voiceCannotTranscribe,
  servers,
  llm,
  llmCleanup,
  onToggleCleanup,
  onChangeVoice,
  onChangeLlm,
  onConfigureWarming,
  onConfigureSampling,
}: {
  voice: ConfiguredModel | undefined;
  /** The default voice model is on an own server and cannot transcribe. */
  voiceCannotTranscribe: boolean;
  servers: ServerView[];
  llm: ConfiguredModel | undefined;
  llmCleanup: boolean;
  onToggleCleanup: (next: boolean) => void;
  onChangeVoice: () => void;
  onChangeLlm: () => void;
  /** When set, shows a "Configure model warming" link below the voice button. */
  onConfigureWarming?: () => void;
  /** When set, shows a sampling link below the cleanup button (local LLM only). */
  onConfigureSampling?: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <section className="border-border bg-card grid grid-cols-1 gap-6 rounded-lg border p-6 min-[820px]:grid-cols-2">
      <PairSide
        kicker={t("models.pair.transcriptionKicker")}
        modelName={voice?.model_name}
        providerName={voice ? providerLabel(voice, servers, t) : undefined}
        warning={
          voiceCannotTranscribe
            ? t("models.servers.cannotTranscribe")
            : undefined
        }
        cta={t("models.pair.changeVoiceShort")}
        ctaAriaLabel={t("models.pair.changeVoice")}
        noneLabel={t("models.pair.noneSelected")}
        onChange={onChangeVoice}
        warmingAction={
          onConfigureWarming
            ? {
                label: t("models.pair.configureWarming"),
                onClick: onConfigureWarming,
              }
            : undefined
        }
      />
      <div className="border-border border-t pt-6 min-[820px]:border-l min-[820px]:border-t-0 min-[820px]:pl-6 min-[820px]:pt-0">
        <PairSide
          kicker={t("models.pair.cleanupKicker")}
          modelName={llmCleanup ? llm?.model_name : undefined}
          providerName={
            llmCleanup && llm ? providerLabel(llm, servers, t) : undefined
          }
          cta={llm ? t("models.pair.change") : t("models.pair.pickModel")}
          noneLabel={t("models.pair.noneSelected")}
          toggle={llmCleanup}
          onToggle={onToggleCleanup}
          onChange={onChangeLlm}
          dimmed={!llmCleanup}
          paramsAction={
            onConfigureSampling
              ? {
                  label: t("models.pair.configureSampling"),
                  onClick: onConfigureSampling,
                }
              : undefined
          }
        />
      </div>
    </section>
  );
}

function PairSide({
  kicker,
  modelName,
  providerName,
  warning,
  cta,
  ctaAriaLabel,
  noneLabel,
  toggle,
  onToggle,
  onChange,
  dimmed,
  warmingAction,
  paramsAction,
}: {
  kicker: string;
  modelName: string | undefined;
  providerName: string | undefined;
  /** A problem with the selected model, shown under the provider line. */
  warning?: string;
  cta: string;
  ctaAriaLabel?: string;
  noneLabel: string;
  toggle?: boolean;
  onToggle?: (next: boolean) => void;
  onChange: () => void;
  dimmed?: boolean;
  /** Voice side only: "Configure model warming". */
  warmingAction?: { label: string; onClick: () => void };
  /** Cleanup side only: jumps to this task's row in TaskProfilesSection
   *  (specs/llm-task-profiles.md §9.5) — same bottom-link slot as
   *  `warmingAction`, just a different call site's action. */
  paramsAction?: { label: string; onClick: () => void };
}): React.JSX.Element {
  const bottomLink = warmingAction ?? paramsAction;
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "flex h-full flex-col gap-4 transition-opacity",
        dimmed && "opacity-60",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <Eyebrow text={kicker} />
        {onToggle !== undefined && (
          <Switch checked={!!toggle} onCheckedChange={onToggle} />
        )}
      </div>
      <div>
        {modelName ? (
          <div
            className="display text-foreground"
            style={{ fontSize: 32, lineHeight: 1.05 }}
          >
            {modelName}
          </div>
        ) : (
          <div
            className="display text-muted-foreground"
            style={{ fontSize: 30, lineHeight: 1.1 }}
          >
            {noneLabel}
          </div>
        )}
        {providerName && (
          <div className="text-muted-foreground mt-1.5 text-[13px]">
            {t("models.pair.via")}{" "}
            <span className="text-foreground/80 font-medium">
              {providerName}
            </span>
          </div>
        )}
        {warning && (
          <div className="text-destructive mt-2 flex items-start gap-1.5 text-[12.5px] leading-snug">
            <AlertTriangle className="mt-px size-3.5 shrink-0" />
            {warning}
          </div>
        )}
      </div>
      <div className="mt-auto flex flex-col items-start gap-2.5 pt-1">
        <Button
          variant="outline"
          size="sm"
          onClick={onChange}
          aria-label={ctaAriaLabel}
        >
          {cta}
        </Button>
        {bottomLink && (
          <Button
            variant="link"
            size="sm"
            onClick={bottomLink.onClick}
            className="text-muted-foreground h-auto px-0 text-[13px] font-normal"
          >
            {bottomLink.label}
          </Button>
        )}
      </div>
    </div>
  );
}
