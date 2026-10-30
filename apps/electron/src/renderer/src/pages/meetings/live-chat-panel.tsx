import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { getClient } from "@renderer/lib/api";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatLiveTime } from "./live-transcript-panel";

/** The server keeps the last 4 turns of the chat. */
const HISTORY_TURNS = 4;
/** A first answer that takes longer than this shows the "warming" text. */
const WARMING_AFTER_MS = 3000;

interface Cite {
  label: string;
  kind: "live" | "past" | "folder";
  title?: string | null;
  timeMs?: number | null;
}

type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; cites: Cite[]; ms: number }
  | { role: "error"; content: string };

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

/**
 * Chat panel in the right column of the live view (issue #375, experimental).
 * One question gives one JSON answer; there is no token streaming and nothing
 * is stored. The input stays at the bottom of the column.
 */
export function LiveChatPanel({
  meetingId,
}: {
  meetingId: string | null;
}): React.JSX.Element {
  const { t } = useTranslation();
  const endRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const answered = messages.some((m) => m.role === "assistant");
  const [slow, setSlow] = useState(false);

  const ask = useMutation({
    mutationFn: async (question: string) => {
      const history = messages
        .filter(
          (m): m is Exclude<Message, { role: "error" }> => m.role !== "error",
        )
        .slice(-HISTORY_TURNS)
        .map((m) => ({ role: m.role, content: m.content }));
      const res = await getClient().api.meetings[":id"].chat.$post({
        param: { id: meetingId ?? "" },
        json: { question, history },
      });
      if (res.status === 409) {
        setUnavailable(true);
        return null;
      }
      if (!res.ok) throw new Error("chat failed");
      return await res.json();
    },
    onSuccess: (data) => {
      if (!data) return;
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.answer,
          cites: data.cites as Cite[],
          ms: data.ms,
        },
      ]);
    },
    onError: () => {
      setMessages((prev) => [
        ...prev,
        { role: "error", content: t("meetings.liveChat.chatError") },
      ]);
    },
  });

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
    setMessages((prev) => [...prev, { role: "user", content: question }]);
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
            {messages.map((m, i) => (
              <div key={i} data-testid={`live-chat-${m.role}`}>
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
