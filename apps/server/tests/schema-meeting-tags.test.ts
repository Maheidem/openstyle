import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initSchema } from "../src/lib/schema.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
});

afterEach(() => db.close());

const columns = (table: string) =>
  db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);

describe("schema 42: meeting tags", () => {
  it("adds the tag tables and index on a new DB", () => {
    initSchema(db);
    expect(db.prepare("SELECT version FROM schema_version").get()).toEqual({
      version: 46,
    });
    expect(columns("tags")).toEqual(["id", "name", "created_at"]);
    expect(columns("meeting_tags")).toEqual([
      "meeting_id",
      "tag_id",
      "source",
      "created_at",
    ]);
    expect(
      db.prepare("PRAGMA foreign_key_list(meeting_tags)").all(),
    ).toContainEqual(
      expect.objectContaining({
        table: "meetings",
        from: "meeting_id",
        on_delete: "CASCADE",
      }),
    );
    expect(db.prepare("PRAGMA index_list(meeting_tags)").all()).toContainEqual(
      expect.objectContaining({ name: "idx_meeting_tags_tag_id" }),
    );
    expect(() => initSchema(db)).not.toThrow();
  });

  it("keeps meeting rows and folders when it upgrades a version-41 DB", () => {
    initSchema(db);
    // Remove only step 42 to get the full version-41 schema.
    db.exec(`
      DROP TABLE meeting_tags;
      DROP TABLE tags;
      UPDATE schema_version SET version = 41;
      INSERT INTO meeting_folders (id, name, created_at, updated_at)
        VALUES ('f1', 'Work', 1, 1);
      INSERT INTO meetings (id, title, status, created_at, folder_id)
        VALUES ('m1', 'Old meeting', 'transcribed', 123, 'f1');
      INSERT INTO meeting_segments (id, meeting_id, source, idx, text)
        VALUES ('s1', 'm1', 'system', 0, 'Old words');
    `);
    const before = db.prepare("SELECT * FROM meetings").all();
    const segments = db.prepare("SELECT * FROM meeting_segments").all();

    initSchema(db);

    expect(db.prepare("SELECT version FROM schema_version").get()).toEqual({
      version: 46,
    });
    expect(db.prepare("SELECT * FROM meetings").all()).toEqual(before);
    expect(db.prepare("SELECT * FROM meeting_segments").all()).toEqual(
      segments,
    );
    expect(columns("meeting_tags")).toContain("source");
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("checks names and sources, and cascades on meeting delete", () => {
    initSchema(db);
    const insertTag = db.prepare(
      "INSERT INTO tags (id, name, created_at) VALUES (?, ?, 1)",
    );
    insertTag.run("t1", "budget");
    expect(() => insertTag.run("t2", "budget")).toThrow();
    for (const name of ["", " a", "a ", "Budget", "x".repeat(41)]) {
      expect(() => insertTag.run("bad", name)).toThrow();
    }
    db.exec("INSERT INTO meetings (id, status) VALUES ('m1', 'recorded')");
    const link = db.prepare(
      "INSERT INTO meeting_tags (meeting_id, tag_id, source, created_at) VALUES (?, ?, ?, 1)",
    );
    expect(() => link.run("m1", "t1", "other")).toThrow();
    expect(() => link.run("missing", "t1", "user")).toThrow();
    link.run("m1", "t1", "llm");
    expect(() => link.run("m1", "t1", "user")).toThrow();
    db.exec("DELETE FROM meetings WHERE id = 'm1'");
    expect(db.prepare("SELECT count(*) AS c FROM meeting_tags").get()).toEqual({
      c: 0,
    });
    // An unused tag stays.
    expect(db.prepare("SELECT name FROM tags").all()).toEqual([
      { name: "budget" },
    ]);
  });
});
