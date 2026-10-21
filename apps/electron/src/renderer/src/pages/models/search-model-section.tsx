/**
 * The "Search model · On-device" group (specs/local-semantic-search.md 5.5):
 * the built-in embedding model rows with download, progress, Use and Delete,
 * in the shape of the built-in LLM rows. Use writes the setting
 * `search_embedding_model` on the server and loads the model once. The group
 * is hidden when the Mac cannot run MLX.
 */
import { getClient } from "@renderer/lib/api";
import { formatBytes, type MlxEmbedStatus } from "@renderer/lib/models";
import { mlxEmbedStatusQueryOptions, queryKeys } from "@renderer/lib/query";
import { ON_DEVICE_PHRASE } from "@renderer/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { ModelRow, type Row } from "./model-list";
import { ConfirmDialog } from "./model-modal";

type EmbedModel = MlxEmbedStatus["models"][number];

export function SearchModelSection(): React.JSX.Element | null {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data } = useQuery(mlxEmbedStatusQueryOptions());
  const [pendingDelete, setPendingDelete] = useState<EmbedModel | null>(null);
  const [deleting, setDeleting] = useState<Set<string>>(new Set());

  if (!data?.platformSupported || data.models.length === 0) return null;

  const refresh = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: queryKeys.mlxEmbedStatus });
  const models = getClient().api["mlx-embed"].models[":model"];
  const call = (p: Promise<unknown>): void => {
    void p.catch(() => {}).then(refresh);
  };

  const onDelete = async (model: string): Promise<void> => {
    setDeleting((s) => new Set(s).add(model));
    try {
      await models.$delete({ param: { model } });
    } catch {
      // The row shows the state of the next status read.
    }
    await refresh();
    setDeleting((s) => {
      const next = new Set(s);
      next.delete(model);
      return next;
    });
  };

  const worker = data.worker;
  const rows: Row[] = data.models.map((m) => {
    const loadedHere = worker.model === m.model;
    const meta =
      m.selected && loadedHere && worker.state === "starting"
        ? t("models.searchModel.loading")
        : `${t("models.onDevice")}${
            m.status !== "ready" ? ` · ${formatBytes(m.sizeBytes)}` : ""
          }`;
    return {
      key: `mlx-embed/${m.model}`,
      name: m.displayName,
      source: "local",
      meta,
      recommended: false,
      selected: m.selected && m.status === "ready",
      status: m.status,
      state: m,
      warning:
        loadedHere && worker.state === "error" && worker.error
          ? t("models.searchModel.loadFailed", { error: worker.error })
          : undefined,
      deleting: deleting.has(m.model),
      deleteWhenSelected: true,
      onSelect: () => call(models.use.$post({ param: { model: m.model } })),
      onDownload: () =>
        call(models.download.$post({ param: { model: m.model } })),
      onCancel: () => call(models.cancel.$post({ param: { model: m.model } })),
      onDelete: () => setPendingDelete(m),
      onRetry: () => call(models.download.$post({ param: { model: m.model } })),
    };
  });

  return (
    <section data-testid="search-model-section">
      <div className="border-border bg-card overflow-hidden rounded-lg border">
        <div className="border-border border-b px-5 py-3">
          <span className="text-foreground text-[13.5px] font-semibold">
            {t("models.searchModel.title")} · {t("models.onDevice")}
          </span>
          <p className="text-muted-foreground mt-0.5 text-[11.5px] leading-snug">
            {t("models.searchModel.desc")}
          </p>
        </div>
        {rows.map((row, i) => (
          <ModelRow key={row.key} row={row} first={i === 0} />
        ))}
      </div>

      {pendingDelete && (
        <ConfirmDialog
          title={t("models.deleteLocalTitle")}
          message={
            <Trans
              i18nKey="models.deleteLocalMsg"
              values={{
                name: pendingDelete.displayName,
                phrase: ON_DEVICE_PHRASE,
              }}
              components={{
                b: <span className="text-foreground/80 font-medium" />,
              }}
            />
          }
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            const { model } = pendingDelete;
            setPendingDelete(null);
            void onDelete(model);
          }}
        />
      )}
    </section>
  );
}
