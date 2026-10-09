import { zValidator } from "@hono/zod-validator";
import { historyQuerySchema } from "@openstyle/validations";
import { Hono } from "hono";
import { getDb } from "../lib/db.js";
import { dateRangeWhere, queryPage } from "../lib/list-query.js";

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

    // Use localtime to match the user's timezone for "today" boundary
    const today = db
      .prepare(
        `SELECT COUNT(*) as sessions, COALESCE(SUM(cost_usd), 0) as cost
         FROM transcription_history
         WHERE date(created_at, 'localtime') = date('now', 'localtime')`,
      )
      .get() as { sessions: number; cost: number };

    return c.json({
      ...stats,
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
