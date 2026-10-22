/**
 * The history date filters compare the raw created_at column with the UTC
 * times of the local day edges, so SQLite uses the created_at index
 * (app-stability-roadmap PR 15, issue #286). The rows must be the same as
 * with the old date(created_at, 'localtime') filters, also on the edges of a
 * day and on a DST change day.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import createApp from "../src/index.js";
import { getDb } from "../src/lib/db.js";
import { dateRangeWhere, LOCAL_TODAY_WHERE } from "../src/lib/list-query.js";

const app = createApp();
const TZ = process.env.TZ;

afterEach(() => {
  getDb().exec("DELETE FROM transcription_history");
});

afterAll(() => {
  if (TZ === undefined) delete process.env.TZ;
  else process.env.TZ = TZ;
});

/** The filters before this change, as the reference. */
function oldWhere(start: string | null, end: string | null) {
  const where: string[] = [];
  const params: string[] = [];
  if (start) {
    where.push("date(created_at, 'localtime') >= ?");
    params.push(start);
  }
  if (end) {
    where.push("date(created_at, 'localtime') <= ?");
    params.push(end);
  }
  return { where, params };
}

function ids(
  filter: { where: string[]; params: string[] },
  order = "ORDER BY id",
): number[] {
  const clause = filter.where.length
    ? `WHERE ${filter.where.join(" AND ")}`
    : "";
  return (
    getDb()
      .prepare(`SELECT id FROM transcription_history ${clause} ${order}`)
      .all(...filter.params) as { id: number }[]
  ).map((r) => r.id);
}

function insertAt(createdAt: string): void {
  getDb()
    .prepare(
      `INSERT INTO transcription_history (raw_text, voice_provider, voice_model, duration_ms, created_at)
       VALUES ('fictional note', 'p', 'm', 1, ?)`,
    )
    .run(createdAt);
}

/** UTC text of a time `seconds` away from the local midnight of `day`. */
function nearMidnight(day: string, seconds: number): string {
  return (
    getDb()
      .prepare("SELECT datetime(?, 'utc', ?) AS t")
      .get(day, `${seconds} seconds`) as { t: string }
  ).t;
}

function plan(sql: string, params: string[]): string {
  return (
    getDb()
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...params) as {
      detail: string;
    }[]
  )
    .map((r) => r.detail)
    .join(" | ");
}

describe("history date filters", () => {
  // Sao Paulo has no DST now; New York and Berlin change on these days.
  const zones = [
    "UTC",
    "America/Sao_Paulo",
    "Asia/Tokyo",
    "America/New_York",
    "Europe/Berlin",
  ];
  const days = [
    "2026-10-24",
    "2026-10-25",
    "2026-10-26",
    "2026-10-31",
    "2026-11-01",
    "2026-11-02",
  ];

  for (const zone of zones) {
    it(`gives the same rows as date(created_at, 'localtime') in ${zone}`, async () => {
      process.env.TZ = zone;
      for (const day of days) {
        for (const s of [-1, 0, 1, 86_399, 86_400])
          insertAt(nearMidnight(day, s));
      }
      const pairs: [string | null, string | null][] = [
        [null, null],
        ["2026-10-25", null],
        [null, "2026-10-25"],
        ["2026-10-25", "2026-10-25"],
        ["2026-10-25", "2026-11-01"],
        ["2026-11-01", "2026-11-01"],
        ["2026-11-02", "2026-10-24"],
      ];
      for (const [start, end] of pairs) {
        const expected = ids(oldWhere(start, end));
        expect(
          ids(dateRangeWhere(start, end)),
          `${zone} ${start}..${end}`,
        ).toEqual(expected);

        // The routes give the same rows and totals.
        const qs = new URLSearchParams({ limit: "200" });
        if (start) qs.set("start_date", start);
        if (end) qs.set("end_date", end);
        const list = (await (
          await app.request(`/api/history?${qs}`)
        ).json()) as {
          items: { id: number }[];
          total: number;
        };
        expect(list.items.map((i) => i.id).sort((a, b) => a - b)).toEqual(
          expected,
        );
        expect(list.total).toBe(expected.length);
        const stats = (await (
          await app.request(`/api/history/stats?${qs}`)
        ).json()) as {
          total_sessions: number;
        };
        expect(stats.total_sessions).toBe(expected.length);
      }
    });
  }

  it("counts today's rows as date(created_at, 'localtime') = date('now', 'localtime')", async () => {
    for (const zone of ["UTC", "America/Sao_Paulo", "Asia/Tokyo"]) {
      process.env.TZ = zone;
      getDb().exec("DELETE FROM transcription_history");
      const today = (
        getDb().prepare("SELECT date('now', 'localtime') AS d").get() as {
          d: string;
        }
      ).d;
      for (const s of [-1, 0, 1, 86_399, 86_400])
        insertAt(nearMidnight(today, s));
      const expected = ids({
        where: ["date(created_at, 'localtime') = date('now', 'localtime')"],
        params: [],
      });
      expect(expected).toHaveLength(3);
      expect(ids({ where: [LOCAL_TODAY_WHERE], params: [] })).toEqual(expected);
      const stats = (await (
        await app.request("/api/history/stats")
      ).json()) as {
        today_sessions: number;
      };
      expect(stats.today_sessions).toBe(3);
    }
  });

  it("uses the created_at index (EXPLAIN QUERY PLAN)", () => {
    const sql = (w: { where: string[] }) =>
      `SELECT * FROM transcription_history WHERE ${w.where.join(" AND ")} ORDER BY created_at DESC`;
    const before = plan(sql(oldWhere("2026-10-01", "2026-10-31")), [
      "2026-10-01",
      "2026-10-31",
    ]);
    const after = plan(sql(dateRangeWhere("2026-10-01", "2026-10-31")), [
      "2026-10-01",
      "2026-10-31",
    ]);
    const today = plan(
      `SELECT COUNT(*) AS sessions, COALESCE(SUM(cost_usd), 0) AS cost FROM transcription_history WHERE ${LOCAL_TODAY_WHERE}`,
      [],
    );
    const todayBefore = plan(
      "SELECT COUNT(*) AS sessions, COALESCE(SUM(cost_usd), 0) AS cost FROM transcription_history WHERE date(created_at, 'localtime') = date('now', 'localtime')",
      [],
    );
    console.log(`EXPLAIN today before: ${todayBefore}`);
    console.log(`EXPLAIN before: ${before}`);
    console.log(`EXPLAIN after: ${after}`);
    console.log(`EXPLAIN today: ${today}`);
    // Before: the index gives only the order; every row is read (no range).
    expect(before).not.toMatch(/SEARCH transcription_history USING/);
    expect(todayBefore).not.toMatch(/SEARCH transcription_history USING/);
    expect(after).toMatch(
      /SEARCH transcription_history USING INDEX idx_transcription_history_created_at \(created_at>\? AND created_at<\?\)/,
    );
    expect(today).toMatch(
      /SEARCH transcription_history USING INDEX idx_transcription_history_created_at \(created_at>\? AND created_at<\?\)/,
    );
  });
});
