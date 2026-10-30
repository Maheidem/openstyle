import { createAppLogger, errorMessage } from "@openstyle/utils";
import type {
  BatchSkipReason,
  MeetingBatchState,
  MeetingStage,
} from "@openstyle/validations";
import type { StageBlock } from "./stage-needs.js";

const log = createAppLogger("meetings");

/**
 * The batch queue (specs/meeting-folder-batch.md 3): one FIFO list of
 * (meeting, stage) items, run one at a time. It lives in memory only. When
 * the app quits, the waiting items are lost, and the folder counts show
 * those meetings as still needed.
 *
 * One item at a time gives the rule "one transcription at a time": the local
 * ASR worker serves one request at a time. Summarize and Enhance use the
 * normal run path, and the LLM lane orders their calls.
 */
export interface BatchQueueDeps {
  /** Start the stage on the meeting, with the guards of its route. */
  start(id: string, stage: MeetingStage): { ok: true } | { ok: false };
  /** Resolves when the job that holds the meeting's slot ends. */
  waitForEnd(id: string): Promise<void>;
  /** Ask the running job of the meeting to stop (the normal cancel). */
  cancel(id: string): void;
  /** The shared "needs stage" rule (stage-needs.ts). */
  needsStage(id: string, stage: MeetingStage): boolean;
  /** Why the stage cannot run now, or null (stage-needs.ts). */
  stageBlock(id: string, stage: MeetingStage): StageBlock | null;
  /** A transcription that runs outside the queue, or null. The queue waits
   * for it before it starts a transcription. */
  runningTranscription(): string | null;
  title(id: string): string | null;
}

interface Item {
  id: string;
  stage: MeetingStage;
  /** Folder batches skip a meeting that no longer needs the stage. An
   * explicit selection is a re-run: it runs also when the stage is done. */
  onlyIfNeeded: boolean;
}

export interface BatchQueue {
  /** Add items at the end. An item that waits or runs already is not added
   * again. Returns the state after the add. */
  enqueue(
    ids: string[],
    stage: MeetingStage,
    onlyIfNeeded: boolean,
  ): MeetingBatchState;
  /** Drop the waiting items and ask the running item to stop. */
  cancel(): MeetingBatchState;
  state(): MeetingBatchState;
  /** Resolves when the queue is empty and no item runs (tests). */
  idle(): Promise<void>;
}

export function createBatchQueue(deps: BatchQueueDeps): BatchQueue {
  let pending: Item[] = [];
  let current: Item | null = null;
  let total = 0;
  let done = 0;
  let cancelled = 0;
  let skipReasons: Partial<Record<BatchSkipReason, number>> = {};
  let running: Promise<void> | null = null;
  /** The user cancelled the batch while `current` waited or ran. */
  let currentCancelled = false;

  const skipped = () =>
    Object.values(skipReasons).reduce((sum, n) => sum + (n ?? 0), 0);

  function state(): MeetingBatchState {
    return {
      active: current !== null || pending.length > 0,
      total,
      done,
      skipped: skipped(),
      cancelled,
      skip_reasons: { ...skipReasons },
      current: current && {
        meeting_id: current.id,
        title: deps.title(current.id),
        stage: current.stage,
      },
      pending: pending.map((i) => ({ meeting_id: i.id, stage: i.stage })),
    };
  }

  function skip(item: Item, reason: BatchSkipReason): void {
    skipReasons = { ...skipReasons, [reason]: (skipReasons[reason] ?? 0) + 1 };
    log.info(`batch: skipped ${item.stage} on meeting ${item.id} (${reason})`);
  }

  async function runOne(item: Item): Promise<void> {
    if (item.stage === "transcribe") {
      // A transcription that the user started on the meeting page.
      const other = deps.runningTranscription();
      if (other) await deps.waitForEnd(other);
    }
    if (currentCancelled) {
      cancelled += 1;
      return;
    }
    if (item.onlyIfNeeded && !deps.needsStage(item.id, item.stage)) {
      skip(item, "not_needed");
      return;
    }
    const block = deps.stageBlock(item.id, item.stage);
    if (block) {
      skip(item, block);
      return;
    }
    if (!deps.start(item.id, item.stage).ok) {
      skip(item, "refused");
      return;
    }
    log.info(`batch: started ${item.stage} on meeting ${item.id}`);
    await deps.waitForEnd(item.id);
    // A cancelled job ends early. It counts as cancelled, not as done.
    if (currentCancelled) cancelled += 1;
    else done += 1;
    log.info(`batch: ended ${item.stage} on meeting ${item.id}`);
  }

  async function drain(): Promise<void> {
    while (pending.length > 0) {
      const item = pending.shift() as Item;
      current = item;
      currentCancelled = false;
      try {
        await runOne(item);
      } catch (err) {
        log.warn(
          `batch: ${item.stage} on meeting ${item.id} failed to start: ${errorMessage(err)}`,
        );
        skip(item, "refused");
      }
      current = null;
    }
    running = null;
  }

  return {
    enqueue(ids, stage, onlyIfNeeded) {
      if (current === null && pending.length === 0) {
        // A new batch: the counters start again.
        total = 0;
        done = 0;
        cancelled = 0;
        skipReasons = {};
      }
      const queued = (id: string) =>
        (current?.id === id && current.stage === stage) ||
        pending.some((i) => i.id === id && i.stage === stage);
      for (const id of new Set(ids)) {
        if (queued(id)) continue;
        pending.push({ id, stage, onlyIfNeeded });
        total += 1;
      }
      if (!running && pending.length > 0) running = drain();
      return state();
    },
    cancel() {
      cancelled += pending.length;
      pending = [];
      if (current && !currentCancelled) {
        currentCancelled = true;
        deps.cancel(current.id);
      }
      return state();
    },
    state,
    idle: async () => {
      while (running) await running;
    },
  };
}
