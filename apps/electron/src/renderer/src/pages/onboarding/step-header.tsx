import { cn } from "@renderer/lib/utils";
import { useTranslation } from "react-i18next";

/**
 * The step counter on top of each counted screen: one segment for each step
 * and the words "Step n of m".
 */
export function StepHeader({
  index,
  total,
  label,
  right,
}: {
  index: number;
  total: number;
  /** The name of the step, already translated. */
  label: string;
  /** A control at the right end of the row (the Enhance switch). */
  right?: React.ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="mb-6 flex items-center justify-between gap-3">
      <div
        className="flex items-center gap-1.5"
        data-testid="onboarding-counter"
        data-step={index}
        data-total={total}
      >
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className={cn(
              "h-1 w-6 rounded-full",
              i + 1 <= index ? "bg-primary" : "bg-border",
            )}
          />
        ))}
        <span className="mono text-muted-foreground ml-2 text-[10.5px] tracking-[0.1em] uppercase">
          {t("onboarding.counter", { index, total, name: label })}
        </span>
      </div>
      {right}
    </div>
  );
}
