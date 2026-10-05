/**
 * Unit tests for the per-endpoint LLM lane (specs/meeting-llm-queue.md §10).
 *
 * These pin the properties the whole design rests on and a typecheck cannot:
 * strict `interactive > background` precedence, FIFO within a class, the
 * host:port lane key folding two config keys onto one physical box, local 1 /
 * cloud 2, exactly-once release on the throw path, cancellation-while-queued
 * never acquiring, and the fail-CLOSED dictation gate (the opposite of
 * `waitForDictationIdle`'s fail-open default).
 *
 * Everything runs on an injected clock and an injected `sleep`. That is not
 * stylistic: `tests/setup.ts:17` installs `vi.useFakeTimers()` globally, so a
 * test here that awaited a real `setTimeout`/`setImmediate` would hang until
 * the 10 s test timeout — the injected seams are the only way to advance a
 * queue deterministically in this suite.
 */

import { serverModelId } from "@openstyle/validations";
import { beforeEach, describe, expect, it } from "vitest";
import { __resetDictationIdleStateForTests } from "../src/lib/dictation-activity.js";
import {
  __resetLlmLanesForTests,
  acquireLlmLane,
  isLocalLaneHost,
  type LaneLease,
  LLM_LANE_CONCURRENCY_CLOUD,
  LLM_LANE_CONCURRENCY_LOCAL,
  LlmLaneCancelledError,
  llmLaneKey,
  llmLaneKeyForProvider,
  llmLaneSnapshot,
} from "../src/lib/llm/lane.js";
import { insertOwnServer } from "../src/lib/own-servers.js";

const LOCAL = "127.0.0.1:8123";
const CLOUD = "api.openai.com:443";

/**
 * A manual clock: `sleep` parks its resolver in `pending`, and `flush(n)`
 * releases n generations of waiters. Nothing here touches a real timer, which
 * is what makes "is it queued or granted?" a synchronous, assertable fact
 * under the suite's global fake timers.
 */
function makeClock(start = 1_000) {
  let t = start;
  let pending: Array<() => void> = [];
  return {
    now: () => t,
    sleep: (_ms: number) =>
      new Promise<void>((resolve) => {
        pending.push(resolve);
      }),
    /** Release every currently-parked waiter, then drain microtasks. */
    async flush(generations = 3): Promise<void> {
      for (let i = 0; i < generations; i++) {
        const batch = pending;
        pending = [];
        t += 1;
        for (const resolve of batch) resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      }
    },
    parked: () => pending.length,
  };
}

/** Standard seams: dictation idle, fake clock, 1 ms poll. */
function idleCtx(clock = makeClock()) {
  return {
    now: clock.now,
    sleep: clock.sleep,
    pollMs: 1,
    isDictationActive: () => false,
    clock,
  };
}

type LaneOptions = Parameters<typeof acquireLlmLane>[0];

/** Acquire with the standard seams. `extra` adds per-call options. */
function acq(
  c: ReturnType<typeof idleCtx>,
  lane: string,
  cls: LaneOptions["cls"],
  taskId: LaneOptions["taskId"],
  extra: Partial<LaneOptions> = {},
) {
  return acquireLlmLane({ ...c, lane, cls, taskId, ...extra });
}

beforeEach(() => {
  __resetLlmLanesForTests();
  // `lastActiveAt` is shared module state ON PURPOSE (spec §6 constraint 2) —
  // reset it so one case's observed dictation does not make the next case sit
  // out a sustained-idle window it never created.
  __resetDictationIdleStateForTests();
});

describe("llmLaneKey — the lane is the ENDPOINT, not the config key", () => {
  it("folds localhost / 127.0.0.1 / ::1 to one lane", () => {
    expect(llmLaneKey("http://localhost:8123")).toBe(LOCAL);
    expect(llmLaneKey("http://127.0.0.1:8123")).toBe(LOCAL);
    expect(llmLaneKey("http://[::1]:8123")).toBe(LOCAL);
    expect(llmLaneKey("  http://127.0.0.1:8123/  ")).toBe(LOCAL);
  });

  it("strips /v1 and deeper paths — they are not lane identity", () => {
    expect(llmLaneKey("http://127.0.0.1:8123/v1")).toBe(LOCAL);
    expect(llmLaneKey("http://127.0.0.1:8123/v1/chat/completions")).toBe(LOCAL);
    // The oMLX precedent (`normalizeOmlxRoot`): the transcribe path collapses
    // too, so two server rows that share a `host:port` land on one lane.
    expect(llmLaneKey("http://127.0.0.1:8123/v1/audio/transcriptions")).toBe(
      LOCAL,
    );
  });

  it("collapses two config keys pointed at ONE physical box into ONE lane", () => {
    const localLlmUrl = llmLaneKey("http://localhost:8123/v1");
    const omlxRoot = llmLaneKey("http://127.0.0.1:8123");
    expect(localLlmUrl).toBe(omlxRoot);
    // ...and that lane is the serial one, because the host is loopback.
    expect(llmLaneSnapshot(localLlmUrl).limit).toBe(LLM_LANE_CONCURRENCY_LOCAL);
  });

  it("folds an omitted port to the scheme default", () => {
    expect(llmLaneKey("https://engine.example")).toBe(
      llmLaneKey("https://engine.example:443"),
    );
    expect(llmLaneKey("http://192.168.31.152")).toBe("192.168.31.152:80");
  });

  it("keeps genuinely different endpoints apart", () => {
    expect(llmLaneKey("http://127.0.0.1:8123")).not.toBe(
      llmLaneKey("http://127.0.0.1:8124"),
    );
  });

  it("gives unparseable input its own lane instead of merging", () => {
    expect(llmLaneKey("not a url")).toBe("lane:not a url");
    expect(llmLaneKey("")).toBe("lane:unconfigured");
    expect(llmLaneKey(null)).toBe("lane:unconfigured");
  });

  it("classifies local vs cloud for the concurrency limit", () => {
    expect(isLocalLaneHost("127.0.0.1")).toBe(true);
    expect(isLocalLaneHost("localhost")).toBe(true);
    expect(isLocalLaneHost("192.168.31.152")).toBe(true);
    expect(isLocalLaneHost("10.0.0.5")).toBe(true);
    expect(isLocalLaneHost("172.16.0.9")).toBe(true);
    expect(isLocalLaneHost("172.32.0.9")).toBe(false);
    expect(isLocalLaneHost("api.openai.com")).toBe(false);
    expect(llmLaneSnapshot(CLOUD).limit).toBe(LLM_LANE_CONCURRENCY_CLOUD);
  });
});

describe("llmLaneKeyForProvider — the limit follows the provider local flag", () => {
  it("gives a local provider on a non-private host a limit of 1", async () => {
    // 100.64.0.0/10 (Tailscale) is not a private range for `isLocalLaneHost`.
    const server = insertOwnServer({
      baseUrl: "http://100.64.0.5:8123",
      apiKey: null,
      flavor: "openai",
    });
    const lane = await llmLaneKeyForProvider(
      "server",
      serverModelId(server.id, "m"),
    );
    expect(lane).toEqual({
      key: "100.64.0.5:8123",
      limit: LLM_LANE_CONCURRENCY_LOCAL,
    });
    // The host guess alone would give this lane the cloud limit.
    expect(isLocalLaneHost("100.64.0.5")).toBe(false);

    const c = idleCtx();
    const first = await acq(c, lane.key, "interactive", "cleanup", {
      limit: lane.limit,
    });
    expect(llmLaneSnapshot(lane.key).limit).toBe(LLM_LANE_CONCURRENCY_LOCAL);
    let second = false;
    const pending = acq(c, lane.key, "interactive", "cleanup", {
      limit: lane.limit,
    }).then((l) => {
      second = true;
      return l;
    });
    await c.clock.flush();
    expect(second).toBe(false);
    first.release();
    await c.clock.flush();
    (await pending).release();
    expect(second).toBe(true);
  });

  it("gives two servers on one host:port one lane", async () => {
    const plain = insertOwnServer({
      baseUrl: "http://gw.example.test:9000/a",
      apiKey: null,
      flavor: "openai",
    });
    const secure = insertOwnServer({
      baseUrl: "https://gw.example.test:9000/b",
      apiKey: null,
      flavor: "openai",
    });

    const a = await llmLaneKeyForProvider(
      "server",
      serverModelId(plain.id, "m"),
    );
    const b = await llmLaneKeyForProvider(
      "server",
      serverModelId(secure.id, "m"),
    );

    expect(a).toEqual({
      key: "gw.example.test:9000",
      limit: LLM_LANE_CONCURRENCY_LOCAL,
    });
    expect(b).toEqual(a);
  });

  it("gives a removed server its own local lane", async () => {
    expect(
      await llmLaneKeyForProvider("server", "server/srv_gone0000/m"),
    ).toEqual({ key: "lane:unconfigured", limit: LLM_LANE_CONCURRENCY_LOCAL });
  });

  it("gives a cloud provider a limit of 2", async () => {
    expect(await llmLaneKeyForProvider("openai", "gpt-4o-mini")).toEqual({
      key: CLOUD,
      limit: LLM_LANE_CONCURRENCY_CLOUD,
    });
  });
});

describe("acquireLlmLane — strict interactive > background FIFO", () => {
  it("grants immediately on a free lane and returns the slot on release", async () => {
    const c = idleCtx();
    const lease = await acq(c, LOCAL, "interactive", "cleanup");
    expect(llmLaneSnapshot(LOCAL)).toMatchObject({ inFlight: 1, limit: 1 });
    lease.release();
    expect(llmLaneSnapshot(LOCAL).inFlight).toBe(0);
  });

  it("an interactive call enqueued AFTER a background call overtakes it", async () => {
    const c = idleCtx();
    const order: string[] = [];
    const held = await acq(c, LOCAL, "background", "meetingSummarize");
    order.push("bg-granted");

    // Enqueued first but the lower class...
    void acq(c, LOCAL, "background", "meetingEnhance").then((l) => {
      order.push("background-granted");
      l.release();
    });
    await c.clock.flush(1);
    // ...and this one arrives second.
    void acq(c, LOCAL, "interactive", "cleanup").then((l) => {
      order.push("interactive-granted");
      l.release();
    });
    await c.clock.flush(1);
    expect(llmLaneSnapshot(LOCAL)).toMatchObject({
      interactive: 1,
      background: 1,
    });

    held.release();
    // The slot must go to `interactive`, not to the background caller that
    // was already standing in the queue.
    await c.clock.flush(3);
    expect(order).toEqual([
      "bg-granted",
      "interactive-granted",
      "background-granted",
    ]);
  });

  it("keeps FIFO within a class", async () => {
    const c = idleCtx();
    const order: number[] = [];
    const held = await acq(c, LOCAL, "background", "meetingSummarize");
    const waiters = [1, 2, 3].map((n) =>
      acq(c, LOCAL, "background", "meetingEnhance").then((l) => {
        order.push(n);
        return l;
      }),
    );
    await c.clock.flush(1);
    expect(llmLaneSnapshot(LOCAL).background).toBe(3);
    held.release();
    await c.clock.flush(2);
    const w1 = await waiters[0];
    w1.release();
    await c.clock.flush(2);
    const w2 = await waiters[1];
    w2.release();
    await c.clock.flush(2);
    const w3 = await waiters[2];
    w3.release();
    expect(order).toEqual([1, 2, 3]);
    expect(llmLaneSnapshot(LOCAL).inFlight).toBe(0);
  });

  it("runs 2 in flight on a cloud lane and only 1 on a local lane", async () => {
    const c = idleCtx();
    const a = await acq(c, CLOUD, "background", "meetingSummarize");
    const b = await acq(c, CLOUD, "background", "meetingEnhance");
    expect(llmLaneSnapshot(CLOUD).inFlight).toBe(2);
    let third = false;
    const cp = acq(c, CLOUD, "interactive", "cleanup").then((l) => {
      third = true;
      return l;
    });
    await c.clock.flush(2);
    expect(third).toBe(false);
    a.release();
    await c.clock.flush(2);
    expect(third).toBe(true);
    const cc = await cp;
    expect(llmLaneSnapshot(CLOUD).inFlight).toBe(2);
    b.release();
    cc.release();
    expect(llmLaneSnapshot(CLOUD).inFlight).toBe(0);
  });

  it("never exceeds the local limit under a burst of interactive callers", async () => {
    const c = idleCtx();
    const peaks: number[] = [];
    const settled: LaneLease[] = [];
    const all = [1, 2, 3, 4].map(() =>
      acq(c, LOCAL, "interactive", "cleanup").then((l) => {
        peaks.push(llmLaneSnapshot(LOCAL).inFlight);
        settled.push(l);
        // Release as each one lands, so the burst walks the single slot
        // instead of deadlocking the assertion on four held leases.
        l.release();
        return l;
      }),
    );
    for (let i = 0; i < 40 && settled.length < 4; i++) {
      await c.clock.flush(1);
    }
    await Promise.all(all);
    expect(settled).toHaveLength(4);
    expect(Math.max(...peaks)).toBe(1);
    expect(llmLaneSnapshot(LOCAL).inFlight).toBe(0);
  });

  it("releases exactly once when the guarded call throws", async () => {
    const c = idleCtx();
    const lease = await acq(c, LOCAL, "interactive", "cleanup");
    expect(llmLaneSnapshot(LOCAL).inFlight).toBe(1);
    const guarded = async (): Promise<void> => {
      try {
        throw new Error("boom");
      } finally {
        // Three releases: the 2nd and 3rd must be no-ops, or a call that
        // threw would hand out slots it never held.
        lease.release();
        lease.release();
        lease.release();
      }
    };
    await expect(guarded()).rejects.toThrow("boom");
    expect(llmLaneSnapshot(LOCAL).inFlight).toBe(0);
    expect(lease.released).toBe(true);
  });
});

describe("acquireLlmLane — the background gate fails CLOSED", () => {
  it("a background call never starts while dictation is live", async () => {
    const clock = makeClock();
    let dictating = true;
    let granted = false;
    const p = acquireLlmLane({
      lane: LOCAL,
      cls: "background",
      taskId: "meetingSummarize",
      isDictationActive: () => dictating,
      idleMs: 2,
      now: clock.now,
      sleep: clock.sleep,
      pollMs: 1,
    }).then((l) => {
      granted = true;
      return l;
    });
    await clock.flush(4);
    expect(granted).toBe(false);
    expect(llmLaneSnapshot(LOCAL).inFlight).toBe(0);
    dictating = false;
    await clock.flush(4);
    const lease = await p;
    expect(granted).toBe(true);
    lease.release();
  });

  it("a throwing dictation seam holds background work instead of releasing it", async () => {
    const clock = makeClock();
    let calls = 0;
    let granted = false;
    const abort = new AbortController();
    const p = acquireLlmLane({
      lane: LOCAL,
      cls: "background",
      taskId: "meetingSummarize",
      signal: abort.signal,
      isDictationActive: () => {
        calls++;
        throw new Error("state unreadable");
      },
      now: clock.now,
      sleep: clock.sleep,
      pollMs: 1,
    }).then((l) => {
      granted = true;
      return l;
    });
    await clock.flush(3);
    // Still parked: the gate read "assume dictation is live", not "no gate"
    // (which is what `waitForDictationIdle`'s own fail-open default would do
    // with an omitted seam — spec §5.3).
    expect(granted).toBe(false);
    expect(calls).toBeGreaterThan(0);
    expect(llmLaneSnapshot(LOCAL).inFlight).toBe(0);
    // The only exit from a permanently unreadable seam is a cancel, and the
    // gate honours it from inside its own poll loop.
    abort.abort();
    await clock.flush(3);
    await expect(p).rejects.toBeInstanceOf(LlmLaneCancelledError);
    expect(granted).toBe(false);
    expect(llmLaneSnapshot(LOCAL).inFlight).toBe(0);
  });

  it("an interactive call is NOT gated — it IS the dictation", async () => {
    const clock = makeClock();
    const lease = await acquireLlmLane({
      lane: LOCAL,
      cls: "interactive",
      taskId: "cleanup",
      isDictationActive: () => true,
      now: clock.now,
      sleep: clock.sleep,
      pollMs: 1,
    });
    expect(lease.released).toBe(false);
    lease.release();
  });
});

describe("acquireLlmLane — cancellation and queue reporting", () => {
  it("a cancelled queued call never acquires a slot", async () => {
    const c = idleCtx();
    const held = await acq(c, LOCAL, "background", "meetingSummarize");
    let stop = false;
    let acquired = false;
    const queued = acq(c, LOCAL, "background", "meetingSummarize", {
      shouldStop: () => stop,
    }).then((l) => {
      acquired = true;
      return l;
    });
    await c.clock.flush(2);
    expect(acquired).toBe(false);
    stop = true;
    await c.clock.flush(2);
    await expect(queued).rejects.toBeInstanceOf(LlmLaneCancelledError);
    expect(acquired).toBe(false);
    // The slot the running job held is untouched, and falls on its own release.
    expect(llmLaneSnapshot(LOCAL).inFlight).toBe(1);
    held.release();
    expect(llmLaneSnapshot(LOCAL).inFlight).toBe(0);
  });

  it("onQueued fires once, with the wait and the position", async () => {
    const c = idleCtx();
    const held = await acq(c, LOCAL, "background", "meetingSummarize");
    const events: Array<{ waitedMs: number; ahead: number }> = [];
    const p = acq(c, LOCAL, "background", "meetingSummarize", {
      onQueued: (i) => events.push(i),
    });
    await c.clock.flush(2);
    expect(events.length).toBe(1);
    expect(events[0].waitedMs).toBeGreaterThanOrEqual(0);
    expect(events[0].ahead).toBeGreaterThanOrEqual(0);
    held.release();
    await c.clock.flush(2);
    const lease = await p;
    lease.release();
    expect(events.length).toBe(1);
  });

  it("the lane drains BETWEEN two sequential map calls — an interactive cleanup lands in the gap", async () => {
    // §5.2's per-call lease, stated as a timeline: this is what turns "a
    // summarize blocks everything" into "one call, a gap, the next call".
    const c = idleCtx();
    const timeline: string[] = [];
    const mapCall = async (i: number): Promise<void> => {
      const lease = await acq(c, LOCAL, "background", "meetingSummarize");
      timeline.push(`map${i}:start`);
      lease.release();
      timeline.push(`map${i}:end`);
    };

    await mapCall(1);
    void acq(c, LOCAL, "interactive", "cleanup").then((l) => {
      timeline.push("cleanup:granted");
      l.release();
    });
    await c.clock.flush(1);
    await mapCall(2);
    await c.clock.flush(2);
    expect(timeline).toEqual([
      "map1:start",
      "map1:end",
      "cleanup:granted",
      "map2:start",
      "map2:end",
    ]);
  });

  it("an interactive call arriving while a background call holds the lane waits, then wins the next slot", async () => {
    // §7's matrix row, pinned: no mid-call preemption (spec §1.1), but the
    // wait is exactly one call long and nothing else queues ahead of it.
    const c = idleCtx();
    const bg = await acq(c, LOCAL, "background", "meetingSummarize");
    const timeline: string[] = [];
    void acq(c, LOCAL, "interactive", "cleanup").then((l) => {
      timeline.push("cleanup");
      l.release();
    });
    void acq(c, LOCAL, "background", "meetingEnhance").then((l) => {
      timeline.push("enhance");
      l.release();
    });
    await c.clock.flush(1);
    expect(timeline).toEqual([]);
    bg.release();
    await c.clock.flush(4);
    expect(timeline).toEqual(["cleanup", "enhance"]);
  });
});
