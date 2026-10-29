import { OWNER_NAME_MAX } from "@openstyle/validations";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { ArrowRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { StepHeading } from "./shared";

/**
 * Optional onboarding step for the owner name (setting `owner_name`).
 * Meeting transcription puts the name first in the ASR bias prompt. The
 * parent holds the field value (it survives Back) and writes the setting:
 * - Continue: `owner_name` = the trimmed name, when it changed
 * - Skip: nothing is written
 */
export function NameStep({
  name,
  onNameChange,
  onDone,
  onBack,
}: {
  name: string;
  onNameChange: (name: string) => void;
  /** The trimmed name, or null for Skip. */
  onDone: (name: string | null) => void;
  onBack: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <form
      className="w-full max-w-[520px]"
      onSubmit={(e) => {
        e.preventDefault();
        onDone(name.trim());
      }}
    >
      <StepHeading title={t("onboarding.name.title")} />
      <p className="text-muted-foreground m-0 text-[14px] leading-relaxed">
        {t("onboarding.name.desc")}
      </p>
      <Input
        className="mt-5"
        data-testid="onboarding-owner-name"
        value={name}
        maxLength={OWNER_NAME_MAX}
        autoComplete="name"
        placeholder={t("onboarding.name.placeholder")}
        aria-label={t("onboarding.name.title")}
        onChange={(e) => onNameChange(e.target.value)}
      />
      <div className="mt-7 flex items-center justify-between gap-3">
        <Button type="button" variant="outline" onClick={onBack}>
          {t("common.back")}
        </Button>
        <Button type="submit" data-testid="onboarding-name-continue">
          {t("common.continue")}
          <ArrowRight data-icon="inline-end" />
        </Button>
      </div>
      <div className="mt-3 flex justify-end">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onDone(null)}
          data-testid="onboarding-name-skip"
        >
          {t("onboarding.name.skip")}
        </Button>
      </div>
    </form>
  );
}
