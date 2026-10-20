import type { LlmRunKind, MeetingDetail } from "@openstyle/validations";
import { InlineNotice } from "@renderer/components/inline-notice";
import { Markdown } from "@renderer/components/markdown";
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
import { Card } from "@renderer/components/ui/card";
import { Progress } from "@renderer/components/ui/progress";
import { Switch } from "@renderer/components/ui/switch";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@renderer/components/ui/tabs";
import { getClient } from "@renderer/lib/api";
import {
  formatClockDuration,
  formatClockMs,
  formatTimestamp,
} from "@renderer/lib/format";
import {
  llmRunsLatestQueryOptions,
  queryKeys,
  resumeRun,
  settingsQueryOptions,
} from "@renderer/lib/query";
import { cn } from "@renderer/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  AudioLines,
  ChevronLeft,
  CircleSlash,
  FolderOpen,
  RefreshCw,
  ScanSearch,
  Sparkles,
  Trash2,
  UserCog,
  Users,
  WandSparkles,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SETTINGS_KEYS } from "../../../../shared/settings-keys";
import { CalendarCard } from "./calendar-card";
import {
  EditableTitle,
  MeetingContextField,
  MeetingLanguageChip,
} from "./fields";
import { type InspectorTarget, LlmInspectorPanel } from "./llm-inspector";
import { isAdvancedMode } from "./llm-inspector-model";
import {
  enhanceNoteOf,
  formatChunkList,
  isSummarizeCancelled,
  llmErrorKey,
  nodeLabelKey,
  noticeTextKey,
  type RunNotice,
  runNotice,
} from "./run-notice";
import { SummaryInstructionsPopover } from "./settings-popovers";
import { CopyButton, StatusBadge, segmentSpeakerLabel } from "./shared";
import { attendeeNameOptions, SpeakersDialog } from "./speakers";
import type { SpeakersResponse, TranscriptSegment } from "./types";

export function MeetingDetailView({
  id,
  onBack,
  onDeleted,
}: {
  id: string;
  onBack: () => void;
  onDeleted: () => void;
}): React.JSX.Element {
  const { t, i18n } = useTranslation();
  // A rate in kHz with one decimal at most ("16", "44.1"), in the UI language.
  const formatKhz = (hz: number): string =>
    new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(
      hz / 1000,
    );
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [diarizeResult, setDiarizeResult] = useState<{
    labeledCount: number;
    speakerCount: number;
  } | null>(null);
  // The success note of an Enhance run (specs/meeting-enhance-agentic.md 8.9)
  // shows only for a run that ended after this moment: the page opened, or the
  // user last started an action. A reload resets it, so the note never lingers.
  const [noteFloor, setNoteFloor] = useState(() => Date.now());
  const [speakersOpen, setSpeakersOpen] = useState(false);
  // The LLM inspector (specs/meeting-enhance-agentic.md 8.5). It stays in
  // memory until this view drops (`key={activeId}`); every entry shows only in
  // advanced mode.
  const [inspector, setInspector] = useState<InspectorTarget | null>(null);
  const [rediarizeConfirmOpen, setRediarizeConfirmOpen] = useState(false);
  // Per-session viewing preference (Phase C, specs/meeting-transcription-
  // quality.md §6.6), not persisted meeting state — a segment Enhance left
  // unchanged (omitted from its JSON response) still renders correctly in
  // either mode via `seg.enhancedText ?? seg.text`.
  const [showEnhanced, setShowEnhanced] = useState(true);

  // T1-1 / UX-03 (specs/lean-audit-2026-09.md §3): cancelling a running
  // transcribe job. `cancelRequested` rides the wind-down window between the
  // POST (202, immediate) and the status flip to 'failed' once in-flight
  // chunks finish. The planned chunk total is latched at click time because
  // once the job frees its slot GET /:id reports job: null, and the durable
  // counts (segment_counts) only cover segments actually written — early
  // cancels would otherwise read "N of N" instead of "N of M".
  const [cancelRequested, setCancelRequested] = useState(false);
  const plannedTotalRef = useRef<number | null>(null);

  const { data: meeting } = useQuery({
    queryKey: queryKeys.meetings.detail(id),
    queryFn: async (): Promise<MeetingDetail | null> => {
      const res = await getClient().api.meetings[":id"].$get({
        param: { id },
      });
      if (!res.ok) return null;
      return await res.json();
    },
    // Poll while the transcription job runs so progress and the final status
    // arrive without user interaction. Summarize and the auto-Enhance pass
    // are background jobs too: neither changes `status` until it succeeds
    // (specs/meeting-llm-queue.md §5.6, meeting-transcription-v2.md §3.2),
    // so their slot — `job.kind` — is what the predicate watches.
    refetchInterval: (query) =>
      query.state.data?.status === "transcribing" ||
      query.state.data?.job?.kind === "summarize" ||
      query.state.data?.job?.kind === "enhance"
        ? 1000
        : false,
  });

  const hasTranscript =
    meeting?.status === "transcribed" || meeting?.status === "summarized";

  const { data: transcript, isFetching: isTranscriptFetching } = useQuery({
    queryKey: queryKeys.meetings.transcript(id),
    queryFn: async (): Promise<TranscriptSegment[]> => {
      const res = await getClient().api.meetings[":id"].transcript.$get({
        param: { id },
      });
      if (!res.ok) return [];
      const body = await res.json();
      return body.segments;
    },
    enabled: hasTranscript,
    // Re-transcribe races: the server sets status='transcribing' and DELETEs
    // meeting_segments synchronously in POST /:id/transcribe, then this
    // component's invalidate() (runAction's finally) fires before the
    // re-render disables this query, so it can refetch mid-DELETE and cache
    // a legitimate-looking `[]`. The global default staleTime (ONE_HOUR,
    // query.ts) would then treat that poisoned `[]` as fresh for the rest of
    // the session, so re-enabling this query once the job actually finishes
    // (hasTranscript flips back to true) would never trigger a refetch.
    // staleTime: 0 here means every re-enable refetches for real.
    staleTime: 0,
  });

  // specs/meeting-speaker-naming.md §7.3: kept warm whenever the detail view
  // is open (same `hasTranscript` gate as the "Speakers" button itself),
  // not just while the dialog is open — §7.4's re-diarize confirmation
  // needs this data regardless of whether the dialog has ever been opened.
  const { data: speakersData } = useQuery({
    queryKey: queryKeys.meetings.speakers(id),
    queryFn: async (): Promise<SpeakersResponse> => {
      const res = await getClient().api.meetings[":id"].speakers.$get({
        param: { id },
      });
      if (!res.ok) {
        return { speakers: [], unlabeledCount: 0, latestSpeakerUpdate: null };
      }
      return await res.json();
    },
    enabled: hasTranscript,
  });
  const hasConfirmedSpeakerState = (speakersData?.speakers ?? []).some(
    (s) => s.displayName !== null || s.mergedInto !== null,
  );

  // Persisted run status replaces the old component error state (8.9): the
  // newest run of each kind feeds the failure, interrupted and success notices.
  const { data: latestRuns } = useQuery(
    llmRunsLatestQueryOptions(id, hasTranscript),
  );

  const { data: appSettings } = useQuery(settingsQueryOptions());
  const calendarEnabled =
    appSettings?.[SETTINGS_KEYS.calendarEnabled] === "true";
  const advancedMode = isAdvancedMode(
    appSettings?.[SETTINGS_KEYS.advancedMode],
  );
  const selectedSegmentId =
    inspector?.kind === "segment" ? inspector.segmentId : null;
  const closeInspector = useCallback(() => setInspector(null), []);

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.meetings.all });
  }, [queryClient]);

  // specs/meeting-transcription-v2.md §3.2: when the Enhance stage of a run
  // ends (job.kind leaves "enhance") its corrections and speaker suggestions
  // have just been written, so invalidate this meeting's transcript (enhanced
  // text), speakers, and the list (the row's badge) here — the global
  // `refetchOnWindowFocus` is off (lib/query.ts), so without this the enhanced
  // text would not appear until the meeting was opened again. When any run job
  // ends (Enhance or Summarize, 8.5) the persisted run records change too, so
  // the run and call queries refetch and the notices follow the new status.
  const prevJobKindRef = useRef<string | null>(null);
  useEffect(() => {
    const kind = meeting?.job?.kind ?? null;
    const prev = prevJobKindRef.current;
    prevJobKindRef.current = kind;
    if ((prev === "enhance" || prev === "summarize") && kind !== prev) {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.meetings.llmRunsOf(id),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.meetings.llmCallsOf(id),
      });
      // Summarize sets `status` to "summarized" when it ends, also when it
      // follows Enhance in a chained run, so the list badge refetches here.
      void queryClient.invalidateQueries({ queryKey: queryKeys.meetings.list });
    }
    if (prev === "enhance" && kind !== "enhance") {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.meetings.transcript(id),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.meetings.speakers(id),
      });
    }
  }, [meeting?.job?.kind, queryClient, id]);

  // Returns the parsed JSON body with the `ok` flag. `body` is null when the
  // request throws or the body is not JSON. On `!ok`, `body` holds the error
  // shape instead of `T`, so callers read it with care.
  const runAction = useCallback(
    async <T,>(
      name: string,
      request: () => Promise<{ ok: boolean; json: () => Promise<unknown> }>,
    ): Promise<{ ok: boolean; body: T | null }> => {
      setBusy(name);
      setActionError(null);
      // Cleared on every action, not just the diarize/enhance ones, so a
      // stale "Identified N speakers"/"Corrected N segments" note doesn't
      // linger through an unrelated re-transcribe/summarize click.
      setDiarizeResult(null);
      setNoteFloor(Date.now());
      let result: { ok: boolean; body: T | null } = { ok: false, body: null };
      try {
        const res = await request();
        const body = (await res.json()) as T;
        if (!res.ok) {
          setActionError(
            (body as { error?: string }).error ?? t("meetings.actionFailed"),
          );
        }
        result = { ok: res.ok, body };
      } catch {
        setActionError(t("meetings.actionFailed"));
      } finally {
        setBusy(null);
        invalidate();
      }
      return result;
    },
    [invalidate, t],
  );

  const transcribe = useCallback(() => {
    // Clear the transcript cache *before* the POST fires. The server
    // synchronously sets status='transcribing' and DELETEs meeting_segments
    // before returning 202, so a query that's still enabled from the
    // previous 'transcribed' render can race the DELETE and cache an empty
    // result that then reads as "confirmed empty" (see the transcript
    // useQuery comment above). Removing the cache entry up front means
    // there is nothing stale for that race to serve.
    queryClient.removeQueries({ queryKey: queryKeys.meetings.transcript(id) });
    // A fresh job invalidates any previous cancel's wind-down/note state.
    setCancelRequested(false);
    plannedTotalRef.current = null;
    return runAction("transcribe", () =>
      getClient().api.meetings[":id"].transcribe.$post({ param: { id } }),
    );
  }, [id, runAction, queryClient]);
  const summarize = useCallback(() => {
    // A fresh job invalidates any previous cancel's wind-down state (this
    // latch is shared by both cancellable job kinds).
    setCancelRequested(false);
    return runAction("summarize", () =>
      getClient().api.meetings[":id"].summarize.$post({ param: { id } }),
    );
  }, [id, runAction]);
  const retryFailed = useCallback(
    () =>
      runAction("retry", () =>
        getClient().api.meetings[":id"]["retry-failed"].$post({
          param: { id },
        }),
      ),
    [id, runAction],
  );
  // Shared cancel call for the Transcribe and Summarize buttons. Both jobs use
  // one server seam. The job registry sets the flag with `requestCancel`, and
  // the job reads it with `isCancelRequested` between chunks. A call that is
  // still QUEUED on the LLM lane never goes on the wire. `onAcked` runs only
  // when the server acknowledges the cancel.
  const cancelJob = useCallback(
    async (onAcked?: () => void) => {
      if (cancelRequested) return;
      setCancelRequested(true);
      try {
        const res = await getClient().api.meetings[":id"][
          "cancel-transcribe"
        ].$post({ param: { id } });
        if (res.ok || res.status === 409) {
          // 409 = no job holds the slot any more (it just finished on its
          // own, or the slot is a non-cancellable diarize pass). The poll
          // shows whatever terminal state the job reached, which is all the
          // user asked for. Run `onAcked` only on an acknowledged cancel.
          if (res.ok) onAcked?.();
          return;
        }
        throw new Error(`cancel-transcribe -> ${res.status}`);
      } catch {
        // Leave the wind-down state only on a real failure; the action error
        // surface below carries the message.
        setCancelRequested(false);
        setActionError(t("meetings.actionFailed"));
      } finally {
        invalidate();
      }
    },
    [id, cancelRequested, invalidate, t],
  );
  const cancelTranscribe = useCallback(async () => {
    if (meeting?.status !== "transcribing") return;
    // Latch the plan for the note only on an acknowledged cancel.
    const total = meeting.job?.total ?? null;
    await cancelJob(() => {
      plannedTotalRef.current = total;
    });
  }, [meeting, cancelJob]);
  // Cancel a running Summarize job (§5.7). Nothing is destroyed: the
  // transcript and every persisted segment survive, no summary is written,
  // and the run ends `cancelled` in the run record (8.9).
  const cancelSummarize = useCallback(async () => {
    if (meeting?.job?.kind !== "summarize") return;
    await cancelJob();
  }, [meeting, cancelJob]);
  // Cancel the auto-Enhance pass (meeting-transcription-v2.md §3.2). Same
  // server seam as the other two cancellable jobs: it keeps the chunks it
  // already finished and leaves the status `transcribed`.
  const cancelEnhance = useCallback(async () => {
    if (meeting?.job?.kind !== "enhance") return;
    await cancelJob();
  }, [meeting, cancelJob]);
  const identifySpeakers = useCallback(async () => {
    const { ok, body } = await runAction<{
      labeledCount: number;
      speakerCount: number;
    }>("diarize", () =>
      getClient().api.meetings[":id"].diarize.$post({ param: { id } }),
    );
    if (ok && body) setDiarizeResult(body);
    // The route only UPDATEs speaker_label on existing rows — the merged
    // transcript needs a re-fetch to pick the new labels up, same as every
    // other action's invalidate() call inside runAction, called out here
    // because it's the effect the task specifically asked to verify.
    void queryClient.invalidateQueries({
      queryKey: queryKeys.meetings.transcript(id),
    });
  }, [id, runAction, queryClient]);
  // specs/meeting-speaker-naming.md §6.3/§7.4: re-diarize clears the naming
  // mapping (label "N" has no guaranteed relationship to the new run's
  // label "N") — guard the click with a confirmation whenever there's
  // actually something to lose. No guard on the common case (first-ever
  // diarization run, nothing confirmed yet).
  const handleIdentifySpeakersClick = useCallback(() => {
    if (hasConfirmedSpeakerState) setRediarizeConfirmOpen(true);
    else void identifySpeakers();
  }, [hasConfirmedSpeakerState, identifySpeakers]);
  // The route answers 202 and starts one run that corrects the transcript and
  // then summarizes it (specs/meeting-enhance-agentic.md 3.4.2). runAction's
  // invalidate() refetches the detail, so the poll starts and follows the job;
  // the notices read the persisted run when it ends (8.9). Any non-2xx answer
  // (404, 409) lands in the generic action error.
  const enhance = useCallback(
    () =>
      runAction("enhance", () =>
        getClient().api.meetings[":id"].enhance.$post({ param: { id } }),
      ),
    [id, runAction],
  );
  // "Resume" of an interrupted run (8.9). A 409 from guard 4 or 6 fails the run
  // and the refetched notice shows its error kind, so those two add no action
  // error. The other guards leave the run as it is and show the server's line.
  const resume = useCallback(
    async (runId: string) => {
      setBusy("resume");
      setActionError(null);
      setNoteFloor(Date.now());
      const result = await resumeRun(queryClient, id, runId);
      if (
        !result.ok &&
        result.reason !== "graph_changed" &&
        result.reason !== "transcript_changed"
      ) {
        setActionError(result.error ?? t("meetings.actionFailed"));
      }
      setBusy(null);
    },
    [id, queryClient, t],
  );
  const deleteMeeting = useCallback(async () => {
    await getClient().api.meetings[":id"].$delete({ param: { id } });
    invalidate();
    onDeleted();
  }, [id, invalidate, onDeleted]);

  if (!meeting) {
    return (
      <div className="text-muted-foreground py-10 text-center text-[13px]">
        {t("common.loading", "Loading…")}
      </div>
    );
  }

  const transcribing = meeting.status === "transcribing";
  // Summarize is a background job now (specs/meeting-llm-queue.md §5.6):
  // POST returns 202 and `status` stays `transcribed` until the job writes the
  // summary, so the polled job blob — not the status — is what the UI reads
  // for "a summarize is happening on this meeting".
  const summarizing = meeting.job?.kind === "summarize";
  // The auto-Enhance pass runs as its own job after the status flip
  // (meeting-transcription-v2.md §3.2): while it holds the slot the status
  // is already `transcribed`, so — like summarize — the job blob is the
  // only signal that something is happening.
  const enhancingJob = meeting.job?.kind === "enhance";
  // Any job holding the slot disables the actions that would race it
  // (meeting-transcription-v2.md §3.2, detail-page rule). The server
  // answers a race with 409 naming the real job; this keeps the UI honest
  // before the click.
  const jobHoldsSlot = meeting.job !== null;
  const summarizeQueueAhead = meeting.job?.queued?.ahead ?? 0;
  const summarizeQueued = summarizing && meeting.job?.queued != null;
  // The newest run of each kind decides its notice (8.9). The persisted run
  // holds the failure of a Summarize too.
  const runOf = (kind: LlmRunKind) =>
    latestRuns?.runs.find((r) => r.kind === kind);
  const enhanceNotice = runNotice(runOf("enhance"), jobHoldsSlot);
  const allRuns = latestRuns?.runs ?? [];
  const summarizeNotice = runNotice(runOf("summarize"), jobHoldsSlot, allRuns);
  const summarizeCancelled = isSummarizeCancelled(
    runOf("summarize"),
    jobHoldsSlot,
    allRuns,
  );
  const enhanceNote = enhanceNoteOf(runOf("enhance"), jobHoldsSlot, noteFloor);
  const canTranscribe =
    !transcribing &&
    meeting.status !== "recording" &&
    busy === null &&
    !jobHoldsSlot;
  const failedCount = meeting.segment_counts.failed;
  // T1-1: the server's canonical cancel error (routes/meetings.ts
  // POST /:id/cancel-transcribe) — mapped to the localized kept-transcript
  // note below instead of rendering the raw string. Mapping survives remounts
  // and navigation (the counts degrade to segment_counts when the latched
  // plan is gone), so the note is honest even for a row reopened later.
  const cancelledByUser = !actionError && meeting.error === "Cancelled by user";
  const keptSegments =
    meeting.segment_counts.total - meeting.segment_counts.failed;
  const plannedSegments =
    plannedTotalRef.current ?? meeting.segment_counts.total;
  const hasEnhanced = (transcript ?? []).some(
    (s) => s.enhancedText !== undefined,
  );
  // specs/meeting-speaker-naming.md §9.2: an already-generated summary is a
  // persisted artifact, not live-computed, so confirming a name after
  // summarizing doesn't retroactively change existing summary text — show a
  // note instead, computed from data already loaded (no new endpoint).
  const summaryStaleNames = Boolean(
    meeting.summary?.markdown &&
      meeting.summary.created_at !== null &&
      speakersData?.latestSpeakerUpdate != null &&
      meeting.summary.created_at < speakersData.latestSpeakerUpdate,
  );
  const transcriptText = (transcript ?? [])
    .map((s) => {
      const label = segmentSpeakerLabel(s, t);
      const text = showEnhanced ? (s.enhancedText ?? s.text) : s.text;
      return `${label}: ${text}`;
    })
    .join("\n");

  return (
    <div>
      <div className="mb-5 flex items-center gap-2.5">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onBack}
          aria-label={t("meetings.back")}
          // The list rail is always visible at >=900px (master-detail), so
          // "back" only means something in the narrow single-pane fallback.
          className="min-[900px]:hidden"
        >
          <ChevronLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <EditableTitle id={id} title={meeting.title} onRenamed={invalidate} />
          <div className="text-muted-foreground text-[11px]">
            {formatTimestamp(meeting.started_at, i18n.language)} ·{" "}
            {formatClockDuration(meeting.duration_ms)}
          </div>
          <MeetingContextField
            id={id}
            context={meeting.context}
            onChanged={invalidate}
          />
          <CalendarCard
            id={id}
            calendar={meeting.calendar}
            enabled={calendarEnabled}
            onChanged={invalidate}
          />
        </div>
        <MeetingLanguageChip
          id={id}
          language={meeting.language}
          onChanged={invalidate}
        />
        <StatusBadge status={meeting.status} />
      </div>

      {/* Actions */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Button
          variant="ink"
          size="sm"
          onClick={() => void transcribe()}
          disabled={!canTranscribe}
        >
          <AudioLines data-icon="inline-start" />
          {hasTranscript
            ? t("meetings.retranscribe")
            : t("meetings.transcribe")}
        </Button>
        {hasTranscript && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleIdentifySpeakersClick}
            // Diarization is a slot-holding job too: while any job runs
            // (transcribe/summarize/enhance) the re-diarize 409s, so the
            // button stays off with the rest. "Speakers" (view-only) stays on.
            disabled={busy !== null || jobHoldsSlot}
          >
            <Users data-icon="inline-start" />
            {busy === "diarize"
              ? t("meetings.identifyingSpeakers")
              : t("meetings.identifySpeakers")}
          </Button>
        )}
        {hasTranscript && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSpeakersOpen(true)}
          >
            <UserCog data-icon="inline-start" />
            {t("meetings.speakers")}
          </Button>
        )}
        {hasTranscript && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void enhance()}
            disabled={busy !== null || jobHoldsSlot}
          >
            <WandSparkles data-icon="inline-start" />
            {busy === "enhance" || enhancingJob
              ? t("meetings.enhancing")
              : hasEnhanced
                ? t("meetings.reEnhance")
                : t("meetings.enhance")}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => void summarize()}
          disabled={
            !hasTranscript || busy !== null || summarizing || jobHoldsSlot
          }
        >
          <Sparkles data-icon="inline-start" />
          {busy === "summarize" || summarizing
            ? t("meetings.summarizing")
            : meeting.summary
              ? t("meetings.resummarize")
              : t("meetings.summarize")}
        </Button>
        {failedCount > 0 && !transcribing && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void retryFailed()}
            disabled={busy !== null || jobHoldsSlot}
          >
            <RefreshCw data-icon="inline-start" />
            {t("meetings.retryFailed", { n: failedCount })}
          </Button>
        )}
        <div className="flex-1" />
        {advancedMode && (
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => setInspector({ kind: "runs" })}
            aria-label={t("meetings.inspector.title")}
            title={t("meetings.inspector.title")}
            data-testid="meetings-inspector-open"
          >
            <ScanSearch />
          </Button>
        )}
        <SummaryInstructionsPopover />
        <Button
          variant="outline"
          size="icon-sm"
          disabled={!meeting.audio_dir}
          onClick={() => void window.api?.revealMeetingInFinder?.(id)}
          aria-label={t("meetings.revealInFinder")}
          title={t("meetings.revealInFinder")}
        >
          <FolderOpen />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="hover:text-destructive"
          onClick={() => setDeleteOpen(true)}
          aria-label={t("meetings.delete")}
          title={t("meetings.delete")}
        >
          <Trash2 />
        </Button>
      </div>

      {/* One card for both background jobs. Transcribe and Summarize use the
          same contract (202 + poll, §5.6), so they get the same face. The
          coral spinner is the only sanctioned live accent. The queued slot
          says *why* nothing is moving yet (the LLM lane is busy, §5.5). */}
      {(transcribing || summarizing || enhancingJob) && (
        <Card className="mb-5 p-4">
          <div className="flex items-center gap-3">
            <RefreshCw className="text-primary h-3.5 w-3.5 animate-spin" />
            <div className="flex-1">
              <div className="text-foreground text-[12.5px]">
                {transcribing
                  ? cancelRequested
                    ? t("meetings.cancellingTranscription")
                    : t("meetings.transcribing")
                  : enhancingJob
                    ? cancelRequested
                      ? t("meetings.cancellingEnhance")
                      : t("meetings.enhancing")
                    : cancelRequested
                      ? t("meetings.cancellingSummarize")
                      : summarizeQueued && summarizeQueueAhead > 0
                        ? t("meetings.summarizeQueuedAhead", {
                            n: summarizeQueueAhead,
                          })
                        : summarizeQueued
                          ? t("meetings.summarizeQueued")
                          : t("meetings.summarizing")}
              </div>
              {meeting.job && meeting.job.total > 0 && (
                <Progress
                  value={(meeting.job.done / meeting.job.total) * 100}
                  className="mt-2 h-1"
                />
              )}
            </div>
            {meeting.job && meeting.job.total > 0 && (
              <span className="mono text-muted-foreground text-[10px] tabular-nums">
                {meeting.job.done}/{meeting.job.total}
              </span>
            )}
            {/* T1-1 (UX-03): the non-destructive exit from a mis-started job —
                inside the progress card, not the toolbar, so it reads as an
                attribute of this run. Ghost: it must not compete with the
                primary actions. Disabled (not hidden) while the acknowledged
                cancel winds down: in-flight chunks (≤2, or 1 for
                whisper-local) still finish and persist. Summarize cancel is
                the existing cancellable-job seam (§5.7). */}
            <Button
              variant="ghost"
              size="sm"
              data-testid={
                transcribing
                  ? "meetings-cancel-transcribe"
                  : summarizing
                    ? "meetings-cancel-summarize"
                    : "meetings-cancel-enhance"
              }
              onClick={() =>
                void (transcribing
                  ? cancelTranscribe()
                  : summarizing
                    ? cancelSummarize()
                    : cancelEnhance())
              }
              disabled={cancelRequested}
            >
              {transcribing
                ? t("meetings.cancelTranscription")
                : summarizing
                  ? t("meetings.cancelSummarize")
                  : t("meetings.cancelEnhance")}
            </Button>
          </div>
        </Card>
      )}

      {/* A cancelled Summarize is not an error either — the transcript is
          untouched and no partial summary was written, so it reads as the same
          neutral note family as the transcribe cancel. A real failure keeps the
          server's own message (it names the provider/model problem), rendered
          like every other action failure on this page. */}
      {summarizeCancelled && !actionError && (
        <InlineNotice
          tone="neutral"
          icon={CircleSlash}
          iconClassName="text-muted-foreground"
        >
          <span>{t("meetings.summarizeCancelled")}</span>
        </InlineNotice>
      )}
      {enhanceNotice && (
        <RunNoticeView
          notice={enhanceNotice}
          disabled={busy !== null}
          onResume={resume}
          onStartAgain={enhance}
          onShowDetails={
            advancedMode
              ? () => setInspector({ kind: "run", runId: enhanceNotice.runId })
              : undefined
          }
        />
      )}
      {summarizeNotice && (
        <RunNoticeView
          notice={summarizeNotice}
          disabled={busy !== null}
          onResume={resume}
          onStartAgain={summarize}
          onShowDetails={
            advancedMode
              ? () =>
                  setInspector({ kind: "run", runId: summarizeNotice.runId })
              : undefined
          }
        />
      )}

      {/* Post-cancel (T1-1): a cancelled job is not an error — every written
          segment survived and Retry failed / Re-transcribe are live — so it
          gets the neutral note treatment (same family as the diarize/enhance
          result notes), NOT the destructive error card. The copy must say the
          partial transcript was kept, or the ungated Delete starts looking
          like the only exit (audit U4). */}
      {cancelledByUser && (
        <InlineNotice
          tone="neutral"
          icon={CircleSlash}
          iconClassName="text-muted-foreground"
        >
          <span>
            {t("meetings.cancelledKeptTranscript", {
              n: keptSegments,
              total: plannedSegments,
            })}
          </span>
        </InlineNotice>
      )}

      {(meeting.error || actionError) && !cancelledByUser && (
        <InlineNotice tone="destructive" icon={AlertTriangle}>
          <span>{actionError ?? meeting.error}</span>
        </InlineNotice>
      )}

      {/* Issue #170: the server compares the sample counts of the two tracks
          in sync.json. The two tracks should have the same length. With a
          ratio outside 0.95..1.05, the system audio can play at the wrong
          speed and the transcript can be wrong. When the ratio is a known
          sample-rate mismatch, the server repairs the system track at the
          start of a transcription, and the page shows a note instead. The
          field can be undefined (a server without it), so test the type. */}
      {typeof meeting.track_ratio_warning === "number" && (
        <InlineNotice tone="destructive" icon={AlertTriangle}>
          <span data-testid="meeting-track-ratio-warning">
            {t("meetings.trackRatioWarning", {
              percent: Math.round(meeting.track_ratio_warning * 100),
            })}
          </span>
        </InlineNotice>
      )}
      {meeting.track_repair && (
        <InlineNotice
          tone="neutral"
          icon={AudioLines}
          iconClassName="text-muted-foreground"
        >
          <span data-testid="meeting-track-repair-note">
            {t(
              meeting.track_repair.repaired
                ? "meetings.trackRepaired"
                : "meetings.trackRepairPending",
              {
                recorded: formatKhz(meeting.track_repair.toRate),
                read: formatKhz(meeting.track_repair.fromRate),
                // The old conversion cut at 8 kHz of the rate it assumed,
                // which is 8 kHz × toRate / fromRate in real time.
                bandwidth: formatKhz(
                  8000 *
                    Math.min(
                      1,
                      meeting.track_repair.toRate /
                        meeting.track_repair.fromRate,
                    ),
                ),
              },
            )}
          </span>
        </InlineNotice>
      )}

      {diarizeResult && !actionError && (
        <InlineNotice tone="neutral" icon={Users}>
          <span>
            {diarizeResult.speakerCount === 0
              ? t("meetings.diarizeNoSpeakers")
              : t("meetings.diarizeResult", { n: diarizeResult.speakerCount })}
            {diarizeResult.speakerCount === 1 &&
              ` ${t("meetings.diarizeSingleSpeakerNote")}`}
          </span>
        </InlineNotice>
      )}

      {enhanceNote !== null && !actionError && (
        <InlineNotice tone="neutral" icon={WandSparkles}>
          <span data-testid="meetings-enhance-note">
            {t(`meetings.${enhanceNote.key}`, { n: enhanceNote.n })}
          </span>
        </InlineNotice>
      )}

      <Tabs defaultValue="transcript">
        <TabsList>
          <TabsTrigger value="transcript">
            {t("meetings.tabTranscript")}
          </TabsTrigger>
          <TabsTrigger value="summary">{t("meetings.tabSummary")}</TabsTrigger>
        </TabsList>

        <TabsContent value="transcript" className="mt-4">
          {transcript && transcript.length > 0 ? (
            <>
              <div className="mb-3 flex items-center justify-between gap-3">
                {hasEnhanced ? (
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={showEnhanced}
                      onCheckedChange={setShowEnhanced}
                      aria-label={t("meetings.showEnhancedLabel")}
                    />
                    <span className="text-muted-foreground text-[11px]">
                      {showEnhanced
                        ? t("meetings.showingEnhanced")
                        : t("meetings.showingRaw")}
                    </span>
                  </div>
                ) : (
                  <div />
                )}
                <CopyButton
                  text={transcriptText}
                  label={t("meetings.copyTranscript")}
                />
              </div>
              {/* Speaker-label column is `max-content`, so it grows to fit
                  the longest label on screen — flag names are arbitrary
                  length now (confirmed names, not just "ME"/"THEM N"), so a
                  fixed width either clips or overlaps the transcript text.
                  `minmax(64px, …)` keeps the short-label case (the common
                  one) at the original artboard-02 proportions; the chip
                  itself caps at 140px with truncation for absurdly long
                  names. A CSS grid (not per-row flex) is required so every
                  row's label column shares one width and stays aligned. */}
              <div className="grid grid-cols-[minmax(64px,max-content)_minmax(0,1fr)_max-content] gap-x-3 gap-y-3.5">
                {transcript.map((seg) => {
                  const label = segmentSpeakerLabel(seg, t);
                  return (
                    <div
                      key={
                        seg.id ?? `${seg.speaker}-${seg.startMs}-${seg.endMs}`
                      }
                      className="contents"
                      data-testid="meetings-segment"
                      data-segment-id={seg.id}
                    >
                      <span className="pt-0.5 text-right leading-none">
                        <span
                          title={label}
                          className={cn(
                            "mono inline-block max-w-[140px] truncate align-bottom whitespace-nowrap rounded-[5px] px-[7px] py-[2.5px] text-[9px] font-medium uppercase tracking-[0.1em]",
                            seg.speaker === "Me"
                              ? "bg-transparent px-0 font-semibold text-foreground"
                              : seg.speakerLabel
                                ? // Confirmed name or numbered-but-unnamed
                                  // "Them N" — a real, distinguishable
                                  // speaker — gets the full accent-passive
                                  // treatment (specs/meeting-speaker-naming.
                                  // md §7.5).
                                  "bg-[var(--accent-passive-tint)] text-[color:var(--accent-passive-ink)]"
                                : // Unidentified: a materially weaker claim
                                  // (the diarizer couldn't attribute this
                                  // line to anyone at all) — a muted
                                  // outline, never the accent-passive fill
                                  // (§3.3/§7.5).
                                  "border border-border bg-transparent text-muted-foreground",
                          )}
                        >
                          {label}
                        </span>
                      </span>
                      <p className="text-foreground m-0 text-[13.5px] leading-[1.55]">
                        {advancedMode &&
                        seg.id &&
                        seg.enhancedText !== undefined ? (
                          // The edited text opens the LLM call that made it.
                          // No aria-label: it would replace the text as the
                          // accessible name.
                          <button
                            type="button"
                            data-testid="meetings-segment-inspect"
                            title={t("meetings.inspector.inspectCorrection")}
                            aria-expanded={selectedSegmentId === seg.id}
                            onClick={() =>
                              setInspector({
                                kind: "segment",
                                segmentId: seg.id as string,
                              })
                            }
                            className={cn(
                              "cursor-pointer rounded-sm text-left underline decoration-dotted underline-offset-2",
                              selectedSegmentId === seg.id && "bg-accent",
                            )}
                          >
                            {showEnhanced ? seg.enhancedText : seg.text}
                          </button>
                        ) : showEnhanced ? (
                          (seg.enhancedText ?? seg.text)
                        ) : (
                          seg.text
                        )}
                      </p>
                      <span className="mono text-muted-foreground/60 pt-0.5 text-[9px] tabular-nums">
                        {formatClockMs(seg.startMs)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="border-border bg-card/30 rounded-lg border border-dashed px-6 py-10 text-center">
              <p className="text-muted-foreground m-0 text-[13px]">
                {!hasTranscript
                  ? t("meetings.transcriptPending")
                  : // Distinguish "confirmed empty" from "haven't refetched this
                    // job's result yet" — isFetching or an as-yet-undefined
                    // cache entry means the query hasn't resolved for the
                    // *current* transcribed state, so transcriptEmpty must
                    // wait for a settled, non-fetching, genuinely zero-length
                    // result (see the transcript useQuery comment above).
                    isTranscriptFetching || transcript === undefined
                    ? t("meetings.transcriptLoading")
                    : t("meetings.transcriptEmpty")}
              </p>
            </div>
          )}
        </TabsContent>

        <TabsContent value="summary" className="mt-4">
          {meeting.summary?.markdown ? (
            <>
              {summaryStaleNames && (
                <InlineNotice
                  tone="neutral"
                  icon={Sparkles}
                  className="mb-3 text-muted-foreground"
                >
                  <span>{t("meetings.summaryStaleNames")}</span>
                </InlineNotice>
              )}
              <div className="mb-3 flex justify-end gap-2">
                {advancedMode && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setInspector({ kind: "summary" })}
                    data-testid="meetings-summary-inspect"
                  >
                    <ScanSearch data-icon="inline-start" />
                    {t("meetings.inspector.inspectSummary")}
                  </Button>
                )}
                <CopyButton
                  text={meeting.summary.markdown}
                  label={t("meetings.copySummary")}
                />
              </div>
              <Markdown source={meeting.summary.markdown} />
            </>
          ) : (
            <div className="border-border bg-card/30 rounded-lg border border-dashed px-6 py-10 text-center">
              <p className="text-muted-foreground m-0 text-[13px]">
                {t("meetings.summaryEmpty")}
              </p>
            </div>
          )}
        </TabsContent>
      </Tabs>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("meetings.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("meetings.deleteDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("meetings.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void deleteMeeting()}
            >
              {t("meetings.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <SpeakersDialog
        id={id}
        open={speakersOpen}
        onOpenChange={setSpeakersOpen}
        data={speakersData}
        attendeeNames={attendeeNameOptions(meeting.calendar)}
        // The dialog is modal, so it closes before the panel opens (8.6).
        onInspectSpeaker={
          advancedMode
            ? (label) => {
                setSpeakersOpen(false);
                setInspector({ kind: "speaker", label });
              }
            : undefined
        }
        onSaved={() => {
          void queryClient.invalidateQueries({
            queryKey: queryKeys.meetings.speakers(id),
          });
          void queryClient.invalidateQueries({
            queryKey: queryKeys.meetings.transcript(id),
          });
        }}
      />

      <AlertDialog
        open={rediarizeConfirmOpen}
        onOpenChange={setRediarizeConfirmOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("meetings.speakerResetOnRediarizeTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("meetings.speakerResetOnRediarizeDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("meetings.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void identifySpeakers()}>
              {t("meetings.identifySpeakers")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {advancedMode && inspector !== null && (
        <LlmInspectorPanel
          meetingId={id}
          target={inspector}
          onTarget={setInspector}
          onClose={closeInspector}
          polling={jobHoldsSlot}
          segmentText={
            inspector.kind === "segment"
              ? ((transcript ?? []).find((s) => s.id === inspector.segmentId)
                  ?.text ?? "")
              : ""
          }
          currentSuggestion={
            inspector.kind === "speaker"
              ? (speakersData?.speakers.find((s) => s.label === inspector.label)
                  ?.suggestedName ?? null)
              : null
          }
          summary={
            meeting.summary
              ? {
                  provider: meeting.summary.llm_provider,
                  model: meeting.summary.llm_model,
                  costUsd: meeting.summary.cost_usd,
                }
              : null
          }
        />
      )}
    </div>
  );
}

/**
 * One failure, partial or interrupted notice of a run (specs/meeting-enhance-
 * agentic.md 8.9): the headline, one line for each node and error kind, and the
 * buttons. The text of a line never holds prompt text.
 */
function RunNoticeView({
  notice,
  disabled,
  onResume,
  onStartAgain,
  onShowDetails,
}: {
  notice: RunNotice;
  disabled: boolean;
  onResume: (runId: string) => void;
  onStartAgain: () => void;
  /** Advanced mode only: opens the Run view of the LLM inspector (8.9). */
  onShowDetails?: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const lineText = (line: RunNotice["lines"][number]): string => {
    const reason = t(llmErrorKey(line.kind));
    if (line.node === null) return reason;
    const labelKey = nodeLabelKey(line.node);
    let where = labelKey ? t(labelKey) : line.node;
    if (line.chunks.length > 0) {
      where += `, ${t("meetings.llmRun.chunks", { list: formatChunkList(line.chunks) })}`;
    }
    return t("meetings.llmRun.line", { where, reason });
  };
  return (
    <InlineNotice
      tone={notice.tone}
      icon={notice.status === "interrupted" ? CircleSlash : AlertTriangle}
      iconClassName={
        notice.status === "interrupted" ? "text-muted-foreground" : undefined
      }
    >
      <span
        className="flex min-w-0 flex-col gap-2"
        data-testid={`meetings-run-notice-${notice.kind}`}
        data-run-status={notice.status}
      >
        <span>
          {t(noticeTextKey(notice.kind, notice.status), {
            failed: notice.failedSteps,
            total: notice.totalSteps,
          })}
        </span>
        {notice.lines.length > 0 && (
          <ul className="m-0 list-none space-y-1 p-0">
            {notice.lines.map((line) => (
              <li
                key={`${line.node}:${line.kind}`}
                data-testid="meetings-run-notice-line"
              >
                {lineText(line)}
              </li>
            ))}
          </ul>
        )}
        <span className="flex min-w-0 flex-wrap gap-2">
          {notice.canResume && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onResume(notice.runId)}
              disabled={disabled}
              data-testid="meetings-run-resume"
            >
              <RefreshCw data-icon="inline-start" />
              {t("meetings.llmRun.resume")}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-auto min-h-7 max-w-full whitespace-normal py-1 text-left"
            onClick={onStartAgain}
            disabled={disabled}
            data-testid={`meetings-${notice.kind}-retry`}
          >
            {notice.kind === "summarize" ? (
              <Sparkles data-icon="inline-start" />
            ) : (
              <WandSparkles data-icon="inline-start" />
            )}
            {notice.startAgainDiscards
              ? t("meetings.llmRun.startAgainDiscards")
              : t("meetings.llmRun.startAgain")}
          </Button>
          {onShowDetails && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onShowDetails}
              data-testid="meetings-run-show-details"
            >
              <ScanSearch data-icon="inline-start" />
              {t("meetings.inspector.showDetails")}
            </Button>
          )}
        </span>
      </span>
    </InlineNotice>
  );
}
