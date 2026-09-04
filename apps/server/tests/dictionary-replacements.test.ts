import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  applyDictionaryReplacements,
  flushPendingDictionaryUsage,
  getCompiledDictionary,
  getDictionaryVersion,
  markDictionaryChanged,
} from "../src/lib/dictionary-replacements.js";

function testDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE dictionary (
      id INTEGER PRIMARY KEY,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      usage_count INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

function usageCounts(db: DatabaseSync): Map<string, number> {
  const rows = db
    .prepare("SELECT key, usage_count FROM dictionary ORDER BY key")
    .all() as { key: string; usage_count: number }[];
  return new Map(rows.map((r) => [r.key, r.usage_count]));
}

describe("applyDictionaryReplacements", () => {
  it("replaces whole words and increments usage_count (post-delivery flush)", () => {
    const db = testDb();
    db.prepare("INSERT INTO dictionary (key, value) VALUES (?, ?)").run(
      "openstyle",
      "Openstyle",
    );

    const result = applyDictionaryReplacements(
      "we use openstyle for dictation",
      db,
    );

    expect(result).toBe("we use Openstyle for dictation");
    // Deferred: the count lands only when the post-delivery flush runs
    // (setImmediate in production — faked here, so flush explicitly).
    expect(usageCounts(db).get("openstyle")).toBe(0);
    flushPendingDictionaryUsage();
    expect(usageCounts(db).get("openstyle")).toBe(1);
  });

  it("replaces Chinese phrases inside running text", () => {
    const db = testDb();
    db.prepare("INSERT INTO dictionary (key, value) VALUES (?, ?)").run(
      "旧金山",
      "San Francisco",
    );

    const result = applyDictionaryReplacements("我们改去旧金山开会", db);

    expect(result).toBe("我们改去San Francisco开会");
  });

  it("does not replace latin keys inside larger words", () => {
    const db = testDb();
    db.prepare("INSERT INTO dictionary (key, value) VALUES (?, ?)").run(
      "cat",
      "dog",
    );

    const result = applyDictionaryReplacements("concatenate the cat", db);

    expect(result).toBe("concatenate the dog");
  });

  it("inserts replacement values containing $ patterns literally", () => {
    const db = testDb();
    const insert = db.prepare(
      "INSERT INTO dictionary (key, value) VALUES (?, ?)",
    );
    insert.run("price", "$&/month");
    insert.run("cash", "A$$B");
    insert.run("prefix", "$` and $' and $1");

    expect(applyDictionaryReplacements("the price is low", db)).toBe(
      "the $&/month is low",
    );
    expect(applyDictionaryReplacements("bring cash today", db)).toBe(
      "bring A$$B today",
    );
    expect(applyDictionaryReplacements("add a prefix here", db)).toBe(
      "add a $` and $' and $1 here",
    );
  });

  it("increments usage_count for all matched entries in one pass", () => {
    const db = testDb();
    const insert = db.prepare(
      "INSERT INTO dictionary (key, value) VALUES (?, ?)",
    );
    insert.run("foo", "FOO");
    insert.run("bar", "BAR");
    insert.run("unused", "UNUSED");

    const result = applyDictionaryReplacements("foo and bar", db);

    expect(result).toBe("FOO and BAR");
    flushPendingDictionaryUsage();
    expect([...usageCounts(db).entries()]).toEqual([
      ["bar", 1],
      ["foo", 1],
      ["unused", 0],
    ]);
  });

  it("reuses cached regexes across calls without stale results", () => {
    const db = testDb();
    db.prepare("INSERT INTO dictionary (key, value) VALUES (?, ?)").run(
      "brb",
      "be right back",
    );

    expect(applyDictionaryReplacements("brb in five", db)).toBe(
      "be right back in five",
    );
    expect(applyDictionaryReplacements("brb brb", db)).toBe(
      "be right back be right back",
    );
  });
});

describe("deferred usage_count batching (T1-7)", () => {
  it("folds several pending deliveries into one flush, preserving +1-per-matched-entry-per-delivery semantics (per-row baseline)", () => {
    const db = testDb();
    const insert = db.prepare(
      "INSERT INTO dictionary (key, value) VALUES (?, ?)",
    );
    insert.run("foo", "FOO");
    insert.run("bar", "BAR");
    insert.run("unused", "UNUSED");

    // Three deliveries: foo matches in all three, bar in one. The inline
    // era would have run three separate UPDATE ... IN (...) statements,
    // each +1 per matched id — the batched flush must land the exact same
    // counts.
    const deliveries = ["foo", "foo and bar", "foo foo"];
    for (const text of deliveries) {
      applyDictionaryReplacements(text, db);
    }
    expect(usageCounts(db).get("foo")).toBe(0); // nothing mid-delivery
    flushPendingDictionaryUsage();
    expect([...usageCounts(db).entries()]).toEqual([
      ["bar", 1],
      ["foo", 3], // one increment per delivery, NOT per occurrence
      ["unused", 0],
    ]);

    // A second flush with nothing pending is a no-op.
    flushPendingDictionaryUsage();
    expect(usageCounts(db).get("foo")).toBe(3);
  });

  it("keeps per-connection pending batches separate (no cross-db bleed)", () => {
    const dbA = testDb();
    const dbB = testDb();
    dbA.prepare("INSERT INTO dictionary (key, value) VALUES ('a', 'A')").run();
    dbB.prepare("INSERT INTO dictionary (key, value) VALUES ('a', 'A!')").run();

    expect(applyDictionaryReplacements("say a", dbA)).toBe("say A");
    expect(applyDictionaryReplacements("say a", dbB)).toBe("say A!");
    flushPendingDictionaryUsage();
    expect(usageCounts(dbA).get("a")).toBe(1);
    expect(usageCounts(dbB).get("a")).toBe(1);
  });
});

describe("compiled snapshot cache per dictionary version (T1-7)", () => {
  it("reuses the compiled snapshot until markDictionaryChanged, then rebuilds", () => {
    const db = testDb();
    db.prepare(
      "INSERT INTO dictionary (key, value) VALUES ('brb', 'be right back')",
    ).run();

    const before = getCompiledDictionary(db);
    expect(before).toHaveLength(1);
    expect(getCompiledDictionary(db)).toBe(before); // same snapshot object

    // A write outside the routes (direct SQL) + explicit invalidation.
    db.prepare(
      "INSERT INTO dictionary (key, value) VALUES ('ttyl', 'talk to you later')",
    ).run();
    const versionBefore = getDictionaryVersion();
    markDictionaryChanged();
    expect(getDictionaryVersion()).toBe(versionBefore + 1);

    const after = getCompiledDictionary(db);
    expect(after).not.toBe(before);
    expect(after).toHaveLength(2);
    // Longest-key-first ordering is preserved in the snapshot.
    expect(after.map((e) => e.key)).toEqual(["ttyl", "brb"]);
  });

  it("edits and deletes are reflected after invalidation (the route write paths)", () => {
    const db = testDb();
    db.prepare(
      "INSERT INTO dictionary (key, value) VALUES ('js', 'JavaScript')",
    ).run();
    expect(applyDictionaryReplacements("i write js", db)).toBe(
      "i write JavaScript",
    );

    // Edit (PUT /:id path).
    db.prepare(
      "UPDATE dictionary SET value = 'ECMAScript' WHERE key = 'js'",
    ).run();
    markDictionaryChanged();
    expect(applyDictionaryReplacements("i write js", db)).toBe(
      "i write ECMAScript",
    );

    // Delete (DELETE /:id path).
    db.prepare("DELETE FROM dictionary WHERE key = 'js'").run();
    markDictionaryChanged();
    expect(applyDictionaryReplacements("i write js", db)).toBe("i write js");
  });
});
