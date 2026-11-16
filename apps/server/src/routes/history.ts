import type { DatabaseSync } from "node:sqlite";
import { zValidator } from "@hono/zod-validator";
import { historyQuerySchema } from "@openstyle/validations";
import { Hono } from "hono";
import { getDb } from "../lib/db.js";
import { LANGUAGE_MIXED } from "../lib/dictation-language.js";
import { getLanguagesSetting } from "../lib/language.js";
import {
  dateRangeWhere,
  LOCAL_TODAY_WHERE,
  queryPage,
} from "../lib/list-query.js";

interface HistoryRow {
  id: number;
  raw_text: string;
  cleaned_text: string | null;
  voice_provider: string;
  voice_model: string;
  llm_provider: string | null;
  llm_model: string | null;
  duration_ms: number;
  audio_duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  fixes_count: number;
  cleanup_skipped: string | null;
  created_at: string;
}

// Space-count heuristic for words in the final text, mirrored in /stats and
// /daily so both aggregates agree.
const WORDS_SQL = `
  CASE
    WHEN length(trim(COALESCE(cleaned_text, raw_text))) = 0 THEN 0
    ELSE length(trim(COALESCE(cleaned_text, raw_text)))
      - length(replace(trim(COALESCE(cleaned_text, raw_text)), ' ', ''))
      + 1
  END`;

/** Days of per-day history returned by /daily — enough for the usage heatmap. */
const DAILY_WINDOW_DAYS = 140;

/** One row of the "By language" stats. `language` null: Unknown. */
export interface LanguageStat {
  language: string | null;
  dictations: number;
  words: number;
  audio_ms: number;
}

/**
 * Dictations, words and audio per language, in the same period as the other
 * stats (issue #443). Each set language has a row, also with 0, in the order
 * of the set; then "mixed" and Unknown (null), only when they have rows. A
 * language outside the set folds into Unknown. With an empty set
 * (auto-detect) no language folds: each detected code has its own row, the
 * most words first.
 */
export function languageStats(
  db: DatabaseSync,
  languages: string[],
  where: string[],
  params: (string | number)[],
): LanguageStat[] {
  const bucket =
    languages.length > 0
      ? `CASE WHEN language IN (${languages.map(() => "?").join(", ")})
              THEN language
              WHEN language = '${LANGUAGE_MIXED}' THEN language
              ELSE NULL END`
      : `CASE WHEN length(language) = 2 OR language = '${LANGUAGE_MIXED}'
              THEN language ELSE NULL END`;
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT ${bucket} AS language,
              COUNT(*) AS dictations,
              COALESCE(SUM(${WORDS_SQL}), 0) AS words,
              COALESCE(SUM(audio_duration_ms), 0) AS audio_ms
         FROM transcription_history
         ${whereClause}
        GROUP BY 1`,
    )
    .all(...languages, ...params) as unknown as LanguageStat[];
  const byCode = new Map(rows.map((r) => [r.language, r]));
  const zero = (language: string): LanguageStat => ({
    language,
    dictations: 0,
    words: 0,
    audio_ms: 0,
  });
  const detected =
    languages.length > 0
      ? languages.map((code) => byCode.get(code) ?? zero(code))
      : rows
          .filter((r) => r.language !== null && r.language !== LANGUAGE_MIXED)
          .sort((a, b) => b.words - a.words);
  const tail = [byCode.get(LANGUAGE_MIXED), byCode.get(null)].filter(
    (r): r is LanguageStat => r !== undefined && r.dictations > 0,
  );
  return [...detected, ...tail];
}

const ALLOWED_ORDER_COLUMNS = new Set([
  "created_at",
  "duration_ms",
  "cost_usd",
]);

const history = new Hono()
  .get("/", zValidator("query", historyQuerySchema), (c) => {
    const {
      limit,
      offset,
      search: rawSearch,
      orderBy,
      start_date = null,
      end_date = null,
    } = c.req.valid("query");
    const search = rawSearch?.trim() || "";
    // The trigram index cannot match fewer than 3 characters. Short terms
    // keep the LIKE scan. Longer terms use FTS5, with the term as one phrase.
    const useFts = Array.from(search).length >= 3;
    const pattern = `%${search}%`;
    const ftsPhrase = `"${search.replaceAll('"', '""')}"`;

    const dates = dateRangeWhere(start_date, end_date);
    const { items, total } = queryPage<HistoryRow>(getDb(), {
      table: "transcription_history",
      where: [
        ...(useFts
          ? [
              "id IN (SELECT rowid FROM transcription_history_fts WHERE transcription_history_fts MATCH ?)",
            ]
          : search
            ? ["(raw_text LIKE ? OR cleaned_text LIKE ? OR voice_model LIKE ?)"]
            : []),
        ...dates.where,
      ],
      params: [
        ...(useFts ? [ftsPhrase] : search ? [pattern, pattern, pattern] : []),
        ...dates.params,
      ],
      orderColumns: ALLOWED_ORDER_COLUMNS,
      orderBy,
      limit,
      offset,
    });

    return c.json({ items, total, limit, offset });
  })
  .get("/stats", zValidator("query", historyQuerySchema), (c) => {
    const db = getDb();

    const { start_date: startDate = null, end_date: endDate = null } =
      c.req.valid("query");

    const { where, params } = dateRangeWhere(startDate, endDate);
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const statsQuery = `
        SELECT
          COUNT(*) as total_sessions,
          COALESCE(SUM(duration_ms), 0) as total_duration_ms,
          COALESCE(SUM(input_tokens), 0) as total_input_tokens,
          COALESCE(SUM(output_tokens), 0) as total_output_tokens,
          COALESCE(SUM(cost_usd), 0) as total_cost_usd,
          COALESCE(AVG(duration_ms), 0) as avg_duration_ms,
          COALESCE(SUM(audio_duration_ms), 0) as total_audio_ms,
          COALESCE(SUM(fixes_count), 0) as total_fixes,
          COALESCE(SUM(${WORDS_SQL}), 0) as total_words
        FROM transcription_history
        ${whereClause}
        `;

    const stats = db.prepare(statsQuery).get(...params) as {
      total_sessions: number;
      total_duration_ms: number;
      total_input_tokens: number;
      total_output_tokens: number;
      total_cost_usd: number;
      avg_duration_ms: number;
      total_audio_ms: number;
      total_fixes: number;
      total_words: number;
    };

    const unfilteredCount = db
      .prepare("SELECT COUNT(*) as count FROM transcription_history")
      .get() as { count: number };

    // "Today" is the local day, as a range that uses the created_at index.
    const today = db
      .prepare(
        `SELECT COUNT(*) as sessions, COALESCE(SUM(cost_usd), 0) as cost
         FROM transcription_history
         WHERE ${LOCAL_TODAY_WHERE}`,
      )
      .get() as { sessions: number; cost: number };

    const byLanguage =
      stats.total_sessions > 0
        ? languageStats(db, getLanguagesSetting(), where, params)
        : [];

    return c.json({
      ...stats,
      by_language: byLanguage,
      today_sessions: today.sessions,
      today_cost: today.cost,
      unfiltered_total_sessions: unfilteredCount.count,
    });
  })
  // Per-local-day usage series for the stats sidebar's heatmap. Fixed lookback
  // window, independent of the list filters. Registered before "/:id" so
  // "daily" isn't swallowed by the id matcher.
  .get("/daily", (c) => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT
           date(created_at, 'localtime') as day,
           COUNT(*) as sessions,
           COALESCE(SUM(${WORDS_SQL}), 0) as words
         FROM transcription_history
         WHERE created_at >= datetime('now', ?)
         GROUP BY day
         ORDER BY day ASC`,
      )
      .all(`-${DAILY_WINDOW_DAYS} days`) as {
      day: string;
      sessions: number;
      words: number;
    }[];

    return c.json({ days: rows });
  })
  .get("/:id", (c) => {
    const db = getDb();
    const id = Number(c.req.param("id"));
    const row = db
      .prepare("SELECT * FROM transcription_history WHERE id = ?")
      .get(id) as HistoryRow | undefined;

    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json(row);
  })
  .delete("/:id", (c) => {
    const db = getDb();
    const id = Number(c.req.param("id"));
    db.prepare("DELETE FROM transcription_history WHERE id = ?").run(id);
    return c.json({ ok: true });
  })
  .delete("/", (c) => {
    const db = getDb();
    db.exec("DELETE FROM transcription_history");
    return c.json({ ok: true });
  });

export default history;
