import type { MeetingDetail } from "@openstyle/validations";
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
import { queryKeys } from "@renderer/lib/query";
import { cn } from "@renderer/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  AudioLines,
  ChevronLeft,
  CircleSlash,
  FolderOpen,
  RefreshCw,
  Sparkles,
  Trash2,
  UserCog,
  Users,
  WandSparkles,
} from "lucide-react";
import { Fragment, useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  EditableTitle,
  MeetingContextField,
  MeetingLanguageChip,
} from "./fields";
import { SummaryInstructionsPopover } from "./settings-popovers";
import { CopyButton, StatusBadge, segmentSpeakerLabel } from "./shared";
import { SpeakersDialog } from "./speakers";
import type { EnhanceNote, SpeakersResponse, TranscriptSegment } from "./types";

export function MeetingDetailView({
  id,
  onBack,
  onDeleted,
}: {
  id: string;
  onBack: () => void;
  onDeleted: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [diarizeResult, setDiarizeResult] = useState<{
    labeledCount: number;
    speakerCount: number;
  } | null>(null);
  const [enhanceResult, setEnhanceResult] = useState<EnhanceNote | null>(null);
  /**
   * Enhance's third state — the one that used to be missing. When every chunk
   * fails the route answers 502 with a `reason`, and that reason lands here so
   * the note reads "Enhance timed out…", NOT "No segments needed correction."
   * (meeting 9243bea0: three `TimeoutError` chunks, reported as a clean
   * transcript). Cleared by `runAction` like `enhanceResult`, so it can never
   * survive into an unrelated action.
   */
  const [enhanceFailure, setEnhanceFailure] = useState<null | {
    reason: "parse" | "provider" | "timeout";
  }>(null);
  const [speakersOpen, setSpeakersOpen] = useState(false);
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
    // arrive without user interaction. Summarize is a background job too
    // (specs/meeting-llm-queue.md §5.6) and never changes `status` until it
    // succeeds, so its slot — `job.kind` — is what the predicate watches.
    refetchInterval: (query) =>
      query.state.data?.status === "transcribing" ||
      query.state.data?.job?.kind === "summarize"
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
      const body = (await res.json()) as { segments: TranscriptSegment[] };
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
      return (await res.json()) as unknown as SpeakersResponse;
    },
    enabled: hasTranscript,
  });
  const hasConfirmedSpeakerState = (speakersData?.speakers ?? []).some(
    (s) => s.displayName !== null || s.mergedInto !== null,
  );

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.meetings.all });
  }, [queryClient]);

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
      setEnhanceResult(null);
      setEnhanceFailure(null);
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
  // one server seam (`activeJobCancellations`, polled between chunks), so a
  // call still QUEUED on the LLM lane never goes on the wire. `onAcked` runs
  // only when the server acknowledges the cancel.
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
  // and the failure lands in `job_error` (not `meetings.error`).
  const cancelSummarize = useCallback(async () => {
    if (meeting?.job?.kind !== "summarize") return;
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
  const enhance = useCallback(async () => {
    const { ok, body } = await runAction<EnhanceNote>("enhance", () =>
      getClient().api.meetings[":id"].enhance.$post({ param: { id } }),
    );
    if (ok && body) {
      setEnhanceResult(body);
    } else if (!ok && body) {
      // A wholly-failed pass is a non-2xx with a machine-readable `reason`.
      const raw = (body as { reason?: unknown }).reason;
      // Anything the route didn't classify reads as a provider failure — the
      // honest default, never "nothing needed correction".
      setEnhanceFailure({
        reason:
          raw === "parse" || raw === "timeout" || raw === "provider"
            ? raw
            : "provider",
      });
    }
    // The route only UPDATEs enhanced_text on existing rows — the merged
    // transcript needs a re-fetch to pick the corrections up, same as
    // identifySpeakers' invalidate() above.
    void queryClient.invalidateQueries({
      queryKey: queryKeys.meetings.transcript(id),
    });
  }, [id, runAction, queryClient]);
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
  const summarizeQueueAhead = meeting.job?.queued?.ahead ?? 0;
  const summarizeQueued = summarizing && meeting.job?.queued != null;
  // A failed/cancelled Summarize lands in `job_error`, never in `meeting.error`
  // (§6 constraint 3 — that one is the chunk-failure banner), so it needs its
  // own surface once the slot is free.
  const summarizeFailure =
    !actionError && !summarizing ? (meeting.job_error ?? null) : null;
  const summarizeCancelled = summarizeFailure === "Cancelled by user";
  const canTranscribe =
    !transcribing && meeting.status !== "recording" && busy === null;
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
            {formatTimestamp(meeting.started_at)} ·{" "}
            {formatClockDuration(meeting.duration_ms)}
          </div>
          <MeetingContextField
            id={id}
            context={meeting.context}
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
            disabled={busy !== null}
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
            disabled={busy !== null}
          >
            <WandSparkles data-icon="inline-start" />
            {busy === "enhance"
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
          disabled={!hasTranscript || busy !== null || summarizing}
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
            disabled={busy !== null}
          >
            <RefreshCw data-icon="inline-start" />
            {t("meetings.retryFailed", { n: failedCount })}
          </Button>
        )}
        <div className="flex-1" />
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
      {(transcribing || summarizing) && (
        <Card className="mb-5 p-4">
          <div className="flex items-center gap-3">
            <RefreshCw className="text-primary h-3.5 w-3.5 animate-spin" />
            <div className="flex-1">
              <div className="text-foreground text-[12.5px]">
                {transcribing
                  ? cancelRequested
                    ? t("meetings.cancellingTranscription")
                    : t("meetings.transcribing")
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
                  : "meetings-cancel-summarize"
              }
              onClick={() =>
                void (transcribing ? cancelTranscribe() : cancelSummarize())
              }
              disabled={cancelRequested}
            >
              {transcribing
                ? t("meetings.cancelTranscription")
                : t("meetings.cancelSummarize")}
            </Button>
          </div>
        </Card>
      )}

      {/* A cancelled Summarize is not an error either — the transcript is
          untouched and no partial summary was written, so it reads as the same
          neutral note family as the transcribe cancel. A real failure keeps the
          server's own message (it names the provider/model problem), rendered
          like every other action failure on this page. */}
      {summarizeCancelled && (
        <InlineNotice
          tone="neutral"
          icon={CircleSlash}
          iconClassName="text-muted-foreground"
        >
          <span>{t("meetings.summarizeCancelled")}</span>
        </InlineNotice>
      )}
      {summarizeFailure && !summarizeCancelled && (
        <InlineNotice tone="destructive" icon={AlertTriangle}>
          <span>{summarizeFailure}</span>
        </InlineNotice>
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

      {(meeting.error || actionError) &&
        !cancelledByUser &&
        !enhanceFailure && (
          <InlineNotice tone="destructive" icon={AlertTriangle}>
            <span>{actionError ?? meeting.error}</span>
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

      {enhanceResult && !actionError && (
        <InlineNotice tone="neutral" icon={WandSparkles}>
          <span>
            {enhanceResult.correctedCount === 0
              ? t("meetings.enhanceNoneCorrected")
              : t("meetings.enhanceResult", {
                  n: enhanceResult.correctedCount,
                })}
            {/* A partial pass says so — "corrected 4 segments" on its own
                hides that the rest of the meeting was never looked at. */}
            {enhanceResult.partial
              ? ` ${t("meetings.enhancePartial", {
                  failed: enhanceResult.chunksFailed ?? 0,
                  attempted: enhanceResult.chunksAttempted ?? 0,
                })}`
              : ""}
          </span>
        </InlineNotice>
      )}

      {/* State three: the pass failed. Destructive card, names the cause, and
          offers the retry the old no-op message made unnecessary. Nothing was
          written — a failed chunk never reaches the UPDATE — so the copy says
          "nothing was changed" rather than hedging. */}
      {enhanceFailure && (
        <InlineNotice tone="destructive" icon={AlertTriangle}>
          <span className="flex min-w-0 flex-col gap-2">
            <span>
              {enhanceFailure.reason === "timeout"
                ? t("meetings.enhanceFailedTimeout")
                : enhanceFailure.reason === "parse"
                  ? t("meetings.enhanceFailedParse")
                  : t("meetings.enhanceFailedProvider")}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => void enhance()}
              disabled={busy !== null}
              data-testid="meetings-enhance-retry"
            >
              <WandSparkles data-icon="inline-start" />
              {t("meetings.retryEnhance")}
            </Button>
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
                    <Fragment
                      key={`${seg.speaker}-${seg.startMs}-${seg.endMs}`}
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
                        {showEnhanced
                          ? (seg.enhancedText ?? seg.text)
                          : seg.text}
                      </p>
                      <span className="mono text-muted-foreground/60 pt-0.5 text-[9px] tabular-nums">
                        {formatClockMs(seg.startMs)}
                      </span>
                    </Fragment>
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
              <div className="mb-3 flex justify-end">
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
    </div>
  );
}
