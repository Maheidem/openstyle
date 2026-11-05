import type { MissingModel } from "@openstyle/validations";
import { Eyebrow } from "@renderer/components/page-chrome";
import { Button } from "@renderer/components/ui/button";
import { getClient } from "@renderer/lib/api";
import { parseMissingParam } from "@renderer/lib/missing-models";
import type { WhisperModelDownloadState } from "@renderer/lib/models";
import {
  missingModelsQueryOptions,
  mlxEmbedStatusQueryOptions,
  queryKeys,
} from "@renderer/lib/query";
import { cn } from "@renderer/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import type { UseModels } from "./use-models";

/**
 * The selected models that are not on the disk, with a Download button for
 * each. It is the end of the cue chain: the sidebar badge, the page banners
 * and the Enhance card all lead here (`/settings/models?missing=<engine>:<id>`).
 * The model of that parameter has a ring and scrolls into view. The card is
 * empty, and hidden, when every selected model is on the disk.
 */
export function MissingModelsCard({
  m,
}: {
  m: UseModels;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const focus = parseMissingParam(searchParams.get("missing"));
  const { data: missing } = useQuery(missingModelsQueryOptions());
  const { data: embed } = useQuery(mlxEmbedStatusQueryOptions());
  const focusRef = useRef<HTMLDivElement | null>(null);

  const hasFocus =
    focus !== null && (missing ?? []).some((x) => isFocus(x, focus));
  useEffect(() => {
    if (hasFocus) focusRef.current?.scrollIntoView({ block: "center" });
  }, [hasFocus]);

  if (!missing || missing.length === 0) return null;

  const stateOf = (
    model: MissingModel,
  ): WhisperModelDownloadState | undefined => {
    if (model.engine === "mlx-llm") {
      return m.localLlmItems.find((row) => row.defId === model.defId)?.state;
    }
    if (model.engine === "mlx-embed") {
      return embed?.models.find((row) => row.model === model.defId);
    }
    return m.voiceItems.find(
      (row) =>
        row.defId === model.defId &&
        (model.engine === "mlx"
          ? row.localEngine === "mlx"
          : row.localEngine === "whisper"),
    )?.state;
  };

  const download = (model: MissingModel): void => {
    if (model.engine === "mlx-embed") {
      void getClient()
        .api["mlx-embed"].models[":model"].download.$post({
          param: { model: model.defId },
        })
        .then(() =>
          queryClient.invalidateQueries({ queryKey: queryKeys.mlxEmbedStatus }),
        );
      return;
    }
    m.downloadLocal(
      model.defId,
      model.engine === "mlx-llm"
        ? "mlx-llm"
        : model.engine === "mlx"
          ? "mlx"
          : undefined,
    );
  };

  return (
    <section data-testid="missing-models-card">
      <div className="mb-3">
        <Eyebrow text={t("models.missing.cardTitle")} />
      </div>
      <div className="overflow-hidden rounded-lg border border-yellow-500/35 bg-yellow-300/15 text-yellow-950 dark:border-yellow-300/35 dark:bg-yellow-400/15 dark:text-yellow-100">
        {missing.map((model, i) => {
          const state = stateOf(model);
          const busy =
            state?.status === "downloading" || state?.status === "verifying";
          const isFocused = focus !== null && isFocus(model, focus);
          return (
            <div
              key={`${model.engine}:${model.defId}`}
              ref={isFocused ? focusRef : undefined}
              data-testid="missing-model-row"
              data-model={`${model.engine}:${model.defId}`}
              className={cn(
                "flex flex-wrap items-center gap-3 px-[18px] py-[13px]",
                i > 0 &&
                  "border-t border-yellow-500/25 dark:border-yellow-300/25",
                isFocused &&
                  "ring-2 ring-inset ring-yellow-600/60 dark:ring-yellow-300/60",
              )}
            >
              <AlertTriangle className="size-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-semibold">
                  {t("models.missing.title", { name: model.name })}
                </div>
                <div className="mt-0.5 text-[12px] opacity-80">
                  {t("models.missing.desc", {
                    tasks: model.tasks
                      .map((task) => t(`models.missing.task.${task}`))
                      .join(", "),
                  })}
                </div>
                {state?.status === "error" && state.error && (
                  <div className="text-destructive mt-1 text-[12px]">
                    {state.error}
                  </div>
                )}
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => download(model)}
                data-testid="missing-model-card-download"
              >
                {busy ? (
                  <>
                    <Loader2
                      className="animate-spin"
                      data-icon="inline-start"
                    />
                    {state?.downloadProgress
                      ? `${Math.round(state.downloadProgress.percent)}%`
                      : t("models.missing.downloading")}
                  </>
                ) : (
                  t("models.missing.download")
                )}
              </Button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function isFocus(
  model: Pick<MissingModel, "engine" | "defId">,
  focus: Pick<MissingModel, "engine" | "defId">,
): boolean {
  return model.engine === focus.engine && model.defId === focus.defId;
}
