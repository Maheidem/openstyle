/**
 * Openstyle config file — `config.freestyle.json` in the same directory as the
 * SQLite database (userData). Stores experimental feature flags and other
 * non-settings configuration that doesn't belong in the DB.
 *
 * Versioned schema — bump `CONFIG_VERSION` when the shape changes. The file
 * has one version so far, so the loader has no migration step yet.
 *
 * Shape (v1):
 * ```json
 * {
 *   "version": 1,
 *   "flags": {
 *     "streaming_audio": true
 *   }
 * }
 * ```
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createAppLogger } from "@openstyle/utils";
import { z } from "zod";

const log = createAppLogger("config");

const CONFIG_FILENAME = "config.freestyle.json";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const CONFIG_VERSION = 1;

const openstyleConfigSchema = z.object({
  version: z.number().int().min(1),
  flags: z.record(z.string(), z.boolean()).default({}),
});

export type OpenstyleConfig = z.infer<typeof openstyleConfigSchema>;

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let cachedConfig: OpenstyleConfig | null = null;
let configPath: string | null = null;

function resolveConfigPath(): string | null {
  if (configPath) return configPath;
  const dbPath = process.env.OPENSTYLE_DB_PATH ?? process.env.FREESTYLE_DB_PATH;
  if (!dbPath) return null;
  configPath = join(dirname(dbPath), CONFIG_FILENAME);
  return configPath;
}

function defaultConfig(): OpenstyleConfig {
  return { version: CONFIG_VERSION, flags: {} };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Load the config file from disk (or return the cached copy). */
function loadConfig(): OpenstyleConfig {
  if (cachedConfig) return cachedConfig;

  const path = resolveConfigPath();
  if (!path) {
    cachedConfig = defaultConfig();
    return cachedConfig;
  }

  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = openstyleConfigSchema.safeParse(JSON.parse(raw));
    if (parsed.success) {
      cachedConfig = parsed.data;
    } else {
      log.warn(`Invalid ${CONFIG_FILENAME}, resetting to defaults`);
      cachedConfig = defaultConfig();
    }
  } catch {
    // File doesn't exist yet or is malformed — start fresh.
    cachedConfig = defaultConfig();
  }
  return cachedConfig;
}

/** Persist the current config to disk. */
function saveConfig(config: OpenstyleConfig): void {
  const path = resolveConfigPath();
  if (!path) return;

  cachedConfig = config;
  try {
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  } catch (err) {
    log.error(
      `Failed to write ${CONFIG_FILENAME}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Read a single flag (defaults to `false` if unset). */
export function getFlag(key: string): boolean {
  return loadConfig().flags[key] === true;
}

/** Set a flag and persist to disk. */
export function setFlag(key: string, value: boolean): void {
  const config = loadConfig();
  config.flags[key] = value;
  saveConfig(config);
}

/** Return the full config object (clone). */
export function getConfig(): OpenstyleConfig {
  const config = loadConfig();
  return { ...config, flags: { ...config.flags } };
}
