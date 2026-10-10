// biome-ignore-all lint/correctness/useExhaustiveDependencies: refs, setters and callbacks come in through deps and keep one identity for the life of AppPage. The dependency lists stay as they were before the move.
import { useCallback } from "react";
import { CANCELLED_MS, DELIVERED_TOTAL_MS, QUIET_MS } from "../pill-motion";
import type { PillExit } from "./constants";
import type { PillShared } from "./pill-shared";

export type UsePillDismissDeps = Pick<
  PillShared,
  | "barModeRef"
  | "cancelModeRef"
  | "cancelOpenRef"
  | "cancelTargetRef"
  | "drainAgainRef"
  | "drainingRef"
  | "exitingRef"
  | "exitTimerRef"
  | "flatlineRef"
  | "hoveredRef"
  | "lastCancelWriteRef"
  | "pendingReRecordRef"
  | "pillActiveRef"
  | "queueRef"
  | "rafRef"
  | "recordingActiveRef"
  | "startTimeRef"
  | "streamResolverRef"
  | "streamSessionErrorRef"
  | "wantsMicRef"
  | "setCanRetry"
  | "setExiting"
  | "setPendingCount"
  | "setPillLanguageLabel"
  | "setPillNotice"
  | "setPillState"
> & { stopVisualization: () => void };

export function usePillDismiss(deps: UsePillDismissDeps) {
  const {
    barModeRef,
    cancelModeRef,
    cancelOpenRef,
    cancelTargetRef,
    drainAgainRef,
    drainingRef,
    exitingRef,
    exitTimerRef,
    flatlineRef,
    hoveredRef,
    lastCancelWriteRef,
    pendingReRecordRef,
    pillActiveRef,
    queueRef,
    rafRef,
    recordingActiveRef,
    startTimeRef,
    streamResolverRef,
    streamSessionErrorRef,
    wantsMicRef,
    setCanRetry,
    setExiting,
    setPendingCount,
    setPillLanguageLabel,
    setPillNotice,
    setPillState,
    stopVisualization,
  } = deps;

  // ---- Hide pill ----
  /**
   * Put every scrap of dictation state back to rest, without touching the pill
   * window itself. Split out of `hidePill` for the one caller that needs the
   * window left standing: the remix chord taking over a dictation that the
   * shared home key started a few milliseconds earlier, where the pill is
   * about to be reused for the remix card.
   */
  const resetDictation = useCallback(() => {
    setPillNotice(null);
    setCanRetry(false);
    setPillLanguageLabel(null);
    setPillState("idle");
    setPendingCount(0);
    wantsMicRef.current = false;
    pillActiveRef.current = false;
    queueRef.current = [];
    drainingRef.current = false;
    drainAgainRef.current = false;
    recordingActiveRef.current = false;
    streamResolverRef.current = null;
    streamSessionErrorRef.current = null;
    pendingReRecordRef.current = false;
    // Hiding removes the hovered element before onMouseLeave can fire. Reset
    // its transient reveal state so the next session does not inherit an open
    // cancel button; the "always" preference remains pinned open.
    hoveredRef.current = false;
    cancelTargetRef.current = cancelModeRef.current === "always" ? 1 : 0;
    cancelOpenRef.current = cancelTargetRef.current;
    lastCancelWriteRef.current = -1;
    setExiting(null);
    exitingRef.current = null;
    // So the next session's `initializing` frames can't read a stale clock.
    startTimeRef.current = 0;
    if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
    exitTimerRef.current = null;
    stopVisualization();
  }, [setPillNotice, stopVisualization, setPillState]);

  const hidePill = useCallback(() => {
    resetDictation();
    window.api.hidePill();
  }, [resetDictation]);

  /** Hide after the selected exit; modal/error paths still call hidePill(). */
  const dismissPill = useCallback(
    (kind: PillExit) => {
      if (!pillActiveRef.current || exitingRef.current) return;
      exitingRef.current = kind;
      recordingActiveRef.current = false;
      wantsMicRef.current = false;
      setExiting(kind);

      if (kind !== "delivered") {
        exitTimerRef.current = setTimeout(
          hidePill,
          kind === "cancelled" ? CANCELLED_MS : QUIET_MS,
        );
        return;
      }

      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      barModeRef.current = null;
      if (flatlineRef.current) flatlineRef.current.setAttribute("opacity", "0");
      exitTimerRef.current = setTimeout(hidePill, DELIVERED_TOTAL_MS);
    },
    [hidePill],
  );

  return { resetDictation, hidePill, dismissPill };
}
