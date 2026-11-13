import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";

// Sub-folders: 2 levels only. A top-level folder (parent_id NULL) can hold
// child folders. A child folder cannot hold folders.

export function meetingFolderExists(id: string | null): boolean {
  return (
    id === null ||
    Boolean(
      getDb().prepare("SELECT 1 FROM meeting_folders WHERE id = ?").get(id),
    )
  );
}

// Check Unicode case here. SQLite NOCASE checks ASCII case in the unique key.
// A name is unique per parent. The top level (parentId null) is one parent.
export function meetingFolderNameExists(
  name: string,
  parentId: string | null,
  exceptId?: string,
): boolean {
  const rows = getDb()
    .prepare(
      "SELECT id, name FROM meeting_folders WHERE COALESCE(parent_id, '') = ?",
    )
    .all(parentId ?? "") as {
    id: string;
    name: string;
  }[];
  return rows.some(
    (row) =>
      row.id !== exceptId && row.name.toLowerCase() === name.toLowerCase(),
  );
}

/**
 * The scope of a folder: the folder id and the ids of its child folders.
 * A parent's scope includes its children everywhere (list, counts, search,
 * Ask, Overview). An unknown id gives only that id.
 */
export function folderScopeIds(db: DatabaseSync, folderId: string): string[] {
  const children = db
    .prepare(
      "SELECT id FROM meeting_folders WHERE parent_id = ? ORDER BY name COLLATE NOCASE, id",
    )
    .all(folderId) as { id: string }[];
  return [folderId, ...children.map((c) => c.id)];
}

/**
 * SQL for "this folder id column is in the scope of folder f.id". Use it in
 * a query that joins meeting_folders as `f`, for example
 * `meetings m ON m.folder_id ${IN_SCOPE_OF_F}`.
 */
export const IN_SCOPE_OF_F =
  "IN (SELECT s.id FROM meeting_folders s WHERE s.id = f.id OR s.parent_id = f.id)";

/** The parent id of a folder. null: top level. undefined: no such folder. */
export function folderParentId(
  db: DatabaseSync,
  folderId: string,
): string | null | undefined {
  const row = db
    .prepare("SELECT parent_id FROM meeting_folders WHERE id = ?")
    .get(folderId) as { parent_id: string | null } | undefined;
  return row === undefined ? undefined : row.parent_id;
}
