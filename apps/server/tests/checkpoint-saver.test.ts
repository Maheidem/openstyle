import type { DatabaseSync } from "node:sqlite";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import {
  type Checkpoint,
  emptyCheckpoint,
  uuid6,
} from "@langchain/langgraph-checkpoint";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeSqliteSaver } from "../src/lib/llm/workflow/checkpoint-saver.js";
import {
  ensureTestRun,
  openLlmTestDb,
  reopenLlmTestDb,
} from "./helpers/llm-test-db.js";

// Cases S1 to S5 and S7 of specs/meeting-enhance-agentic.md 10.7. They run on a
// real database file with migration 40 applied and foreign keys on.

let handle: ReturnType<typeof openLlmTestDb>;
let db: DatabaseSync;
let saver: NodeSqliteSaver;

beforeEach(() => {
  handle = openLlmTestDb("checkpoint-saver-");
  db = handle.db;
  saver = new NodeSqliteSaver(db);
});

afterEach(() => {
  handle.cleanup();
});

const META = { source: "loop", step: 0, parents: {} } as const;

function cfg(threadId: string, checkpointId?: string) {
  return {
    configurable: {
      thread_id: threadId,
      checkpoint_ns: "",
      ...(checkpointId ? { checkpoint_id: checkpointId } : {}),
    },
  };
}

function checkpoint(over: Partial<Checkpoint> = {}): Checkpoint {
  return { ...emptyCheckpoint(), id: uuid6(0), ...over };
}

function count(table: string, threadId: string): number {
  const row = db
    .prepare(`SELECT count(*) AS n FROM ${table} WHERE thread_id = ?`)
    .get(threadId) as { n: number };
  return row.n;
}

describe("NodeSqliteSaver", () => {
  it("S1: migration 40 creates both checkpoint tables", () => {
    const names = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'llm_checkpoint%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toEqual(["llm_checkpoint_writes", "llm_checkpoints"]);
  });

  it("S2: a Uint8Array round-trips through BLOB columns", async () => {
    ensureTestRun(db, "t1");
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    const cp = checkpoint({
      channel_values: { raw: bytes },
      channel_versions: { raw: 1 },
    });
    const at = await saver.put(cfg("t1"), cp, META, { raw: 1 });
    await saver.putWrites(at, [["raw", bytes]], "task-1");

    // A separate query: the stored columns are BLOBs, not text.
    const types = db
      .prepare(
        "SELECT typeof(checkpoint) AS c, typeof(metadata) AS m FROM llm_checkpoints WHERE thread_id = 't1'",
      )
      .get() as { c: string; m: string };
    expect(types).toEqual({ c: "blob", m: "blob" });
    const wtype = db
      .prepare(
        "SELECT typeof(value) AS v FROM llm_checkpoint_writes WHERE thread_id = 't1'",
      )
      .get() as { v: string };
    expect(wtype.v).toBe("blob");

    const tuple = await saver.getTuple(cfg("t1"));
    expect(tuple?.checkpoint.channel_values.raw).toEqual(bytes);
    expect(tuple?.pendingWrites?.[0]?.[2]).toEqual(bytes);
  });

  it("S3: deleteThread leaves 0 rows for the thread and keeps the others", async () => {
    for (const id of ["a", "b"]) {
      ensureTestRun(db, id);
      const at = await saver.put(cfg(id), checkpoint(), META, {});
      await saver.putWrites(at, [["ch", id]], "task-1");
    }
    expect(count("llm_checkpoints", "a")).toBe(1);
    expect(count("llm_checkpoint_writes", "a")).toBe(1);

    await saver.deleteThread("a");

    expect(count("llm_checkpoints", "a")).toBe(0);
    expect(count("llm_checkpoint_writes", "a")).toBe(0);
    expect(count("llm_checkpoints", "b")).toBe(1);
    expect(count("llm_checkpoint_writes", "b")).toBe(1);
    // The run row stays: only the checkpoint rows go.
    const run = db.prepare("SELECT id FROM llm_runs WHERE id = 'a'").get();
    expect(run).toBeDefined();
  });

  it("S4: a failed write rolls back with no partial rows", async () => {
    ensureTestRun(db, "t1");
    const at = await saver.put(cfg("t1"), checkpoint(), META, {});
    // The second row hits the trigger, so the first row must go too.
    db.exec(`
      CREATE TRIGGER boom BEFORE INSERT ON llm_checkpoint_writes
      WHEN NEW.channel = 'boom'
      BEGIN SELECT RAISE(ABORT, 'boom'); END;
    `);
    await expect(
      saver.putWrites(
        at,
        [
          ["ok", 1],
          ["boom", 2],
        ],
        "task-1",
      ),
    ).rejects.toThrow(/boom/);
    expect(count("llm_checkpoint_writes", "t1")).toBe(0);
    // The connection is usable after the rollback.
    await saver.putWrites(at, [["ok", 1]], "task-2");
    expect(count("llm_checkpoint_writes", "t1")).toBe(1);
  });

  it("S5: a write for a deleted run inserts 0 rows and does not throw", async () => {
    ensureTestRun(db, "gone");
    const at = await saver.put(cfg("gone"), checkpoint(), META, {});
    db.prepare("DELETE FROM llm_runs WHERE id = 'gone'").run();
    // The cascade removed the checkpoint rows with the run.
    expect(count("llm_checkpoints", "gone")).toBe(0);

    await expect(
      saver.put(cfg("gone"), checkpoint({ id: uuid6(1) }), META, {}),
    ).resolves.toBeDefined();
    await expect(
      saver.putWrites(at, [["ch", 1]], "task-1"),
    ).resolves.toBeUndefined();
    expect(count("llm_checkpoints", "gone")).toBe(0);
    expect(count("llm_checkpoint_writes", "gone")).toBe(0);
  });

  it("S7: a graph resumes on a new handle and saver; counters A 1, B 2, C 1", async () => {
    const counters = { a: 0, b: 0, c: 0 };
    const State = Annotation.Root({
      trail: Annotation<string[]>({
        reducer: (cur, next) => [...cur, ...next],
        default: () => [],
      }),
    });
    const build = (checkpointer: NodeSqliteSaver) =>
      new StateGraph(State)
        .addNode("A", () => {
          counters.a += 1;
          return { trail: ["A"] };
        })
        .addNode("B", () => {
          counters.b += 1;
          // The first call fails, as a killed process would.
          if (counters.b === 1) throw new Error("B dies");
          return { trail: ["B"] };
        })
        .addNode("C", () => {
          counters.c += 1;
          return { trail: ["C"] };
        })
        .addEdge(START, "A")
        .addEdge("A", "B")
        .addEdge("B", "C")
        .addEdge("C", END)
        .compile({ checkpointer });

    ensureTestRun(db, "run-1");
    const config = {
      configurable: { thread_id: "run-1" },
      durability: "sync" as const,
    };
    await expect(build(saver).invoke({ trail: [] }, config)).rejects.toThrow(
      /B dies/,
    );
    expect(counters).toEqual({ a: 1, b: 1, c: 0 });

    // Close the handle, drop the saver, open new ones on the same file.
    db.close();
    const db2 = reopenLlmTestDb(handle.path);
    try {
      const saver2 = new NodeSqliteSaver(db2);
      const final = await build(saver2).invoke(null, config);
      expect(final.trail).toEqual(["A", "B", "C"]);
      expect(counters).toEqual({ a: 1, b: 2, c: 1 });
    } finally {
      db2.close();
    }
  });
});
