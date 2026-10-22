import type { DatabaseSync } from "node:sqlite";

type SqlParam = string | number;

interface QueryPageOptions {
  /** Table name. Use a code constant, never user input. */
  table: string;
  /** SQL conditions that are joined with AND. */
  where: string[];
  /** Values for the placeholders in `where`, in order. */
  params: SqlParam[];
  /** Columns that the caller may sort by. Other columns fall back to created_at. */
  orderColumns: ReadonlySet<string>;
  orderBy?: { column: string; order: string };
  limit: number;
  offset: number;
}

/** Return one page of rows and the total row count for the same filter. */
export function queryPage<T>(
  db: DatabaseSync,
  {
    table,
    where,
    params,
    orderColumns,
    orderBy,
    limit,
    offset,
  }: QueryPageOptions,
): { items: T[]; total: number } {
  const orderColumn =
    orderBy && orderColumns.has(orderBy.column) ? orderBy.column : "created_at";
  // Default ordering (no orderBy param) is newest-first.
  const orderDir = orderBy
    ? orderBy.order === "desc"
      ? "DESC"
      : "ASC"
    : "DESC";
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const items = db
    .prepare(
      `SELECT * FROM ${table} ${whereClause} ORDER BY ${orderColumn} ${orderDir} LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as unknown as T[];
  const countRow = db
    .prepare(`SELECT COUNT(*) as count FROM ${table} ${whereClause}`)
    .get(...params) as { count: number };

  return { items, total: countRow.count };
}

/** created_at in the local "today", as a range on the raw column. */
export const LOCAL_TODAY_WHERE = `created_at >= datetime('now', 'localtime', 'start of day', 'utc')
  AND created_at < datetime('now', 'localtime', 'start of day', '+1 day', 'utc')`;

/** Build the local-time date filters for created_at. Both dates are optional. */
export function dateRangeWhere(
  start: string | null,
  end: string | null,
): { where: string[]; params: string[] } {
  const where: string[] = [];
  const params: string[] = [];
  // created_at is UTC text from datetime('now') ("YYYY-MM-DD HH:MM:SS").
  // Compare the raw column with the UTC times of the local day edges, so the
  // created_at index is used. Same days as date(created_at, 'localtime').
  if (start) {
    where.push("created_at >= datetime(?, 'utc')");
    params.push(start);
  }
  if (end) {
    where.push("created_at < datetime(?, '+1 day', 'utc')");
    params.push(end);
  }
  return { where, params };
}
