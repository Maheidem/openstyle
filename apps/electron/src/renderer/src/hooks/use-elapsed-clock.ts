import { formatClockDuration } from "@renderer/lib/format";
import { useEffect, useState } from "react";

/** How often the clock reads the time again. Under one second, so two
 * clocks in two windows change on the same second. */
const TICK_MS = 250;

function elapsedLabel(startedAt: number | null): string {
  return formatClockDuration(
    startedAt === null ? null : Date.now() - startedAt,
  );
}

/**
 * The elapsed time since `startedAt` (epoch ms) as (h:)mm:ss. It returns
 * "0:00" when `startedAt` is null. The main process sends the start time, so
 * every window that uses this hook shows the same time.
 */
export function useElapsedClock(startedAt: number | null): string {
  const [label, setLabel] = useState(() => elapsedLabel(startedAt));

  useEffect(() => {
    setLabel(elapsedLabel(startedAt));
    if (startedAt === null) return;
    const timer = setInterval(() => setLabel(elapsedLabel(startedAt)), TICK_MS);
    return () => clearInterval(timer);
  }, [startedAt]);

  return label;
}
