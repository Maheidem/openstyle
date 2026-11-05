import { useEffect, useState } from "react";

/**
 * True while the running meeting recording is paused. It reads the status of
 * the main process once, then follows the status events.
 */
export function useRecordingPaused(): boolean {
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.api
      ?.getMeetingStatus?.()
      .then((s) => {
        if (!cancelled) setPaused(s.pausedAt != null);
      })
      .catch(() => {});
    const remove = window.api?.onMeetingStatusChanged?.(
      (_status, _startedAt, pausedAt) => {
        // An event is newer than the first reply, so ignore that reply.
        cancelled = true;
        setPaused(pausedAt != null);
      },
    );
    return () => {
      cancelled = true;
      remove?.();
    };
  }, []);

  return paused;
}
