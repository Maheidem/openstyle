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
    expect(version.version).toBe(32);

    const columns = (
      db.prepare("PRAGMA table_info(meeting_segments)").all() as {
        name: string;
        notnull: number;
      }[]
    ).find((c) => c.name === "speaker_label");
    expect(columns).toBeDefined();
    expect(columns?.notnull).toBe(0);

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
    expect(version.version).toBe(32);
  });

  it("migrates a v29 database (with existing segment rows) to v30 with a nullable speaker_label", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE schema_version (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        version INTEGER NOT NULL
      )
    `);
    db.exec("INSERT INTO schema_version (id, version) VALUES (1, 29)");
    db.exec(`
      CREATE TABLE meetings (
        id TEXT PRIMARY KEY,
        title TEXT,
        started_at INTEGER,
        ended_at INTEGER,
        duration_ms INTEGER,
        status TEXT NOT NULL CHECK(status IN (
          'recording','interrupted','recorded','transcribing',
          'transcribed','summarized','failed'
        )),
        audio_dir TEXT,
        stt_provider TEXT,
        stt_model TEXT,
        error TEXT,
        created_at INTEGER
      )
    `);
    db.exec(`
      CREATE TABLE meeting_segments (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        source TEXT NOT NULL CHECK(source IN ('mic','system')),
        idx INTEGER,
        start_ms INTEGER,
        end_ms INTEGER,
        text TEXT,
        status TEXT
      )
    `);
    db.prepare(
      "INSERT INTO meetings (id, status, created_at) VALUES ('m1', 'transcribed', ?)",
    ).run(Date.now());
    db.prepare(
      `INSERT INTO meeting_segments (id, meeting_id, source, idx, start_ms, end_ms, text, status)
       VALUES ('s1', 'm1', 'system', 0, 0, 1000, 'hi there', 'ok')`,
    ).run();

    initSchema(db);

    const version = db
      .prepare("SELECT version FROM schema_version WHERE id = 1")
      .get() as { version: number };
    expect(version.version).toBe(32);

    const row = db
      .prepare("SELECT speaker_label FROM meeting_segments WHERE id = 's1'")
      .get() as { speaker_label: string | null };
    expect(row.speaker_label).toBeNull();
  });

  it("migrates a v30 database (with existing meeting rows) to v31 with a nullable language column", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE schema_version (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        version INTEGER NOT NULL
      )
    `);
    db.exec("INSERT INTO schema_version (id, version) VALUES (1, 30)");
    db.exec(`
      CREATE TABLE meetings (
        id TEXT PRIMARY KEY,
        title TEXT,
        started_at INTEGER,
        ended_at INTEGER,
        duration_ms INTEGER,
        status TEXT NOT NULL CHECK(status IN (
          'recording','interrupted','recorded','transcribing',
          'transcribed','summarized','failed'
        )),
        audio_dir TEXT,
        stt_provider TEXT,
        stt_model TEXT,
        error TEXT,
        created_at INTEGER
      )
    `);
    db.exec(`
      CREATE TABLE meeting_segments (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        source TEXT NOT NULL CHECK(source IN ('mic','system')),
        idx INTEGER,
        start_ms INTEGER,
        end_ms INTEGER,
        text TEXT,
        status TEXT,
        speaker_label TEXT
      )
    `);
    db.prepare(
      "INSERT INTO meetings (id, status, created_at) VALUES ('m1', 'transcribed', ?)",
    ).run(Date.now());

    initSchema(db);

    const version = db
      .prepare("SELECT version FROM schema_version WHERE id = 1")
      .get() as { version: number };
    expect(version.version).toBe(32);

    const columns = (
      db.prepare("PRAGMA table_info(meetings)").all() as {
        name: string;
        notnull: number;
      }[]
    ).find((c) => c.name === "language");
    expect(columns).toBeDefined();
    expect(columns?.notnull).toBe(0);

    const row = db
      .prepare("SELECT language FROM meetings WHERE id = 'm1'")
      .get() as { language: string | null };
    expect(row.language).toBeNull();
  });

  it("migrates a v31 database (with existing segment rows) to v32 with a nullable enhanced_text column", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE schema_version (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        version INTEGER NOT NULL
      )
    `);
    db.exec("INSERT INTO schema_version (id, version) VALUES (1, 31)");
    db.exec(`
      CREATE TABLE meetings (
        id TEXT PRIMARY KEY,
        title TEXT,
        started_at INTEGER,
        ended_at INTEGER,
        duration_ms INTEGER,
        status TEXT NOT NULL CHECK(status IN (
          'recording','interrupted','recorded','transcribing',
          'transcribed','summarized','failed'
        )),
        audio_dir TEXT,
        stt_provider TEXT,
        stt_model TEXT,
        error TEXT,
        language TEXT,
        created_at INTEGER
      )
    `);
    db.exec(`
      CREATE TABLE meeting_segments (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        source TEXT NOT NULL CHECK(source IN ('mic','system')),
        idx INTEGER,
        start_ms INTEGER,
        end_ms INTEGER,
        text TEXT,
        status TEXT,
        speaker_label TEXT
      )
    `);
    db.prepare(
      "INSERT INTO meetings (id, status, created_at) VALUES ('m1', 'transcribed', ?)",
    ).run(Date.now());
    db.prepare(
      `INSERT INTO meeting_segments (id, meeting_id, source, idx, start_ms, end_ms, text, status)
       VALUES ('s1', 'm1', 'system', 0, 0, 1000, 'hi there', 'ok')`,
    ).run();

    initSchema(db);

    const version = db
      .prepare("SELECT version FROM schema_version WHERE id = 1")
      .get() as { version: number };
    expect(version.version).toBe(32);

    const columns = (
      db.prepare("PRAGMA table_info(meeting_segments)").all() as {
        name: string;
        notnull: number;
      }[]
    ).find((c) => c.name === "enhanced_text");
    expect(columns).toBeDefined();
    expect(columns?.notnull).toBe(0);

    const row = db
      .prepare("SELECT enhanced_text FROM meeting_segments WHERE id = 's1'")
      .get() as { enhanced_text: string | null };
    expect(row.enhanced_text).toBeNull();
  });

  it("has nullable meetings.language and meeting_segments.enhanced_text columns on a fresh database", () => {
    const db = new DatabaseSync(":memory:");
    initSchema(db);
    const languageCol = (
      db.prepare("PRAGMA table_info(meetings)").all() as {
        name: string;
        notnull: number;
      }[]
    ).find((c) => c.name === "language");
    expect(languageCol).toBeDefined();
    expect(languageCol?.notnull).toBe(0);

    const enhancedTextCol = (
      db.prepare("PRAGMA table_info(meeting_segments)").all() as {
        name: string;
        notnull: number;
      }[]
    ).find((c) => c.name === "enhanced_text");
    expect(enhancedTextCol).toBeDefined();
    expect(enhancedTextCol?.notnull).toBe(0);
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
