import { DatabaseSync } from "node:sqlite";

interface VersionedDbOptions {
  /** Create the `settings` table. Set it to false to keep the seed partial. */
  settings?: boolean;
}

/**
 * Build an in-memory DB that looks like an old install. It has a
 * `schema_version` row stamped `version` and a `settings` table. It adds only
 * the `extraDdl` you pass. It never creates other tables, so the guards in
 * `initSchema` stay under test.
 */
export function createVersionedDb(
  version: number,
  extraDdl = "",
  { settings = true }: VersionedDbOptions = {},
): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE schema_version (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      version INTEGER NOT NULL
    );
    INSERT INTO schema_version (id, version) VALUES (1, ${version});
  `);
  if (settings) {
    db.exec(`
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }
  if (extraDdl) db.exec(extraDdl);
  return db;
}
