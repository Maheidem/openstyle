const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Run `run` once at start and then every 24 hours. The timer does not keep
 * the process alive. An error from `run` is ignored, so one failed sweep
 * cannot stop the timer. A second `start` call does nothing.
 */
export function createDailySweep(run: () => void): {
  start: () => void;
  stop: () => void;
} {
  let timer: NodeJS.Timeout | null = null;

  const sweep = (): void => {
    try {
      run();
    } catch {
      // Never let a sweep failure kill the periodic timer.
    }
  };

  return {
    start: () => {
      if (timer) return;
      sweep();
      timer = setInterval(sweep, SWEEP_INTERVAL_MS);
      timer.unref();
    },
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
