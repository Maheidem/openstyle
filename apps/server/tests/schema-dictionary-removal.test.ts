import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initSchema } from "../src/lib/schema.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
});

afterEach(() => db.close());

const terms = () =>
  (
    db.prepare("SELECT term FROM vocabulary ORDER BY id").all() as {
      term: string;
    }[]
  ).map((r) => r.term);

const hasTable = () =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE name = 'dictionary'")
    .get() !== undefined;

describe("schema 53: Shortcuts removal", () => {
  it("copies dictionary values into the vocabulary and drops the table", () => {
    initSchema(db);
    // Go back to version 52 with the old table and some fictional rows.
    db.exec(`
      CREATE TABLE dictionary (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL,
        usage_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      UPDATE schema_version SET version = 52;
    `);
    db.prepare("INSERT INTO vocabulary (term, notes) VALUES (?, ?)").run(
      "Acme Cloud",
      "kept note",
    );
    const add = db.prepare("INSERT INTO dictionary (key, value) VALUES (?, ?)");
    add.run("acme", "ACME CLOUD"); // same term, other letter case: skip
    add.run("zeta", "Zeta Labs");
    add.run("zl", "zeta labs"); // duplicate of the row above: skip
    add.run("blank", "   "); // empty: skip
    add.run("long", "x".repeat(201)); // over the term limit: skip
    add.run("qx", "  Quixote  ");

    initSchema(db);

    expect(terms()).toEqual(["Acme Cloud", "Zeta Labs", "Quixote"]);
    expect(
      db
        .prepare("SELECT notes FROM vocabulary WHERE term = 'Acme Cloud'")
        .get(),
    ).toEqual({ notes: "kept note" });
    expect(
      db.prepare("SELECT notes FROM vocabulary WHERE term = 'Zeta Labs'").get(),
    ).toEqual({ notes: null });
    expect(hasTable()).toBe(false);
    expect(db.prepare("SELECT version FROM schema_version").get()).toEqual({
      version: 53,
    });
  });

  it("is a no-op on a second run", () => {
    initSchema(db);
    db.exec(`
      CREATE TABLE dictionary (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL
      );
      INSERT INTO dictionary (key, value) VALUES ('a', 'Alpha');
      UPDATE schema_version SET version = 52;
    `);
    initSchema(db);
    initSchema(db);
    expect(terms()).toEqual(["Alpha"]);
    // Even with the version forced back, a missing table changes nothing.
    db.exec("UPDATE schema_version SET version = 52");
    initSchema(db);
    expect(terms()).toEqual(["Alpha"]);
    expect(hasTable()).toBe(false);
  });

  it("is safe with an empty table and on a new DB", () => {
    initSchema(db);
    expect(terms()).toEqual([]);
    expect(hasTable()).toBe(false);
  });
});
