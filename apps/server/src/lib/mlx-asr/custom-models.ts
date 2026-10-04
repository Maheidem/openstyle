/**
 * Custom MLX speech models: the `custom_mlx_models` table
 * (specs/custom-mlx-models.md section 5) and its link to the catalog.
 *
 * `constants.ts` cannot import this file because `models.ts` imports both.
 * So this module registers `getCustomMlxDef` as the resolver that
 * `getMlxAsrModel` calls for ids that are not curated.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { getDb } from "../db.js";
import {
  type CustomMlxFile,
  type MlxAsrModelDef,
  setCustomMlxResolver,
} from "./constants.js";

export const HF_ID_PATTERN = /^[\w.-]+\/[\w.-]+$/;

export const MAX_MODEL_BYTES = 8 * 1024 ** 3;

/** A top-level JSON file above this size is not read, and counts as code. */
const MAX_JSON_SCAN_BYTES = 64 * 1024 ** 2;

interface CustomMlxRow {
  id: string;
  hf_id: string;
  display_name: string;
  family: string;
  model_type: string | null;
  total_bytes: number;
  revision: string;
  files_json: string;
}

export function customModelId(hfId: string): string {
  return `custom--${hfId.replace("/", "--")}`;
}

/**
 * True when an id is safe to join into a cache path (spec section 7, step 2).
 * A part that starts or ends with "-" is refused too: `a-/b` and `a/-b` would
 * both give the id `custom--a---b` and the same cache dir.
 */
export function isSafeHfId(hfId: string): boolean {
  if (!HF_ID_PATTERN.test(hfId)) return false;
  return hfId
    .split("/")
    .every(
      (part) =>
        !part.includes("..") &&
        !part.includes("--") &&
        part[0] !== "." &&
        !part.startsWith("-") &&
        !part.endsWith("-"),
    );
}

/** Rows come from our own table, but the server re-checks the id and the JSON. */
function rowToDef(row: CustomMlxRow): MlxAsrModelDef | undefined {
  if (!isSafeHfId(row.hf_id)) return undefined;
  let files: CustomMlxFile[];
  try {
    files = JSON.parse(row.files_json) as CustomMlxFile[];
  } catch {
    return undefined;
  }
  const ramGb = Math.max(1, Math.ceil((row.total_bytes * 1.5) / 1024 ** 3));
  return {
    id: row.id,
    hfId: row.hf_id,
    displayName: row.display_name,
    family: row.family,
    sizeBytes: row.total_bytes,
    ramRequired: `~${ramGb} GB`,
    speed: "",
    quality: "",
    quantized: false,
    custom: { revision: row.revision, files },
  };
}

function readRows(sql: string, ...params: string[]): CustomMlxRow[] {
  try {
    return getDb()
      .prepare(sql)
      .all(...params) as unknown as CustomMlxRow[];
  } catch {
    // DB may be unavailable during shutdown.
    return [];
  }
}

export function listCustomMlxDefs(): MlxAsrModelDef[] {
  return readRows("SELECT * FROM custom_mlx_models ORDER BY added_at, id")
    .map(rowToDef)
    .filter((def): def is MlxAsrModelDef => def !== undefined);
}

export function getCustomMlxDef(id: string): MlxAsrModelDef | undefined {
  const row = readRows("SELECT * FROM custom_mlx_models WHERE id = ?", id)[0];
  return row ? rowToDef(row) : undefined;
}

/** The id of the row with this repo id, compared in lowercase. */
export function findCustomModelId(hfId: string): string | undefined {
  return readRows(
    "SELECT id FROM custom_mlx_models WHERE lower(hf_id) = lower(?)",
    hfId,
  )[0]?.id;
}

export interface NewCustomModel {
  hfId: string;
  family: string;
  modelType: string | null;
  totalBytes: number;
  revision: string;
  files: CustomMlxFile[];
}

/** Insert a row and return its id. Throws on a duplicate `hf_id`. */
export function insertCustomModel(model: NewCustomModel): string {
  const id = customModelId(model.hfId);
  getDb()
    .prepare(
      `INSERT INTO custom_mlx_models
         (id, hf_id, display_name, family, model_type, total_bytes, revision, files_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      model.hfId,
      model.hfId.split("/")[1],
      model.family,
      model.modelType,
      model.totalBytes,
      model.revision,
      JSON.stringify(model.files),
    );
  return id;
}

/** Remove the row. Returns true when a row existed. */
export function deleteCustomModelRow(id: string): boolean {
  try {
    const result = getDb()
      .prepare("DELETE FROM custom_mlx_models WHERE id = ?")
      .run(id);
    return Number(result.changes) > 0;
  } catch {
    return false;
  }
}

function listSnapshotFiles(dir: string, prefix = ""): CustomMlxFile[] {
  const files: CustomMlxFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    // Snapshot files are symlinks into blobs/. statSync follows them.
    const stat = statSync(join(dir, entry.name));
    if (stat.isDirectory())
      files.push(...listSnapshotFiles(join(dir, entry.name), path));
    else files.push({ path, size: stat.size });
  }
  return files;
}

/**
 * `main` can move between the add and the download, and the hub names the
 * snapshot dir by the sha it got. So after the download, take the revision and
 * the file list from the snapshot that exists (spec section 8).
 */
export function recordCustomSnapshot(id: string, snapshotDir: string): void {
  const files = listSnapshotFiles(snapshotDir);
  getDb()
    .prepare(
      "UPDATE custom_mlx_models SET revision = ?, files_json = ? WHERE id = ?",
    )
    .run(basename(snapshotDir), JSON.stringify(files), id);
}

/**
 * True when a downloaded repo holds code the worker could import (spec
 * section 11): a .py file anywhere, or a top-level .json file with an
 * `auto_map` key. Validation reads `main` once at add time. This scan reads the
 * files that are on disk, which are the files the worker loads.
 */
export function hasRemoteCode(repoDir: string): boolean {
  const snapshotsDir = join(repoDir, "snapshots");
  try {
    return readdirSync(snapshotsDir).some((revision) => {
      const dir = join(snapshotsDir, revision);
      return (readdirSync(dir, { recursive: true }) as string[]).some(
        (path) => {
          const lower = path.toLowerCase();
          if (lower.endsWith(".py")) return true;
          if (path.includes("/") || !lower.endsWith(".json")) return false;
          return jsonHasAutoMap(join(dir, path));
        },
      );
    });
  } catch {
    // No snapshots dir: nothing to load.
    return false;
  }
}

function jsonHasAutoMap(file: string): boolean {
  if (statSync(file).size > MAX_JSON_SCAN_BYTES) return true;
  try {
    const json: unknown = JSON.parse(readFileSync(file, "utf8"));
    return !!json && typeof json === "object" && "auto_map" in json;
  } catch {
    // Not JSON, so `transformers` cannot read an auto_map from it either.
    return false;
  }
}

setCustomMlxResolver(getCustomMlxDef);
