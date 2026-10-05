import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { normalizeOmlxRoot, serverKey } from "@openstyle/validations";

/**
 * Schema 36 (specs/model-picker-groups.md section 6.3). It moves the three old
 * server settings into the `own_servers` table and rewrites every model id
 * that pointed at them. It reads the old settings by their literal key names.
 * It makes no network call. The caller runs it inside the migration
 * transaction. The change is one way (rule M7).
 */

/** The three old URL settings, in rule M1 order, each with its own key. */
const OLD_SERVER_SETTINGS = [
  { url: "omlx_base_url", apiKey: "omlx_api_key" },
  { url: "local_llm_url", apiKey: "local_llm_api_key" },
  { url: "openai_stt_base_url", apiKey: "openai_stt_api_key" },
] as const;

type OldUrlSetting = (typeof OLD_SERVER_SETTINGS)[number]["url"];

interface Candidate {
  id: string;
  baseUrl: string;
  apiKey: string | null;
}

interface ConfigRow {
  id: number;
  model_id: string;
  type: string;
  is_default: number;
}

function newServerId(taken: ReadonlySet<string>): string {
  for (;;) {
    const id = `srv_${randomBytes(4).toString("hex")}`;
    if (!taken.has(id)) return id;
  }
}

/** Remove one leading `<prefix>/` from an old model id. */
function stripOldPrefix(prefix: string, modelId: string): string {
  return modelId.startsWith(`${prefix}/`)
    ? modelId.slice(prefix.length + 1)
    : modelId;
}

export function migrateOwnServers(
  db: DatabaseSync,
  tableExists: (name: string) => boolean,
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS own_servers (
      id         TEXT PRIMARY KEY,
      base_url   TEXT NOT NULL,
      api_key    TEXT,
      flavor     TEXT,
      server_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  if (!tableExists("settings")) return;

  const readOld = (key: string): string => {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return (row?.value ?? "").trim();
  };

  // M1: one candidate per non-empty URL. Candidates with one `server_key`
  // merge. The first URL text wins. A key stays with its own URL. When
  // candidates merge, the first non-empty key wins.
  const merged = new Map<string, Candidate>();
  const serverIdByUrlSetting = new Map<OldUrlSetting, string>();
  const takenIds = new Set<string>();
  for (const source of OLD_SERVER_SETTINGS) {
    const baseUrl = normalizeOmlxRoot(readOld(source.url));
    if (!baseUrl) continue;
    const apiKey = readOld(source.apiKey) || null;
    const key = serverKey(baseUrl);
    let candidate = merged.get(key);
    if (!candidate) {
      candidate = { id: newServerId(takenIds), baseUrl, apiKey };
      takenIds.add(candidate.id);
      merged.set(key, candidate);
    } else if (!candidate.apiKey && apiKey) {
      candidate.apiKey = apiKey;
    }
    serverIdByUrlSetting.set(source.url, candidate.id);
  }

  const insert = db.prepare(
    "INSERT INTO own_servers (id, base_url, api_key, server_key) VALUES (?, ?, ?, ?)",
  );
  for (const [key, candidate] of merged) {
    insert.run(candidate.id, candidate.baseUrl, candidate.apiKey, key);
  }

  if (tableExists("model_configs")) {
    migrateModelConfigs(db, serverIdByUrlSetting);
  }
  migrateTaskOverrides(db, serverIdByUrlSetting.get("local_llm_url"));
}

/** M2, M3, M4, M5b and M6 on the `model_configs` rows. */
function migrateModelConfigs(
  db: DatabaseSync,
  serverIdByUrlSetting: ReadonlyMap<OldUrlSetting, string>,
): void {
  const rowsOf = (provider: string, defaultVoiceOnly: boolean) =>
    db
      .prepare(
        `SELECT id, model_id, type, is_default FROM model_configs
         WHERE provider = ?${defaultVoiceOnly ? " AND type = 'voice' AND is_default = 1" : ""}`,
      )
      .all(provider) as unknown as ConfigRow[];

  const rewrite = (
    rows: ConfigRow[],
    oldProvider: string,
    serverId: string | undefined,
  ): void => {
    for (const row of rows) {
      // M6: no old URL means the row could not run before. Delete it.
      if (!serverId) {
        db.prepare("DELETE FROM model_configs WHERE id = ?").run(row.id);
        continue;
      }
      const newModelId = `server/${serverId}/${stripOldPrefix(oldProvider, row.model_id)}`;
      // M5b: UNIQUE(provider, model_id, type). Merge into the row that holds
      // the new id. The kept row is default when either row was.
      const clash = db
        .prepare(
          "SELECT id, is_default FROM model_configs WHERE provider = 'server' AND model_id = ? AND type = ? AND id != ?",
        )
        .get(newModelId, row.type, row.id) as
        | { id: number; is_default: number }
        | undefined;
      if (clash) {
        if (row.is_default && !clash.is_default) {
          db.prepare(
            "UPDATE model_configs SET is_default = 1 WHERE id = ?",
          ).run(clash.id);
        }
        db.prepare("DELETE FROM model_configs WHERE id = ?").run(row.id);
        continue;
      }
      db.prepare(
        "UPDATE model_configs SET provider = 'server', model_id = ? WHERE id = ?",
      ).run(newModelId, row.id);
    }
  };

  // M4 first: an `openai` default voice row with a custom STT URL. Other
  // `openai` rows stay cloud rows.
  const sttServerId = serverIdByUrlSetting.get("openai_stt_base_url");
  if (sttServerId) {
    rewrite(rowsOf("openai", true), "openai", sttServerId);
  }
  // M2 and M3.
  rewrite(
    rowsOf("omlx", false),
    "omlx",
    serverIdByUrlSetting.get("omlx_base_url"),
  );
  rewrite(
    rowsOf("local-llm", false),
    "local-llm",
    serverIdByUrlSetting.get("local_llm_url"),
  );
}

/** M5: task overrides on `local-llm` move to the `server` provider. */
function migrateTaskOverrides(
  db: DatabaseSync,
  serverId: string | undefined,
): void {
  if (!serverId) return;
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'llm_task_assignments'")
    .get() as { value: string } | undefined;
  if (!row) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return;
  }

  let changed = false;
  for (const assignment of Object.values(parsed as Record<string, unknown>)) {
    if (typeof assignment !== "object" || assignment === null) continue;
    const override = (assignment as { modelOverride?: unknown }).modelOverride;
    if (typeof override !== "object" || override === null) continue;
    const target = override as { provider?: unknown; model_id?: unknown };
    if (
      target.provider !== "local-llm" ||
      typeof target.model_id !== "string"
    ) {
      continue;
    }
    target.provider = "server";
    target.model_id = `server/${serverId}/${stripOldPrefix("local-llm", target.model_id)}`;
    changed = true;
  }

  if (changed) {
    db.prepare(
      "UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = 'llm_task_assignments'",
    ).run(JSON.stringify(parsed));
  }
}
