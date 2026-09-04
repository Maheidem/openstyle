import type { DatabaseSync } from "node:sqlite";

/**
 * User dictionary word replacements (longest keys first) for the dictation
 * delivery path (`applyFinalRewrites` → `postProcess`).
 *
 * Perf shape (specs/lean-audit-2026-09.md T1-7):
 * - The compiled replacement list (rows + per-key RegExps) is cached **per
 *   dictionary version**. Every dictionary write route bumps the version via
 *   {@link markDictionaryChanged}, so a delivery either reuses the cached
 *   snapshot or rebuilds it once — never a full SELECT + N regex builds per
 *   transcript. The usage-count UPDATE (see below) deliberately does NOT
 *   bump the version: it only touches `usage_count`, not the keys/values
 *   the snapshot is built from.
 * - `usage_count` increments are **deferred past delivery and batched**:
 *   each delivery only records which entry ids matched; a scheduled flush
 *   (setImmediate — runs after the current macrotask, i.e. after the cleaned
 *   text has been handed to the HTTP/WS transport) folds every pending
 *   delivery into a single transaction. Counting semantics are unchanged
 *   from the inline era: +1 per matched entry per delivery, regardless of
 *   how many times the key occurred in that text.
 */

const CJK_SCRIPT_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORDLIKE_CHAR_CLASS = "[\\p{L}\\p{N}\\p{M}_]";

const REGEX_CACHE_MAX = 5000;
const regexCache = new Map<string, RegExp>();

function buildDictionaryRegex(key: string): RegExp {
  const cached = regexCache.get(key);
  if (cached) return cached;

  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Chinese/Japanese/Korean phrases are commonly written without spaces, so
  // "whole word" boundaries prevent valid replacements inside running text.
  let regex: RegExp;
  if (CJK_SCRIPT_RE.test(key)) {
    regex = new RegExp(escaped, "gu");
  } else {
    const startsWordLike = /^[\p{L}\p{N}\p{M}_]/u.test(key);
    const endsWordLike = /[\p{L}\p{N}\p{M}_]$/u.test(key);
    const prefix = startsWordLike ? `(?<!${WORDLIKE_CHAR_CLASS})` : "";
    const suffix = endsWordLike ? `(?!${WORDLIKE_CHAR_CLASS})` : "";
    regex = new RegExp(`${prefix}${escaped}${suffix}`, "giu");
  }

  if (regexCache.size >= REGEX_CACHE_MAX) regexCache.clear();
  regexCache.set(key, regex);
  return regex;
}

// ---------------------------------------------------------------------------
// Compiled-snapshot cache (one per dictionary version)
// ---------------------------------------------------------------------------

/** One dictionary entry with its replacement pattern precompiled. */
export interface CompiledDictionaryEntry {
  id: number;
  key: string;
  value: string;
  regex: RegExp;
}

/**
 * Monotonic dictionary version. Bumped by every dictionary write route
 * (routes/dictionary.ts: create, edit, delete, import) via
 * {@link markDictionaryChanged}; compared against each cached snapshot.
 */
let dictionaryVersion = 0;

/** Invalidate every compiled snapshot — call after any dictionary write. */
export function markDictionaryChanged(): void {
  dictionaryVersion++;
}

/** Test/inspection seam: the current version token. */
export function getDictionaryVersion(): number {
  return dictionaryVersion;
}

// Keyed by connection so the cache is correct for the production singleton
// and for tests that pass their own in-memory DatabaseSync.
const compiledCache = new WeakMap<
  DatabaseSync,
  { version: number; entries: CompiledDictionaryEntry[] }
>();

/**
 * The dictionary's replacement entries, longest key first, with regexes
 * precompiled. Rebuilt only when the dictionary version changed since the
 * last build for this connection; otherwise the cached snapshot is returned.
 */
export function getCompiledDictionary(
  db: DatabaseSync,
): CompiledDictionaryEntry[] {
  const cached = compiledCache.get(db);
  if (cached && cached.version === dictionaryVersion) return cached.entries;
  let entries: CompiledDictionaryEntry[] = [];
  try {
    const rows = db
      .prepare(
        "SELECT id, key, value FROM dictionary ORDER BY length(key) DESC",
      )
      .all() as { id: number; key: string; value: string }[];
    entries = rows.map((r) => ({
      id: r.id,
      key: r.key,
      value: r.value,
      regex: buildDictionaryRegex(r.key),
    }));
  } catch {
    // Dictionary table may not exist yet — cache the empty snapshot so a
    // missing table isn't re-probed on every delivery either.
  }
  compiledCache.set(db, { version: dictionaryVersion, entries });
  return entries;
}

// ---------------------------------------------------------------------------
// Deferred, batched usage_count accounting
// ---------------------------------------------------------------------------

/** One delivery's matched-entry counts (entry id → times this delivery matched it). */
interface PendingUsageBatch {
  db: DatabaseSync;
  counts: Map<number, number>;
}

const pendingUsage: PendingUsageBatch[] = [];
let flushScheduled = false;

function scheduleUsageFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  // Macrotask, not microtask: runs after the current delivery finishes
  // handing its response to the transport (the HTTP response write / WS
  // send), keeping the DB write off the delivery critical path.
  setImmediate(() => {
    flushScheduled = false;
    flushPendingDictionaryUsage();
  });
}

/**
 * Fold every pending delivery's usage counts into one transaction per
 * connection: +n per entry id, where n is the number of deliveries that
 * matched it. Runs scheduled via setImmediate after delivery; also callable
 * directly (tests) for deterministic accounting. Best-effort: a failure
 * (missing table, locked db) drops the pending counts, never text output.
 */
export function flushPendingDictionaryUsage(): void {
  if (pendingUsage.length === 0) return;
  const batches = pendingUsage.splice(0, pendingUsage.length);

  const byDb = new Map<DatabaseSync, Map<number, number>>();
  for (const { db, counts } of batches) {
    let merged = byDb.get(db);
    if (!merged) {
      merged = new Map();
      byDb.set(db, merged);
    }
    for (const [id, n] of counts) {
      merged.set(id, (merged.get(id) ?? 0) + n);
    }
  }

  for (const [db, counts] of byDb) {
    try {
      db.exec("BEGIN");
      const stmt = db.prepare(
        "UPDATE dictionary SET usage_count = usage_count + ? WHERE id = ?",
      );
      for (const [id, n] of counts) stmt.run(n, id);
      db.exec("COMMIT");
    } catch {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Connection unusable — nothing left to do.
      }
    }
  }
}

/**
 * Apply user dictionary word replacements (longest keys first). Text output
 * is identical to the uncached inline era; the only behavioral difference is
 * that `usage_count` increments are recorded now and land in the DB on the
 * next {@link flushPendingDictionaryUsage} (scheduled post-delivery).
 */
export function applyDictionaryReplacements(
  text: string,
  db: DatabaseSync,
): string {
  let cleanedText = text;

  try {
    const entries = getCompiledDictionary(db);
    if (entries.length === 0) return cleanedText;

    const counts = new Map<number, number>();
    for (const { id, value, regex } of entries) {
      const nextText = cleanedText.replace(regex, () => value);
      if (nextText !== cleanedText) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
        cleanedText = nextText;
      }
    }

    if (counts.size > 0) {
      pendingUsage.push({ db, counts });
      scheduleUsageFlush();
    }
  } catch {
    // Dictionary table may not exist yet
  }

  return cleanedText;
}
