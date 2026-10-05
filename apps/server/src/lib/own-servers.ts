import { randomBytes } from "node:crypto";
import { serverKey } from "@openstyle/validations";
import { getDb, prepareCached, withTransaction } from "./db.js";

/** One row of the `own_servers` table (specs/model-picker-groups.md 6.1). */
export interface OwnServer {
  id: string;
  base_url: string;
  api_key: string | null;
  flavor: string | null;
  server_key: string;
}

const COLUMNS = "id, base_url, api_key, flavor, server_key";

export function listOwnServers(): OwnServer[] {
  return prepareCached(
    `SELECT ${COLUMNS} FROM own_servers ORDER BY created_at, rowid`,
  ).all() as unknown as OwnServer[];
}

export function getOwnServer(id: string): OwnServer | null {
  const row = prepareCached(
    `SELECT ${COLUMNS} FROM own_servers WHERE id = ?`,
  ).get(id) as OwnServer | undefined;
  return row ?? null;
}

/** The server that holds this address, or null. Compares by identity. */
export function findOwnServerByUrl(baseUrl: string): OwnServer | null {
  const row = prepareCached(
    `SELECT ${COLUMNS} FROM own_servers WHERE server_key = ?`,
  ).get(serverKey(baseUrl)) as OwnServer | undefined;
  return row ?? null;
}

export function insertOwnServer(input: {
  baseUrl: string;
  apiKey: string | null;
  flavor: string;
}): OwnServer {
  const id = `srv_${randomBytes(4).toString("hex")}`;
  const key = serverKey(input.baseUrl);
  prepareCached(
    "INSERT INTO own_servers (id, base_url, api_key, flavor, server_key) VALUES (?, ?, ?, ?, ?)",
  ).run(id, input.baseUrl, input.apiKey, input.flavor, key);
  return {
    id,
    base_url: input.baseUrl,
    api_key: input.apiKey,
    flavor: input.flavor,
    server_key: key,
  };
}

export function updateOwnServerFlavor(id: string, flavor: string): void {
  prepareCached("UPDATE own_servers SET flavor = ? WHERE id = ?").run(
    flavor,
    id,
  );
}

/**
 * Delete a server and every configured model that points at it (section 6.4).
 * The model ids start with `server/<id>/`. The id holds `_`, which `LIKE`
 * reads as a wildcard, so the match uses `substr`.
 */
export function deleteOwnServer(id: string): void {
  const prefix = `server/${id}/`;
  const db = getDb();
  withTransaction(db, () => {
    db.prepare(
      "DELETE FROM model_configs WHERE substr(model_id, 1, ?) = ?",
    ).run(prefix.length, prefix);
    db.prepare("DELETE FROM own_servers WHERE id = ?").run(id);
  });
}
