import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { getClient } from "@renderer/lib/api";
import { queryKeys } from "@renderer/lib/query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatLiveTime } from "./live-transcript-panel";

/** A first answer that takes longer than this shows the "warming" text. */
const WARMING_AFTER_MS = 3000;

interface Cite {
  label: string;
  kind: "live" | "past" | "folder";
  title?: string | null;
  timeMs?: number | null;
}

/** A message in the list: saved by the server, or shown while it is sent. */
export type ChatListMessage = {
  key: string;
  role: "user" | "assistant" | "error";
  content: string;
  cites: Cite[];
};

/**
 * The saved chat of a meeting (`GET /api/meetings/:id/chat`). The server keeps
 * it, so it survives a page change and can be read after Stop. The query cache
 * keeps it while the panel is not on screen.
 */
export function useChatMessages(meetingId: string | null) {
  return useQuery({
    queryKey: queryKeys.meetings.chat(meetingId ?? ""),
    enabled: !!meetingId,
    staleTime: 0,
    queryFn: async (): Promise<ChatListMessage[]> => {
      const res = await getClient().api.meetings[":id"].chat.$get({
        param: { id: meetingId ?? "" },
      });
      if (!res.ok) throw new Error("Failed to load the chat");
      const { messages } = await res.json();
      return messages.map((m) => ({
        key: `saved-${m.id}`,
        role: m.role,
        content: m.content,
        cites: m.cites as Cite[],
      }));
    },
  });
}

function CiteChip({ cite }: { cite: Cite }): React.JSX.Element {
  const { t } = useTranslation();
  const time = cite.timeMs != null ? formatLiveTime(cite.timeMs) : "";
  let text: string;
  if (cite.kind === "live") {
    text = t("meetings.liveChat.citeLive", { time });
  } else if (cite.kind === "folder") {
    text = t("meetings.liveChat.citeFolder");
  } else {
    text = time
      ? t("meetings.liveChat.citePast", {
          title: cite.title ?? "",
          time,
        })
      : (cite.title ?? "");
  }
  return (
    <span
      className="border-border bg-muted text-muted-foreground mono rounded-md border px-1.5 py-0.5 text-[10px]"
      data-testid="live-chat-cite"
    >
      {cite.label} · {text}
    </span>
  );
}

/** The messages with their cite chips. The live panel and the saved chat of a
 * finished meeting both use it. */
export function ChatMessageList({
  messages,
}: {
  messages: ChatListMessage[];
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <>
      {messages.map((m) => (
        <div key={m.key} data-testid={`live-chat-${m.role}`}>
          <span className="mono text-muted-foreground mr-2 text-[9px] uppercase tracking-[0.14em]">
            {m.role === "user"
              ? t("meetings.liveChat.you")
              : t("meetings.liveChat.answer")}
          </span>
          <span
            className={
              m.role === "error" ? "text-destructive" : "text-foreground"
            }
          >
            {m.content}
          </span>
          {m.role === "assistant" && m.cites.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {m.cites.map((c) => (
                <CiteChip key={c.label} cite={c} />
              ))}
            </div>
          )}
        </div>
      ))}
    </>
  );
}

/**
 * Chat panel in the right column of the live view (issue #375, experimental).
 * One question gives one JSON answer; there is no token streaming. The server
 * saves each answered question with the meeting, so the chat stays when the
 * panel unmounts (a click on another meeting, another page) and the user can
 * read it after Stop. The input stays at the bottom of the column.
 */
export function LiveChatPanel({
  meetingId,
}: {
  meetingId: string | null;
}): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const endRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState("");
  // The question while the answer is on its way, and a failed answer. The
  // server saves only answered questions.
  const [sending, setSending] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const { data: saved = [] } = useChatMessages(meetingId);
  const answered = saved.some((m) => m.role === "assistant");
  const [slow, setSlow] = useState(false);

  const ask = useMutation({
    mutationFn: async (question: string) => {
      const res = await getClient().api.meetings[":id"].chat.$post({
        param: { id: meetingId ?? "" },
        json: { question },
      });
      if (res.status === 409) {
        setUnavailable(true);
        return null;
      }
      if (!res.ok) throw new Error("chat failed");
      return await res.json();
    },
    onSuccess: async () => {
      // The server saved the pair. Load it, then drop the local copy.
      await queryClient.invalidateQueries({
        queryKey: queryKeys.meetings.chat(meetingId ?? ""),
      });
      setSending(null);
    },
    onError: (_err, question) => {
      setSending(null);
      setFailed(question);
    },
  });

  const messages: ChatListMessage[] = [
    ...saved,
    ...(sending
      ? [
          {
            key: "sending",
            role: "user" as const,
            content: sending,
            cites: [],
          },
        ]
      : []),
    ...(failed
      ? [
          {
            key: "failed-question",
            role: "user" as const,
            content: failed,
            cites: [],
          },
          {
            key: "failed",
            role: "error" as const,
            content: t("meetings.liveChat.chatError"),
            cites: [],
          },
        ]
      : []),
  ];

  const pending = ask.isPending;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new messages
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [messages.length, pending]);
  useEffect(() => {
    setSlow(false);
    if (!pending) return;
    const timer = setTimeout(() => setSlow(true), WARMING_AFTER_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  const send = (): void => {
    const question = input.trim();
    if (!question || !meetingId || ask.isPending) return;
    setFailed(null);
    setSending(question);
    setInput("");
    ask.mutate(question);
  };

  return (
    <section
      className="flex min-h-0 flex-1 flex-col"
      data-testid="live-chat"
      aria-label={t("meetings.liveChat.chatTitle")}
    >
      <div className="mb-2 flex shrink-0 items-center gap-2">
        <span className="text-foreground text-[12px] font-medium">
          {t("meetings.liveChat.chatTitle")}
        </span>
        <span className="mono text-muted-foreground text-[9px] uppercase tracking-[0.14em]">
          {t("meetings.liveChat.experimental")}
        </span>
      </div>
      {unavailable ? (
        <p
          className="text-muted-foreground text-[12px]"
          data-testid="live-chat-unavailable"
        >
          {t("meetings.liveChat.chatUnavailable")}
        </p>
      ) : (
        <>
          <div className="mb-2 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1 text-[12.5px] leading-snug">
            {messages.length === 0 && (
              <p className="text-muted-foreground">
                {t("meetings.liveChat.chatEmpty")}
              </p>
            )}
            <ChatMessageList messages={messages} />
            {ask.isPending && (
              <p
                className="text-muted-foreground"
                data-testid={
                  slow && !answered ? "live-chat-warming" : "live-chat-thinking"
                }
              >
                {slow && !answered
                  ? t("meetings.liveChat.chatWarming")
                  : t("meetings.liveChat.chatThinking")}
              </p>
            )}
            <div ref={endRef} />
          </div>
          <div className="flex shrink-0 gap-2">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") send();
              }}
              placeholder={t("meetings.liveChat.chatPlaceholder")}
              aria-label={t("meetings.liveChat.chatTitle")}
              data-testid="live-chat-input"
            />
            <Button
              size="sm"
              onClick={send}
              disabled={!input.trim() || ask.isPending || !meetingId}
              data-testid="live-chat-send"
            >
              {t("meetings.liveChat.chatSend")}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
