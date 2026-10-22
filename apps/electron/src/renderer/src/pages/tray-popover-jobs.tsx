import type {
  JobsResponse,
  MeetingJobItem,
  ModelJobItem,
} from "@openstyle/validations";
import { getClient, initApiBase } from "@renderer/lib/api";
import { formatNumber } from "@renderer/lib/format";
import { Download, LoaderCircle, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

// The Jobs section of the tray popover (issue #317, step 2): the meeting jobs
// that run or wait, and the model downloads and loads. It reads GET /api/jobs
// only while the popover shows (`active`).

const JOBS_POLL_MS = 1500;

type MeetingKindKey = "enhance" | "summarize" | "transcribe" | "diarize";

function kindKey(kind: MeetingJobItem["kind"]): MeetingKindKey {
  if (kind === "enhance" || kind === "summarize" || kind === "diarize")
    return kind;
  return "transcribe";
}

function percentOf(done: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round(Math.min(1, done / total) * 100);
}

function gigabytes(bytes: number): string {
  return formatNumber(bytes / 1e9, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

/** Poll the jobs while `active`. Keep the last answer while hidden. */
export function useTrayJobs(active: boolean): JobsResponse | null {
  const [jobs, setJobs] = useState<JobsResponse | null>(null);
  useEffect(() => {
    if (!active) return;
    let live = true;
    const tick = async (): Promise<void> => {
      try {
        await initApiBase();
        const res = await getClient().api.jobs.$get();
        if (res.ok && live) setJobs(await res.json());
      } catch {
        // The server is not up yet. The next tick reads again.
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), JOBS_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [active]);
  return jobs;
}

function ProgressBar({
  percent,
  label,
}: {
  percent: number;
  label: string;
}): React.JSX.Element {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted"
    >
      <div
        className="h-full rounded-full bg-foreground transition-[width] duration-300"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function MeetingJobRow({ job }: { job: MeetingJobItem }): React.JSX.Element {
  const { t } = useTranslation();
  const title = job.title ?? t("trayPopover.jobs.untitled");
  const kind = kindKey(job.kind);
  const percent = job.queued ? null : percentOf(job.done, job.total);
  const text = job.queued
    ? t("trayPopover.jobs.queued", {
        kind: t(`trayPopover.jobs.kind.${kind}`),
        title,
      })
    : t(`trayPopover.jobs.running.${kind}`, { title });
  const spoken =
    percent === null
      ? t("trayPopover.jobs.openMeeting", { job: text })
      : t("trayPopover.jobs.openMeeting", { job: `${text}, ${percent}%` });
  return (
    <button
      type="button"
      data-testid="tray-popover-job"
      data-queued={job.queued ? "true" : undefined}
      onClick={() => window.api.openMeetingFromTrayPopover(job.meeting_id)}
      aria-label={spoken}
      className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left hover:bg-muted/60"
    >
      <Sparkles
        aria-hidden="true"
        className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span
            className={
              job.queued
                ? "line-clamp-2 min-w-0 flex-1 text-[13px] text-muted-foreground"
                : "line-clamp-2 min-w-0 flex-1 text-[13px]"
            }
          >
            {text}
          </span>
          {percent !== null && (
            <span className="shrink-0 text-[12px] font-semibold tabular-nums">
              {percent}%
            </span>
          )}
        </div>
        {percent !== null && <ProgressBar percent={percent} label={text} />}
      </div>
    </button>
  );
}

function ModelJobRow({ model }: { model: ModelJobItem }): React.JSX.Element {
  const { t } = useTranslation();
  const name = model.display_name;
  if (model.status === "loading") {
    const text = t("trayPopover.jobs.loading", { model: name });
    return (
      <div
        data-testid="tray-popover-model-job"
        className="flex items-center gap-2.5 px-3 py-2.5"
      >
        <LoaderCircle
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground motion-safe:animate-spin"
        />
        <span className="min-w-0 flex-1 truncate text-[13px]">{text}</span>
      </div>
    );
  }
  const total = model.download?.bytes_total || model.size_bytes;
  const done = model.download?.bytes_done ?? 0;
  const percent = Math.floor(model.download?.percent ?? 0);
  const text = t("trayPopover.jobs.downloading", { model: name });
  const detail = t("trayPopover.jobs.downloadSize", {
    done: gigabytes(done),
    total: gigabytes(total),
  });
  return (
    <div
      data-testid="tray-popover-model-job"
      className="flex items-start gap-2.5 px-3 py-2.5"
    >
      <Download
        aria-hidden="true"
        className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px]">{text}</span>
          <span className="shrink-0 text-[12px] font-semibold tabular-nums">
            {percent}%
          </span>
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
          {detail}
        </div>
        <ProgressBar percent={percent} label={`${text}, ${detail}`} />
      </div>
    </div>
  );
}

/** The Jobs section. It renders nothing when no job runs or waits. */
export function JobsSection({
  jobs,
  title,
}: {
  jobs: JobsResponse | null;
  title: React.ReactNode;
}): React.JSX.Element | null {
  const models =
    jobs?.models.filter(
      (m) => m.status === "downloading" || m.status === "loading",
    ) ?? [];
  const meetings = jobs?.meetings ?? [];
  if (meetings.length === 0 && models.length === 0) return null;
  // Running jobs first, then the queued ones.
  const ordered = [...meetings].sort(
    (a, b) => Number(a.queued !== null) - Number(b.queued !== null),
  );
  return (
    <section
      aria-labelledby="tray-popover-jobs"
      data-testid="tray-popover-jobs"
    >
      {title}
      <div className="divide-y divide-border overflow-hidden rounded-[10px] border border-border">
        {ordered.map((job) => (
          <MeetingJobRow key={job.meeting_id} job={job} />
        ))}
        {models.map((model) => (
          <ModelJobRow key={`${model.type}:${model.model}`} model={model} />
        ))}
      </div>
    </section>
  );
}
