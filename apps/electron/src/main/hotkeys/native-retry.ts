// Retry for a native key listener that failed for good. The caller keeps
// its fallback while this runs. One shared rule for the dictation, Remix
// and language listeners.
import { createAppLogger, errorMessage } from "@openstyle/utils";

const log = createAppLogger("hotkey");

/** Minimum time between two retries. Never retry faster than this. */
export const NATIVE_RETRY_INTERVAL_MS = 60_000;

/**
 * The wait between retries. Only a test run (OPENSTYLE_E2E=1) can shorten it,
 * with OPENSTYLE_E2E_HOTKEY_RETRY_MS. A real run always waits 60 s.
 */
function retryIntervalMs(): number {
  const override = Number(process.env.OPENSTYLE_E2E_HOTKEY_RETRY_MS);
  if (process.env.OPENSTYLE_E2E === "1" && override > 0) return override;
  return NATIVE_RETRY_INTERVAL_MS;
}

interface NativeRetryOptions {
  /** Name used in the log line, for example "Dictation". */
  label: string;
  /** Start a new native listener. Resolve true on READY, false on failure. */
  attempt: () => Promise<boolean>;
  /** Called after READY. Remove the fallback and restore hold mode here. */
  onRecovered: () => void;
}

/**
 * Wait 60 s, run `attempt`, and repeat after each failure. The next wait
 * starts after the attempt ends, so retries never overlap. Returns a
 * function that cancels the retry.
 */
export function startNativeRetry(options: NativeRetryOptions): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (): void => {
    timer = setTimeout(() => void run(), retryIntervalMs());
  };

  const run = async (): Promise<void> => {
    timer = null;
    let ready = false;
    try {
      ready = await options.attempt();
    } catch (err) {
      log.warn(
        `${options.label} key listener retry failed: ${errorMessage(err)}`,
      );
    }
    if (cancelled) return;
    if (!ready) {
      schedule();
      return;
    }
    options.onRecovered();
    log.info(`${options.label} key listener recovered; hold mode restored.`);
  };

  schedule();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
