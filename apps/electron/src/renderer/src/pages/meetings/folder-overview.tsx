import {
  type FolderOverview,
  folderOverviewSchema,
  type OverviewActionItem,
  type OverviewSource,
} from "@openstyle/validations";
import { getClient } from "@renderer/lib/api";
import { formatClockDuration, formatTimestamp } from "@renderer/lib/format";
import { queryKeys } from "@renderer/lib/query";
import { cn } from "@renderer/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { splitActionItems, visibleSources } from "./folder-overview-model";

// The Overview tab of a folder (issue #374, specs/folder-project-page.md).
// The server computes it from stored data on every read. The only write is
// the done mark of an action item.

function SourceLinks({
  sources,
  onOpen,
}: {
  sources: readonly OverviewSource[];
  onOpen: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const { shown, hidden } = visibleSources(sources, expanded);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
      {shown.map((s) => (
        <button
          key={s.meeting_id}
          type="button"
          data-testid="overview-source"
          onClick={() => onOpen(s.meeting_id)}
          className="text-muted-foreground hover:text-foreground max-w-[16rem] truncate rounded-sm text-[11px] underline decoration-border underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
          title={s.title || t("meetings.untitled")}
        >
          {s.title || t("meetings.untitled")}
          {s.started_at
            ? ` · ${formatTimestamp(s.started_at, i18n.language)}`
            : ""}
        </button>
      ))}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="text-muted-foreground hover:text-foreground rounded-sm text-[11px] focus-visible:outline-2 focus-visible:outline-ring"
        >
          {t("meetings.folderOverview.moreSources", { count: hidden })}
        </button>
      )}
    </span>
  );
}

function Section({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <section data-testid={testId} aria-label={title} className="mb-6">
      <h3 className="eyebrow mb-2">{title}</h3>
      {children}
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <p className="border-border text-muted-foreground rounded-lg border border-dashed px-3.5 py-3 text-[12.5px]">
      {text}
    </p>
  );
}

const card = "border-border bg-card divide-border divide-y rounded-lg border";

function ActionRow({
  item,
  busy,
  onToggle,
  onOpen,
}: {
  item: OverviewActionItem;
  busy: boolean;
  onToggle: (done: boolean) => void;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <li
      data-testid="overview-action"
      data-done={item.done}
      className="flex min-w-0 items-start gap-2.5 px-3.5 py-2.5"
    >
      <input
        type="checkbox"
        checked={item.done}
        disabled={busy}
        onChange={(event) => onToggle(event.target.checked)}
        aria-label={t(
          item.done
            ? "meetings.folderOverview.markOpen"
            : "meetings.folderOverview.markDone",
          { text: item.text },
        )}
        className="mt-0.5 size-3.5 shrink-0 accent-[var(--accent-passive-ink)]"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span
          className={cn(
            "text-[12.5px]",
            item.done && "text-muted-foreground line-through",
          )}
        >
          {item.text}
        </span>
        {(item.owner || item.due) && (
          <span className="mono text-muted-foreground text-[10.5px]">
            {[
              item.owner &&
                t("meetings.folderOverview.owner", { name: item.owner }),
              item.due && t("meetings.folderOverview.due", { when: item.due }),
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        )}
        <SourceLinks sources={item.sources} onOpen={onOpen} />
      </div>
    </li>
  );
}

function ActionItems({
  folderId,
  items,
  onOpen,
}: {
  folderId: string;
  items: readonly OverviewActionItem[];
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [showDone, setShowDone] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const { open, done } = splitActionItems(items);
  const toggle = async (key: string, value: boolean) => {
    setBusyKey(key);
    setFailed(false);
    // Show the mark at once. The refresh after the request keeps the server
    // state, also when the request fails.
    const queryKey = queryKeys.meetings.folderOverview(folderId);
    queryClient.setQueryData<FolderOverview>(
      queryKey,
      (old) =>
        old && {
          ...old,
          action_items: old.action_items.map((a) =>
            a.key === key ? { ...a, done: value } : a,
          ),
        },
    );
    try {
      const res = await getClient().api.meetings.folders[":id"]["action-items"][
        ":key"
      ].$put({ param: { id: folderId, key }, json: { done: value } });
      if (!res.ok) setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      await queryClient.invalidateQueries({ queryKey });
      setBusyKey(null);
    }
  };
  const rows = showDone ? [...open, ...done] : open;
  return (
    <Section
      title={t("meetings.folderOverview.actionsTitle")}
      testId="overview-actions"
    >
      {rows.length ? (
        <ul className={card}>
          {rows.map((item) => (
            <ActionRow
              key={item.key}
              item={item}
              busy={busyKey === item.key}
              onToggle={(value) => void toggle(item.key, value)}
              onOpen={onOpen}
            />
          ))}
        </ul>
      ) : (
        <Empty
          text={t(
            items.length
              ? "meetings.folderOverview.allDone"
              : "meetings.folderOverview.noActions",
          )}
        />
      )}
      {failed && (
        <p className="text-destructive mt-2 text-xs" role="alert">
          {t("meetings.folderOverview.markFailed")}
        </p>
      )}
      {done.length > 0 && (
        <button
          type="button"
          data-testid="overview-show-done"
          onClick={() => setShowDone(!showDone)}
          className="text-muted-foreground hover:text-foreground mt-2 rounded-sm text-xs underline decoration-border underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
        >
          {t(
            showDone
              ? "meetings.folderOverview.hideDone"
              : "meetings.folderOverview.showDone",
            { count: done.length },
          )}
        </button>
      )}
    </Section>
  );
}

function SourcedList({
  items,
  onOpen,
  testId,
}: {
  items: FolderOverview["decisions"];
  onOpen: (id: string) => void;
  testId: string;
}) {
  return (
    <ul className={card}>
      {items.map((item) => (
        <li
          key={item.text}
          data-testid={testId}
          className="flex min-w-0 flex-col gap-1 px-3.5 py-2.5"
        >
          <span className="text-[12.5px]">{item.text}</span>
          <SourceLinks sources={item.sources} onOpen={onOpen} />
        </li>
      ))}
    </ul>
  );
}

function Chips({
  items,
  testId,
}: {
  items: { name: string; meeting_count: number }[];
  testId: string;
}) {
  return (
    <ul className="flex flex-wrap gap-1.5" data-testid={testId}>
      {items.map((p) => (
        <li
          key={p.name}
          className="border-border bg-card flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px]"
        >
          {p.name}
          <span className="mono text-muted-foreground text-[10.5px] tabular-nums">
            {p.meeting_count}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function FolderOverviewView({
  folderId,
  onOpen,
}: {
  folderId: string;
  onOpen: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const { data, isError, isPending } = useQuery({
    queryKey: queryKeys.meetings.folderOverview(folderId),
    queryFn: async (): Promise<FolderOverview> => {
      const res = await getClient().api.meetings.folders[":id"].overview.$get({
        param: { id: folderId },
      });
      if (!res.ok) throw new Error("overview_failed");
      return folderOverviewSchema.parse(await res.json());
    },
  });
  if (isPending || isError) {
    return (
      <p
        className="text-muted-foreground py-5 text-xs"
        role={isError ? "alert" : undefined}
      >
        {t(
          isError
            ? "meetings.folderOverview.failed"
            : "meetings.folderOverview.loading",
        )}
      </p>
    );
  }
  const o = data;
  return (
    <div data-testid="folder-overview" className="pt-4">
      {o.last_activity && (
        <p className="text-muted-foreground mb-4 text-[11.5px]">
          {t("meetings.folderOverview.lastActivity", {
            date: formatTimestamp(o.last_activity, i18n.language),
          })}
        </p>
      )}
      {o.counts.meetings > 0 && o.counts.summarized === 0 && (
        <p
          data-testid="overview-no-summaries"
          className="border-border bg-card text-muted-foreground mb-5 rounded-lg border px-3.5 py-2.5 text-[12.5px]"
        >
          {t("meetings.folderOverview.noSummaries")}
        </p>
      )}
      <ActionItems folderId={folderId} items={o.action_items} onOpen={onOpen} />
      {o.open_questions.length > 0 && (
        <Section
          title={t("meetings.folderOverview.questionsTitle")}
          testId="overview-questions"
        >
          <SourcedList
            items={o.open_questions}
            onOpen={onOpen}
            testId="overview-question"
          />
        </Section>
      )}
      <Section
        title={t("meetings.folderOverview.decisionsTitle")}
        testId="overview-decisions"
      >
        {o.decisions.length ? (
          <SourcedList
            items={o.decisions}
            onOpen={onOpen}
            testId="overview-decision"
          />
        ) : (
          <Empty text={t("meetings.folderOverview.noDecisions")} />
        )}
      </Section>
      <Section
        title={t("meetings.folderOverview.timelineTitle")}
        testId="overview-timeline"
      >
        {o.timeline.length ? (
          <ul className={card}>
            {o.timeline.map((m) => (
              <li key={m.meeting_id} data-testid="overview-timeline-row">
                <button
                  type="button"
                  onClick={() => onOpen(m.meeting_id)}
                  className="hover:bg-accent/50 flex w-full min-w-0 flex-col gap-1 px-3.5 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <span className="truncate text-[12.5px] font-medium">
                    {m.title || t("meetings.untitled")}
                  </span>
                  <span className="mono text-muted-foreground text-[10px]">
                    {formatTimestamp(m.started_at, i18n.language)} ·{" "}
                    {formatClockDuration(m.duration_ms)}
                  </span>
                  <span
                    className={cn(
                      "text-[12px]",
                      m.gist ? "" : "text-muted-foreground italic",
                    )}
                  >
                    {m.gist ?? t("meetings.folderOverview.noGist")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <Empty text={t("meetings.folderOverview.noMeetings")} />
        )}
        {o.counts.meetings > o.timeline.length && (
          <p className="text-muted-foreground mt-2 text-xs">
            {t("meetings.folders.listLimit", {
              count: o.timeline.length,
              total: o.counts.meetings,
            })}
          </p>
        )}
      </Section>
      <Section
        title={t("meetings.folderOverview.peopleTitle")}
        testId="overview-people"
      >
        {o.people.length ? (
          <Chips items={o.people} testId="overview-people-list" />
        ) : (
          <Empty text={t("meetings.folderOverview.noPeople")} />
        )}
      </Section>
      <Section
        title={t("meetings.folderOverview.tagsTitle")}
        testId="overview-tags"
      >
        {o.tags.length ? (
          <Chips items={o.tags} testId="overview-tags-list" />
        ) : (
          <Empty text={t("meetings.folderOverview.noTags")} />
        )}
      </Section>
    </div>
  );
}
