import {
  usePersistentBool,
  usePersistentState,
} from "@renderer/hooks/use-persistent-state";
import { useCallback } from "react";

export const STATS_WIDTH_MIN = 260;
export const STATS_WIDTH_MAX = 480;

/** Open state and width of the History stats sidebar. */
export function useStatsPanel(): {
  statsOpen: boolean;
  statsWidth: number;
  openStats: () => void;
  closeStats: () => void;
  onResizeStart: (e: React.PointerEvent<HTMLDivElement>) => void;
  setStatsWidth: (w: number) => void;
} {
  // Stats sidebar visibility and width. Open by default, collapsible, and
  // resizable by dragging its left edge; both persisted across sessions.
  const [statsOpen, setStatsOpen] = usePersistentBool("today.statsOpen", true);
  const openStats = useCallback(() => setStatsOpen(true), [setStatsOpen]);
  const closeStats = useCallback(() => setStatsOpen(false), [setStatsOpen]);
  const [statsWidthRaw, setStatsWidthRaw] = usePersistentState<string>(
    "today.statsWidth",
    "320",
    (v): v is string => /^\d+$/.test(v),
  );
  const statsWidth = Math.min(
    STATS_WIDTH_MAX,
    Math.max(STATS_WIDTH_MIN, Number(statsWidthRaw) || 320),
  );
  const setStatsWidth = useCallback(
    (w: number) =>
      setStatsWidthRaw(
        String(Math.min(STATS_WIDTH_MAX, Math.max(STATS_WIDTH_MIN, w))),
      ),
    [setStatsWidthRaw],
  );
  // The panel sits flush against the window's right edge, so its width is
  // simply the distance from the pointer to that edge, clamped.
  const onResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      const onMove = (ev: PointerEvent): void => {
        setStatsWidth(Math.round(window.innerWidth - ev.clientX));
      };
      const onUp = (ev: PointerEvent): void => {
        el.releasePointerCapture(ev.pointerId);
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
      };
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
    },
    [setStatsWidth],
  );

  return {
    statsOpen,
    statsWidth,
    openStats,
    closeStats,
    onResizeStart,
    setStatsWidth,
  };
}
