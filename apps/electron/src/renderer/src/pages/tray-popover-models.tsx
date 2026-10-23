import { configuredModelsQueryOptions } from "@renderer/lib/query";
import { resolveModelLabel } from "@renderer/pages/history/helpers";
import { useModelNames } from "@renderer/pages/history/use-model-names";
import { useQuery } from "@tanstack/react-query";
import { Cpu } from "lucide-react";
import { useTranslation } from "react-i18next";

// The active models line of the tray popover: the default voice model and
// the default LLM, with the names of the history chip (#309).

export function ActiveModelsLine(): React.JSX.Element | null {
  const { t } = useTranslation();
  const names = useModelNames();
  const { data: configured } = useQuery(configuredModelsQueryOptions());
  const labels = ["voice", "llm"]
    .map((type) =>
      configured?.find((m) => m.type === type && Boolean(m.is_default)),
    )
    .map((m) => resolveModelLabel(m?.model_id, names))
    .filter((label) => label !== "");
  if (labels.length === 0) return null;
  return (
    <p
      data-testid="tray-popover-models"
      className="flex items-center gap-1.5 px-0.5 text-[12px] text-muted-foreground"
    >
      <Cpu aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="sr-only">{t("trayPopover.models.label")}: </span>
      <span className="truncate" data-testid="tray-popover-models-names">
        {labels.join(" · ")}
      </span>
    </p>
  );
}
