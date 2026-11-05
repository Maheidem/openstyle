import { formatClockDuration } from "@renderer/lib/format";
import { useEffect, useState } from "react";

/** How often the clock reads the time again. Under one second, so two
 * clocks in two windows change on the same second. */
const TICK_MS = 250;

function elapsedLabel(
  startedAt: number | null,
  pausedAt: number | null,
): string {
  return formatClockDuration(
    startedAt === null ? null : (pausedAt ?? Date.now()) - startedAt,
  );
}

/**
 * The elapsed time since `startedAt` (epoch ms) as (h:)mm:ss. It returns
 * "0:00" when `startedAt` is null. The main process sends the start time, so
 * every window that uses this hook shows the same time. The main process adds
 * the paused time to the start time, so the clock counts recorded time only.
 * While `pausedAt` (epoch ms) is set, the clock stops at that time.
 */
export function useElapsedClock(
  startedAt: number | null,
  pausedAt: number | null = null,
): string {
  const [label, setLabel] = useState(() => elapsedLabel(startedAt, pausedAt));

  useEffect(() => {
    setLabel(elapsedLabel(startedAt, pausedAt));
    if (startedAt === null || pausedAt !== null) return;
    const timer = setInterval(
      () => setLabel(elapsedLabel(startedAt, null)),
      TICK_MS,
    );
    return () => clearInterval(timer);
  }, [startedAt, pausedAt]);

  return label;
}
