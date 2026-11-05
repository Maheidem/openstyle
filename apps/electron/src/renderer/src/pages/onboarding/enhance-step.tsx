import { Button } from "@renderer/components/ui/button";
import { Switch } from "@renderer/components/ui/switch";
import { ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { StepHeading } from "./shared";
import { StepHeader } from "./step-header";

const RAW_PHASE_MS = 1800;
const CLEAN_PHASE_MS = 2600;

/** The clean line fades in under the raw line, then the card resets and repeats. */
function useEnhanceAnimation(running: boolean): boolean {
  const [clean, setClean] = useState(false);
  useEffect(() => {
    if (!running) {
      setClean(false);
      return;
    }
    // A reader who asked for less motion sees the end state, with no loop.
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setClean(true);
      return;
    }
    const timer = window.setTimeout(
      () => setClean((c) => !c),
      clean ? CLEAN_PHASE_MS : RAW_PHASE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [running, clean]);
  return clean;
}

// ---------------------------------------------------------------------------
// Step 6 — Enhance. On by default. One headline and a short animation. A small
// switch in the corner turns it off. One button.
// ---------------------------------------------------------------------------
export function EnhanceStep({
  counter,
  enabled,
  onToggle,
  download,
  onBack,
  onContinue,
  busy,
}: {
  counter: { index: number; total: number };
  enabled: boolean;
  onToggle: (on: boolean) => void;
  /** The text model that Continue downloads, when none is set. Null otherwise. */
  download: { name: string; size: string } | null;
  onBack: () => void;
  onContinue: () => void;
  busy: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const clean = useEnhanceAnimation(enabled);

  return (
    <div className="w-full max-w-[520px]">
      <StepHeader
        index={counter.index}
        total={counter.total}
        label={t("onboarding.stepName.enhance")}
        right={
          <div className="text-muted-foreground flex items-center gap-2 text-[12px]">
            {t("onboarding.enhance.switch")}
            <Switch
              checked={enabled}
              onCheckedChange={onToggle}
              aria-label={t("onboarding.enhance.switch")}
              data-testid="onboarding-enhance-switch"
            />
          </div>
        }
      />
      <StepHeading
        title={
          enabled
            ? t("onboarding.enhance.headOn")
            : t("onboarding.enhance.headOff")
        }
      />
      <p
        data-testid="onboarding-enhance-sub"
        className="text-muted-foreground -mt-3 mb-0 text-[14px] leading-relaxed"
      >
        {!enabled
          ? t("onboarding.enhance.subOff")
          : download
            ? t("onboarding.enhance.subDownload", download)
            : t("onboarding.enhance.subOn")}
      </p>
      <div className="border-border bg-card mt-5 rounded-[12px] border px-5 py-4">
        <div className="mono text-muted-foreground text-[10.5px] tracking-[0.1em] uppercase">
          {t("onboarding.enhance.raw")}
        </div>
        <div className="text-muted-foreground mt-0.5 text-[14px]">
          {t("onboarding.enhance.rawText")}
        </div>
        {enabled && (
          <div data-testid="onboarding-enhance-clean">
            <div className="mono mt-3.5 text-[10.5px] tracking-[0.1em] text-emerald-700 uppercase dark:text-emerald-300">
              {t("onboarding.enhance.after")}
            </div>
            <div
              className="text-foreground mt-0.5 min-h-6 text-[16px] font-medium transition-opacity duration-[600ms]"
              style={{ opacity: clean ? 1 : 0.15 }}
            >
              {t("onboarding.enhance.cleanText")}
            </div>
          </div>
        )}
      </div>
      <div className="mt-6 flex items-center justify-between gap-3">
        <Button variant="outline" onClick={onBack} disabled={busy}>
          {t("common.back")}
        </Button>
        <Button
          onClick={onContinue}
          disabled={busy}
          data-testid="onboarding-enhance-continue"
        >
          {t("common.continue")}
          <ArrowRight data-icon="inline-end" />
        </Button>
      </div>
    </div>
  );
}
