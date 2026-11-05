import { Button } from "@renderer/components/ui/button";
import { Progress } from "@renderer/components/ui/progress";
import { type DownloadSummary, minutesLeft } from "@renderer/lib/onboarding";
import { AlertTriangle, Check } from "lucide-react";
import { useTranslation } from "react-i18next";

// ---------------------------------------------------------------------------
// The footer of steps 2 to 7: the downloads that the user started. It shows
// the progress, the end, or a stop with three ways out.
// ---------------------------------------------------------------------------
export function DownloadFooter({
  summary,
  onRetry,
  onChooseOther,
  onDecideLater,
}: {
  summary: DownloadSummary;
  onRetry: () => void;
  onChooseOther: () => void;
  onDecideLater: () => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  if (summary.state === "idle") return null;
  const current = summary.current;
  const minutes = minutesLeft(summary.secondsLeft);

  return (
    <div
      className="border-border bg-card text-foreground shrink-0 border-t px-6 py-2.5 text-[12.5px]"
      data-testid="onboarding-footer"
      data-state={summary.state}
    >
      <div className="mx-auto max-w-[1100px]">
        {summary.state === "running" && current && (
          <div role="status" aria-live="polite">
            <div className="mb-1.5 flex justify-between gap-3">
              <span data-testid="onboarding-footer-text">
                {current.phase === "building_binary"
                  ? t("onboarding.footer.worker")
                  : t(`onboarding.footer.downloading.${current.kind}`, {
                      name: current.name,
                    })}{" "}
                · {summary.percent}%
              </span>
              <span>
                {minutes != null &&
                  t("onboarding.footer.minutesLeft", { count: minutes })}
              </span>
            </div>
            <Progress value={summary.percent} className="h-[6px]" />
          </div>
        )}
        {summary.state === "done" && (
          <div
            className="flex items-center gap-2 text-emerald-700 dark:text-emerald-300"
            data-testid="onboarding-footer-done"
          >
            <Check size={14} />
            <span>{t("onboarding.footer.done")}</span>
          </div>
        )}
        {summary.state === "failed" && (
          <div
            className="text-destructive flex flex-wrap items-center gap-3"
            data-testid="onboarding-footer-failed"
          >
            <AlertTriangle size={14} />
            <span>
              <strong>{t("onboarding.footer.stoppedTitle")}</strong>{" "}
              {summary.error ?? t("onboarding.footer.stopped")}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={onRetry}
              data-testid="onboarding-footer-retry"
            >
              {t("onboarding.footer.retry")}
            </Button>
            <Button size="sm" variant="outline" onClick={onChooseOther}>
              {t("onboarding.footer.chooseOther")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="underline"
              onClick={onDecideLater}
            >
              {t("onboarding.model.decideLater")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
