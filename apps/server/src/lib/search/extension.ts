import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createAppLogger, errorMessage } from "@openstyle/utils";
import type { SearchOffReason } from "@openstyle/validations";

// The sqlite-vec loader (specs/local-semantic-search.md 6.1, D1, D2). It never
// throws. When the load fails, search is off and the rest of the app works.
// Only this file and vec-store.ts touch the vec0 table (9.1).

const log = createAppLogger("search");

/** The vec_version() that the app ships and was probed (Appendix A). */
export const SQLITE_VEC_VERSION = "v0.1.9";

/** The file name in resources/bin (spec 11.2). */
const DYLIB_NAME = "vec0.dylib";

export type ExtensionReason = Exclude<SearchOffReason, "no_model">;

export interface ExtensionState {
  state: "loaded" | "failed";
  reason: ExtensionReason | null;
  path: string | null;
  vecVersion: string | null;
}

let current: ExtensionState = {
  state: "failed",
  reason: "extension_missing",
  path: null,
  vecVersion: null,
};

/**
 * The candidate paths, first match wins. Same shape as
 * `ffmpegBinaryCandidates` (lib/audio/decode.ts): resourcesPath, then
 * cwd/resources/bin/<platform>-<arch>. The env override comes first (tests).
 */
function dylibCandidates(): string[] {
  const proc = process as NodeJS.Process & { resourcesPath?: string };
  const out: string[] = [];
  if (proc.resourcesPath) out.push(join(proc.resourcesPath, "bin", DYLIB_NAME));
  out.push(
    join(
      process.cwd(),
      "resources",
      "bin",
      `${process.platform}-${process.arch}`,
      DYLIB_NAME,
    ),
  );
  return out;
}

function fail(reason: ExtensionReason, path: string | null): ExtensionState {
  return { state: "failed", reason, path, vecVersion: null };
}

function load(db: DatabaseSync): ExtensionState {
  // Tests set the path of a sqlite-vec build for their platform (spec 12.2).
  const override = process.env.OPENSTYLE_SQLITE_VEC_PATH?.trim();
  if (!override && !(process.platform === "darwin" && process.arch === "arm64"))
    return fail("unsupported_platform", null);
  const path = override || dylibCandidates().find(existsSync);
  if (!path || !existsSync(path))
    return fail("extension_missing", path ?? null);
  try {
    db.loadExtension(path);
  } catch (err) {
    log.error(`sqlite-vec load failed (${path}): ${errorMessage(err)}`);
    return fail("extension_load_failed", path);
  }
  try {
    const row = db.prepare("SELECT vec_version() AS v").get() as
      | { v: string }
      | undefined;
    if (row?.v !== SQLITE_VEC_VERSION) {
      log.error(
        `sqlite-vec version ${String(row?.v)} at ${path}, expected ${SQLITE_VEC_VERSION}`,
      );
      return fail("extension_version", path);
    }
    return { state: "loaded", reason: null, path, vecVersion: row.v };
  } catch (err) {
    log.error(`sqlite-vec init failed (${path}): ${errorMessage(err)}`);
    return fail("extension_load_failed", path);
  }
}

/**
 * Load sqlite-vec into `db` (opened with `allowExtension: true`), then always
 * turn extension loading off again. After that, no later load is possible
 * (P1 1c), and the SQL function load_extension() stays "not authorized" (P4).
 */
export function tryLoadSqliteVec(db: DatabaseSync): ExtensionState {
  try {
    current = load(db);
  } finally {
    try {
      db.enableLoadExtension(false);
    } catch {
      // The connection was opened without allowExtension: nothing to turn off.
    }
  }
  if (current.state === "loaded") {
    log.info(`sqlite-vec ${current.vecVersion} loaded from ${current.path}`);
  } else if (current.reason !== "unsupported_platform") {
    log.warn(`search is off: ${current.reason}`);
  }
  return current;
}

/** Mark the vec0 table as broken (spec 6.1 step 4). */
export function markVecTableFailed(err: unknown): void {
  log.error(`vec0 table create failed: ${errorMessage(err)}`);
  current = { ...current, state: "failed", reason: "vec_table" };
}

export function getExtensionState(): ExtensionState {
  return current;
}

/** True when the vec0 module is loaded and the table exists. */
export function isVecReady(): boolean {
  return current.state === "loaded";
}
