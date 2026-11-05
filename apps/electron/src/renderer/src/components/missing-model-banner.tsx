import type { ModelMissingTask } from "@openstyle/validations";
import { Button } from "@renderer/components/ui/button";
import { missingForTasks, modelsPathFor } from "@renderer/lib/missing-models";
import { missingModelsQueryOptions } from "@renderer/lib/query";
import { cn } from "@renderer/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

/**
 * The cue for a selected local model that is not on the disk. It shows one
 * banner for each missing model that one of `tasks` uses, with a button that
 * opens the Models page at that model. It shows nothing when the model is
 * there. The server only stats files, so the state is fresh and cheap.
 */
export function MissingModelBanner({
  tasks,
  className,
}: {
  tasks: readonly ModelMissingTask[];
  className?: string;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data } = useQuery(missingModelsQueryOptions());
  const missing = missingForTasks(data, tasks);
  if (missing.length === 0) return null;

  return (
    <div className={cn("mb-5 space-y-2", className)}>
      {missing.map((model) => (
        <div
          key={`${model.engine}:${model.defId}`}
          role="alert"
          data-testid="missing-model-banner"
          data-model={`${model.engine}:${model.defId}`}
          className="border-yellow-500/35 bg-yellow-300/15 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-yellow-950 dark:border-yellow-300/35 dark:bg-yellow-400/15 dark:text-yellow-100"
        >
          <div className="flex min-w-0 items-start gap-2.5">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div className="min-w-0">
              <div className="text-[13px] font-semibold">
                {t("models.missing.title", { name: model.name })}
              </div>
              <p className="mt-0.5 text-[12px] leading-snug opacity-80">
                {t("models.missing.desc", {
                  tasks: model.tasks
                    .map((task) => t(`models.missing.task.${task}`))
                    .join(", "),
                })}
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            data-testid="missing-model-download"
            onClick={() => navigate(modelsPathFor(model))}
          >
            {t("models.missing.action")}
          </Button>
        </div>
      ))}
    </div>
  );
}
