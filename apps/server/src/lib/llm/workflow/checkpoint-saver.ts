import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  compareWritesSortKeys,
  copyCheckpoint,
  maxChannelVersion,
  type PendingWrite,
  type SerializerProtocol,
  TASKS,
  WRITES_IDX_MAP,
  writesSortKey,
} from "@langchain/langgraph-checkpoint";
import { withTransaction } from "../../db.js";

// A LangGraph checkpoint saver on `node:sqlite` (specs/meeting-enhance-agentic.md
// 3.1, 7.9). It is generic: it keys on a thread id and knows no consumer. The
// tables `llm_checkpoints` and `llm_checkpoint_writes` come from migration 40.
// Both have a foreign key from `thread_id` to `llm_runs(id)`.
//
// `node:sqlite` is synchronous, so each method serializes first (async), then
// runs its SQL in one synchronous step.

interface CheckpointRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  type: string | null;
  checkpoint: Uint8Array;
  metadata: Uint8Array;
}

interface WriteRow {
  task_id: string;
  task_path: string;
  idx: number;
  channel: string;
  type: string | null;
  value: Uint8Array | null;
}

const CHECKPOINT_COLUMNS =
  "thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata";

/** True when every key of `filter` has an equal JSON value in `metadata`. */
function matchesFilter(
  metadata: CheckpointMetadata | undefined,
  filter: Record<string, unknown>,
): boolean {
  for (const [key, want] of Object.entries(filter)) {
    if (want === undefined) continue;
    const have = (metadata as Record<string, unknown> | undefined)?.[key];
    if (JSON.stringify(have) !== JSON.stringify(want)) return false;
  }
  return true;
}

export class NodeSqliteSaver extends BaseCheckpointSaver {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();

  constructor(db: DatabaseSync, serde?: SerializerProtocol) {
    super(serde);
    this.db = db;
  }

  /**
   * A statement is bound to one connection, so the cache lives on the saver.
   * `node:sqlite` has no `pragma()` or `transaction()`; see `withTransaction`.
   */
  private stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  private async hydrate(row: CheckpointRow): Promise<CheckpointTuple> {
    const writes = this.stmt(
      `SELECT task_id, task_path, idx, channel, type, value
       FROM llm_checkpoint_writes
       WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`,
    ).all(
      row.thread_id,
      row.checkpoint_ns,
      row.checkpoint_id,
    ) as unknown as WriteRow[];
    // Sort in JS, so the order never depends on a collation and always matches
    // live execution (`writesSortKey`).
    writes.sort((a, b) =>
      compareWritesSortKeys(
        writesSortKey(a.task_path, a.task_id, a.idx),
        writesSortKey(b.task_path, b.task_id, b.idx),
      ),
    );
    const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
      writes.map(
        async (w) =>
          [
            w.task_id,
            w.channel,
            await this.serde.loadsTyped(w.type ?? "json", w.value ?? ""),
          ] as CheckpointPendingWrite,
      ),
    );
    const type = row.type ?? "json";
    const checkpoint = (await this.serde.loadsTyped(
      type,
      row.checkpoint,
    )) as Checkpoint;
    if (checkpoint.v < 4 && row.parent_checkpoint_id) {
      await this.migratePendingSends(
        checkpoint,
        row.thread_id,
        row.checkpoint_ns,
        row.parent_checkpoint_id,
      );
    }
    const tuple: CheckpointTuple = {
      config: {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns: row.checkpoint_ns,
          checkpoint_id: row.checkpoint_id,
        },
      },
      checkpoint,
      metadata: (await this.serde.loadsTyped(
        type,
        row.metadata,
      )) as CheckpointMetadata,
      pendingWrites,
    };
    if (row.parent_checkpoint_id) {
      tuple.parentConfig = {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns: row.checkpoint_ns,
          checkpoint_id: row.parent_checkpoint_id,
        },
      };
    }
    return tuple;
  }

  /**
   * A checkpoint of format 3 or older kept its pending `Send` payloads as
   * writes of the parent checkpoint. Move them into the channel values, as the
   * official savers do (the suite tests it).
   */
  private async migratePendingSends(
    checkpoint: Checkpoint,
    threadId: string,
    ns: string,
    parentCheckpointId: string,
  ): Promise<void> {
    const sends = this.stmt(
      `SELECT type, value FROM llm_checkpoint_writes
       WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ? AND channel = ?
       ORDER BY task_path, task_id, idx`,
    ).all(threadId, ns, parentCheckpointId, TASKS) as unknown as Pick<
      WriteRow,
      "type" | "value"
    >[];
    const values = await Promise.all(
      sends.map((w) => this.serde.loadsTyped(w.type ?? "json", w.value ?? "")),
    );
    checkpoint.channel_values ??= {};
    checkpoint.channel_values[TASKS] = values;
    const versions = Object.values(checkpoint.channel_versions);
    checkpoint.channel_versions[TASKS] =
      versions.length > 0
        ? maxChannelVersion(...versions)
        : this.getNextVersion(undefined);
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const {
      thread_id: threadId,
      checkpoint_ns: ns = "",
      checkpoint_id: checkpointId,
    } = config.configurable ?? {};
    if (threadId === undefined) return undefined;
    const row = (checkpointId
      ? this.stmt(
          `SELECT ${CHECKPOINT_COLUMNS} FROM llm_checkpoints
             WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`,
        ).get(threadId, ns, checkpointId)
      : this.stmt(
          `SELECT ${CHECKPOINT_COLUMNS} FROM llm_checkpoints
             WHERE thread_id = ? AND checkpoint_ns = ?
             ORDER BY checkpoint_id DESC LIMIT 1`,
        ).get(threadId, ns)) as unknown as CheckpointRow | undefined;
    if (!row) return undefined;
    const tuple = await this.hydrate(row);
    // A call without a checkpoint id gets back the config it passed in plus
    // the id it found, as the official savers do.
    return checkpointId ? { ...tuple, config } : tuple;
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const { limit, before, filter } = options ?? {};
    const threadId = config.configurable?.thread_id;
    const ns = config.configurable?.checkpoint_ns;
    const where: string[] = [];
    const args: string[] = [];
    if (threadId) {
      where.push("thread_id = ?");
      args.push(threadId);
    }
    if (ns !== undefined && ns !== null) {
      where.push("checkpoint_ns = ?");
      args.push(ns);
    }
    if (before?.configurable?.checkpoint_id !== undefined) {
      where.push("checkpoint_id < ?");
      args.push(before.configurable.checkpoint_id);
    }
    // The metadata filter runs in JS after the rows load; the limit follows it.
    const sql = `SELECT ${CHECKPOINT_COLUMNS} FROM llm_checkpoints${
      where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""
    } ORDER BY checkpoint_id DESC`;
    const rows = this.stmt(sql).all(...args) as unknown as CheckpointRow[];
    let yielded = 0;
    for (const row of rows) {
      if (limit !== undefined && yielded >= limit) return;
      const tuple = await this.hydrate(row);
      if (filter && !matchesFilter(tuple.metadata, filter)) continue;
      yielded += 1;
      yield tuple;
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    if (!config.configurable) throw new Error("Empty configuration supplied.");
    const threadId = config.configurable.thread_id;
    if (!threadId) {
      throw new Error(
        `Missing "thread_id" field in passed "config.configurable".`,
      );
    }
    const ns: string = config.configurable.checkpoint_ns ?? "";
    const parentId: string | undefined = config.configurable.checkpoint_id;
    const [[type, serializedCheckpoint], [metadataType, serializedMetadata]] =
      await Promise.all([
        this.serde.dumpsTyped(copyCheckpoint(checkpoint)),
        this.serde.dumpsTyped(metadata),
      ]);
    if (type !== metadataType) {
      throw new Error(
        "Failed to serialize checkpoint and metadata to the same type.",
      );
    }
    // The run row may be gone (a meeting deleted mid-run, 7.9): then no row is
    // inserted and nothing throws.
    this.stmt(
      `INSERT OR REPLACE INTO llm_checkpoints
         (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM llm_runs WHERE id = ?)`,
    ).run(
      threadId,
      ns,
      checkpoint.id,
      parentId ?? null,
      type,
      serializedCheckpoint,
      serializedMetadata,
      threadId,
    );
    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: ns,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
    taskPath = "",
  ): Promise<void> {
    if (!config.configurable) throw new Error("Empty configuration supplied.");
    const threadId = config.configurable.thread_id;
    const checkpointId = config.configurable.checkpoint_id;
    if (!threadId)
      throw new Error("Missing thread_id field in config.configurable.");
    if (!checkpointId) {
      throw new Error("Missing checkpoint_id field in config.configurable.");
    }
    const ns: string = config.configurable.checkpoint_ns ?? "";
    // Special channels (error, interrupt) replace an earlier write at the same
    // index; ordinary writes keep the first one, so a replayed task adds nothing.
    const allSpecial = writes.every(([channel]) => channel in WRITES_IDX_MAP);
    const rows = await Promise.all(
      writes.map(async ([channel, value], i) => {
        const [type, bytes] = await this.serde.dumpsTyped(value);
        return { idx: WRITES_IDX_MAP[channel] ?? i, channel, type, bytes };
      }),
    );
    const insert = this.stmt(
      `INSERT OR ${allSpecial ? "REPLACE" : "IGNORE"} INTO llm_checkpoint_writes
         (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, task_path, channel, type, value)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM llm_runs WHERE id = ?)`,
    );
    withTransaction(this.db, () => {
      for (const r of rows) {
        insert.run(
          threadId,
          ns,
          checkpointId,
          taskId,
          r.idx,
          taskPath,
          r.channel,
          r.type,
          r.bytes,
          threadId,
        );
      }
    });
  }

  /**
   * Delete a thread from both tables. The runner calls it at every final
   * status; the run row stays, so the foreign key cascade does not fire (7.9).
   */
  async deleteThread(threadId: string): Promise<void> {
    withTransaction(this.db, () => {
      this.stmt("DELETE FROM llm_checkpoints WHERE thread_id = ?").run(
        threadId,
      );
      this.stmt("DELETE FROM llm_checkpoint_writes WHERE thread_id = ?").run(
        threadId,
      );
    });
  }
}
