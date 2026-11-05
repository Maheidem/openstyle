import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";
import { ArrowRight, Check } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface ReadyChip {
  id: string;
  label: string;
  /** "ok" is green. "warn" is amber (a download still runs, or not tested). */
  tone: "ok" | "warn";
}

// ---------------------------------------------------------------------------
// Step 7 — Ready. One screen, green chips for what is set, one button.
// ---------------------------------------------------------------------------
export function ReadyStep({
  chips,
  line,
  onFinish,
}: {
  chips: ReadyChip[];
  /** The one line under the title. */
  line: string;
  onFinish: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div
      className="w-full max-w-[520px] text-center"
      data-testid="onboarding-ready"
    >
      <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
        <Check size={30} strokeWidth={2.5} />
      </div>
      <h1 className="display text-foreground m-0 text-[32px] leading-[1.1] font-medium">
        {t("onboarding.ready.title")}
      </h1>
      <p
        className="text-muted-foreground mt-2 mb-0 text-[14px] leading-relaxed"
        data-testid="onboarding-ready-line"
      >
        {line}
      </p>
      <div
        className="mt-5 flex flex-wrap justify-center gap-2"
        data-testid="onboarding-ready-chips"
      >
        {chips.map((chip) => (
          <span
            key={chip.id}
            data-testid={`onboarding-chip-${chip.id}`}
            data-tone={chip.tone}
            className={cn(
              "mono rounded-[6px] px-2.5 py-1 text-[11px] tracking-[0.08em] uppercase",
              chip.tone === "ok"
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                : "bg-amber-500/15 text-amber-800 dark:text-amber-300",
            )}
          >
            {chip.label}
          </span>
        ))}
      </div>
      <div className="mt-7 flex justify-center">
        <Button onClick={onFinish} data-testid="onboarding-finish">
          {t("onboarding.ready.open")}
          <ArrowRight data-icon="inline-end" />
        </Button>
      </div>
    </div>
  );
}
