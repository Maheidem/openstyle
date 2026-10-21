import type { MeetingListItem } from "@openstyle/validations";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import { useCopyToClipboard } from "@renderer/hooks/use-copy-to-clipboard";
import { cn } from "@renderer/lib/utils";
import type { TFunction } from "i18next";
import { Check, Clock, Copy, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TranscriptSegment } from "./types";

// specs/meeting-speaker-naming.md §4: prefer a confirmed speakerName over the
// numbered fallback; a "Them" segment with no speakerLabel at all renders
// "Unidentified" (§3.3 amendment), never bare "Them".
export function segmentSpeakerLabel(
  seg: TranscriptSegment,
  t: TFunction,
): string {
  if (seg.speaker === "Me") return t("meetings.me");
  return (
    seg.speakerName ??
    (seg.speakerLabel
      ? t("meetings.themNumbered", { n: seg.speakerLabel })
      : t("meetings.speakerUnidentified"))
  );
}

// Everything except an active failure renders as the same plain, muted badge
// (spec: matches the approved mockup's undifferentiated `.badge` — Recorded,
// Transcribed and Summarized are not visually distinguished from each other).
export const STATUS_BADGE_VARIANT: Record<string, "destructive" | "outline"> = {
  interrupted: "destructive",
  failed: "destructive",
};

// "recording"/"transcribing" are this page's only in-progress states — the
// one spot that earns the fenced accent-live coral (spec: record / live /
// in-progress ONLY). Mirrors the mockup's `.badge.live` treatment (tinted
// background + a small dot), never reused for anything else.
export const LIVE_STATUSES = new Set(["recording", "transcribing"]);

export function StatusBadge({ status }: { status: string }): React.JSX.Element {
  const { t } = useTranslation();
  const live = LIVE_STATUSES.has(status);
  const variant = STATUS_BADGE_VARIANT[status] ?? "outline";
  return (
    <Badge
      variant={variant}
      className={cn(
        "mono h-4 shrink-0 gap-1 px-1.5 text-[9px] uppercase tracking-[0.12em]",
        variant === "outline" && !live && "text-muted-foreground",
        live &&
          "border-[color:var(--live)]/30 bg-[var(--live-tint)] text-[color:var(--live)]",
      )}
    >
      {live && (
        <span className="h-[5px] w-[5px] shrink-0 animate-pulse rounded-full bg-[var(--live)]" />
      )}
      {t(`meetings.status.${status}`, status)}
    </Badge>
  );
}

/** The label key and the percent of a running job in a list row. A job that
 * waits for the LLM lane shows "Queued" and no percent: no work has started. */
export function jobBadgeView(job: NonNullable<MeetingListItem["job"]>): {
  key: string;
  percent: number | null;
} {
  if (job.queued) return { key: "queued", percent: null };
  const percent =
    job.total > 0 ? Math.round((job.done / job.total) * 100) : null;
  if (job.phase === "diarizing") return { key: "diarize", percent };
  switch (job.kind) {
    case "retry-failed":
      return { key: "retryFailed", percent };
    case "diarize":
    case "enhance":
    case "summarize":
      return { key: job.kind, percent };
    default:
      return { key: "transcribe", percent };
  }
}

/**
 * The one line of the progress card of the detail view (issue #262): the
 * label, then " · " and the progress. A workflow run (Enhance, Summarize)
 * shows a percent, a transcription shows "done/total". The label loses its
 * end ellipsis when the progress follows it. With no progress, the label
 * stays as it is.
 */
export function jobProgressLine(
  label: string,
  progress: { done: number; total: number; workflow: boolean } | null,
): string {
  if (!progress || progress.total <= 0) return label;
  const value = progress.workflow
    ? `${Math.round((progress.done / progress.total) * 100)}%`
    : `${progress.done}/${progress.total}`;
  return `${label.replace(/(\u2026|\.\.\.)$/, "")} · ${value}`;
}

// A running job (Transcribe, Enhance, Summarize, Diarize, Retry) is an
// in-progress state too, so it uses the live badge with a spinner. The
// percent shows when the job knows its total. A queued job keeps the live
// badge but shows a static clock, because it does not move yet.
export function JobBadge({
  job,
}: {
  job: NonNullable<MeetingListItem["job"]>;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { key, percent } = jobBadgeView(job);
  const queued = key === "queued";
  const Icon = queued ? Clock : RefreshCw;
  return (
    <Badge
      variant="outline"
      data-testid="meetings-job-badge"
      data-queued={queued ? "true" : undefined}
      className="mono h-4 shrink-0 gap-1 border-[color:var(--live)]/30 bg-[var(--live-tint)] px-1.5 text-[9px] uppercase tracking-[0.12em] text-[color:var(--live)]"
    >
      <Icon className={cn("h-2.5 w-2.5 shrink-0", !queued && "animate-spin")} />
      {t(`meetings.jobBadge.${key}`)}
      {percent !== null && <span className="tabular-nums">{percent}%</span>}
    </Badge>
  );
}

export function CopyButton({
  text,
  label,
}: {
  text: string;
  label: string;
}): React.JSX.Element {
  const { copied, copy } = useCopyToClipboard();
  return (
    <Button variant="outline" size="sm" onClick={() => void copy(text)}>
      {copied ? (
        <Check data-icon="inline-start" className="text-primary" />
      ) : (
        <Copy data-icon="inline-start" />
      )}
      {label}
    </Button>
  );
}
