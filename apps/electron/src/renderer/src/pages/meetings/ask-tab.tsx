import {
  CHAT_QUESTION_MAX_CHARS,
  type ChatAskReply,
  type ChatMessage,
  type ChatThread,
  type ChatThreadDetail,
  type MeetingListItem,
} from "@openstyle/validations";
import { Button } from "@renderer/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { Textarea } from "@renderer/components/ui/textarea";
import { getClient } from "@renderer/lib/api";
import { queryKeys } from "@renderer/lib/query";
import { cn } from "@renderer/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { AskAnswer, type CiteActions } from "./ask-blocks";
import {
  ASK_WARMING_AFTER_MS,
  type AskErrorView,
  askErrorView,
  type CiteTarget,
  checkQuestion,
  citeTarget,
  danglingQuestion,
  mergeMessages,
  readSelectedThread,
  rememberSelectedThread,
  threadTitle,
  unsavedQuestion,
} from "./ask-model";

/** The three example questions. Each one fills the composer. */
const EXAMPLE_KEYS = ["exampleDecisions", "exampleActions", "exampleStatus"];

/** A failed turn. The question stays on screen. */
interface AskFailure {
  question: string;
  view: AskErrorView;
}

class AskRequestError extends Error {
  constructor(
    readonly status: number | null,
    readonly reason: string | null,
  ) {
    super("ask request failed");
  }
}

async function failureOf(res: Response): Promise<AskRequestError> {
  let reason: string | null = null;
  try {
    const body = (await res.json()) as { reason?: unknown };
    if (typeof body.reason === "string") reason = body.reason;
  } catch {
    // No JSON body. The status alone decides.
  }
  return new AskRequestError(res.status, reason);
}

async function fetchThreads(meetingId: string): Promise<ChatThread[]> {
  const res = await getClient().api.chat.threads.$get({
    query: { meeting_id: meetingId },
  });
  if (!res.ok) throw await failureOf(res);
  const body: unknown = await res.json();
  return (body as { threads: ChatThread[] }).threads;
}

async function fetchThread(id: string): Promise<ChatThreadDetail> {
  const res = await getClient().api.chat.threads[":id"].$get({
    param: { id },
  });
  if (!res.ok) throw await failureOf(res);
  const body: unknown = await res.json();
  return body as ChatThreadDetail;
}

async function createThread(meetingId: string): Promise<ChatThread> {
  const res = await getClient().api.chat.threads.$post({
    json: { scope: { kind: "meeting", id: meetingId } },
  });
  if (!res.ok) throw await failureOf(res);
  const body: unknown = await res.json();
  return (body as { thread: ChatThread }).thread;
}

async function postQuestion(
  threadId: string,
  question: string,
): Promise<ChatAskReply> {
  const res = await getClient().api.chat.threads[":id"].messages.$post({
    param: { id: threadId },
    json: { question },
  });
  if (!res.ok) throw await failureOf(res);
  const body: unknown = await res.json();
  return body as ChatAskReply;
}

/**
 * The Ask tab of one meeting (specs/meeting-chat-agent.md section 11, P1).
 * The scope is this meeting and never changes. One question gives one answer.
 * The server does not stream, so the tab shows a status text while it waits.
 */
export function AskTab({
  meetingId,
  onShowTranscript,
  onShowSummary,
}: {
  meetingId: string;
  /** Open the Transcript tab and mark the segment at `startMs`. */
  onShowTranscript: (startMs: number | null) => void;
  onShowSummary: () => void;
}): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const endRef = useRef<HTMLDivElement>(null);

  // null: the newest thread. "new": an empty chat. Else: a thread id. The
  // choice outlives the tab: the owner can leave the meeting and come back.
  const [selected, setSelectedState] = useState<string | null>(() =>
    readSelectedThread(meetingId),
  );
  const setSelected = (v: string | null): void => {
    rememberSelectedThread(meetingId, v);
    setSelectedState(v);
  };
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<AskFailure | null>(null);
  const [slow, setSlow] = useState(false);

  const { data: threads = [] } = useQuery({
    queryKey: queryKeys.chat.threads(meetingId),
    queryFn: () => fetchThreads(meetingId),
    staleTime: 0,
  });
  const activeId =
    selected === "new" ? null : (selected ?? threads[0]?.id ?? null);

  // A turn runs on the server and goes on when the tab is away. While the
  // server says `pending`, the tab reloads the thread until the answer is in.
  const { data: detail } = useQuery({
    queryKey: queryKeys.chat.thread(activeId ?? ""),
    queryFn: () => fetchThread(activeId ?? ""),
    enabled: activeId !== null,
    refetchInterval: (query) => (query.state.data?.pending ? 1500 : false),
  });
  const messages: ChatMessage[] = activeId ? (detail?.messages ?? []) : [];
  const serverPending = activeId !== null && detail?.pending === true;

  // A turn that ended while the tab ran: the thread list has a new title.
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !serverPending) {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.chat.threads(meetingId),
      });
    }
    wasPending.current = serverPending;
  }, [serverPending, queryClient, meetingId]);

  // Meeting ids that exist. A cite of another meeting is "removed" when its
  // meeting is not in the list. Without the list the chip stays active.
  const listed = queryClient.getQueryData<MeetingListItem[]>(
    queryKeys.meetings.list,
  );
  const knownIds = useMemo(
    () => (listed ? new Set(listed.map((m) => m.id)) : null),
    [listed],
  );

  const actions: CiteActions = {
    resolve: (cite) => citeTarget(cite, meetingId, knownIds),
    open: (target: CiteTarget) => {
      if (target.kind === "transcript") onShowTranscript(target.startMs);
      else if (target.kind === "summary") onShowSummary();
      else if (target.kind === "meeting") {
        navigate(`/meetings?meeting=${encodeURIComponent(target.meetingId)}`);
      }
    },
  };

  // The "warming" text shows when a turn takes longer than 3 s.
  useEffect(() => {
    setSlow(false);
    if (pending === null) return;
    const timer = setTimeout(() => setSlow(true), ASK_WARMING_AFTER_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  const lastKey = `${messages.length}:${pending ?? ""}:${failure ? 1 : 0}:${serverPending ? 1 : 0}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on a new message
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [lastKey]);

  const send = async (raw: string): Promise<void> => {
    const check = checkQuestion(raw);
    if (!check.ok || pending !== null || serverPending) return;
    setFailure(null);
    setPending(check.text);
    setInput("");
    let threadId = activeId;
    try {
      if (threadId === null) {
        const thread = await createThread(meetingId);
        threadId = thread.id;
        // Keep the thread, so a Retry after an error uses the same thread.
        queryClient.setQueryData<ChatThreadDetail>(
          queryKeys.chat.thread(thread.id),
          { thread, messages: [], pending: true, failure: null },
        );
        setSelected(thread.id);
      }
      const reply = await postQuestion(threadId, check.text);
      queryClient.setQueryData<ChatThreadDetail | undefined>(
        queryKeys.chat.thread(threadId),
        (prev) =>
          prev && {
            ...prev,
            messages: mergeMessages(prev.messages, [
              reply.user,
              reply.assistant,
            ]),
            pending: false,
            failure: null,
          },
      );
      await queryClient.invalidateQueries({
        queryKey: queryKeys.chat.threads(meetingId),
      });
    } catch (err) {
      const status = err instanceof AskRequestError ? err.status : null;
      const reason = err instanceof AskRequestError ? err.reason : null;
      setFailure({
        question: check.text,
        view: askErrorView(status, reason),
      });
    } finally {
      setPending(null);
    }
  };

  const check = checkQuestion(input);
  const busy = pending !== null || serverPending;
  const dangling =
    pending === null && !failure
      ? danglingQuestion(messages, serverPending)
      : null;
  const empty = messages.length === 0 && !busy && !failure;

  const threadLabel = (thread: ChatThread): string =>
    threadTitle(thread) ??
    t("meetings.ask.threadUntitled", {
      date: new Intl.DateTimeFormat(i18n.language, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(thread.created_at)),
    });

  return (
    <section
      className="flex min-w-0 flex-col gap-3"
      data-testid="meeting-ask"
      aria-label={t("meetings.ask.title")}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span
          className="text-foreground text-[12.5px] font-medium"
          data-testid="meeting-ask-scope"
        >
          {t("meetings.ask.scopeMeeting")}
        </span>
        <span className="mono text-muted-foreground text-[9px] uppercase tracking-[0.14em]">
          {t("meetings.ask.experimental")}
        </span>
        <div className="flex-1" />
        {threads.length > 0 && (
          <Select
            value={activeId ?? ""}
            onValueChange={(v) => {
              setFailure(null);
              setSelected(v);
            }}
            disabled={busy}
          >
            <SelectTrigger
              className="w-56 max-w-full"
              aria-label={t("meetings.ask.threads")}
              data-testid="meeting-ask-threads"
            >
              <SelectValue placeholder={t("meetings.ask.threadNew")} />
            </SelectTrigger>
            <SelectContent>
              {threads.map((th) => (
                <SelectItem key={th.id} value={th.id}>
                  {threadLabel(th)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={busy || (activeId === null && !failure)}
          onClick={() => {
            setFailure(null);
            setSelected("new");
          }}
          data-testid="meeting-ask-new"
        >
          <Plus data-icon="inline-start" />
          {t("meetings.ask.newChat")}
        </Button>
      </div>

      <div
        className="flex max-h-[min(60vh,34rem)] min-h-24 flex-col gap-3 overflow-y-auto pr-1 text-[12.5px] leading-snug"
        data-testid="meeting-ask-messages"
      >
        {empty && (
          <div className="flex flex-col items-start gap-2">
            <p className="text-muted-foreground m-0">
              {t("meetings.ask.empty")}
            </p>
            <div className="flex flex-wrap gap-2">
              {EXAMPLE_KEYS.map((key) => (
                <Button
                  key={key}
                  variant="outline"
                  size="sm"
                  className="h-auto max-w-full py-1 whitespace-normal"
                  onClick={() => setInput(t(`meetings.ask.${key}`))}
                  data-testid="meeting-ask-example"
                >
                  {t(`meetings.ask.${key}`)}
                </Button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} data-testid={`meeting-ask-${m.role}`}>
            {m.role === "user" ? (
              <UserBubble text={m.content} />
            ) : (
              <AskAnswer message={m} actions={actions} />
            )}
          </div>
        ))}
        {busy && unsavedQuestion(messages, pending) !== null && (
          <div data-testid="meeting-ask-user">
            <UserBubble text={pending ?? ""} />
          </div>
        )}
        {dangling !== null && (
          <AskError
            view={askErrorView(null, null)}
            onRetry={() => void send(dangling)}
            onModels={() => navigate("/settings/models")}
            onSettings={() => navigate("/settings#meetings")}
          />
        )}
        {failure && (
          <>
            {unsavedQuestion(messages, failure.question) !== null && (
              <div data-testid="meeting-ask-user">
                <UserBubble text={failure.question} />
              </div>
            )}
            <AskError
              view={failure.view}
              onRetry={() => void send(failure.question)}
              onModels={() => navigate("/settings/models")}
              onSettings={() => navigate("/settings#meetings")}
            />
          </>
        )}
        <div ref={endRef} />
      </div>

      {/* The status text is a polite live region. It is always in the page, so
          a screen reader hears each change. The answer is not repeated here. */}
      <div
        role="status"
        aria-live="polite"
        className="text-muted-foreground min-h-4 text-[12px]"
        data-testid="meeting-ask-status"
      >
        {busy &&
          (slow ? t("meetings.ask.warming") : t("meetings.ask.thinking"))}
      </div>

      <div className="flex shrink-0 flex-col gap-1">
        <div className="flex items-end gap-2">
          <Textarea
            value={input}
            maxLength={CHAT_QUESTION_MAX_CHARS}
            rows={2}
            disabled={busy}
            placeholder={t("meetings.ask.placeholder")}
            aria-label={t("meetings.ask.inputLabel")}
            className="min-h-10 max-h-40 resize-none text-[13px]"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                void send(input);
              }
            }}
            data-testid="meeting-ask-input"
          />
          <Button
            size="sm"
            disabled={!check.ok || busy}
            onClick={() => void send(input)}
            data-testid="meeting-ask-send"
          >
            {t("meetings.ask.send")}
          </Button>
        </div>
        <span className="text-muted-foreground text-[11px]">
          {t("meetings.ask.hint", { max: CHAT_QUESTION_MAX_CHARS })}
        </span>
      </div>
    </section>
  );
}

function UserBubble({ text }: { text: string }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="flex justify-end">
      <p
        className={cn(
          "bg-muted text-foreground m-0 max-w-[85%] rounded-lg px-3 py-1.5 break-words whitespace-pre-wrap",
        )}
      >
        <span className="sr-only">{t("meetings.ask.you")}: </span>
        {text}
      </p>
    </div>
  );
}

function AskError({
  view,
  onRetry,
  onModels,
  onSettings,
}: {
  view: AskErrorView;
  onRetry: () => void;
  onModels: () => void;
  onSettings: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div
      className="border-destructive/40 bg-destructive/10 text-destructive flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2"
      data-testid="meeting-ask-error"
      data-error={view.key}
    >
      <span className="min-w-0 flex-1">{t(`meetings.ask.${view.key}`)}</span>
      {view.action === "retry" && (
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          data-testid="meeting-ask-retry"
        >
          {t("meetings.ask.retry")}
        </Button>
      )}
      {view.action === "models" && (
        <Button
          variant="outline"
          size="sm"
          onClick={onModels}
          data-testid="meeting-ask-open-models"
        >
          {t("meetings.ask.openModels")}
        </Button>
      )}
      {view.action === "settings" && (
        <Button
          variant="outline"
          size="sm"
          onClick={onSettings}
          data-testid="meeting-ask-open-settings"
        >
          {t("meetings.ask.openSettings")}
        </Button>
      )}
    </div>
  );
}
