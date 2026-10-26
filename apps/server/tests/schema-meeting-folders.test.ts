import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initSchema } from "../src/lib/schema.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
});

afterEach(() => db.close());

describe("schema 41: meeting folders", () => {
  it("adds the folder table, nullable key, and index on a new DB", () => {
    initSchema(db);
    expect(db.prepare("SELECT version FROM schema_version").get()).toEqual({
      version: 47,
    });
    expect(
      db
        .prepare("PRAGMA table_info(meeting_folders)")
        .all()
        .map((c) => c.name),
    ).toEqual([
      "id",
      "name",
      "description",
      "created_at",
      "updated_at",
      "color",
    ]);
    expect(db.prepare("PRAGMA table_info(meetings)").all()).toContainEqual(
      expect.objectContaining({ name: "folder_id", type: "TEXT", notnull: 0 }),
    );
    expect(
      db.prepare("PRAGMA foreign_key_list(meetings)").all(),
    ).toContainEqual(
      expect.objectContaining({
        table: "meeting_folders",
        from: "folder_id",
        to: "id",
        on_delete: "RESTRICT",
      }),
    );
    expect(db.prepare("PRAGMA index_list(meetings)").all()).toContainEqual(
      expect.objectContaining({ name: "idx_meetings_folder_id" }),
    );
    expect(() => initSchema(db)).not.toThrow();
  });

  it("keeps meeting rows and child rows when it upgrades a version-40 DB", () => {
    initSchema(db);
    // Remove only step 41 to get the full version-40 schema.
    db.exec(`
      DROP INDEX idx_meetings_folder_id;
      ALTER TABLE meetings DROP COLUMN folder_id;
      DROP TABLE meeting_folders;
      UPDATE schema_version SET version = 40;
      INSERT INTO meetings (id, title, status, created_at, language, context)
        VALUES ('m1', 'Old meeting', 'transcribed', 123, 'en', 'Old context');
      INSERT INTO meeting_segments (id, meeting_id, source, idx, text)
        VALUES ('s1', 'm1', 'system', 0, 'Old words');
      INSERT INTO meeting_summaries (meeting_id, markdown) VALUES ('m1', '# Old summary');
    `);
    const before = db.prepare("SELECT * FROM meetings").all();
    const segments = db.prepare("SELECT * FROM meeting_segments").all();
    const summaries = db.prepare("SELECT * FROM meeting_summaries").all();

    initSchema(db);

    expect(db.prepare("SELECT version FROM schema_version").get()).toEqual({
      version: 47,
    });
    expect(db.prepare("SELECT * FROM meetings").all()).toEqual(
      before.map((row) => ({ ...row, folder_id: null })),
    );
    expect(db.prepare("SELECT * FROM meeting_segments").all()).toEqual(
      segments,
    );
    expect(db.prepare("SELECT * FROM meeting_summaries").all()).toEqual(
      summaries,
    );
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("checks names and blocks a delete that could remove a meeting link", () => {
    initSchema(db);
    const insert = db.prepare(
      `INSERT INTO meeting_folders (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)`,
    );
    insert.run("f1", "Work");
    expect(() => insert.run("f2", "work")).toThrow();
    for (const name of ["", " ", " Work ", "x".repeat(61)]) {
      expect(() => insert.run("invalid", name)).toThrow();
    }
    expect(() =>
      db.exec(
        `INSERT INTO meetings (id, status, folder_id) VALUES ('bad', 'recorded', 'missing')`,
      ),
    ).toThrow();
    db.exec(
      `INSERT INTO meetings (id, status, folder_id) VALUES ('m1', 'recorded', 'f1')`,
    );
    expect(() =>
      db.exec("DELETE FROM meeting_folders WHERE id = 'f1'"),
    ).toThrow();
    db.exec("UPDATE meetings SET folder_id = NULL WHERE id = 'm1'");
    db.exec("DELETE FROM meeting_folders WHERE id = 'f1'");
    expect(db.prepare("SELECT id, folder_id FROM meetings").all()).toEqual([
      { id: "m1", folder_id: null },
    ]);
  });
});
