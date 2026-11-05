import { Button } from "@renderer/components/ui/button";
import { ArrowRight } from "lucide-react";
import { useTranslation } from "react-i18next";

const ROWS = ["language", "listen", "allow", "try"] as const;

// Step 0: say what the app does and that nothing downloads before a yes.
export function WelcomeStep({
  onStart,
}: {
  onStart: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="w-full max-w-[520px]">
      <h1 className="display text-foreground m-0 text-[40px] leading-[1.05] font-medium tracking-[-0.02em]">
        {t("onboarding.welcome.title")}
      </h1>
      <p className="text-muted-foreground mt-3 mb-0 text-[15px] leading-relaxed">
        {t("onboarding.welcome.desc")}
      </p>
      <div className="border-border bg-card mt-6 rounded-[12px] border px-5 py-4">
        <div className="text-foreground text-[14px] font-semibold">
          {t("onboarding.welcome.cardTitle")}
        </div>
        <ul className="m-0 mt-3 flex list-none flex-col gap-2 p-0">
          {ROWS.map((row) => (
            <li
              key={row}
              className="flex items-center justify-between text-[13.5px]"
            >
              <span>{t(`onboarding.welcome.rows.${row}`)}</span>
              <span className="text-muted-foreground text-[12.5px]">
                {t("onboarding.welcome.oneMinute")}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <p className="text-muted-foreground mt-4 mb-0 text-[12.5px] leading-relaxed">
        {t("onboarding.welcome.note")}
      </p>
      <div className="mt-6 flex justify-end">
        <Button onClick={onStart} data-testid="onboarding-start">
          {t("onboarding.welcome.start")}
          <ArrowRight data-icon="inline-end" />
        </Button>
      </div>
    </div>
  );
}
