import { Card } from "@renderer/components/ui/card";
import { useElapsedClock } from "@renderer/hooks/use-elapsed-clock";
import { datedTitle } from "@renderer/lib/format";
import { useTranslation } from "react-i18next";
import { LiveChatPanel } from "./live-chat-panel";
import { LiveTranscriptPanel } from "./live-transcript-panel";
import { StatusBadge } from "./shared";

/**
 * The live view of a recording (issue #375, experimental). It fills the right
 * pane while the meeting records and the setting `live_chat_enabled` is on.
 * Left: the live transcript. Right: the chat, with the input at the bottom.
 * On a narrow pane the columns stack, transcript on top.
 */
export function LiveView({
  meetingId,
  title,
  startedAt,
  pausedAt,
}: {
  meetingId: string;
  title: string | null;
  startedAt: number | null;
  /** The time (epoch ms) of the running pause, or null. */
  pausedAt: number | null;
}): React.JSX.Element {
  const { t } = useTranslation();
  const elapsed = useElapsedClock(startedAt, pausedAt);
  return (
    <div
      className="@container flex h-full min-h-[34rem] flex-col"
      data-testid="live-view"
    >
      <header className="mb-4 flex min-w-0 shrink-0 items-center gap-3">
        <h2
          className="display min-w-0 truncate text-[20px]"
          data-testid="live-view-title"
        >
          {datedTitle(title || t("meetings.untitled"), startedAt)}
        </h2>
        <StatusBadge status="recording" />
        {pausedAt !== null && (
          <span
            className="text-muted-foreground shrink-0 text-[12px] font-medium"
            data-testid="live-view-paused"
          >
            {t("meetings.paused")}
          </span>
        )}
        <span
          className="mono text-muted-foreground shrink-0 text-[12px] tabular-nums"
          data-testid="live-view-elapsed"
        >
          {elapsed}
        </span>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 @[32rem]:grid-cols-2 @[32rem]:grid-rows-[minmax(0,1fr)]">
        <Card className="min-h-[16rem] min-w-0 px-4">
          <LiveTranscriptPanel meetingId={meetingId} />
        </Card>
        <Card className="min-h-[18rem] min-w-0 px-4">
          <LiveChatPanel meetingId={meetingId} />
        </Card>
      </div>
    </div>
  );
}
