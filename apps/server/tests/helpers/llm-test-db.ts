import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initSchema } from "../../src/lib/schema.js";

/** A fresh database file with the full schema and foreign keys on. */
export function openLlmTestDb(prefix = "llm-test-"): {
  db: DatabaseSync;
  dir: string;
  path: string;
  cleanup(): void;
} {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const path = join(dir, "db.sqlite");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  initSchema(db);
  return {
    db,
    dir,
    path,
    cleanup() {
      try {
        db.close();
      } catch {
        // Already closed.
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Open an existing database file again, as a new process would. */
export function reopenLlmTestDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

/**
 * Insert one `llm_runs` row of scope `test` with no meeting, so the checkpoint
 * foreign keys hold. Does nothing when the row exists (spec 10.7, O7-3).
 */
export function ensureTestRun(db: DatabaseSync, id: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO llm_runs
       (id, scope, scope_id, meeting_id, kind, started_by, status,
        graph_version, input_hash, resume_count, result_json, lost_records,
        error_kind, error_detail, started_at, updated_at, finished_at)
     VALUES (?, 'test', ?, NULL, 'test', 'test', 'running',
        1, NULL, 0, NULL, 0, NULL, NULL, 0, 0, NULL)`,
  ).run(id, id);
}
