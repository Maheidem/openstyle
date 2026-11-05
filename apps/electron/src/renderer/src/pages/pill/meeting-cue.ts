import { useEffect, useState } from "react";
import { QUIET_MS } from "../pill-motion";
import type { PillState } from "./constants";

/** What the pill shows of a meeting. */
export interface MeetingCue {
  /** The start time (epoch ms) of the meeting that the capsule shows, or null. */
  startedAt: number | null;
  /** The time (epoch ms) of the running pause, or null. */
  pausedAt: number | null;
  /** True while the capsule plays its exit after a stop. */
  leaving: boolean;
}

const NO_MEETING: MeetingCue = {
  startedAt: null,
  pausedAt: null,
  leaving: false,
};

/**
 * The next cue for a meeting status. A stop keeps the last start time and
 * sets `leaving`, so the capsule can play its exit before it unmounts.
 */
export function nextMeetingCue(
  prev: MeetingCue,
  status: string,
  startedAt: number | null,
  pausedAt: number | null = null,
): MeetingCue {
  if (status === "recording" && startedAt !== null) {
    return { startedAt, pausedAt, leaving: false };
  }
  if (prev.startedAt === null || prev.leaving) return prev;
  return { ...prev, leaving: true };
}

/**
 * The meeting that the pill shows. The main process sends the start time, so
 * the pill and the Meetings page show the same elapsed time. After a stop,
 * the capsule plays the quiet exit for QUIET_MS. Then the cue clears and the
 * renderer tells main that it can hide the pill.
 */
export function useMeetingCue(): MeetingCue {
  const [cue, setCue] = useState<MeetingCue>(NO_MEETING);

  useEffect(() => {
    let cancelled = false;
    // The pill window can load while a meeting already records.
    void window.api
      ?.getMeetingStatus?.()
      .then((s) => {
        if (!cancelled && s.status === "recording")
          setCue({
            startedAt: s.startedAt,
            pausedAt: s.pausedAt ?? null,
            leaving: false,
          });
      })
      .catch(() => {});
    const remove = window.api?.onMeetingStatusChanged?.(
      (status, start, pausedAt) => {
        // An event is newer than the first reply, so ignore that reply.
        cancelled = true;
        setCue((prev) => nextMeetingCue(prev, status, start, pausedAt));
      },
    );
    return () => {
      cancelled = true;
      remove?.();
    };
  }, []);

  useEffect(() => {
    if (!cue.leaving) return;
    const timer = setTimeout(() => {
      setCue(NO_MEETING);
      window.api?.meetingPillExitDone?.();
    }, QUIET_MS);
    return () => clearTimeout(timer);
  }, [cue.leaving]);

  return cue;
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
