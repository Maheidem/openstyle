import { useEffect, useState } from "react";
import type { PillState } from "./constants";

/**
 * The start time (epoch ms) of the meeting that records now, or null. The
 * main process sends it, so the pill and the Meetings page show the same
 * elapsed time.
 */
export function useMeetingStartedAt(): number | null {
  const [startedAt, setStartedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    // The pill window can load while a meeting already records.
    void window.api
      ?.getMeetingStatus?.()
      .then((s) => {
        if (!cancelled)
          setStartedAt(s.status === "recording" ? s.startedAt : null);
      })
      .catch(() => {});
    const remove = window.api?.onMeetingStatusChanged?.((status, start) => {
      // An event is newer than the first reply, so ignore that reply.
      cancelled = true;
      setStartedAt(status === "recording" ? start : null);
    });
    return () => {
      cancelled = true;
      remove?.();
    };
  }, []);

  return startedAt;
}

/**
 * Which capsule the pill shows. A dictation always takes over the pill. The
 * meeting Recording state shows only while no dictation runs.
 */
export function pillSurface(
  state: PillState,
  meetingStartedAt: number | null,
): "dictation" | "meeting" | null {
  if (state !== "idle") return "dictation";
  return meetingStartedAt === null ? null : "meeting";
}
