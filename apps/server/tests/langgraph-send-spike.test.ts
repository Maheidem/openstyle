import {
  Command,
  END,
  type LangGraphRunnableConfig,
  ReducedValue,
  Send,
  START,
  StateGraph,
  StateSchema,
} from "@langchain/langgraph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { NodeSqliteSaver } from "../src/lib/llm/workflow/checkpoint-saver.js";
import {
  ensureTestRun,
  openLlmTestDb,
  reopenLlmTestDb,
} from "./helpers/llm-test-db.js";

// The WP4 spike of specs/meeting-enhance-agentic.md 3.7 (U2, U3, U9, U10, U11)
// and the WP4 card in 11.5. It uses the real NodeSqliteSaver on a temp file and
// no LLM. The state follows the snippet of 3.3 (SP5).

interface ChunkResult {
  chunkIndex: number;
  note: string;
}

/** One entry for each chunkIndex. A later write replaces an earlier one. */
function mergeByChunkIndex(cur: ChunkResult[], next: ChunkResult[]) {
  const byIndex = new Map(cur.map((r) => [r.chunkIndex, r]));
  for (const r of next) byIndex.set(r.chunkIndex, r);
  return [...byIndex.values()].sort((a, b) => a.chunkIndex - b.chunkIndex);
}

const SpikeState = new StateSchema({
  runId: z.string(),
  chunks: z.array(z.number()).default(() => []),
  // Fan-out results, as `corrections` in 3.3.
  corrections: new ReducedValue(
    z.array(z.custom<ChunkResult>()).default(() => []),
    {
      inputSchema: z.array(z.custom<ChunkResult>()),
      reducer: mergeByChunkIndex,
    },
  ),
  failure: z.string().nullable().default(null),
  saved: z.number().nullable().default(null),
});

interface WorkInput {
  chunkIndex: number;
  payload: string;
}

interface Probe {
  runs: Map<number, number>;
  alive: number;
  maxAlive: number;
  /** Chunk index that throws on its first run; -1 for none. */
  failIndex: number;
  /** Chunks that ended before the failing one throws. */
  ended: number;
  waitFor: number;
  yields: number;
}

function newProbe(over: Partial<Probe> = {}): Probe {
  return {
    runs: new Map(),
    alive: 0,
    maxAlive: 0,
    failIndex: -1,
    ended: 0,
    waitFor: 0,
    yields: 0,
    ...over,
  };
}

const tick = () => Promise.resolve();

async function yieldTicks(n: number) {
  for (let i = 0; i < n; i += 1) await tick();
}

function buildSpikeGraph(
  saver: NodeSqliteSaver,
  probe: Probe,
  chunkCount: number,
  payloadFor: (i: number) => string = () => "",
) {
  return new StateGraph(SpikeState)
    .addNode("prepare", () => ({
      chunks: Array.from({ length: chunkCount }, (_, i) => i),
    }))
    .addNode("correctChunk", async (input: WorkInput) => {
      probe.runs.set(
        input.chunkIndex,
        (probe.runs.get(input.chunkIndex) ?? 0) + 1,
      );
      probe.alive += 1;
      probe.maxAlive = Math.max(probe.maxAlive, probe.alive);
      try {
        await yieldTicks(probe.yields);
        if (
          input.chunkIndex === probe.failIndex &&
          probe.runs.get(input.chunkIndex) === 1
        ) {
          // Wait until the other tasks have ended, then fail.
          while (probe.ended < probe.waitFor) await tick();
          throw new Error(`chunk ${input.chunkIndex} dies`);
        }
        probe.ended += 1;
        return {
          corrections: [
            { chunkIndex: input.chunkIndex, note: `done ${input.chunkIndex}` },
          ],
        };
      } finally {
        probe.alive -= 1;
      }
    })
    .addNode("save", (state) => ({ saved: state.corrections.length }))
    .addEdge(START, "prepare")
    .addConditionalEdges("prepare", (state) =>
      state.chunks.map(
        (i) =>
          new Send("correctChunk", {
            chunkIndex: i,
            payload: payloadFor(i),
          } satisfies WorkInput),
      ),
    )
    .addEdge("correctChunk", "save")
    .addEdge("save", END)
    .compile({ checkpointer: saver });
}

let handle: ReturnType<typeof openLlmTestDb>;

beforeEach(() => {
  handle = openLlmTestDb("langgraph-spike-");
});

afterEach(() => {
  handle.cleanup();
});

function config(runId: string, extra: Partial<LangGraphRunnableConfig> = {}) {
  return {
    configurable: { thread_id: runId },
    durability: "sync" as const,
    ...extra,
  };
}

describe("WP4 spike: LangGraph on NodeSqliteSaver", () => {
  it("SP1 (U2): a resume runs the unfinished task only; the reducer holds 3 entries", async () => {
    ensureTestRun(handle.db, "r1");
    const probe = newProbe({ failIndex: 2, waitFor: 2, yields: 3 });
    const first = buildSpikeGraph(new NodeSqliteSaver(handle.db), probe, 3);
    await expect(first.invoke({ runId: "r1" }, config("r1"))).rejects.toThrow(
      /chunk 2 dies/,
    );
    expect([...probe.runs]).toEqual([
      [0, 1],
      [1, 1],
      [2, 1],
    ]);

    // New handle, new saver, new graph on the same file.
    handle.db.close();
    const db2 = reopenLlmTestDb(handle.path);
    try {
      const second = buildSpikeGraph(new NodeSqliteSaver(db2), probe, 3);
      const final = await second.invoke(null, config("r1"));
      expect([...probe.runs]).toEqual([
        [0, 1],
        [1, 1],
        [2, 2],
      ]);
      expect(final.corrections.map((c) => c.chunkIndex)).toEqual([0, 1, 2]);
      expect(final.saved).toBe(3);
    } finally {
      db2.close();
    }
  });

  it.each([
    { cap: 2, expected: 2 },
    { cap: 3, expected: 3 },
  ])("SP2 (U3): maxConcurrency $cap keeps at most $expected tasks alive", async ({
    cap,
    expected,
  }) => {
    ensureTestRun(handle.db, "r2");
    const probe = newProbe({ yields: 25 });
    const graph = buildSpikeGraph(new NodeSqliteSaver(handle.db), probe, 6);
    const final = await graph.invoke(
      { runId: "r2" },
      config("r2", { maxConcurrency: cap }),
    );
    expect(final.saved).toBe(6);
    expect(probe.maxAlive).toBe(expected);
  });

  it("SP2 finding: maxConcurrency 1 drops the tasks after the first, with no error", async () => {
    // LangGraph 1.5.1, pregel/runner.js `_executeTasksWithRetry`: the loop ends
    // when the map of running tasks is empty. With a cap of 1 the map is empty
    // after the first task, so the other tasks never start. The run does not
    // fail and `save` does not run. The planned cap is 3 (3.5 rule 2); this
    // test fails when a LangGraph upgrade fixes the bug, and then the note in
    // the PR can go.
    ensureTestRun(handle.db, "r2x");
    const probe = newProbe({ yields: 5 });
    const graph = buildSpikeGraph(new NodeSqliteSaver(handle.db), probe, 6);
    const final = await graph.invoke(
      { runId: "r2x" },
      config("r2x", { maxConcurrency: 1 }),
    );
    expect(probe.maxAlive).toBe(1);
    expect([...probe.runs]).toEqual([[0, 1]]);
    expect(final.saved).toBeNull();
  });

  it("SP2 control: with no cap all tasks are alive together", async () => {
    ensureTestRun(handle.db, "r2c");
    const probe = newProbe({ yields: 25 });
    const graph = buildSpikeGraph(new NodeSqliteSaver(handle.db), probe, 6);
    await graph.invoke({ runId: "r2c" }, config("r2c"));
    expect(probe.maxAlive).toBe(6);
  });

  it("SP3 (U11): errorHandler with no retry policy routes to save with the marker", async () => {
    ensureTestRun(handle.db, "r3");
    const afterRuns: string[] = [];
    const graph = new StateGraph(SpikeState)
      .addNode(
        "risky",
        () => {
          throw new Error("risky dies");
        },
        {
          errorHandler: (_state, { node, error }) =>
            new Command({
              goto: "save",
              update: { failure: `${node}: ${error.message}` },
            }),
        },
      )
      .addNode("after", () => {
        afterRuns.push("after");
        return {};
      })
      .addNode("save", (state) => ({ saved: state.failure ? -1 : 1 }))
      .addEdge(START, "risky")
      .addEdge("risky", "after")
      .addEdge("after", "save")
      .addEdge("save", END)
      .compile({ checkpointer: new NodeSqliteSaver(handle.db) });
    const final = await graph.invoke({ runId: "r3" }, config("r3"));
    expect(final.failure).toBe("risky: risky dies");
    expect(final.saved).toBe(-1);
    expect(afterRuns).toEqual([]);
  });
});

describe("WP4 spike: checkpoint size", () => {
  it("SP4 (U10): the fan-out payloads are inside the checkpoint rows", async () => {
    ensureTestRun(handle.db, "r4");
    const probe = newProbe({ yields: 2 });
    const marker = (i: number) => `PAYLOAD${i}_`;
    const payloadBytes = 100_000;
    const graph = buildSpikeGraph(
      new NodeSqliteSaver(handle.db),
      probe,
      3,
      (i) => marker(i) + "x".repeat(payloadBytes),
    );
    await graph.invoke({ runId: "r4" }, config("r4"));

    const holding = handle.db
      .prepare(
        `SELECT length(checkpoint) AS bytes,
                instr(checkpoint, CAST(? AS BLOB)) > 0 AS p0,
                instr(checkpoint, CAST(? AS BLOB)) > 0 AS p1,
                instr(checkpoint, CAST(? AS BLOB)) > 0 AS p2
         FROM llm_checkpoints WHERE thread_id = 'r4'
           AND instr(checkpoint, CAST(? AS BLOB)) > 0`,
      )
      .all(marker(0), marker(1), marker(2), marker(0)) as {
      bytes: number;
      p0: number;
      p1: number;
      p2: number;
    }[];
    // One checkpoint (the one after `prepare`) holds all 3 payloads.
    expect(holding).toHaveLength(1);
    expect(holding[0]).toMatchObject({ p0: 1, p1: 1, p2: 1 });
    expect(holding[0]?.bytes).toBeGreaterThan(3 * payloadBytes);
    expect(holding[0]?.bytes).toBeLessThan(3 * payloadBytes + 10_000);
    // The same payloads also sit in the writes table (channel __pregel_tasks),
    // so the fan-out input is stored twice.
    const sends = handle.db
      .prepare(
        `SELECT count(*) AS n, sum(length(value)) AS bytes
         FROM llm_checkpoint_writes
         WHERE thread_id = 'r4' AND channel = '__pregel_tasks'`,
      )
      .get() as { n: number; bytes: number };
    expect(sends.n).toBe(3);
    expect(sends.bytes).toBeGreaterThan(3 * payloadBytes);
    expect(sends.bytes).toBeLessThan(3 * payloadBytes + 10_000);
    // The other checkpoints stay small.
    const small = handle.db
      .prepare(
        `SELECT max(length(checkpoint)) AS bytes FROM llm_checkpoints
         WHERE thread_id = 'r4' AND instr(checkpoint, CAST(? AS BLOB)) = 0`,
      )
      .get(marker(0)) as { bytes: number };
    expect(small.bytes).toBeLessThan(2_000);
  });
});

describe("WP4 spike: retry under the fake timers of tests/setup.ts", () => {
  it("U7: a node RetryPolicy waits on a faked setTimeout; the test advances the timers", async () => {
    ensureTestRun(handle.db, "r7");
    let attempts = 0;
    const graph = new StateGraph(SpikeState)
      .addNode(
        "flaky",
        () => {
          attempts += 1;
          if (attempts === 1) throw new Error("first attempt fails");
          return { saved: attempts };
        },
        {
          retryPolicy: { maxAttempts: 2, initialInterval: 500, jitter: false },
        },
      )
      .addEdge(START, "flaky")
      .addEdge("flaky", END)
      .compile({ checkpointer: new NodeSqliteSaver(handle.db) });
    let settled = false;
    const run = graph.invoke({ runId: "r7" }, config("r7")).then((v) => {
      settled = true;
      return v;
    });
    // Let microtasks run. The retry wait is a faked timer, so the run stays open.
    await yieldTicks(200);
    expect(settled).toBe(false);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(1_000);
    const final = await run;
    expect(final.saved).toBe(2);
    expect(attempts).toBe(2);
  });
});
