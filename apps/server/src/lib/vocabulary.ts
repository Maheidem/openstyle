import { createAppLogger } from "@openstyle/utils";
import { getDb } from "./db.js";

const log = createAppLogger("vocabulary");

export interface VocabularyRow {
  id: number;
  term: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface VocabularyEntry {
  term: string;
  notes: string | null;
}

export function loadVocabularyEntries(): VocabularyEntry[] {
  const db = getDb();
  try {
    const rows = db
      .prepare(
        "SELECT term, notes FROM vocabulary ORDER BY length(term) DESC, created_at DESC",
      )
      .all() as { term: string; notes: string | null }[];
    return rows
      .map((r) => ({ term: r.term.trim(), notes: r.notes?.trim() || null }))
      .filter((r) => r.term.length > 0);
  } catch (err) {
    log.error(`Failed to load vocabulary terms: ${err}`);
    return [];
  }
}

/** All vocabulary terms for ASR biasing, longest first for provider limits. */
export function loadVocabularyTerms(): string[] {
  return loadVocabularyEntries().map((e) => e.term);
}

/** An entry accepted by {@link importVocabularyEntries}. */
export interface VocabularyImportEntry {
  term: string;
  notes?: string | null;
}

/**
 * Insert many vocabulary entries in one transaction, skipping blanks and
 * duplicates (`INSERT OR IGNORE`). Returns the counts so the caller can report
 * them and decide whether to push to the cloud.
 *
 * node:sqlite (`DatabaseSync`) has no `.transaction()` helper, so the batch is
 * wrapped in explicit BEGIN/COMMIT.
 */
export function importVocabularyEntries(entries: VocabularyImportEntry[]): {
  imported: number;
  skipped: number;
} {
  const db = getDb();
  let imported = 0;
  let skipped = 0;
  const insertStmt = db.prepare(
    "INSERT OR IGNORE INTO vocabulary (term, notes) VALUES (?, ?)",
  );

  db.exec("BEGIN");
  try {
    for (const entry of entries) {
      const term = entry.term.trim();
      if (!term) {
        skipped++;
        continue;
      }
      const result = insertStmt.run(term, entry.notes?.trim() || null);
      if (result.changes > 0) imported++;
      else skipped++;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return { imported, skipped };
}

/** All entries as `{ term, notes }`, sorted by term ascending (export order). */
export function exportVocabularyEntries(): VocabularyEntry[] {
  return getDb()
    .prepare("SELECT term, notes FROM vocabulary ORDER BY term ASC")
    .all() as unknown as VocabularyEntry[];
}

/**
 * Delete many vocabulary rows by id in one transaction. Ids are deduped so a
 * repeated id doesn't skew the count. Returns the number of rows actually
 * removed (ids that didn't exist are ignored).
 */
export function deleteVocabularyByIds(ids: number[]): number {
  const db = getDb();
  const unique = [...new Set(ids)];
  let deleted = 0;
  const remove = db.prepare("DELETE FROM vocabulary WHERE id = ?");

  db.exec("BEGIN");
  try {
    for (const id of unique) {
      const result = remove.run(id);
      if (result.changes > 0) deleted++;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return deleted;
}

const NOTE_TEXT_MAX_CHARS = 2000;

export function buildVocabularyNoteText(
  entries: VocabularyEntry[],
): string | undefined {
  const lines: string[] = [];
  let used = 0;
  for (const entry of entries) {
    if (!entry.notes) continue;
    const line = `${entry.term}: ${entry.notes}`;
    if (used + line.length + 1 > NOTE_TEXT_MAX_CHARS) continue;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}
