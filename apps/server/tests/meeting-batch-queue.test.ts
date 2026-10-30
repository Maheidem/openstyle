import type { MeetingStage } from "@openstyle/validations";
import { describe, expect, it } from "vitest";
import {
  type BatchQueueDeps,
  createBatchQueue,
  type StageOutcome,
} from "../src/lib/meetings/batch-queue.js";
import type { StageBlock } from "../src/lib/meetings/stage-needs.js";

/**
 * A fake world for the queue: each started job runs until the test ends it.
 * `running` holds the meetings whose job runs now.
 */
function world(
  o: {
    needs?: (id: string, stage: MeetingStage) => boolean;
    block?: (id: string, stage: MeetingStage) => StageBlock | null;
    refuse?: Set<string>;
    outcome?: (id: string) => StageOutcome;
  } = {},
) {
  const running = new Map<string, () => void>();
  const started: string[] = [];
  const cancelled: string[] = [];
  let maxRunning = 0;
  let outside: string | null = null;
  const outsideEnd = Promise.withResolvers<void>();
  const deps: BatchQueueDeps = {
    start: (id) => {
      if (o.refuse?.has(id)) return { ok: false };
      started.push(id);
      const end = Promise.withResolvers<void>();
      running.set(id, end.resolve);
      maxRunning = Math.max(maxRunning, running.size);
      ends.set(id, end.promise);
      return { ok: true, runId: `run-${id}` };
    },
    outcome: (id) => o.outcome?.(id) ?? "ok",
    failureKind: (id) => (id === "bad" ? "length" : null),
    waitForEnd: (id) =>
      id === outside ? outsideEnd.promise : (ends.get(id) ?? Promise.resolve()),
    cancel: (id) => {
      cancelled.push(id);
    },
    needsStage: o.needs ?? (() => true),
    stageBlock: o.block ?? (() => null),
    runningTranscription: () => outside,
    title: (id) => `Title ${id}`,
  };
  const ends = new Map<string, Promise<void>>();
  return {
    deps,
    started,
    cancelled,
    get maxRunning() {
      return maxRunning;
    },
    /** End the job of a meeting, as releaseJob does. */
    finish(id: string) {
      running.get(id)?.();
      running.delete(id);
    },
    startOutside(id: string) {
      outside = id;
    },
    endOutside() {
      outside = null;
      outsideEnd.resolve();
    },
  };
}

/** Let the queue's promise chain move on. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("batch queue", () => {
  it("runs one item at a time, in FIFO order, and reports progress", async () => {
    const w = world();
    const q = createBatchQueue(w.deps);
    q.enqueue(["a", "b", "c"], "transcribe", true);
    await flush();
    expect(w.started).toEqual(["a"]);
    expect(q.state()).toMatchObject({
      active: true,
      total: 3,
      done: 0,
      current: { meeting_id: "a", title: "Title a", stage: "transcribe" },
      pending: [
        { meeting_id: "b", stage: "transcribe" },
        { meeting_id: "c", stage: "transcribe" },
      ],
    });
    w.finish("a");
    await flush();
    expect(w.started).toEqual(["a", "b"]);
    expect(q.state()).toMatchObject({ done: 1, current: { meeting_id: "b" } });
    w.finish("b");
    await flush();
    w.finish("c");
    await q.idle();
    expect(w.started).toEqual(["a", "b", "c"]);
    expect(w.maxRunning).toBe(1);
    expect(q.state()).toMatchObject({
      active: false,
      total: 3,
      done: 3,
      skipped: 0,
      current: null,
      pending: [],
    });
  });

  it("counts a run that failed or did part of its work as failed, never as done", async () => {
    const w = world({
      outcome: (id) =>
        id === "bad" ? "failed" : id === "half" ? "partial" : "ok",
    });
    const q = createBatchQueue(w.deps);
    q.enqueue(["good", "bad", "half"], "enhance", true);
    for (const id of ["good", "bad", "half"]) {
      await flush();
      w.finish(id);
    }
    await q.idle();
    expect(q.state()).toMatchObject({
      total: 3,
      done: 1,
      failed: 2,
      fail_reasons: { length: 1, partly_done: 1 },
      skipped: 0,
      cancelled: 0,
    });
  });

  it("counts a run that was cancelled outside the batch as cancelled", async () => {
    const w = world({ outcome: () => "cancelled" });
    const q = createBatchQueue(w.deps);
    q.enqueue(["a"], "enhance", true);
    await flush();
    w.finish("a");
    await q.idle();
    expect(q.state()).toMatchObject({ done: 0, failed: 0, cancelled: 1 });
  });

  it("skips a folder item that no longer needs the stage, but runs a selected item", async () => {
    const w = world({ needs: (id) => id !== "done1" });
    const q = createBatchQueue(w.deps);
    q.enqueue(["done1"], "summarize", true);
    await q.idle();
    expect(w.started).toEqual([]);
    expect(q.state()).toMatchObject({
      total: 1,
      skipped: 1,
      skip_reasons: { not_needed: 1 },
    });
    // A selection is a re-run: the rule "needs stage" does not apply.
    q.enqueue(["done1"], "summarize", false);
    await flush();
    expect(w.started).toEqual(["done1"]);
    w.finish("done1");
    await q.idle();
    expect(q.state()).toMatchObject({ total: 1, done: 1, skipped: 0 });
  });

  it("counts every skip reason: blocked meetings and a refused start", async () => {
    const blocks: Record<string, StageBlock> = {
      gone1: "gone",
      noaudio1: "no_audio",
      noaudio2: "no_audio",
      busy1: "busy",
    };
    const w = world({
      block: (id) => blocks[id] ?? null,
      refuse: new Set(["empty1"]),
    });
    const q = createBatchQueue(w.deps);
    q.enqueue(
      ["gone1", "noaudio1", "ok1", "noaudio2", "busy1", "empty1"],
      "transcribe",
      true,
    );
    await flush();
    w.finish("ok1");
    await q.idle();
    expect(w.started).toEqual(["ok1"]);
    expect(q.state()).toMatchObject({
      total: 6,
      done: 1,
      skipped: 5,
      skip_reasons: { gone: 1, no_audio: 2, busy: 1, refused: 1 },
    });
  });

  it("cancel drops the waiting items and stops the running one through its job", async () => {
    const w = world();
    const q = createBatchQueue(w.deps);
    q.enqueue(["a", "b", "c"], "transcribe", true);
    await flush();
    const after = q.cancel();
    expect(after).toMatchObject({
      active: true,
      cancelled: 2,
      pending: [],
      current: { meeting_id: "a" },
    });
    expect(w.cancelled).toEqual(["a"]);
    // A second cancel does not ask the job again.
    q.cancel();
    expect(w.cancelled).toEqual(["a"]);
    w.finish("a");
    await q.idle();
    expect(w.started).toEqual(["a"]);
    expect(q.state()).toMatchObject({
      active: false,
      total: 3,
      done: 0,
      cancelled: 3,
    });
  });

  it("does not add an item that waits or runs already, and starts new counters after an idle queue", async () => {
    const w = world();
    const q = createBatchQueue(w.deps);
    q.enqueue(["a", "b"], "enhance", false);
    const state = q.enqueue(["b", "a", "c"], "enhance", false);
    expect(state.total).toBe(3);
    expect(state.pending.map((p) => p.meeting_id)).toEqual(["b", "c"]);
    // The same meeting with another stage is another item.
    expect(q.enqueue(["a"], "summarize", false).total).toBe(4);
    for (const id of ["a", "b", "c", "a"]) {
      await flush();
      w.finish(id);
    }
    await q.idle();
    expect(q.state()).toMatchObject({ total: 4, done: 4 });
    q.enqueue(["d"], "summarize", false);
    expect(q.state()).toMatchObject({ total: 1, done: 0, active: true });
    await flush();
    w.finish("d");
    await q.idle();
  });

  it("waits for a transcription that runs outside the queue before it starts one", async () => {
    const w = world();
    w.startOutside("manual");
    const q = createBatchQueue(w.deps);
    q.enqueue(["a"], "transcribe", true);
    await flush();
    expect(w.started).toEqual([]);
    w.endOutside();
    await flush();
    expect(w.started).toEqual(["a"]);
    w.finish("a");
    await q.idle();
  });

  it("a cancel while the item waits for an outside transcription never starts it", async () => {
    const w = world();
    w.startOutside("manual");
    const q = createBatchQueue(w.deps);
    q.enqueue(["a", "b"], "transcribe", true);
    await flush();
    q.cancel();
    w.endOutside();
    await q.idle();
    expect(w.started).toEqual([]);
    expect(q.state()).toMatchObject({ total: 2, done: 0, cancelled: 2 });
  });
});
