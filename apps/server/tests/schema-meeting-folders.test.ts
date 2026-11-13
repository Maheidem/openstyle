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
      version: 58,
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
      "parent_id",
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
      version: 58,
    });
    expect(db.prepare("SELECT * FROM meetings").all()).toEqual(
      // Schema 58 fills title_source: system text only reads as an import.
      before.map((row) => ({ ...row, folder_id: null, title_source: "file" })),
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

describe("schema 58: sub-folders", () => {
  const insertFolder = (id: string, name: string, parent: string | null) =>
    db
      .prepare(
        "INSERT INTO meeting_folders (id, name, parent_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)",
      )
      .run(id, name, parent);

  it("makes names unique per parent and keeps a parent with children", () => {
    initSchema(db);
    expect(
      db.prepare("PRAGMA foreign_key_list(meeting_folders)").all(),
    ).toContainEqual(
      expect.objectContaining({
        table: "meeting_folders",
        from: "parent_id",
        to: "id",
        on_delete: "RESTRICT",
      }),
    );
    const indexes = db
      .prepare("PRAGMA index_list(meeting_folders)")
      .all()
      .map((i) => i.name);
    expect(indexes).toContain("idx_meeting_folders_parent");
    expect(indexes).toContain("idx_meeting_folders_parent_name");
    insertFolder("p1", "Acme", null);
    insertFolder("p2", "Globex", null);
    insertFolder("c1", "Planning", "p1");
    // The same name under another parent, and at the top level, is good.
    insertFolder("c2", "Planning", "p2");
    insertFolder("t1", "Planning", null);
    expect(() => insertFolder("c3", "planning", "p1")).toThrow();
    expect(() => insertFolder("t2", "ACME", null)).toThrow();
    expect(() => insertFolder("c4", "X", "missing")).toThrow();
    expect(() =>
      db.exec("DELETE FROM meeting_folders WHERE id = 'p1'"),
    ).toThrow();
  });

  it("upgrades a v57 DB: rows that refer to a folder survive, '/' leaves the names", () => {
    initSchema(db);
    // Put back the v57 table: the column UNIQUE, no parent_id. Foreign keys
    // are off for this step only, so the DROP deletes nothing else.
    db.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE meeting_folders;
      CREATE TABLE meeting_folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE
          CHECK(length(name) BETWEEN 1 AND 60 AND name = trim(name)),
        description TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        color TEXT
      );
      PRAGMA foreign_keys = ON;
      UPDATE schema_version SET version = 57;
      INSERT INTO meeting_folders (id, name, description, created_at, updated_at, color) VALUES
        ('f1', 'Client/Acme', 'Acme work', 1, 1, 'blue'),
        ('f2', 'Client-Acme', NULL, 2, 2, NULL),
        ('f3', 'Work', NULL, 3, 3, NULL),
        ('f4', 'a/b/c', NULL, 4, 4, NULL);
      INSERT INTO meetings (id, title, status, created_at, folder_id) VALUES
        ('m1', 'One', 'transcribed', 10, 'f1'),
        ('m2', 'Two', 'transcribed', 20, 'f3');
      INSERT INTO folder_standing (folder_id, input_hash, bullets_json, generated_at)
        VALUES ('f1', 'h', '["Going well"]', 5);
      INSERT INTO folder_action_item_state (folder_id, item_key, done, updated_at)
        VALUES ('f1', 'k1', 1, 6), ('f3', 'k2', 0, 7);
      INSERT INTO chat_threads (id, meeting_id, folder_id, title, created_at, updated_at)
        VALUES ('t1', NULL, 'f1', 'Ask Acme', 8, 8);
      INSERT INTO chat_messages (thread_id, role, content, created_at)
        VALUES ('t1', 'user', 'What is open?', 9);
    `);
    const keep = [
      "meetings",
      "folder_standing",
      "folder_action_item_state",
      "chat_threads",
      "chat_messages",
    ];
    const before = Object.fromEntries(
      keep.map((t) => [t, db.prepare(`SELECT * FROM ${t}`).all()]),
    );
    expect(before.chat_threads).toHaveLength(1);

    initSchema(db);

    expect(db.prepare("SELECT version FROM schema_version").get()).toEqual({
      version: 58,
    });
    for (const t of keep) {
      expect(db.prepare(`SELECT * FROM ${t}`).all()).toEqual(before[t]);
    }
    expect(
      db
        .prepare(
          "SELECT id, name, description, color, parent_id FROM meeting_folders ORDER BY id",
        )
        .all(),
    ).toEqual([
      // "Client-Acme" was taken, so the replace adds a suffix.
      {
        id: "f1",
        name: "Client-Acme (2)",
        description: "Acme work",
        color: "blue",
        parent_id: null,
      },
      {
        id: "f2",
        name: "Client-Acme",
        description: null,
        color: null,
        parent_id: null,
      },
      {
        id: "f3",
        name: "Work",
        description: null,
        color: null,
        parent_id: null,
      },
      {
        id: "f4",
        name: "a-b-c",
        description: null,
        color: null,
        parent_id: null,
      },
    ]);
    // initSchema turns foreign keys on again, and every reference is valid.
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({
      foreign_keys: 1,
    });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    // The cascade still works after the rebuild.
    db.exec("UPDATE meetings SET folder_id = NULL WHERE folder_id = 'f1'");
    db.exec("DELETE FROM meeting_folders WHERE id = 'f1'");
    expect(db.prepare("SELECT COUNT(*) AS n FROM chat_threads").get()).toEqual({
      n: 0,
    });
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM folder_standing").get(),
    ).toEqual({ n: 0 });
  });
});
