import { getDb } from "../db.js";

export function meetingFolderExists(id: string | null): boolean {
  return (
    id === null ||
    Boolean(
      getDb().prepare("SELECT 1 FROM meeting_folders WHERE id = ?").get(id),
    )
  );
}

// Check Unicode case here. SQLite NOCASE checks ASCII case in the unique key.
export function meetingFolderNameExists(
  name: string,
  exceptId?: string,
): boolean {
  const rows = getDb()
    .prepare("SELECT id, name FROM meeting_folders")
    .all() as {
    id: string;
    name: string;
  }[];
  return rows.some(
    (row) =>
      row.id !== exceptId && row.name.toLowerCase() === name.toLowerCase(),
  );
}
