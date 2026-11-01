import type {
  ChatMessage,
  ChatScope,
  MeetingListItem,
} from "@openstyle/validations";
import { Button } from "@renderer/components/ui/button";
import { Textarea } from "@renderer/components/ui/textarea";
import { cn } from "@renderer/lib/utils";
import type { ChatBubbleShown } from "@shared/chat-bubble";
import { MessageSquareText, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AskRequestError,
  createThread,
  postQuestion,
} from "./meetings/ask-api";
import { AskAnswer, type CiteActions } from "./meetings/ask-blocks";
import {
  ASK_WARMING_AFTER_MS,
  askErrorView,
  checkQuestion,
  citeTarget,
  widenedScope,
  widerOffer,
} from "./meetings/ask-model";
import { useMeetingsList } from "./meetings/ask-scope";
import { useMeetingFolders } from "./meetings/folders-data";

// The Ask bubble (specs/meeting-chat-agent.md 11.6, decision D19): a small
// floating window that the global hotkey opens. It shows the scope in words,
// one action to widen it, an input and a short answer with cite chips. "Open
// in Ask" continues the thread on the Ask page. Escape closes it.

/** The window is opened again by the hotkey: forget the last question. */
const EMPTY = { thread: null, question: null, answer: null } as const;

/** The scope one step wider, from the meeting list. null: nothing is wider. */
function widerScope(
  scope: ChatScope,
  meetings: readonly MeetingListItem[],
): ChatScope | null {
  if (scope.kind === "all") return null;
  if (scope.kind === "folder") return { kind: "all" };
  const folderId = meetings.find((m) => m.id === scope.id)?.folder_id ?? null;
  return folderId ? { kind: "folder", id: folderId } : { kind: "all" };
}

export default function ChatBubblePage(): React.JSX.Element {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // The scope that the next question uses. Main gives it at each open.
  const [scope, setScope] = useState<ChatScope>({ kind: "all" });
  const [threadId, setThreadId] = useState<string | null>(EMPTY.thread);
  const [threadScope, setThreadScope] = useState<ChatScope>({ kind: "all" });
  const [question, setQuestion] = useState<string | null>(EMPTY.question);
  const [answer, setAnswer] = useState<ChatMessage | null>(EMPTY.answer);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const { data: folders = [] } = useMeetingFolders(true);
  const { data: meetings = [] } = useMeetingsList();

  // Main opens the bubble with the scope of the Meetings selection. The first
  // open loads this page, and the message comes before React mounts, so the
  // page also asks main for the last open. Each open counts once.
  const appliedOpen = useRef(0);
  useEffect(() => {
    const apply = (shown: ChatBubbleShown): void => {
      if (shown.openCount <= appliedOpen.current) return;
      appliedOpen.current = shown.openCount;
      setScope(shown.scope);
      setThreadScope(shown.scope);
      setThreadId(EMPTY.thread);
      setQuestion(EMPTY.question);
      setAnswer(EMPTY.answer);
      setInput("");
      setBusy(false);
      setErrorKey(null);
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    const off = window.api.onChatBubbleShown(apply);
    void window.api.getChatBubbleState().then((shown) => {
      if (shown) apply(shown);
    });
    return off;
  }, []);

  // Escape closes the bubble (main gives the focus back).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        window.api.hideChatBubble();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // The window has no page scroll: main sizes it to the card.
  useEffect(() => {
    const { documentElement: html, body } = document;
    const before = [html.style.overflow, body.style.overflow];
    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    return () => {
      html.style.overflow = before[0] ?? "";
      body.style.overflow = before[1] ?? "";
    };
  }, []);

  // Main sizes the window to the content.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const report = (): void =>
      window.api.setChatBubbleHeight(root.getBoundingClientRect().height + 24);
    const observer = new ResizeObserver(report);
    observer.observe(root);
    report();
    return () => observer.disconnect();
  }, []);

  // The "warming" text shows when a turn takes longer than 3 s.
  useEffect(() => {
    setSlow(false);
    if (!busy) return;
    const timer = setTimeout(() => setSlow(true), ASK_WARMING_AFTER_MS);
    return () => clearTimeout(timer);
  }, [busy]);

  const folderName = useCallback(
    (id: string) => folders.find((f) => f.id === id)?.name ?? null,
    [folders],
  );
  const untitled = t("meetings.ask.untitled");
  const nameOf = (s: ChatScope): string => {
    if (s.kind === "all") return t("ask.bubble.everything");
    if (s.kind === "folder") return folderName(s.id) ?? "";
    return meetings.find((m) => m.id === s.id)?.title?.trim() || untitled;
  };
  const wider = widerScope(scope, meetings);

  const fail = (err: unknown): void => {
    const view = askErrorView(
      err instanceof AskRequestError ? err.status : null,
      err instanceof AskRequestError ? err.reason : null,
    );
    setErrorKey(view.key);
  };

  const send = async (raw: string): Promise<void> => {
    const check = checkQuestion(raw);
    if (!check.ok || busy) return;
    setErrorKey(null);
    setBusy(true);
    setQuestion(check.text);
    setInput("");
    try {
      let id = threadId;
      if (id === null) {
        const thread = await createThread(scope);
        id = thread.id;
        setThreadId(id);
        setThreadScope(scope);
      }
      const reply = await postQuestion(id, { question: check.text });
      setAnswer(reply.assistant);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  /** The user confirmed one step wider after a not-found answer (D16). */
  const widenAnswer = async (): Promise<void> => {
    if (threadId === null || busy) return;
    setErrorKey(null);
    setBusy(true);
    try {
      const reply = await postQuestion(threadId, { widen: true });
      setAnswer(reply.assistant);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const actions: CiteActions = {
    resolve: (cite) => citeTarget(cite, null, null),
    open: (target) => {
      if (target.kind === "meeting") {
        window.api.openChatBubbleCite(target.meetingId, target.startMs);
      }
    },
  };

  const scopeNote = (): string | null => {
    if (!answer) return null;
    const used = widenedScope(answer, threadScope);
    if (!used) return null;
    return used.kind === "all"
      ? t("meetings.ask.searchedEverything")
      : t("meetings.ask.searchedFolder", { name: nameOf(used) });
  };

  const check = checkQuestion(input);
  const canWiden = !busy && answer !== null && widerOffer(answer) !== null;

  return (
    <main
      ref={rootRef}
      aria-label={t("ask.bubble.label")}
      data-testid="chat-bubble"
      data-scope={scope.kind === "all" ? "all" : `${scope.kind}:${scope.id}`}
      className="border-border bg-card text-card-foreground m-3 flex flex-col gap-3 overflow-hidden rounded-[14px] border p-3 shadow-(--shadow-card)"
    >
      <header className="flex items-center gap-2">
        <MessageSquareText
          className="text-muted-foreground size-4 shrink-0"
          aria-hidden="true"
        />
        <p
          className="m-0 min-w-0 flex-1 truncate text-[12.5px] font-medium"
          data-testid="chat-bubble-scope"
          title={nameOf(scope)}
        >
          {t("ask.bubble.scopeIn", { name: nameOf(scope) })}
        </p>
        {wider && threadId === null && (
          <Button
            variant="outline"
            size="xs"
            onClick={() => setScope(wider)}
            disabled={busy}
            data-testid="chat-bubble-widen"
          >
            {wider.kind === "all"
              ? t("ask.bubble.widenEverything")
              : t("ask.bubble.widenFolder", { name: nameOf(wider) })}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t("ask.bubble.close")}
          onClick={() => window.api.hideChatBubble()}
          data-testid="chat-bubble-close"
        >
          <X />
        </Button>
      </header>

      <Textarea
        ref={inputRef}
        value={input}
        rows={1}
        autoFocus
        disabled={busy}
        placeholder={t("ask.bubble.placeholder", { name: nameOf(scope) })}
        aria-label={t("meetings.ask.inputLabel")}
        className="min-h-10 max-h-28 resize-none text-[13px]"
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send(input);
          }
        }}
        data-testid="chat-bubble-input"
      />

      {/* A polite live region: a screen reader hears the state, not the answer twice. */}
      <div
        role="status"
        aria-live="polite"
        className={cn("text-muted-foreground text-[12px]", !busy && "sr-only")}
        data-testid="chat-bubble-status"
      >
        {busy &&
          (slow ? t("meetings.ask.warming") : t("meetings.ask.thinking"))}
      </div>

      {question !== null && (
        <p
          className="text-muted-foreground m-0 text-[11.5px] break-words"
          data-testid="chat-bubble-question"
        >
          {question}
        </p>
      )}

      {errorKey && (
        <p
          className="text-destructive m-0 text-[12px]"
          role="alert"
          data-testid="chat-bubble-error"
          data-error={errorKey}
        >
          {t(`meetings.ask.${errorKey}`)}
        </p>
      )}

      {answer && (
        <div
          className="max-h-64 overflow-y-auto pr-1 text-[12.5px] leading-snug"
          data-testid="chat-bubble-answer"
        >
          <AskAnswer
            message={answer}
            actions={actions}
            scopeNote={scopeNote()}
            {...(canWiden ? { onWiden: () => void widenAnswer() } : {})}
          />
        </div>
      )}

      <footer className="flex items-center gap-2">
        <span className="text-muted-foreground min-w-0 flex-1 text-[11px]">
          {t("ask.bubble.hint")}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={threadId === null}
          onClick={() =>
            threadId && window.api.openChatBubbleThreadInAsk(threadId)
          }
          data-testid="chat-bubble-open-in-ask"
        >
          {t("ask.bubble.openInAsk")}
        </Button>
        <Button
          size="sm"
          disabled={!check.ok || busy}
          onClick={() => void send(input)}
          data-testid="chat-bubble-send"
        >
          {t("meetings.ask.send")}
        </Button>
      </footer>
    </main>
  );
}
