import { MAX_LANGUAGES } from "@openstyle/validations";
import {
  LanguageMultiPickerDialog,
  useLanguageOptions,
} from "@renderer/components/language-combobox";
import { ModelSetupPanel } from "@renderer/components/model-setup-panel";
import { Button } from "@renderer/components/ui/button";
import type { VoiceItem } from "@renderer/lib/models";
import { ArrowRight } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

// ---------------------------------------------------------------------------
// Step 3 — Language (the model sets itself up in the background)
// ---------------------------------------------------------------------------
export function LanguageStep({
  languages,
  onToggle,
  onClear,
  localModel,
  onDownloadLocal,
  onRetryLocal,
  onBack,
  onContinue,
}: {
  languages: string[];
  onToggle: (id: string) => void;
  onClear: () => void;
  localModel: VoiceItem | undefined;
  onDownloadLocal: () => void;
  onRetryLocal: () => void;
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

  return (
    <div className="w-full max-w-[560px]">
      <h1 className="display text-foreground m-0 mb-7 text-center text-[56px] leading-[0.95] font-normal tracking-[-0.025em]">
        {t("onboarding.language.titlePrefix")}
        {t("onboarding.language.titleEmphasis")}
      </h1>

      <div className="flex flex-wrap justify-center gap-2">
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

      <ModelSetupPanel
        model={localModel}
        onDownload={onDownloadLocal}
        onRetry={onRetryLocal}
      />

      <div className="mt-7 flex items-center justify-between">
        <Button variant="outline" onClick={onBack}>
          {t("common.back")}
        </Button>
        <Button variant="ink" onClick={onContinue}>
          {t("common.continue")}
          <ArrowRight data-icon="inline-end" />
        </Button>
      </div>
    </div>
  );
}
