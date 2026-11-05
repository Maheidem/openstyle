import { MAX_LANGUAGES } from "@openstyle/validations";
import {
  LanguageMultiPickerDialog,
  useLanguageOptions,
} from "@renderer/components/language-combobox";
import { Button } from "@renderer/components/ui/button";
import { ArrowRight } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { StepHeading } from "./shared";
import { StepHeader } from "./step-header";

// ---------------------------------------------------------------------------
// Step 1 — Language. The pick feeds the voice model suggestion of step 2.
// ---------------------------------------------------------------------------
export function LanguageStep({
  languages,
  osLanguage,
  touched,
  counter,
  onToggle,
  onClear,
  onBack,
  onContinue,
}: {
  languages: string[];
  /** The code of the OS language when it was pre-selected, else null. */
  osLanguage: string | null;
  /** The user changed the list. The OS note then gives way to the count. */
  touched: boolean;
  counter: { index: number; total: number };
  onToggle: (id: string) => void;
  onClear: () => void;
  onBack: () => void;
  onContinue: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const options = useLanguageOptions();
  const [showAll, setShowAll] = useState(false);

  const selectedSet = useMemo(() => new Set(languages), [languages]);
  const atCap = languages.length >= MAX_LANGUAGES;

  // Show a handful of region-relevant languages as pills; the rest live behind
  // "See all". "auto" gets its own pill below, so exclude it from the top set.
  const PILL_COUNT = 12;
  const pills = useMemo(
    () => options.filter((l) => l.code !== "auto").slice(0, PILL_COUNT),
    [options],
  );

  // Selected languages picked via "See all" may fall outside the top pills;
  // surface them as extra pills so every selection stays visible.
  const selectedOutside = useMemo(
    () =>
      languages
        .filter((code) => !pills.some((l) => l.code === code))
        .map((code) => options.find((l) => l.code === code))
        .filter((l): l is (typeof options)[number] => Boolean(l)),
    [languages, pills, options],
  );

  const osLabel = options.find((l) => l.code === osLanguage)?.label;
  const note =
    !touched && osLabel
      ? t("onboarding.language.osNote", { language: osLabel })
      : languages.length === 0
        ? t("onboarding.language.autoNote")
        : t("onboarding.language.countNote", {
            count: languages.length,
            max: MAX_LANGUAGES,
          });

  return (
    <div className="w-full max-w-[560px]">
      <StepHeader
        index={counter.index}
        total={counter.total}
        label={t("onboarding.stepName.language")}
      />
      <StepHeading title={t("onboarding.language.title")} />
      <p className="text-muted-foreground -mt-3 mb-5 text-[14px] leading-relaxed">
        {t("onboarding.language.desc")}
      </p>

      <div className="flex flex-wrap gap-2">
        <Button
          variant={languages.length === 0 ? "default" : "outline"}
          size="sm"
          onClick={onClear}
          className="rounded-full px-4 text-[13.5px]"
        >
          {t("onboarding.language.autoDetect")}
        </Button>
        {pills.map((l) => {
          const active = selectedSet.has(l.code);
          return (
            <Button
              key={l.code}
              variant={active ? "default" : "outline"}
              size="sm"
              disabled={!active && atCap}
              onClick={() => onToggle(l.code)}
              className="rounded-full px-4 text-[13.5px]"
            >
              {l.label}
            </Button>
          );
        })}
        {selectedOutside.map((l) => (
          <Button
            key={l.code}
            variant="default"
            size="sm"
            onClick={() => onToggle(l.code)}
            className="rounded-full px-4 text-[13.5px]"
          >
            {l.label}
          </Button>
        ))}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowAll(true)}
          className="rounded-full px-4 text-[13.5px]"
        >
          {t("onboarding.language.seeAll") || "See all"}
        </Button>
      </div>

      <LanguageMultiPickerDialog
        open={showAll}
        onOpenChange={setShowAll}
        values={languages}
        onToggle={onToggle}
        options={options}
      />

      <p
        className="text-muted-foreground mt-3 mb-0 text-[12.5px]"
        data-testid="onboarding-language-note"
      >
        {note}
      </p>

      <div className="mt-7 flex items-center justify-between">
        <Button variant="outline" onClick={onBack}>
          {t("common.back")}
        </Button>
        <Button onClick={onContinue}>
          {t("common.continue")}
          <ArrowRight data-icon="inline-end" />
        </Button>
      </div>
    </div>
  );
}
