import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { getClient } from "@renderer/lib/api";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatLiveTime } from "./live-transcript-panel";

/** The server keeps the last 4 turns of the chat. */
const HISTORY_TURNS = 4;

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
 * Chat panel in the recording view (issue #375, experimental). One question
 * gives one JSON answer; there is no token streaming and nothing is stored.
 */
export function LiveChatPanel({
  meetingId,
}: {
  meetingId: string | null;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const answered = messages.some((m) => m.role === "assistant");

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

  const send = (): void => {
    const question = input.trim();
    if (!question || !meetingId || ask.isPending) return;
    setMessages((prev) => [...prev, { role: "user", content: question }]);
    setInput("");
    ask.mutate(question);
  };

  return (
    <div className="border-border mt-4 border-t pt-3" data-testid="live-chat">
      <div className="mb-2 flex items-center gap-2">
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
          <div className="mb-2 flex max-h-56 flex-col gap-2 overflow-y-auto pr-1 text-[12.5px] leading-snug">
            {messages.length === 0 && (
              <p className="text-muted-foreground">
                {t("meetings.liveChat.chatEmpty")}
              </p>
            )}
            {messages.map((m, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: the list only grows
                key={i}
                data-testid={`live-chat-${m.role}`}
              >
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
                  answered ? "live-chat-thinking" : "live-chat-warming"
                }
              >
                {answered
                  ? t("meetings.liveChat.chatThinking")
                  : t("meetings.liveChat.chatWarming")}
              </p>
            )}
          </div>
          <div className="flex gap-2">
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
    </div>
  );
}
