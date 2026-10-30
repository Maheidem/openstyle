import type { MeetingBatchState, MeetingStage } from "@openstyle/validations";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog";
import { Button } from "@renderer/components/ui/button";
import { Progress } from "@renderer/components/ui/progress";
import { SegmentedControl } from "@renderer/components/ui/segmented-control";
import { getClient } from "@renderer/lib/api";
import { queryKeys } from "@renderer/lib/query";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AudioLines,
  Layers,
  type LucideIcon,
  Sparkles,
  Square,
  WandSparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { MeetingFolder } from "./folders-model";

// The batch runs of a folder (specs/meeting-folder-batch.md): the stage
// counts, the queue progress, the confirmation and the bulk bar.

export const STAGES: readonly MeetingStage[] = [
  "transcribe",
  "summarize",
  "enhance",
];

const STAGE_ICON: Record<MeetingStage, LucideIcon> = {
  transcribe: AudioLines,
  summarize: Sparkles,
  enhance: WandSparkles,
};

/** What a "Start" in the confirmation sends to POST /meetings/batch. */
export type BatchRequest =
  | { stage: MeetingStage; folder_id: string; count: number }
  | { stage: MeetingStage; meeting_ids: string[]; count: number };

/**
 * The checked ids after a click on `id` in `order` (the list order). A range
 * click sets every row from `anchor` to `id` to the new state of `id`.
 */
export function toggleSelection(
  order: readonly string[],
  checked: ReadonlySet<string>,
  anchor: string | null,
  id: string,
  range: boolean,
): Set<string> {
  const next = new Set(checked);
  const value = !checked.has(id);
  const from = anchor === null ? -1 : order.indexOf(anchor);
  const to = order.indexOf(id);
  const ids =
    range && from >= 0 && to >= 0
      ? order.slice(Math.min(from, to), Math.max(from, to) + 1)
      : [id];
  for (const each of ids) {
    if (value) next.add(each);
    else next.delete(each);
  }
  return next;
}

/** The batch queue state, its poll and its two actions. */
export function useMeetingBatch(enabled: boolean) {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: queryKeys.meetings.batch,
    queryFn: async (): Promise<MeetingBatchState> => {
      const res = await getClient().api.meetings.batch.$get();
      if (!res.ok) throw new Error("batch_load_failed");
      return res.json();
    },
    enabled,
    refetchInterval: (query) => (query.state.data?.active ? 1500 : false),
  });
  // Each step of the queue changes what the folders need: refresh the
  // counts, the lists and the open meeting.
  const step = data
    ? `${data.done}/${data.skipped}/${data.failed}/${data.cancelled}/${data.current?.meeting_id ?? ""}/${data.active}`
    : null;
  useEffect(() => {
    if (step === null) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.meetings.all });
  }, [step, queryClient]);
  const start = useCallback(
    async (request: BatchRequest): Promise<boolean> => {
      const json =
        "folder_id" in request
          ? { stage: request.stage, folder_id: request.folder_id }
          : { stage: request.stage, meeting_ids: request.meeting_ids };
      try {
        const res = await getClient().api.meetings.batch.$post({ json });
        if (res.status !== 202) return false;
        queryClient.setQueryData(queryKeys.meetings.batch, await res.json());
        return true;
      } catch {
        return false;
      }
    },
    [queryClient],
  );
  const cancel = useCallback(async () => {
    const res = await getClient().api.meetings.batch.cancel.$post();
    if (res.ok) {
      queryClient.setQueryData(queryKeys.meetings.batch, await res.json());
    }
  }, [queryClient]);
  return { state: data, start, cancel };
}

/** A key that changes when a new batch starts or the batch moves on. The
 * rail hides a finished batch until this key changes. */
export function batchKey(state: MeetingBatchState): string {
  return `${state.total}/${state.done}/${state.skipped}/${state.failed}/${state.cancelled}`;
}

/** The stage counts of a folder, with one "Run on N" button per stage. */
export function FolderStageCard({
  folder,
  onRun,
}: {
  folder: MeetingFolder;
  onRun: (stage: MeetingStage, count: number) => void;
}) {
  const { t } = useTranslation();
  const counts = folder.stage_counts;
  const nothing = STAGES.every(
    (s) => counts[s].ready === 0 && counts[s].blocked === 0,
  );
  return (
    <section
      aria-label={t("meetings.folders.batch.stagesTitle")}
      data-testid="folder-stage-card"
      className="border-border bg-card mb-5 rounded-lg border"
    >
      <h3 className="eyebrow px-3.5 pt-3">
        {t("meetings.folders.batch.stagesTitle")}
      </h3>
      {nothing ? (
        <p className="text-muted-foreground px-3.5 pt-1 pb-3 text-[12.5px]">
          {t("meetings.folders.batch.nothing")}
        </p>
      ) : (
        <ul className="divide-border divide-y">
          {STAGES.map((stage) => {
            const Icon = STAGE_ICON[stage];
            const { ready, blocked } = counts[stage];
            return (
              <li
                key={stage}
                data-testid={`folder-stage-${stage}`}
                className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5"
              >
                <Icon className="text-muted-foreground size-3.5 shrink-0" />
                <span className="min-w-24 text-[12.5px] font-medium">
                  {t(`meetings.folders.batch.stage.${stage}`)}
                </span>
                <span className="mono text-[11px] tabular-nums">
                  {t("meetings.folders.batch.needCount", { count: ready })}
                </span>
                {blocked > 0 && (
                  <span
                    className="mono text-muted-foreground text-[11px] tabular-nums"
                    title={t(
                      stage === "transcribe"
                        ? "meetings.folders.batch.blockedAudioHint"
                        : "meetings.folders.batch.blockedLlmHint",
                    )}
                  >
                    {t(
                      stage === "transcribe"
                        ? "meetings.folders.batch.blockedAudio"
                        : "meetings.folders.batch.blockedLlm",
                      { count: blocked },
                    )}
                  </span>
                )}
                <span className="flex-1" />
                <Button
                  size="xs"
                  variant="outline"
                  disabled={ready === 0}
                  onClick={() => onRun(stage, ready)}
                >
                  {t("meetings.folders.batch.run", { count: ready })}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** The confirmation before a batch starts. It says what the stage does. */
export function BatchConfirmDialog({
  request,
  autoRun,
  onConfirm,
  onClose,
}: {
  request: BatchRequest | null;
  /** The setting "run Enhance after each transcript" is on. */
  autoRun: boolean;
  onConfirm: (request: BatchRequest) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const selection = request !== null && "meeting_ids" in request;
  const stageName = request
    ? t(`meetings.folders.batch.stage.${request.stage}`)
    : "";
  const lines = !request
    ? []
    : request.stage === "transcribe"
      ? [
          "meetings.folders.batch.explain.transcribe",
          ...(autoRun ? ["meetings.folders.batch.explain.transcribeAuto"] : []),
          "meetings.folders.batch.explain.names",
        ]
      : [`meetings.folders.batch.explain.${request.stage}`];
  return (
    <AlertDialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogContent data-testid="batch-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t(
              selection
                ? "meetings.folders.batch.confirmSelectedTitle"
                : "meetings.folders.batch.confirmTitle",
              { stage: stageName },
            )}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p className="text-foreground font-medium">
                {t("meetings.folders.batch.confirmCount", {
                  count: request?.count ?? 0,
                })}
              </p>
              {lines.map((key) => (
                <p key={key}>{t(key)}</p>
              ))}
              {selection && <p>{t("meetings.folders.batch.explain.rerun")}</p>}
              <p>{t("meetings.folders.batch.queueNote")}</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("meetings.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              if (request) onConfirm(request);
            }}
          >
            {t("meetings.folders.batch.start")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The skip and fail reasons as one line: "no audio: 1 · run failed: 2". */
function reasonLine(
  state: MeetingBatchState,
  t: (key: string) => string,
): string {
  const line = (
    reasons: Record<string, number | undefined>,
    text: (reason: string) => string,
  ) =>
    Object.entries(reasons)
      .filter(([, n]) => (n ?? 0) > 0)
      .map(([reason, n]) => `${text(reason).replace(/\.$/, "")}: ${n}`);
  return [
    ...line(state.skip_reasons, (r) =>
      t(`meetings.folders.batch.skipReason.${r}`),
    ),
    // A failure kind has its text under meetings.llmError. The two generic
    // reasons have theirs under the batch keys.
    ...line(state.fail_reasons, (r) =>
      r === "run_failed" || r === "partly_done"
        ? t(`meetings.folders.batch.failReason.${r}`)
        : t(`meetings.llmError.${r}`),
    ),
  ].join(" · ");
}

/** The progress of the batch queue: n of N, the meeting in work, Cancel. */
export function BatchProgressCard({
  state,
  onCancel,
  onClose,
}: {
  state: MeetingBatchState;
  onCancel: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const finished = state.done + state.skipped + state.failed + state.cancelled;
  const stage = state.current?.stage ?? state.pending[0]?.stage ?? null;
  const reasons = reasonLine(state, t);
  return (
    <section
      aria-label={t("meetings.folders.batch.progressLabel")}
      data-testid="batch-progress"
      className="border-border bg-card mb-4 rounded-lg border px-3 py-2.5 text-[12px]"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Layers className="text-muted-foreground size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-semibold">
          {state.active && stage
            ? t("meetings.folders.batch.progressTitle", {
                stage: t(`meetings.folders.batch.stage.${stage}`),
              })
            : t("meetings.folders.batch.finished")}
        </span>
        <span className="mono text-muted-foreground text-[11px] tabular-nums">
          {t("meetings.folders.batch.progress", {
            done: finished,
            total: state.total,
          })}
        </span>
        {!state.active && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onClose}
            aria-label={t("meetings.folders.batch.close")}
          >
            <X />
          </Button>
        )}
      </div>
      <Progress
        className="mt-2"
        value={state.total > 0 ? (finished / state.total) * 100 : 0}
      />
      {state.current && (
        <p className="mt-2 min-w-0 truncate">
          {t("meetings.folders.batch.now", {
            title: state.current.title || t("meetings.untitled"),
          })}
        </p>
      )}
      <p className="text-muted-foreground mt-1">
        {[
          state.pending.length > 0 &&
            t("meetings.folders.batch.waiting", {
              count: state.pending.length,
            }),
          t("meetings.folders.batch.doneCount", { count: state.done }),
          state.skipped > 0 &&
            t("meetings.folders.batch.skipped", { count: state.skipped }),
          state.failed > 0 &&
            t("meetings.folders.batch.failed", { count: state.failed }),
          state.cancelled > 0 &&
            t("meetings.folders.batch.cancelledCount", {
              count: state.cancelled,
            }),
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {reasons && (
        <p className="text-muted-foreground mt-1 text-[11px]">{reasons}</p>
      )}
      {state.active && (
        <>
          <p className="text-muted-foreground mt-1 text-[11px]">
            {t("meetings.folders.batch.memoryNote")}
          </p>
          <Button
            variant="outline"
            size="xs"
            className="mt-2"
            onClick={onCancel}
            data-testid="batch-cancel"
          >
            <Square />
            {t("meetings.folders.batch.cancel")}
          </Button>
        </>
      )}
    </section>
  );
}

/** The bar of the selection mode: count, stage picker, Run. */
export function MeetingBulkBar({
  count,
  total,
  stage,
  onStage,
  onRun,
  onSelectAll,
  onClear,
  onDone,
}: {
  count: number;
  total: number;
  stage: MeetingStage;
  onStage: (stage: MeetingStage) => void;
  onRun: () => void;
  onSelectAll: () => void;
  onClear: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="toolbar"
      aria-label={t("meetings.folders.batch.bulkLabel")}
      data-testid="meeting-bulk-bar"
      className="border-border bg-card sticky bottom-2 z-10 mb-5 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 shadow-(--shadow-card)"
    >
      <span className="mono text-[11px] font-semibold tabular-nums">
        {t("meetings.folders.batch.selectedCount", { count })}
      </span>
      <Button
        variant="ghost"
        size="xs"
        onClick={count === total ? onClear : onSelectAll}
      >
        {t(
          count === total
            ? "meetings.folders.batch.clearSelection"
            : "meetings.folders.batch.selectAll",
        )}
      </Button>
      <span className="flex-1" />
      <SegmentedControl
        size="sm"
        value={stage}
        onValueChange={(v) => onStage(v as MeetingStage)}
        options={STAGES.map((s) => ({
          value: s,
          label: t(`meetings.folders.batch.stage.${s}`),
          icon: STAGE_ICON[s],
        }))}
      />
      <Button size="xs" disabled={count === 0} onClick={onRun}>
        {t("meetings.folders.batch.runSelected")}
      </Button>
      <Button variant="ghost" size="xs" onClick={onDone}>
        {t("meetings.folders.batch.selectDone")}
      </Button>
    </div>
  );
}
