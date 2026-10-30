import { Markdown } from "@renderer/components/markdown";
import { Button } from "@renderer/components/ui/button";
import { getClient } from "@renderer/lib/api";
import { formatTimestamp } from "@renderer/lib/format";
import { queryKeys } from "@renderer/lib/query";
import { cn } from "@renderer/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { History, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * The previous summaries of a meeting (specs/meeting-folder-batch.md 5): a
 * list under the summary. A click shows one past summary, read only.
 * `current` is the time of the summary on the page: a new summary refetches
 * the list.
 */
export function SummaryVersions({
  id,
  current,
}: {
  id: string;
  current: number | null;
}) {
  const { t, i18n } = useTranslation();
  const [openId, setOpenId] = useState<number | null>(null);
  const { data, refetch } = useQuery({
    queryKey: queryKeys.meetings.summaryVersions(id),
    queryFn: async () => {
      const res = await getClient().api.meetings[":id"][
        "summary-versions"
      ].$get({ param: { id } });
      if (!res.ok) return [];
      return (await res.json()).items;
    },
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on a new summary
  useEffect(() => {
    void refetch();
  }, [current, refetch]);
  const items = data ?? [];
  if (items.length === 0) return null;
  const open = items.find((v) => v.id === openId) ?? null;
  return (
    <section
      aria-label={t("meetings.summaryVersions.title")}
      data-testid="summary-versions"
      className="border-border mt-6 border-t pt-4"
    >
      <h4 className="eyebrow mb-2 flex items-center gap-1.5">
        <History className="size-3" />
        {t("meetings.summaryVersions.title")}
      </h4>
      <ul className="flex flex-col gap-1">
        {items.map((v) => (
          <li key={v.id}>
            <button
              type="button"
              aria-pressed={v.id === openId}
              onClick={() => setOpenId(v.id === openId ? null : v.id)}
              className={cn(
                "hover:bg-accent/50 flex w-full min-w-0 items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[12px]",
                v.id === openId &&
                  "bg-[var(--accent-passive-tint)] text-[var(--accent-passive-ink)]",
              )}
            >
              <span className="mono min-w-0 truncate text-[11px]">
                {formatTimestamp(v.created_at, i18n.language)}
                {v.llm_model ? ` · ${v.llm_model}` : ""}
                {v.partial ? ` · ${t("meetings.summaryVersions.partial")}` : ""}
              </span>
              <span className="text-muted-foreground shrink-0 text-[11px]">
                {t("meetings.summaryVersions.replaced", {
                  date: formatTimestamp(v.replaced_at, i18n.language),
                })}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {open && (
        <div
          data-testid="summary-version-view"
          className="border-border bg-card/30 mt-3 rounded-lg border border-dashed px-4 py-3"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="eyebrow">
              {t("meetings.summaryVersions.readOnly")}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setOpenId(null)}
              aria-label={t("meetings.summaryVersions.close")}
            >
              <X />
            </Button>
          </div>
          <Markdown source={open.markdown ?? ""} />
        </div>
      )}
    </section>
  );
}
