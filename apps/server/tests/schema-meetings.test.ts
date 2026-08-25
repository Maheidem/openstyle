import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { initSchema } from "../src/lib/schema.js";

function tableNames(db: DatabaseSync): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
}

describe("schema v29 (meetings)", () => {
  it("creates the meeting tables and indexes on a fresh database", () => {
    const db = new DatabaseSync(":memory:");
    initSchema(db);

    const tables = tableNames(db);
    expect(tables).toContain("meetings");
    expect(tables).toContain("meeting_segments");
    expect(tables).toContain("meeting_summaries");

    const version = db
      .prepare("SELECT version FROM schema_version WHERE id = 1")
      .get() as { version: number };
    expect(version.version).toBe(29);

    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(indexes).toContain("idx_meeting_segments_meeting_id");
    expect(indexes).toContain("idx_meetings_created_at");
  });

  it("migrates a database stamped at v28 (the pre-meetings version)", () => {
    const db = new DatabaseSync(":memory:");
    // Simulate an existing installation stamped just below the new version.
    db.exec(`
      CREATE TABLE schema_version (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        version INTEGER NOT NULL
      )
    `);
    db.exec("INSERT INTO schema_version (id, version) VALUES (1, 28)");

    initSchema(db);

    expect(tableNames(db)).toContain("meetings");
    const version = db
      .prepare("SELECT version FROM schema_version WHERE id = 1")
      .get() as { version: number };
    expect(version.version).toBe(29);
  });

  it("enforces the status CHECK and cascades segment/summary deletes", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    initSchema(db);

    db.prepare(
      "INSERT INTO meetings (id, status, created_at) VALUES ('m1', 'recording', ?)",
    ).run(Date.now());

    expect(() =>
      db
        .prepare(
          "INSERT INTO meetings (id, status, created_at) VALUES ('m2', 'bogus', 1)",
        )
        .run(),
    ).toThrow();

    db.prepare(
      `INSERT INTO meeting_segments (id, meeting_id, source, idx, start_ms, end_ms, text, status)
       VALUES ('s1', 'm1', 'mic', 0, 0, 1000, 'hello', 'done')`,
    ).run();
    db.prepare(
      "INSERT INTO meeting_summaries (meeting_id, markdown, created_at) VALUES ('m1', '# notes', ?)",
    ).run(Date.now());

    expect(() =>
      db
        .prepare(
          "INSERT INTO meeting_segments (id, meeting_id, source) VALUES ('s2', 'm1', 'tv')",
        )
        .run(),
    ).toThrow();

    db.prepare("DELETE FROM meetings WHERE id = 'm1'").run();
    const segCount = db
      .prepare("SELECT COUNT(*) as c FROM meeting_segments")
      .get() as { c: number };
    const sumCount = db
      .prepare("SELECT COUNT(*) as c FROM meeting_summaries")
      .get() as { c: number };
    expect(segCount.c).toBe(0);
    expect(sumCount.c).toBe(0);
  });
});
