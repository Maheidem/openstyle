import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { initSchema } from "../src/lib/schema.js";
import { createVersionedDb } from "./helpers/schema-db.js";

let db: DatabaseSync | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

describe("dismissed_notifications migration (v19)", () => {
  it("creates the dismissed_notifications table when upgrading an existing DB", () => {
    // Minimal pre-v19 DB: just the version marker + settings table. The v19
    // migration only adds a new table, so no prior tables are required.
    db = createVersionedDb(18);

    initSchema(db);

    // Table exists.
    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dismissed_notifications'",
      )
      .get();
    expect(table).toBeDefined();

    // Version was bumped.
    const version = db
      .prepare("SELECT version FROM schema_version WHERE id = 1")
      .get() as { version: number };
    expect(version.version).toBeGreaterThanOrEqual(19);

    // The expected columns are present and usable. Idempotent insert.
    db.prepare(`INSERT INTO dismissed_notifications (key) VALUES (?)`).run(
      "profile_info_prompt",
    );
    db.prepare(
      `INSERT INTO dismissed_notifications (key) VALUES (?)
       ON CONFLICT(key) DO NOTHING`,
    ).run("profile_info_prompt");

    const stored = db
      .prepare(
        "SELECT key, dismissed_at FROM dismissed_notifications WHERE key = ?",
      )
      .get("profile_info_prompt") as { key: string; dismissed_at: string };
    expect(stored.key).toBe("profile_info_prompt");
    expect(stored.dismissed_at).toBeTruthy();
  });
});
