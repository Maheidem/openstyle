import type {
  LlmCallSummary,
  LlmLinkInfo,
  LlmRunInfo,
  LlmStepInfo,
} from "@openstyle/validations";
import { InlineNotice } from "@renderer/components/inline-notice";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import { formatTimestamp } from "@renderer/lib/format";
import { llmCallsQueryOptions, llmRunsQueryOptions } from "@renderer/lib/query";
import { cn } from "@renderer/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronLeft, CircleSlash, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type InspectedSegment,
  LlmCallView,
  QueryState,
} from "./llm-call-view";
import {
  errorTextKey,
  failureCall,
  failureEntries,
  isCurrentLink,
  linkBadgeKey,
  missingCalls,
  producingCall,
  reduceNeedsDetail,
  skipReasonKey,
  stepLabel,
  verdictTextKey,
} from "./llm-inspector-model";
import { nodeLabelKey } from "./run-notice";

// The LLM inspector panel (specs/meeting-enhance-agentic.md 8.5 to 8.8). It is
// a non-modal overlay at the bottom of the meeting detail pane. The parent
// mounts it in advanced mode only, so none of its queries run otherwise.

/** What opened the panel (8.5). */
export type InspectorTarget =
  | { kind: "runs" }
  | { kind: "run"; runId: string }
  | { kind: "segment"; segmentId: string }
  | { kind: "speaker"; label: string }
  | { kind: "summary" };

/** The view that a list opened inside the panel (Call view, or the calls of one step). */
type OpenView =
  | { kind: "call"; callId: number }
  | { kind: "step"; runId: string; step: LlmStepInfo };

/** The summary of the meeting, for the header of the Summary view (8.7). */
export interface InspectorSummaryInfo {
  provider: string | null;
  model: string | null;
  costUsd: number | null;
}

function targetKey(target: InspectorTarget): string {
  return JSON.stringify(target);
}

type TFn = ReturnType<typeof useTranslation>["t"];

/** The text of a step key: "Single", "Map 3", "Reduce", "Chunk 4" (8.7 Summary view). */
function stepText(t: TFn, key: string, withDetail: boolean): string {
  const label = stepLabel(key);
  switch (label.kind) {
    case "single":
      return t("meetings.inspector.node.single");
    case "map":
      return t("meetings.inspector.node.map", { n: label.n });
    case "reduce":
      return withDetail
        ? t("meetings.inspector.node.reduceAt", {
            level: label.level,
            group: label.group,
          })
        : t("meetings.inspector.node.reduce");
    case "chunk":
      return t("meetings.inspector.node.chunk", { n: label.n });
    default:
      return label.key;
  }
}

function nodeText(t: TFn, node: string): string {
  const key = nodeLabelKey(node);
  return key ? t(key) : node;
}

function StatusBadge({
  group,
  status,
}: {
  group: "runStatus" | "stepStatus";
  status: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const bad = status === "failed" || status === "interrupted";
  return (
    <Badge
      variant={bad ? "destructive" : "outline"}
      className="mono h-4 shrink-0 px-1.5 text-[9px] uppercase tracking-[0.12em]"
    >
      {t(`meetings.inspector.${group}.${status}`, {
        defaultValue: t(`meetings.inspector.${group}.unknown`),
      })}
    </Badge>
  );
}

/** A full-width row button of a list. */
function RowButton({
  onClick,
  testId,
  selected,
  children,
}: {
  onClick: () => void;
  testId?: string;
  selected?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={cn(
        "border-border hover:bg-muted flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-2.5 py-1.5 text-left text-[12px]",
        selected && "bg-accent",
      )}
    >
      {children}
    </button>
  );
}

function SectionTitle({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <h3 className="text-muted-foreground m-0 mb-1.5 text-[11px] font-medium">
      {children}
    </h3>
  );
}

function RecordLost({ run }: { run: LlmRunInfo }): React.JSX.Element | null {
  const { t } = useTranslation();
  if (run.lostRecords <= 0) return null;
  return (
    <p
      className="text-muted-foreground m-0 mb-2 text-[12px]"
      data-testid="meetings-inspector-record-lost"
    >
      {t("meetings.inspector.recordLost", { n: run.lostRecords })}
    </p>
  );
}

function StepRow({
  step,
  onClick,
}: {
  step: LlmStepInfo;
  onClick: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const gap = missingCalls(step);
  return (
    <RowButton onClick={onClick} testId="meetings-inspector-step">
      <span>{nodeText(t, step.node)}</span>
      <span className="mono text-muted-foreground">
        {stepText(t, step.key, true)}
      </span>
      <StatusBadge group="stepStatus" status={step.status} />
      <span className="mono text-muted-foreground tabular-nums">
        {step.attempts}
      </span>
      {step.status === "skipped" ? (
        // A skip is not an error (issue #300): a neutral reason text.
        <span
          className="text-muted-foreground"
          data-testid="meetings-inspector-skip-reason"
        >
          {t(skipReasonKey(step.skipReason))}
        </span>
      ) : (
        step.errorKind && (
          <span className="text-destructive">
            {t(errorTextKey(step.errorKind))}
          </span>
        )
      )}
      {gap > 0 && (
        <span className="text-muted-foreground">
          {t("meetings.inspector.recordedGap", { missing: gap })}
        </span>
      )}
    </RowButton>
  );
}

function RunsView({
  meetingId,
  polling,
  onTarget,
  onOpenStep,
}: {
  meetingId: string;
  polling: boolean;
  onTarget: (target: InspectorTarget) => void;
  onOpenStep: (runId: string, step: LlmStepInfo) => void;
}): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const query = useQuery(llmRunsQueryOptions(meetingId, undefined, polling));
  const runs = query.data?.runs ?? [];
  const failures = failureEntries(runs);
  if (!query.data) {
    return (
      <QueryState
        loading={query.isPending}
        failed={query.isError}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (runs.length === 0) {
    return (
      <p
        className="text-muted-foreground m-0 text-[12px]"
        data-testid="meetings-inspector-no-runs"
      >
        {t("meetings.inspector.noRuns")}
      </p>
    );
  }
  return (
    <div>
      {failures.length > 0 && (
        <div className="mb-3" data-testid="meetings-inspector-failures">
          <SectionTitle>{t("meetings.inspector.failures")}</SectionTitle>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {failures.map((f) => (
              <li key={`${f.run.id}:${f.step.key}`}>
                <StepRow
                  step={f.step}
                  onClick={() => onOpenStep(f.run.id, f.step)}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
      <SectionTitle>{t("meetings.inspector.runs")}</SectionTitle>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {runs.map((run) => (
          <li key={run.id}>
            <RecordLost run={run} />
            <RowButton
              testId="meetings-inspector-run"
              onClick={() => onTarget({ kind: "run", runId: run.id })}
            >
              <span>{t(`meetings.inspector.runKind.${run.kind}`)}</span>
              <StatusBadge group="runStatus" status={run.status} />
              <span className="mono text-muted-foreground tabular-nums">
                {formatTimestamp(run.startedAt, i18n.language)}
              </span>
              <span className="mono text-muted-foreground tabular-nums">
                {t("meetings.inspector.runCalls", { count: run.callCount })}
              </span>
            </RowButton>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RunView({
  meetingId,
  runId,
  polling,
  onOpenStep,
}: {
  meetingId: string;
  runId: string;
  polling: boolean;
  onOpenStep: (runId: string, step: LlmStepInfo) => void;
}): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const query = useQuery(llmRunsQueryOptions(meetingId, runId, polling));
  const run = query.data?.runs[0];
  if (!run) {
    return (
      <QueryState
        loading={query.isPending}
        failed={query.isError}
        onRetry={() => void query.refetch()}
      />
    );
  }
  const steps = [...run.steps].sort((a, b) => a.seq - b.seq);
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
        <span>{t(`meetings.inspector.runKind.${run.kind}`)}</span>
        <StatusBadge group="runStatus" status={run.status} />
        <span className="mono text-muted-foreground tabular-nums">
          {formatTimestamp(run.startedAt, i18n.language)}
        </span>
        <span className="mono text-muted-foreground tabular-nums">
          {t("meetings.inspector.runCalls", { count: run.callCount })}
        </span>
      </div>
      {run.errorKind && (
        <InlineNotice tone="destructive" icon={AlertTriangle} className="mb-3">
          <span>{t(errorTextKey(run.errorKind))}</span>
        </InlineNotice>
      )}
      <RecordLost run={run} />
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {steps.map((step) => (
          <li key={step.key}>
            <StepRow step={step} onClick={() => onOpenStep(run.id, step)} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The calls of one step: the Call view of its last attempt (for a partial step,
 * of the first failed half). A step with no call row shows its own error (8.7).
 */
function StepCallView({
  meetingId,
  runId,
  step,
  polling,
  segment,
  onSelectCall,
}: {
  meetingId: string;
  runId: string;
  step: LlmStepInfo;
  polling: boolean;
  segment?: InspectedSegment;
  onSelectCall: (callId: number) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const query = useQuery(
    llmCallsQueryOptions(
      meetingId,
      { run_id: runId, step_key: step.key, detail: "summary" },
      polling,
    ),
  );
  if (!query.data) {
    return (
      <QueryState
        loading={query.isPending}
        failed={query.isError}
        onRetry={() => void query.refetch()}
      />
    );
  }
  const pick = failureCall(query.data.calls);
  if (pick) {
    return (
      <LlmCallView
        meetingId={meetingId}
        callId={pick.id}
        segment={segment}
        polling={polling}
        onSelectCall={onSelectCall}
      />
    );
  }
  return (
    <div data-testid="meetings-inspector-step-error">
      <p className="mono text-muted-foreground m-0 mb-2 text-[11px]">
        {step.key} · {step.node}
      </p>
      {step.status === "skipped" ? (
        <InlineNotice
          tone="neutral"
          icon={CircleSlash}
          iconClassName="text-muted-foreground"
          className="mb-3"
        >
          <span data-testid="meetings-inspector-skip-reason">
            {t(skipReasonKey(step.skipReason))}
          </span>
        </InlineNotice>
      ) : step.errorKind ? (
        <InlineNotice tone="destructive" icon={AlertTriangle} className="mb-3">
          <span className="flex min-w-0 flex-col gap-1">
            <span>{t(errorTextKey(step.errorKind))}</span>
            {step.errorDetail && (
              <span className="mono break-words text-[11px]">
                {step.errorDetail}
              </span>
            )}
          </span>
        </InlineNotice>
      ) : (
        <p className="text-muted-foreground m-0 text-[12px]">
          {t("meetings.inspector.stepNoCall")}
        </p>
      )}
    </div>
  );
}

/** The edit of one segment: the call that produced it, or `noRecord` (8.12). */
function SegmentView({
  meetingId,
  segmentId,
  segmentText,
  callId,
  polling,
  onSelectCall,
}: {
  meetingId: string;
  segmentId: string;
  segmentText: string;
  callId: number | null;
  polling: boolean;
  onSelectCall: (callId: number) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const query = useQuery(
    llmCallsQueryOptions(
      meetingId,
      { target_type: "segment", target_id: segmentId, detail: "summary" },
      polling,
    ),
  );
  if (!query.data) {
    return (
      <QueryState
        loading={query.isPending}
        failed={query.isError}
        onRetry={() => void query.refetch()}
      />
    );
  }
  const producing = producingCall(query.data.calls, segmentId);
  const shownId = callId ?? producing?.id ?? null;
  if (shownId === null) {
    return (
      <p
        className="text-muted-foreground m-0 text-[12px]"
        data-testid="meetings-inspector-no-record"
      >
        {t("meetings.inspector.noRecord")}
      </p>
    );
  }
  return (
    <LlmCallView
      meetingId={meetingId}
      callId={shownId}
      segment={{ id: segmentId, text: segmentText }}
      polling={polling}
      onSelectCall={onSelectCall}
    />
  );
}

function SpeakerLinkRow({
  call,
  link,
  currentSuggestion,
  onSelectCall,
}: {
  call: LlmCallSummary;
  link: LlmLinkInfo | null;
  currentSuggestion: string | null;
  onSelectCall: (callId: number) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const verdict = link?.verdict ?? null;
  const name = verdict?.finalName ?? verdict?.proposedName ?? link?.appliedText;
  const dropped = link?.outcome === "dropped";
  const reason = link?.reason ?? verdict?.reason ?? null;
  return (
    <div
      className="border-border rounded-md border px-2.5 py-1.5 text-[12px]"
      data-testid="meetings-inspector-speaker-row"
      data-outcome={link?.outcome ?? "none"}
    >
      <button
        type="button"
        onClick={() => onSelectCall(call.id)}
        className="hover:bg-muted flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded text-left"
      >
        <span className="mono text-muted-foreground">
          {stepText(t, call.stepKey, false)}
        </span>
        {name && <span className="font-medium">{name}</span>}
        {verdict && (
          <span className="text-muted-foreground">
            {t(`meetings.inspector.kind.${verdict.proposedKind}`)}
          </span>
        )}
        {link && linkBadgeKey(link.outcome) && (
          <Badge variant="outline" className="shrink-0">
            {t(linkBadgeKey(link.outcome) as string)}
          </Badge>
        )}
        {link && isCurrentLink(link, currentSuggestion) && (
          <Badge variant="outline" className="shrink-0">
            {t("meetings.inspector.current")}
          </Badge>
        )}
        {call.errorKind && (
          <span className="text-destructive">
            {t(errorTextKey(call.errorKind))}
          </span>
        )}
      </button>
      {verdict?.quote && (
        <p className="mono text-muted-foreground m-0 mt-1 break-words text-[11px]">
          {verdict.quote}
        </p>
      )}
      {dropped && reason && (
        <p className="m-0 mt-1">{t(verdictTextKey(reason))}</p>
      )}
      {!dropped && verdict?.evidenceType && (
        <p className="m-0 mt-1">{t(verdictTextKey(verdict.evidenceType))}</p>
      )}
      {verdict?.respelledFrom && verdict.finalName && (
        <p className="m-0 mt-1">
          {t("meetings.inspector.respelled", { name: verdict.finalName })}
        </p>
      )}
      {verdict?.winnerCallId != null && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 h-6 px-1 text-[11px]"
          onClick={() => onSelectCall(verdict.winnerCallId as number)}
        >
          {t("meetings.inspector.winnerCall")}
        </Button>
      )}
    </div>
  );
}

/** The proposals of the producing run for one speaker label, kept and dropped (8.7). */
function SpeakerView({
  meetingId,
  label,
  currentSuggestion,
  polling,
  onSelectCall,
}: {
  meetingId: string;
  label: string;
  currentSuggestion: string | null;
  polling: boolean;
  onSelectCall: (callId: number) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const query = useQuery(
    llmCallsQueryOptions(
      meetingId,
      { target_type: "speaker", target_id: label, detail: "summary" },
      polling,
    ),
  );
  if (!query.data) {
    return (
      <QueryState
        loading={query.isPending}
        failed={query.isError}
        onRetry={() => void query.refetch()}
      />
    );
  }
  const calls = query.data.calls;
  if (calls.length === 0) {
    return (
      <p
        className="text-muted-foreground m-0 text-[12px]"
        data-testid="meetings-inspector-no-record"
      >
        {t("meetings.inspector.noRecord")}
      </p>
    );
  }
  const stale = calls.some((c) => c.links.some((l) => l.staleLabels));
  return (
    <div className="grid gap-1">
      {stale && (
        <p className="text-muted-foreground m-0 mb-1 text-[12px]">
          {t("meetings.inspector.speakerLabelNote")}
        </p>
      )}
      {calls.flatMap((call) =>
        (call.links.length > 0 ? call.links : [null]).map((link) => (
          <SpeakerLinkRow
            key={`${call.id}:${link?.id ?? "none"}`}
            call={call}
            link={link}
            currentSuggestion={currentSuggestion}
            onSelectCall={onSelectCall}
          />
        )),
      )}
    </div>
  );
}

/** The calls of the run that made the current summary (8.7). */
function SummaryView({
  meetingId,
  summary,
  polling,
  onSelectCall,
}: {
  meetingId: string;
  summary: InspectorSummaryInfo | null;
  polling: boolean;
  onSelectCall: (callId: number) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const query = useQuery(
    llmCallsQueryOptions(
      meetingId,
      { target_type: "summary", detail: "summary" },
      polling,
    ),
  );
  if (!query.data) {
    return (
      <QueryState
        loading={query.isPending}
        failed={query.isError}
        onRetry={() => void query.refetch()}
      />
    );
  }
  const calls = query.data.calls;
  if (calls.length === 0) {
    return (
      <p
        className="text-muted-foreground m-0 text-[12px]"
        data-testid="meetings-inspector-no-record"
      >
        {t("meetings.inspector.noRecord")}
      </p>
    );
  }
  const withDetail = reduceNeedsDetail(calls.map((c) => c.stepKey));
  return (
    <div>
      <dl className="m-0 mb-3 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-0.5 text-[12px]">
        <dt className="text-muted-foreground">
          {t("meetings.inspector.field.provider")}
        </dt>
        <dd className="mono m-0">{summary?.provider ?? "-"}</dd>
        <dt className="text-muted-foreground">
          {t("meetings.inspector.field.model")}
        </dt>
        <dd className="mono m-0 break-words">{summary?.model ?? "-"}</dd>
        <dt className="text-muted-foreground">
          {t("meetings.inspector.field.cost")}
        </dt>
        <dd className="mono m-0 tabular-nums">
          {summary?.costUsd != null ? `$${summary.costUsd.toFixed(4)}` : "-"}
        </dd>
      </dl>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {calls.map((call) => (
          <li key={call.id}>
            <RowButton
              testId="meetings-inspector-summary-call"
              onClick={() => onSelectCall(call.id)}
            >
              <span>{stepText(t, call.stepKey, withDetail)}</span>
              {call.stepKey.includes("/") && (
                <span className="mono text-muted-foreground">
                  {call.stepKey}
                </span>
              )}
              <span className="mono text-muted-foreground tabular-nums">
                {t("meetings.inspector.attemptN", { n: call.attempt })}
              </span>
              <span className="mono text-muted-foreground">
                {call.finishUnified ?? "-"}
              </span>
              {call.errorKind && (
                <span className="text-destructive">
                  {t(errorTextKey(call.errorKind))}
                </span>
              )}
            </RowButton>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** How long a clicked row keeps scrolling above a growing panel. */
const SETTLE_MS = 1500;

const VIEW_TITLE_KEY: Record<InspectorTarget["kind"], string> = {
  runs: "meetings.inspector.viewRuns",
  run: "meetings.inspector.viewRun",
  segment: "meetings.inspector.viewCall",
  speaker: "meetings.inspector.viewSpeaker",
  summary: "meetings.inspector.viewSummary",
};

/** Find the nearest ancestor that scrolls vertically. */
function scrollParentOf(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

export function LlmInspectorPanel({
  meetingId,
  target,
  onTarget,
  onClose,
  polling,
  segmentText,
  currentSuggestion,
  summary,
}: {
  meetingId: string;
  target: InspectorTarget;
  onTarget: (target: InspectorTarget) => void;
  onClose: () => void;
  /** A job runs: open queries refetch every 2 s (8.5). */
  polling: boolean;
  /** The raw text of the clicked segment (Change block). */
  segmentText: string;
  /** The current suggestion of the inspected speaker label ("Current" mark). */
  currentSuggestion: string | null;
  summary: InspectorSummaryInfo | null;
}): React.JSX.Element {
  const { t } = useTranslation();
  const asideRef = useRef<HTMLElement>(null);
  const key = targetKey(target);
  const [opened, setOpened] = useState<{ key: string; view: OpenView } | null>(
    null,
  );
  // A list opens a view; a new target drops it.
  const open = opened && opened.key === key ? opened.view : null;
  const setOpen = (view: OpenView | null): void =>
    setOpened(view ? { key, view } : null);

  // The panel is non-modal: Escape closes it and focus goes back to the
  // control that opened it. A dialog on top keeps its own Escape.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) {
        return;
      }
      closeRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  // The scroll container keeps the panel height as bottom padding, so
  // `scrollIntoView` leaves a row above the panel (8.6). The panel grows while
  // its data loads, so a clicked row scrolls again for a short time after it
  // opens. The row wrapper has `display: contents` and no box, so the scroll
  // goes to its text.
  const segmentId = target.kind === "segment" ? target.segmentId : null;
  useEffect(() => {
    const aside = asideRef.current;
    if (!aside) return;
    const scroller = scrollParentOf(aside);
    const previous = scroller?.style.scrollPaddingBottom ?? "";
    const settleUntil = Date.now() + SETTLE_MS;
    const showRow = (): void => {
      if (segmentId === null) return;
      document
        .querySelector(`[data-segment-id="${CSS.escape(segmentId)}"] p`)
        ?.scrollIntoView({ block: "nearest" });
    };
    const apply = (): void => {
      if (scroller) {
        // A sticky box stops at the padding of its scroll container, not at
        // its edge, so the panel height and that padding both stay covered.
        const pad = Number.parseFloat(getComputedStyle(scroller).paddingBottom);
        scroller.style.scrollPaddingBottom = `${aside.offsetHeight + (Number.isNaN(pad) ? 0 : pad)}px`;
      }
      if (Date.now() < settleUntil) showRow();
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(aside);
    return () => {
      observer.disconnect();
      if (scroller) scroller.style.scrollPaddingBottom = previous;
    };
  }, [segmentId]);

  // A click on edited text opens the Call view with no view behind it.
  const canBack =
    target.kind !== "segment" && (open !== null || target.kind === "run");
  const onBack = (): void => {
    if (open !== null) setOpen(null);
    else onTarget({ kind: "runs" });
  };
  const openCall = (callId: number): void => setOpen({ kind: "call", callId });
  const openStep = (runId: string, step: LlmStepInfo): void =>
    setOpen({ kind: "step", runId, step });

  let body: React.ReactNode;
  if (target.kind === "segment") {
    body = (
      <SegmentView
        meetingId={meetingId}
        segmentId={target.segmentId}
        segmentText={segmentText}
        callId={open?.kind === "call" ? open.callId : null}
        polling={polling}
        onSelectCall={openCall}
      />
    );
  } else if (open?.kind === "call") {
    body = (
      <LlmCallView
        meetingId={meetingId}
        callId={open.callId}
        polling={polling}
        onSelectCall={openCall}
      />
    );
  } else if (open?.kind === "step") {
    body = (
      <StepCallView
        meetingId={meetingId}
        runId={open.runId}
        step={open.step}
        polling={polling}
        onSelectCall={openCall}
      />
    );
  } else if (target.kind === "runs") {
    body = (
      <RunsView
        meetingId={meetingId}
        polling={polling}
        onTarget={onTarget}
        onOpenStep={openStep}
      />
    );
  } else if (target.kind === "run") {
    body = (
      <RunView
        meetingId={meetingId}
        runId={target.runId}
        polling={polling}
        onOpenStep={openStep}
      />
    );
  } else if (target.kind === "speaker") {
    body = (
      <SpeakerView
        meetingId={meetingId}
        label={target.label}
        currentSuggestion={currentSuggestion}
        polling={polling}
        onSelectCall={openCall}
      />
    );
  } else {
    body = (
      <SummaryView
        meetingId={meetingId}
        summary={summary}
        polling={polling}
        onSelectCall={openCall}
      />
    );
  }

  return (
    <aside
      ref={asideRef}
      aria-label={t("meetings.inspector.title")}
      data-testid="meetings-inspector"
      className="bg-card border-border sticky bottom-0 mt-5 max-h-[min(60vh,28rem)] overflow-y-auto rounded-t-lg border-x border-t shadow-lg"
    >
      <div className="bg-card border-border sticky top-0 z-10 flex items-center gap-2 border-b px-3 py-2">
        {canBack && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onBack}
            aria-label={t("meetings.inspector.back")}
            data-testid="meetings-inspector-back"
          >
            <ChevronLeft />
          </Button>
        )}
        <div className="min-w-0 flex-1 text-[12px]">
          <span className="font-medium">{t("meetings.inspector.title")}</span>
          <span className="text-muted-foreground">
            {" · "}
            {t(
              open
                ? "meetings.inspector.viewCall"
                : VIEW_TITLE_KEY[target.kind],
            )}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label={t("meetings.inspector.close")}
          data-testid="meetings-inspector-close"
        >
          <X />
        </Button>
      </div>
      <div className="px-3 py-3">{body}</div>
    </aside>
  );
}
