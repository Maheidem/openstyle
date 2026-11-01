import {
  CHAT_QUESTION_MAX_CHARS,
  type ChatMessage,
  type ChatScope,
  type ChatThread,
  type ChatThreadDetail,
  type ChatWider,
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
import { queryKeys } from "@renderer/lib/query";
import { cn } from "@renderer/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import {
  AskRequestError,
  createThread,
  fetchThread,
  fetchThreads,
  postQuestion,
} from "./ask-api";
import { AskAnswer, type CiteActions } from "./ask-blocks";
import {
  ASK_WARMING_AFTER_MS,
  type AskErrorView,
  askErrorView,
  checkQuestion,
  danglingQuestion,
  mergeMessages,
  readSelectedThread,
  rememberSelectedThread,
  scopeKey,
  threadTitle,
  unsavedQuestion,
  widenedScope,
  widerOffer,
} from "./ask-model";

/** The three example questions. Each one fills the composer. */
const EXAMPLE_KEYS = ["exampleDecisions", "exampleActions", "exampleStatus"];

/** A failed turn. The question stays on screen. */
interface AskFailure {
  /** The question to send again. Null for a failed widen turn. */
  question: string | null;
  view: AskErrorView;
}

/** The words that depend on the scope. */
export interface AskPanelStrings {
  title: string;
  empty: string;
  placeholder: string;
  threads: string;
}

export interface AskPanelProps {
  scope: ChatScope;
  /** The scope in words, for the line above the conversation. */
  scopeText: string;
  strings: AskPanelStrings;
  actions: CiteActions;
  /** How the thread list shows: a dropdown (tabs) or a column (Ask page). */
  threads: "select" | "list";
  /** A thread to open first (the Ask page gets it from the URL). */
  initialThreadId?: string | null;
  /** The name of a folder, for the line "Searched in: ...". */
  folderName?: (id: string) => string | null;
  /** The thread in view changed. null: an empty chat. */
  onThread?: (id: string | null) => void;
}

/**
 * The Ask conversation of one scope (specs/meeting-chat-agent.md 11.6). The
 * meeting tab, the folder tab and the Ask page all show it. The scope is
 * fixed by the page that shows it; a new scope is a new panel (`key`).
 * One question gives one answer. The server does not stream, so the panel
 * shows a status text while it waits.
 */
export function AskPanel({
  scope,
  scopeText,
  strings,
  actions,
  threads: threadsMode,
  initialThreadId = null,
  folderName,
  onThread,
}: AskPanelProps): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const endRef = useRef<HTMLDivElement>(null);
  const key = scopeKey(scope);

  // null: the newest thread. "new": an empty chat. Else: a thread id. The
  // choice outlives the panel: the user can leave and come back.
  const [selected, setSelectedState] = useState<string | null>(
    () => initialThreadId ?? readSelectedThread(key),
  );
  const setSelected = (v: string | null): void => {
    rememberSelectedThread(key, v);
    setSelectedState(v);
  };
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [widening, setWidening] = useState(false);
  const [failure, setFailure] = useState<AskFailure | null>(null);
  const [slow, setSlow] = useState(false);

  const { data: threads = [] } = useQuery({
    queryKey: queryKeys.chat.threads(key),
    queryFn: () => fetchThreads(scope),
    staleTime: 0,
  });
  const activeId =
    selected === "new" ? null : (selected ?? threads[0]?.id ?? null);

  useEffect(() => {
    onThread?.(activeId);
  }, [activeId, onThread]);

  // A turn runs on the server and goes on when the panel is away. While the
  // server says `pending`, the panel reloads the thread until the answer is in.
  const { data: detail } = useQuery({
    queryKey: queryKeys.chat.thread(activeId ?? ""),
    queryFn: () => fetchThread(activeId ?? ""),
    enabled: activeId !== null,
    refetchInterval: (query) => (query.state.data?.pending ? 1500 : false),
  });
  const messages: ChatMessage[] = activeId ? (detail?.messages ?? []) : [];
  const serverPending = activeId !== null && detail?.pending === true;

  // A turn that ended while the panel ran: the thread list has a new title.
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !serverPending) {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.chat.threads(key),
      });
    }
    wasPending.current = serverPending;
  }, [serverPending, queryClient, key]);

  const working = pending !== null || widening;

  // The "warming" text shows when a turn takes longer than 3 s.
  useEffect(() => {
    setSlow(false);
    if (!working) return;
    const timer = setTimeout(() => setSlow(true), ASK_WARMING_AFTER_MS);
    return () => clearTimeout(timer);
  }, [working]);

  const lastKey = `${messages.length}:${pending ?? ""}:${widening ? 1 : 0}:${failure ? 1 : 0}:${serverPending ? 1 : 0}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on a new message
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [lastKey]);

  /** Put a reply into the thread cache, once each message. */
  const storeReply = (
    threadId: string,
    reply: { user: ChatMessage; assistant: ChatMessage },
  ): void => {
    queryClient.setQueryData<ChatThreadDetail | undefined>(
      queryKeys.chat.thread(threadId),
      (prev) =>
        prev && {
          ...prev,
          messages: mergeMessages(prev.messages, [reply.user, reply.assistant]),
          pending: false,
          failure: null,
        },
    );
  };

  const failureView = (err: unknown): AskErrorView =>
    askErrorView(
      err instanceof AskRequestError ? err.status : null,
      err instanceof AskRequestError ? err.reason : null,
    );

  const send = async (raw: string): Promise<void> => {
    const check = checkQuestion(raw);
    if (!check.ok || working || serverPending) return;
    setFailure(null);
    setPending(check.text);
    setInput("");
    let threadId = activeId;
    try {
      if (threadId === null) {
        const thread = await createThread(scope);
        threadId = thread.id;
        // Keep the thread, so a Retry after an error uses the same thread.
        queryClient.setQueryData<ChatThreadDetail>(
          queryKeys.chat.thread(thread.id),
          { thread, messages: [], pending: true, failure: null },
        );
        setSelected(thread.id);
      }
      storeReply(
        threadId,
        await postQuestion(threadId, { question: check.text }),
      );
      await queryClient.invalidateQueries({
        queryKey: queryKeys.chat.threads(key),
      });
    } catch (err) {
      setFailure({ question: check.text, view: failureView(err) });
    } finally {
      setPending(null);
    }
  };

  /** The user confirmed one step wider (D16). The server checks the offer. */
  const widen = async (): Promise<void> => {
    if (activeId === null || working || serverPending) return;
    setFailure(null);
    setWidening(true);
    try {
      storeReply(activeId, await postQuestion(activeId, { widen: true }));
      await queryClient.invalidateQueries({
        queryKey: queryKeys.chat.threads(key),
      });
    } catch (err) {
      setFailure({ question: null, view: failureView(err) });
    } finally {
      setWidening(false);
    }
  };

  const check = checkQuestion(input);
  const busy = working || serverPending;
  const dangling =
    !working && !failure ? danglingQuestion(messages, serverPending) : null;
  const empty = messages.length === 0 && !busy && !failure;
  const lastAssistantId = messages.findLast((m) => m.role === "assistant")?.id;

  const threadLabel = (thread: ChatThread): string =>
    threadTitle(thread) ??
    t("meetings.ask.threadUntitled", {
      date: new Intl.DateTimeFormat(i18n.language, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(thread.created_at)),
    });

  /** "Searched in: ..." under an answer from a wider scope. */
  const scopeNote = (message: ChatMessage): string | null => {
    const used = widenedScope(message, scope);
    if (!used) return null;
    if (used.kind === "all") return t("meetings.ask.searchedEverything");
    const name = used.kind === "folder" ? folderName?.(used.id) : null;
    return name
      ? t("meetings.ask.searchedFolder", { name })
      : t("meetings.ask.searchedWider");
  };

  const onWiden = (_wider: ChatWider): void => void widen();

  const newChat = (
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
  );

  const conversation = (
    <div className="flex min-w-0 flex-1 flex-col gap-3">
      <div
        className="flex max-h-[min(60vh,34rem)] min-h-24 flex-col gap-3 overflow-y-auto pr-1 text-[12.5px] leading-snug"
        data-testid="meeting-ask-messages"
      >
        {empty && (
          <div className="flex flex-col items-start gap-2">
            <p className="text-muted-foreground m-0">{strings.empty}</p>
            <div className="flex flex-wrap gap-2">
              {EXAMPLE_KEYS.map((exampleKey) => (
                <Button
                  key={exampleKey}
                  variant="outline"
                  size="sm"
                  className="h-auto max-w-full py-1 whitespace-normal"
                  onClick={() => setInput(t(`meetings.ask.${exampleKey}`))}
                  data-testid="meeting-ask-example"
                >
                  {t(`meetings.ask.${exampleKey}`)}
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
              <AskAnswer
                message={m}
                actions={actions}
                scopeNote={scopeNote(m)}
                {...(m.id === lastAssistantId && !busy && widerOffer(m)
                  ? { onWiden }
                  : {})}
              />
            )}
          </div>
        ))}
        {pending !== null && unsavedQuestion(messages, pending) !== null && (
          <div data-testid="meeting-ask-user">
            <UserBubble text={pending} />
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
            {failure.question !== null &&
              unsavedQuestion(messages, failure.question) !== null && (
                <div data-testid="meeting-ask-user">
                  <UserBubble text={failure.question} />
                </div>
              )}
            <AskError
              view={failure.view}
              onRetry={() =>
                void (failure.question === null
                  ? widen()
                  : send(failure.question))
              }
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
            placeholder={strings.placeholder}
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
    </div>
  );

  return (
    <section
      className="flex min-w-0 flex-col gap-3"
      data-testid="meeting-ask"
      data-scope={key}
      aria-label={strings.title}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span
          className="text-foreground text-[12.5px] font-medium"
          data-testid="meeting-ask-scope"
        >
          {scopeText}
        </span>
        <span className="mono text-muted-foreground text-[9px] uppercase tracking-[0.14em]">
          {t("meetings.ask.experimental")}
        </span>
        <div className="flex-1" />
        {threadsMode === "select" && threads.length > 0 && (
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
              aria-label={strings.threads}
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
        {newChat}
      </div>

      {threadsMode === "list" ? (
        <div className="flex min-w-0 flex-col gap-4 min-[820px]:flex-row">
          <nav
            aria-label={strings.threads}
            className="flex shrink-0 flex-col gap-1 min-[820px]:w-56"
            data-testid="ask-thread-list"
          >
            {threads.length === 0 ? (
              <p className="text-muted-foreground m-0 text-[12px]">
                {t("meetings.ask.noThreads")}
              </p>
            ) : (
              <ul className="m-0 flex max-h-[min(60vh,34rem)] list-none flex-col gap-1 overflow-y-auto p-0">
                {threads.map((th) => (
                  <li key={th.id}>
                    <button
                      type="button"
                      disabled={busy}
                      aria-current={th.id === activeId ? "true" : undefined}
                      onClick={() => {
                        setFailure(null);
                        setSelected(th.id);
                      }}
                      data-testid="ask-thread-item"
                      className={cn(
                        "w-full rounded-md px-2.5 py-1.5 text-left text-[12.5px] leading-snug break-words",
                        "hover:bg-muted focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none",
                        "disabled:cursor-not-allowed disabled:opacity-60",
                        th.id === activeId
                          ? "bg-muted text-foreground font-medium"
                          : "text-muted-foreground",
                      )}
                    >
                      {threadLabel(th)}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </nav>
          {conversation}
        </div>
      ) : (
        conversation
      )}
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
