import { createAppLogger } from "@openstyle/utils";
import {
  needsManagedMlxRuntimeUpdate,
  updateManagedMlxRuntimeIfNeeded,
} from "../../mlx-asr/runtime.js";

// A meeting run that stopped because the on-device engine was not ready
// (`engine_not_ready`: the MLX worker update is not installed) starts again
// when the engine is ready. One timer for all meetings: each tick tries the
// worker download once. While the update is still pending, the wait doubles
// up to MAX_DELAY_MS. When it is installed, each waiting meeting gets its
// run again.

const log = createAppLogger("engine-retry");

const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 5 * 60_000;

/** Starts the run again. "busy": a job runs, so try at the next tick. "gone": the meeting is gone. */
type StartAgain = () => "started" | "busy" | "gone";

const waiting = new Map<string, StartAgain>();
let timer: ReturnType<typeof setTimeout> | null = null;
let delayMs = BASE_DELAY_MS;

function arm(): void {
  if (timer || waiting.size === 0) return;
  timer = setTimeout(() => {
    timer = null;
    void tick();
  }, delayMs);
  timer.unref?.();
}

async function tick(): Promise<void> {
  try {
    await updateManagedMlxRuntimeIfNeeded();
  } catch (err) {
    log.debug(`engine update still fails: ${String(err)}`);
  }
  if (needsManagedMlxRuntimeUpdate()) {
    delayMs = Math.min(delayMs * 2, MAX_DELAY_MS);
    arm();
    return;
  }
  delayMs = BASE_DELAY_MS;
  for (const [meetingId, startAgain] of [...waiting]) {
    waiting.delete(meetingId);
    const result = startAgain();
    log.info(`meeting ${meetingId}: engine ready, run start: ${result}`);
    if (result === "busy") waiting.set(meetingId, startAgain);
  }
  arm();
}

/**
 * Start the run of `meetingId` again when the engine is ready. A second call
 * for the same meeting replaces the first.
 */
export function scheduleEngineRetry(
  meetingId: string,
  startAgain: StartAgain,
): void {
  waiting.set(meetingId, startAgain);
  log.info(`meeting ${meetingId}: waits for the on-device engine`);
  arm();
}

/** A new run of the meeting started: no retry is necessary. */
export function cancelEngineRetry(meetingId: string): void {
  waiting.delete(meetingId);
  if (waiting.size === 0 && timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/** For tests: the meetings that wait now. */
export function engineRetryWaiting(): string[] {
  return [...waiting.keys()];
}

/** For tests: run one tick now. */
export async function runEngineRetryTickForTest(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  await tick();
}
