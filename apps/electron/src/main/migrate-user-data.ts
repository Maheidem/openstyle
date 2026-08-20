import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createAppLogger } from "@openstyle/utils";
import { app } from "electron";

const log = createAppLogger("user-data-migration");

/**
 * Product name the app shipped under before the Openstyle rename (Freestyle
 * 0.7.1 and earlier). Electron derives `userData` from the product name, so
 * renaming the app moved it from `<appData>/Freestyle` to `<appData>/Openstyle`
 * and left every existing install's history behind.
 */
const LEGACY_APP_NAME = "Freestyle";

/**
 * The SQLite file keeps its original name across the rename: it is a filename,
 * not branding, and `OPENSTYLE_DB_PATH` is still built from it. Copying it
 * under the same name means the migrated database opens with no schema work.
 */
const DB_FILE = "freestyle.db";

/**
 * Copied before the database, so that once `freestyle.db` exists in the new
 * directory everything it depends on is already there. See `migrate()` for why
 * the ordering matters.
 */
const PRE_DB_FILES = [`${DB_FILE}-wal`, `${DB_FILE}-shm`, "settings.json"];

/** Copied wholesale; installed plugins live here. */
const PRE_DB_DIRS = ["plugins"];

/**
 * Written once the migration has fully succeeded, and the real "already done"
 * signal.
 *
 * The database's presence alone is not enough: the in-app factory reset deletes
 * `freestyle.db` (and settings) from userData and relaunches, which would
 * otherwise look identical to "never migrated" and copy the old profile
 * straight back in, silently undoing the reset. Reset removes only an
 * enumerated list of files, so this marker survives it.
 */
const MARKER_FILE = ".migrated-from-freestyle";

/**
 * One-time copy of an existing Freestyle profile into Openstyle's userData
 * directory. Idempotent, and a no-op on fresh installs.
 *
 * Must run before anything reads or writes `settings.json` or the database.
 *
 * Copies rather than moves: the original stays untouched as a safety net, so a
 * bad migration is recoverable and downgrading still finds its data.
 */
export function migrateLegacyUserData(): void {
  let newDir: string;
  try {
    newDir = app.getPath("userData");
  } catch (err) {
    log.error(`Could not resolve userData, skipping migration: ${String(err)}`);
    return;
  }

  const legacyDir = join(dirname(newDir), LEGACY_APP_NAME);

  // Already pointed at the legacy profile: either the product rename has not
  // taken effect, or OPENSTYLE_USER_DATA overrode the path for an E2E run.
  if (legacyDir === newDir) return;

  // Ran to completion before. Checked first so a factory reset (which deletes
  // the database but not this marker) is not undone by re-importing the old
  // profile on the next launch.
  if (existsSync(join(newDir, MARKER_FILE))) return;

  // Chromium creates the userData directory before this module runs, so the
  // guard keys on the database file, never on the directory's existence.
  if (existsSync(join(newDir, DB_FILE))) return;

  if (!existsSync(join(legacyDir, DB_FILE))) {
    // Fresh install, or a legacy profile that never got a database.
    return;
  }

  log.info(`Migrating Freestyle user data from ${legacyDir} to ${newDir}`);

  try {
    mkdirSync(newDir, { recursive: true });

    for (const name of PRE_DB_FILES) {
      const from = join(legacyDir, name);
      if (!existsSync(from)) continue;
      copyFileSync(from, join(newDir, name));
      log.info(`Migrated ${name}`);
    }

    for (const name of PRE_DB_DIRS) {
      const from = join(legacyDir, name);
      if (!existsSync(from)) continue;
      cpSync(from, join(newDir, name), { recursive: true });
      log.info(`Migrated ${name}/`);
    }

    // Last on purpose. The database's presence is this function's "done" flag,
    // so if any step above dies the next launch still sees no database here,
    // re-enters the migration, and retries from the untouched original.
    copyFileSync(join(legacyDir, DB_FILE), join(newDir, DB_FILE));
    log.info(`Migrated ${DB_FILE}`);

    // Only now is the migration genuinely complete, so only now is it recorded.
    writeFileSync(
      join(newDir, MARKER_FILE),
      `${new Date().toISOString()} copied from ${legacyDir}\n`,
    );

    log.info(
      `User data migration complete. The original is left untouched at ${legacyDir}.`,
    );
  } catch (err) {
    // A failed migration must never block startup: the app falls back to an
    // empty profile and retries on the next launch.
    log.error(`User data migration failed: ${String(err)}`);
  }
}
