import {
  InputGroupAddon,
  InputGroupButton,
} from "@renderer/components/ui/input-group";
import { Eye, EyeOff } from "lucide-react";
import { useTranslation } from "react-i18next";

/**
 * Trailing show/hide ("eye") toggle for a secret `InputGroupInput`. Render it
 * as the last child of an `InputGroup`, alongside an input whose `type` is
 * driven by `revealed` (`revealed ? "text" : "password"`).
 */
function RevealToggle({
  revealed,
  onToggle,
  label,
}: {
  revealed: boolean;
  onToggle: () => void;
  /** Translated noun used in the aria-label, e.g. "API key" → "Show API key". Defaults to a generic "value". */
  label?: string;
}) {
  const { t } = useTranslation();
  return (
    <InputGroupAddon align="inline-end">
      <InputGroupButton
        size="icon-xs"
        aria-label={t(revealed ? "common.reveal.hide" : "common.reveal.show", {
          label: label ?? t("common.reveal.value"),
        })}
        onClick={onToggle}
      >
        {revealed ? <EyeOff /> : <Eye />}
      </InputGroupButton>
    </InputGroupAddon>
  );
}

export { RevealToggle };
