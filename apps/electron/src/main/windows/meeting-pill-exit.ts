/**
 * The wait between a meeting stop and the hide of the pill. The renderer
 * plays the quiet exit of the meeting capsule, then sends
 * `pill:meeting-exit-done` (specs/voice-pill-motion.md: the renderer owns
 * the end of what it shows). If that message does not come, the fallback
 * timer hides the pill. The hide happens only when `canHide()` is true, so a
 * dictation that took the pill during the exit keeps it.
 */
export interface MeetingPillExit {
  /** The meeting stopped: wait for the renderer. A second call does nothing. */
  start(): void;
  /** The renderer ended the exit. Does nothing when no wait runs. */
  done(): void;
  /** A new meeting records: stop the wait and do not hide. */
  cancel(): void;
}

export function createMeetingPillExit({
  fallbackMs,
  canHide,
  hide,
}: {
  fallbackMs: number;
  canHide: () => boolean;
  hide: () => void;
}): MeetingPillExit {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const finish = (): void => {
    if (!timer) return;
    cancel();
    if (canHide()) hide();
  };

  return {
    start: () => {
      if (timer) return;
      timer = setTimeout(finish, fallbackMs);
    },
    done: finish,
    cancel,
  };
}
