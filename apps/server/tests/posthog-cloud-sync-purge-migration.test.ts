import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { initSchema } from "../src/lib/schema.js";

let db: DatabaseSync | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

function createV27Db(startVersion = 27): DatabaseSync {
  const instance = new DatabaseSync(":memory:");
  instance.exec(`
    CREATE TABLE schema_version (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      version INTEGER NOT NULL
    );
    INSERT INTO schema_version (id, version) VALUES (1, ${startVersion});

    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return instance;
}

function setSetting(instance: DatabaseSync, key: string, value: string): void {
  instance
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
    .run(key, value);
}

describe("posthog_*/cloud_synced_* settings purge migration (v28)", () => {
  it("removes the orphaned pre-fork telemetry and cloud-sync rows", () => {
    db = createV27Db();
    // The exact keys this machine's live freestyle.db carried, per the
    // fork-separation audit (§5): a real PostHog device id and linked-user
    // id, plus a real cloud account id and timezone, all copied forward from
    // the pre-fork Freestyle install even though the code that wrote them
    // (telemetry, cloud sync) was fully removed.
    setSetting(db, "posthog_device_id", "f265f627-4f0b-4f27-8307-fcddbe43d341");
    setSetting(
      db,
      "posthog_linked_user_id",
      "sJ5EhkljMgTNDeoAkZDAz6FVbkrUVFGI",
    );
    setSetting(
      db,
      "cloud_synced_account_id",
      "sJ5EhkljMgTNDeoAkZDAz6FVbkrUVFGI",
    );
    setSetting(db, "cloud_synced_timezone", "America/Sao_Paulo");
    // Keys that merely look related must survive untouched — this proves the
    // LIKE patterns are prefix-tight rather than a broad "posthog"/"cloud"
    // substring match, and documents that leaving them is deliberate.
    setSetting(db, "analytics_last_version", "0.4.2");
    setSetting(db, "cloud_prefs_backfilled", "");
    setSetting(db, "freestyle_cloud_panel_expanded", "true");
    setSetting(db, "language", "en");

    initSchema(db);

    const purged = db
      .prepare(
        `SELECT key FROM settings WHERE key IN (
           'posthog_device_id', 'posthog_linked_user_id',
           'cloud_synced_account_id', 'cloud_synced_timezone'
         )`,
      )
      .all();
    expect(purged).toHaveLength(0);

    const survivors = db
      .prepare("SELECT key FROM settings ORDER BY key")
      .all() as { key: string }[];
    expect(survivors.map((r) => r.key)).toEqual([
      "analytics_last_version",
      "cloud_prefs_backfilled",
      "freestyle_cloud_panel_expanded",
      "language",
    ]);

    // Version was bumped at least past this migration (matches the
    // convention in sync-outbox-migration.test.ts).
    const version = db
      .prepare("SELECT version FROM schema_version WHERE id = 1")
      .get() as { version: number };
    expect(version.version).toBeGreaterThanOrEqual(28);
  });

  it("still purges for a database carrying upstream's higher schema version", () => {
    // Same upstream-version-shadowing hazard covered in
    // retired-provider-migration.test.ts: a DB stamped 26+ by upstream's own
    // numbering must still run this fork's v28 purge rather than being
    // skipped by the `currentVersion < SCHEMA_VERSION` gate.
    db = createV27Db(26);
    setSetting(db, "posthog_device_id", "abc123");
    setSetting(db, "cloud_synced_account_id", "def456");

    initSchema(db);

    const rows = db.prepare("SELECT key FROM settings").all();
    expect(rows).toHaveLength(0);
  });

  it("is a no-op on a clean database with no such rows", () => {
    db = new DatabaseSync(":memory:");

    expect(() => initSchema(db!)).not.toThrow();

    const version = db
      .prepare("SELECT version FROM schema_version WHERE id = 1")
      .get() as { version: number };
    expect(version.version).toBeGreaterThanOrEqual(28);

    const settingsRows = db.prepare("SELECT key FROM settings").all();
    expect(settingsRows).toHaveLength(0);
  });
});
