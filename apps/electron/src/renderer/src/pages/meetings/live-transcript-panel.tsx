import { getClient } from "@renderer/lib/api";
import { cn } from "@renderer/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

/** The live panel asks the server for new text about once each second. */
const LIVE_POLL_MS = 1000;

export function formatLiveTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** The live state of a recording (issue #375). Shared by the two panels. */
export function useLiveTranscript(meetingId: string | null) {
  return useQuery({
    queryKey: ["meetings", "live", meetingId],
    enabled: !!meetingId,
    refetchInterval: LIVE_POLL_MS,
    queryFn: async () => {
      const res = await getClient().api.meetings[":id"].live.$get({
        param: { id: meetingId ?? "" },
      });
      if (!res.ok) throw new Error("Failed to load the live transcript");
      return await res.json();
    },
  });
}

/**
 * Live transcript inside the recording card. Experimental: the parent shows
 * it only while the setting is on. It shows the final lines and one grey
 * partial line for each channel.
 */
export function LiveTranscriptPanel({
  meetingId,
}: {
  meetingId: string | null;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const { data } = useLiveTranscript(meetingId);
  const endRef = useRef<HTMLDivElement>(null);
  const lineCount = data?.lines.length ?? 0;

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new lines
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [lineCount]);

  // "off": the setting was off when the recording started.
  if (!data || data.status === "off") return null;

  return (
    <div
      className="border-border mt-4 border-t pt-3"
      data-testid="live-transcript"
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="text-foreground text-[12px] font-medium">
          {t("meetings.liveChat.transcriptTitle")}
        </span>
        <span className="mono text-muted-foreground text-[9px] uppercase tracking-[0.14em]">
          {t("meetings.liveChat.experimental")}
        </span>
      </div>
      {data.status === "unavailable" ? (
        <p
          className="text-muted-foreground text-[12px]"
          data-testid="live-unavailable"
        >
          {t("meetings.liveChat.unavailable")}
        </p>
      ) : (
        <div className="max-h-48 overflow-y-auto pr-1 text-[12.5px] leading-snug">
          {data.status === "warming" && data.lines.length === 0 && (
            <p className="text-muted-foreground" data-testid="live-warming">
              {t("meetings.liveChat.warming")}
            </p>
          )}
          {data.lines.map((line) => (
            <p
              key={`${line.source}-${line.startMs}-${line.final}`}
              className={cn(
                "py-0.5",
                line.final ? "text-foreground" : "text-muted-foreground",
              )}
              data-testid={line.final ? "live-line" : "live-partial"}
            >
              <span className="mono text-muted-foreground mr-2 text-[10px] tabular-nums">
                {formatLiveTime(line.startMs)}
              </span>
              <span className="mono text-muted-foreground mr-2 text-[9px] uppercase tracking-[0.14em]">
                {line.source === "mic"
                  ? t("meetings.liveChat.sourceMe")
                  : t("meetings.liveChat.sourceThem")}
              </span>
              {line.text}
            </p>
          ))}
          <div ref={endRef} />
        </div>
      )}
    </div>
  );
}
