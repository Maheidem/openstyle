import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLlmRecorder } from "../src/lib/llm/recorder.js";
import { initSchema } from "../src/lib/schema.js";
import { createVersionedDb } from "./helpers/schema-db.js";

// Migration 40 and the scope-generic tables (specs/meeting-enhance-agentic.md
// 7.3, 10.9 checks 1, 7 and 10). Migration 40 also drops the three Remix
// tables and three Remix settings rows (WP2 accept 1). Real database files.

const LLM_TABLES = [
  "llm_runs",
  "llm_run_steps",
  "llm_calls",
  "llm_call_links",
  "llm_checkpoints",
  "llm_checkpoint_writes",
];

let dir: string;
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "schema-llm-"));
  db = new DatabaseSync(join(dir, "db.sqlite"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function one<T = Record<string, unknown>>(
  sql: string,
  ...args: (string | number)[]
): T {
  return db.prepare(sql).get(...args) as T;
}

function count(sql: string, ...args: (string | number)[]): number {
  return one<{ c: number }>(sql, ...args).c;
}

function version(): number {
  return one<{ version: number }>(
    "SELECT version FROM schema_version WHERE id = 1",
  ).version;
}

/** A v39 database: the head schema with migration 40 undone, and Remix data in place. */
function makeV39(): void {
  initSchema(db);
  for (const t of [...LLM_TABLES].reverse()) db.exec(`DROP TABLE ${t}`);
  db.exec("ALTER TABLE meeting_summaries DROP COLUMN summary_json");
  db.exec(`
    CREATE TABLE remix_threads (id INTEGER PRIMARY KEY, title TEXT);
    CREATE TABLE remix_messages (id INTEGER PRIMARY KEY, thread_id INTEGER REFERENCES remix_threads(id) ON DELETE CASCADE);
    CREATE TABLE remix_runs (id INTEGER PRIMARY KEY, thread_id INTEGER);
    INSERT INTO remix_threads (id, title) VALUES (1, 'old');
    INSERT INTO settings (key, value) VALUES ('remix_hotkey', 'F5'), ('remix_bar_enabled', 'true'), ('remix_enabled', 'true'), ('keep_me', 'yes');
    INSERT INTO meetings (id, title, status, created_at) VALUES ('m1', 'One', 'summarized', 1), ('m2', 'Two', 'transcribed', 2);
    INSERT INTO meeting_summaries (meeting_id, markdown, created_at) VALUES ('m1', '# Old summary', 5);
    UPDATE schema_version SET version = 39 WHERE id = 1;
  `);
}

function tableNames(like: string): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ? ORDER BY name",
      )
      .all(like) as { name: string }[]
  ).map((r) => r.name);
}

describe("migration 40", () => {
  it("upgrades a v39 file: six tables, summary_json, Remix gone, data kept (accept 1)", () => {
    makeV39();
    expect(version()).toBe(39);
    expect(tableNames("llm_%")).toEqual([]);
    expect(count("SELECT count(*) AS c FROM meetings")).toBe(2);

    initSchema(db);

    expect(version()).toBe(49);
    expect(
      count(
        "SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name LIKE 'llm_%'",
      ),
    ).toBe(6);
    expect(tableNames("llm_%")).toEqual([...LLM_TABLES].sort());
    expect(
      count(
        "SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name LIKE 'remix_%'",
      ),
    ).toBe(0);
    expect(
      count(
        "SELECT count(*) AS c FROM pragma_table_info('meeting_summaries') WHERE name = 'summary_json'",
      ),
    ).toBe(1);
    expect(count("SELECT count(*) AS c FROM meetings")).toBe(2);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    // Old summary rows read NULL.
    expect(
      one<{ summary_json: string | null }>(
        "SELECT summary_json FROM meeting_summaries WHERE meeting_id = 'm1'",
      ).summary_json,
    ).toBeNull();
    expect(
      count(
        "SELECT count(*) AS c FROM meeting_summaries WHERE summary_json IS NOT NULL",
      ),
    ).toBe(0);
    // The Remix settings go; the others stay.
    expect(
      (
        db.prepare("SELECT key FROM settings ORDER BY key").all() as {
          key: string;
        }[]
      ).map((r) => r.key),
    ).toEqual(["keep_me"]);
    // Seven idx_ indexes and one unique index.
    expect(
      count(
        "SELECT count(*) AS c FROM sqlite_master WHERE type='index' AND name LIKE 'idx_llm_%'",
      ),
    ).toBe(7);
    expect(
      count(
        "SELECT count(*) AS c FROM sqlite_master WHERE type='index' AND name = 'uq_llm_call_links'",
      ),
    ).toBe(1);
  });

  it("runs the step a second time with no error and no second column", () => {
    makeV39();
    initSchema(db);
    db.prepare(
      "INSERT INTO llm_runs (id, scope, scope_id, meeting_id, kind, started_by, status, graph_version, resume_count, lost_records, started_at, updated_at) VALUES ('r1','meeting','m1','m1','enhance','auto','succeeded',1,0,0,1,1)",
    ).run();
    db.exec("UPDATE schema_version SET version = 39 WHERE id = 1");
    expect(() => initSchema(db)).not.toThrow();
    expect(version()).toBe(49);
    expect(
      count(
        "SELECT count(*) AS c FROM pragma_table_info('meeting_summaries') WHERE name = 'summary_json'",
      ),
    ).toBe(1);
    expect(count("SELECT count(*) AS c FROM llm_runs")).toBe(1);
    expect(
      count(
        "SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name LIKE 'remix_%'",
      ),
    ).toBe(0);
  });

  it("skips the six tables when there is no meetings table, but still drops Remix", () => {
    const old = createVersionedDb(
      39,
      `
      CREATE TABLE remix_threads (id INTEGER PRIMARY KEY);
      INSERT INTO settings (key, value) VALUES ('remix_enabled', 'true'), ('other', '1');
    `,
    );
    initSchema(old);
    expect(
      (
        old
          .prepare("SELECT version FROM schema_version WHERE id = 1")
          .get() as { version: number }
      ).version,
    ).toBe(49);
    expect(
      old
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'llm_%' OR name LIKE 'remix_%')",
        )
        .all(),
    ).toEqual([]);
    expect(old.prepare("SELECT key FROM settings").all()).toEqual([
      { key: "other" },
    ]);
    old.close();
  });

  it("works on a v39 file that has no settings table", () => {
    const old = createVersionedDb(39, "", { settings: false });
    expect(() => initSchema(old)).not.toThrow();
    old.close();
  });
});

function seedRun(
  id: string,
  scope: "meeting" | "test",
  scopeId: string,
): number {
  const rec = createLlmRecorder(db);
  expect(
    rec.startRun({
      id,
      scope,
      scopeId,
      kind: "enhance",
      startedBy: "auto",
      graphVersion: 1,
      startedAt: 1,
    }),
  ).toBe("ok");
  rec.startStep(id, { key: "chunk:0", node: "correctChunk" });
  const call = rec.recordCall({
    runId: id,
    unitKey: "chunk:0",
    node: "correctChunk",
    retryReason: null,
    provider: null,
    modelRequested: null,
    modelServed: null,
    instructions: "s",
    messages: [{ role: "user", content: "u" }],
    schema: { name: "n", version: 1, json: {} },
    params: {
      topLevel: {},
      extraBody: {},
      dropped: [],
      source: { mode: "auto" },
      capturedFrom: "wire",
      warnings: [],
      structuredMode: "json_schema",
    },
    rawText: null,
    parsed: null,
    reasoningChars: null,
    finishUnified: null,
    finishRaw: null,
    usage: { input: null, output: null, reasoning: null, cached: null },
    queuedMs: null,
    latencyMs: null,
    errorKind: null,
    errorDetail: null,
    startedAt: 1,
    finishedAt: 2,
  });
  const callId = call?.id as number;
  rec.linkCall(callId, [
    {
      targetType: "segment",
      targetId: `${scopeId}:system:0`,
      seq: 0,
      outcome: "applied",
      reason: null,
      appliedText: "x",
      verdict: null,
    },
  ]);
  db.prepare(
    "INSERT INTO llm_checkpoints (thread_id, checkpoint_ns, checkpoint_id, type, checkpoint, metadata) VALUES (?, '', 'c1', 'json', ?, ?)",
  ).run(id, new Uint8Array([1, 2]), new Uint8Array([3]));
  db.prepare(
    "INSERT INTO llm_checkpoint_writes (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, task_path, channel, type, value) VALUES (?, '', 'c1', 't1', 0, '', 'ch', 'json', ?)",
  ).run(id, new Uint8Array([9]));
  return callId;
}

function sixCounts(): Record<string, number> {
  return Object.fromEntries(
    LLM_TABLES.map((t) => [t, count(`SELECT count(*) AS c FROM ${t}`)]),
  );
}

describe("scope-generic tables (check 7)", () => {
  beforeEach(() => {
    initSchema(db);
    db.exec(`
      INSERT INTO meetings (id, title, status, created_at) VALUES ('m1', 'One', 'transcribed', 1), ('m2', 'Two', 'transcribed', 2);
      INSERT INTO meeting_segments (id, meeting_id, source, idx, start_ms, end_ms, text, status) VALUES ('m1:system:0', 'm1', 'system', 0, 0, 900, 'hello', 'ok');
    `);
  });

  it("a meeting delete empties all six tables for it; other rows stay", () => {
    seedRun("rm1", "meeting", "m1");
    seedRun("rm2", "meeting", "m2");
    seedRun("rt", "test", "sandbox");
    expect(sixCounts()).toEqual(
      Object.fromEntries(LLM_TABLES.map((t) => [t, 3])),
    );
    expect(
      count("SELECT count(*) AS c FROM llm_runs WHERE meeting_id IS NULL"),
    ).toBe(1);

    db.prepare("DELETE FROM meetings WHERE id = 'm1'").run();
    expect(sixCounts()).toEqual(
      Object.fromEntries(LLM_TABLES.map((t) => [t, 2])),
    );
    expect(
      count("SELECT count(*) AS c FROM llm_runs WHERE scope_id = 'm1'"),
    ).toBe(0);

    db.prepare("DELETE FROM meetings WHERE id = 'm2'").run();
    expect(sixCounts()).toEqual(
      Object.fromEntries(LLM_TABLES.map((t) => [t, 1])),
    );
    expect(
      one<{ id: string; meeting_id: string | null }>(
        "SELECT id, meeting_id FROM llm_runs",
      ),
    ).toEqual({ id: "rt", meeting_id: null });
  });

  it("a run of scope test has meeting_id NULL and carries scope and scope_id on runs and calls", () => {
    seedRun("rt", "test", "sandbox");
    expect(one("SELECT scope, scope_id, meeting_id FROM llm_runs")).toEqual({
      scope: "test",
      scope_id: "sandbox",
      meeting_id: null,
    });
    expect(one("SELECT scope, scope_id FROM llm_calls")).toEqual({
      scope: "test",
      scope_id: "sandbox",
    });
    expect(
      one("SELECT scope, scope_id, target_type, target_id FROM llm_call_links"),
    ).toEqual({
      scope: "test",
      scope_id: "sandbox",
      target_type: "segment",
      target_id: "sandbox:system:0",
    });
  });

  it("only llm_runs names a meeting; the link table names no meeting table", () => {
    for (const t of LLM_TABLES.filter((x) => x !== "llm_runs")) {
      const sql = one<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name = ?",
        t,
      ).sql;
      expect(sql, t).not.toMatch(/meeting/i);
    }
    const links = (
      db.prepare("PRAGMA foreign_key_list(llm_call_links)").all() as {
        table: string;
      }[]
    ).map((r) => r.table);
    expect(links).toEqual(["llm_calls"]);
    const runsFks = db.prepare("PRAGMA foreign_key_list(llm_runs)").all() as {
      table: string;
      on_delete: string;
    }[];
    expect(runsFks).toMatchObject([
      { table: "meetings", on_delete: "CASCADE" },
    ]);
  });

  it("a link survives a segment delete and INSERT OR REPLACE (no FK to a segment)", () => {
    seedRun("rm1", "meeting", "m1");
    expect(count("SELECT count(*) AS c FROM llm_call_links")).toBe(1);
    db.prepare(
      "INSERT OR REPLACE INTO meeting_segments (id, meeting_id, source, idx, start_ms, end_ms, text, status) VALUES ('m1:system:0', 'm1', 'system', 0, 0, 900, 'changed', 'ok')",
    ).run();
    expect(count("SELECT count(*) AS c FROM llm_call_links")).toBe(1);
    db.prepare("DELETE FROM meeting_segments WHERE meeting_id = 'm1'").run();
    expect(count("SELECT count(*) AS c FROM llm_call_links")).toBe(1);
  });

  it("an unknown meeting_id fails with a FOREIGN KEY error", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO llm_runs (id, scope, scope_id, meeting_id, kind, started_by, status, graph_version, resume_count, lost_records, started_at, updated_at) VALUES ('x','meeting','nope','nope','enhance','auto','running',1,0,0,1,1)",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it("a duplicate link key fails on the unique index", () => {
    const callId = seedRun("rm1", "meeting", "m1");
    expect(() =>
      db
        .prepare(
          "INSERT INTO llm_call_links (call_id, scope, scope_id, target_type, target_id, seq, outcome, created_at) VALUES (?, 'meeting', 'm1', 'segment', 'm1:system:0', 0, 'applied', 1)",
        )
        .run(callId),
    ).toThrow(
      /UNIQUE constraint failed: llm_call_links\.call_id, llm_call_links\.target_type, llm_call_links\.target_id, llm_call_links\.seq/,
    );
  });

  it("the indexes serve the meeting FK scan and the scope lists", () => {
    const plan = (sql: string): string =>
      (
        db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("m1") as {
          detail: string;
        }[]
      )
        .map((r) => r.detail)
        .join("\n");
    expect(plan("SELECT * FROM llm_runs WHERE meeting_id = ?")).toContain(
      "idx_llm_runs_meeting",
    );
    expect(
      plan("SELECT * FROM llm_runs WHERE scope = 'meeting' AND scope_id = ?"),
    ).toContain("idx_llm_runs_scope");
    expect(
      plan("SELECT * FROM llm_calls WHERE scope = 'meeting' AND scope_id = ?"),
    ).toContain("idx_llm_calls_scope");
    expect(
      plan(
        "SELECT * FROM llm_call_links WHERE scope = 'meeting' AND scope_id = ? AND target_type = 'segment' AND target_id = 'x'",
      ),
    ).toContain("idx_llm_call_links_target");
  });
});

describe("summary_json (check 10, column only)", () => {
  it("stores the summary object as JSON text and reads it back", () => {
    initSchema(db);
    db.prepare(
      "INSERT INTO meetings (id, title, status, created_at) VALUES ('m1', 'One', 'summarized', 1)",
    ).run();
    const summary = {
      overview: "o",
      keyPoints: ["k"],
      decisions: [],
      actionItems: [],
      openQuestions: [],
    };
    db.prepare(
      "INSERT INTO meeting_summaries (meeting_id, markdown, created_at, summary_json) VALUES ('m1', '# md', 5, ?)",
    ).run(JSON.stringify(summary));
    const row = one<{ summary_json: string }>(
      "SELECT summary_json FROM meeting_summaries WHERE meeting_id = 'm1'",
    );
    expect(JSON.parse(row.summary_json)).toEqual(summary);
  });
});

describe("migration 43 (meeting_summaries.partial, PR #258)", () => {
  it("adds the column to a v42 file, keeps old rows NULL, and runs twice", () => {
    initSchema(db);
    db.exec(`
      ALTER TABLE meeting_summaries DROP COLUMN partial;
      INSERT INTO meetings (id, title, status, created_at) VALUES ('m1', 'One', 'summarized', 1);
      INSERT INTO meeting_summaries (meeting_id, markdown, created_at) VALUES ('m1', '# md', 5);
      UPDATE schema_version SET version = 42 WHERE id = 1;
    `);
    initSchema(db);
    expect(version()).toBe(49);
    expect(
      one<{ partial: number | null }>(
        "SELECT partial FROM meeting_summaries WHERE meeting_id = 'm1'",
      ).partial,
    ).toBeNull();
    db.exec("UPDATE schema_version SET version = 42 WHERE id = 1");
    expect(() => initSchema(db)).not.toThrow();
    expect(
      count(
        "SELECT count(*) AS c FROM pragma_table_info('meeting_summaries') WHERE name = 'partial'",
      ),
    ).toBe(1);
  });
});
