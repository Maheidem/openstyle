import { z } from "zod/v3";

/** Max number of transcription languages a user can select. */
export const MAX_LANGUAGES = 5;

/**
 * The canonical transcription-language list: an array of ISO codes.
 *
 * An array lets a multilingual user list every language they speak (streaming
 * STT biases toward all of them; batch STT uses the first). The list has a cap
 * of {@link MAX_LANGUAGES} to keep the STT hints focused. `[]` (or `null`) means
 * auto-detect.
 *
 * Note the sentinel `"auto"` is a UI-only concept and is never stored here:
 * pickers translate an "auto-detect" selection into an empty array.
 */
export const languageListSchema = z
  .array(z.string().trim().min(1).max(10))
  .max(MAX_LANGUAGES);
export type LanguageList = z.infer<typeof languageListSchema>;

/**
 * Normalize a raw language-code list into the canonical stored form: trim,
 * lowercase, drop empties and the `"auto"` sentinel, dedupe (order-preserving),
 * and cap at {@link MAX_LANGUAGES}. Returns `[]` when nothing usable remains
 * (which providers treat as auto-detect).
 */
export function normalizeLanguageList(
  codes: readonly string[] | null | undefined,
): string[] {
  if (!codes) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of codes) {
    const code = raw.trim().toLowerCase();
    if (!code || code === "auto" || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
    if (out.length >= MAX_LANGUAGES) break;
  }
  return out;
}

/**
 * Resolve a persisted language selection into the canonical list, shared by
 * every client's storage layer (server SQLite, Electron settings map, mobile
 * AsyncStorage). `raw` is the stored value of the canonical `languages` key (a
 * JSON array string); `legacy` is the pre-migration singular `language` value.
 *
 * Semantics (matching the server's authoritative read):
 *   - `raw` present (even empty/invalid) is authoritative → never falls back;
 *     an explicit empty/cleared value means auto-detect (`[]`). A stray scalar
 *     stored under the array key is tolerated as a single code.
 *   - only an entirely absent `raw` falls back to the legacy singular key, so a
 *     pre-migration choice is honored exactly once.
 */
export function parseStoredLanguageList(
  raw: string | null | undefined,
  legacy: string | null | undefined,
): string[] {
  if (raw != null) {
    if (!raw) return []; // present-but-empty = explicit auto-detect
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return normalizeLanguageList(parsed);
    } catch {
      // A stray scalar stored under the array key — treat as one code.
      return normalizeLanguageList([raw]);
    }
    return [];
  }
  return normalizeLanguageList(legacy ? [legacy] : []);
}

/** A language option in the shape both pickers consume. */
export interface LanguageChoice {
  code: string;
  label: string;
}

/**
 * Filter language options by a free-text query, matching either the display
 * label or the language code (case-insensitive). Pinned entries such as
 * `"auto"` are always kept so the search list never hides the default. An empty
 * query returns the list unchanged.
 */
export function filterLanguageOptions<T extends LanguageChoice>(
  options: readonly T[],
  query: string,
  pinnedFirst: readonly string[] = ["auto"],
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...options];
  const pinnedSet = new Set(pinnedFirst);
  return options.filter(
    (o) =>
      pinnedSet.has(o.code) ||
      o.label.toLowerCase().includes(q) ||
      o.code.toLowerCase().includes(q),
  );
}
