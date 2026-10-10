import { beforeEach, describe, expect, it } from "vitest";
import createApp from "../src/index.js";
import { getDb, writeSetting } from "../src/lib/db.js";
import {
  HISTORY_PAUSED_SETTING_KEY,
  HISTORY_RETENTION_SETTING_KEY,
  purgeExpiredHistory,
  saveRawHistory,
} from "../src/lib/history-store.js";

// Search tests for the history route (GET /api/history?search=).
// The route uses an FTS5 index for terms of 3 or more characters and a
// LIKE scan for shorter terms. These tests run through the route only.
// Each test checks what the user sees: the rows that the route returns.

const app = createApp();

interface HistoryItem {
  raw_text: string;
}

async function searchTexts(term: string): Promise<string[]> {
  const res = await app.request(
    `/api/history?search=${encodeURIComponent(term)}`,
  );
  expect(res.status).toBe(200);
  const data = (await res.json()) as { items: HistoryItem[] };
  return data.items.map((item) => item.raw_text).sort();
}

function addRow(rawText: string): void {
  const saved = saveRawHistory({
    rawText,
    voiceProvider: "voice",
    voiceModel: "model",
    durationMs: 1000,
    audioDurationMs: 1000,
  });
  expect(saved).toBe(true);
}

function idOf(rawText: string): number {
  const row = getDb()
    .prepare("SELECT id FROM transcription_history WHERE raw_text = ?")
    .get(rawText) as { id: number } | undefined;
  if (!row) throw new Error(`no history row for "${rawText}"`);
  return row.id;
}

describe("history search (FTS5 and LIKE paths)", () => {
  beforeEach(() => {
    const db = getDb();
    db.exec("DELETE FROM transcription_history");
    db.prepare("DELETE FROM settings WHERE key = ?").run(
      HISTORY_PAUSED_SETTING_KEY,
    );
    db.prepare("DELETE FROM settings WHERE key = ?").run(
      HISTORY_RETENTION_SETTING_KEY,
    );
  });

  it("finds rows by a term of 3 or more characters", async () => {
    addRow("quarterly budget review notes");
    addRow("grocery list for sunday");

    expect(await searchTexts("budget")).toEqual([
      "quarterly budget review notes",
    ]);
  });

  it("after an update, the old term no longer matches and the new term matches", async () => {
    addRow("alpha planning meeting");
    expect(await searchTexts("alpha")).toEqual(["alpha planning meeting"]);

    // No route edits history text. The row changes with direct SQL, which
    // fires the table triggers that keep the search index in step.
    getDb()
      .prepare(
        "UPDATE transcription_history SET raw_text = ? WHERE raw_text = ?",
      )
      .run("beta planning meeting", "alpha planning meeting");

    expect(await searchTexts("alpha")).toEqual([]);
    expect(await searchTexts("beta")).toEqual(["beta planning meeting"]);
  });

  it("after a delete, the removed row no longer matches", async () => {
    addRow("gamma retro notes");
    addRow("gamma standup notes");
    expect(await searchTexts("gamma")).toEqual([
      "gamma retro notes",
      "gamma standup notes",
    ]);

    const res = await app.request(`/api/history/${idOf("gamma retro notes")}`, {
      method: "DELETE",
    });
    expect(res.ok).toBe(true);

    expect(await searchTexts("gamma")).toEqual(["gamma standup notes"]);
  });

  it("after a retention purge, expired rows no longer match", async () => {
    addRow("delta archive entry");
    addRow("delta fresh entry");
    // Age one row to 40 days. Retention keeps 30 days.
    getDb()
      .prepare(
        "UPDATE transcription_history SET created_at = datetime('now', '-40 days') WHERE raw_text = ?",
      )
      .run("delta archive entry");
    expect(await searchTexts("delta")).toEqual([
      "delta archive entry",
      "delta fresh entry",
    ]);

    writeSetting(HISTORY_RETENTION_SETTING_KEY, "30");
    expect(purgeExpiredHistory()).toBe(1);

    expect(await searchTexts("delta")).toEqual(["delta fresh entry"]);
  });

  it("finds rows by a 2-character term", async () => {
    addRow("ok go for the launch");
    addRow("bye now");

    expect(await searchTexts("ok")).toEqual(["ok go for the launch"]);
  });

  it("does not throw on a double quote and matches it as a literal character", async () => {
    addRow('she said "hello" to the team');
    addRow("hello there with no quotes");

    const res = await app.request(
      `/api/history?search=${encodeURIComponent('"hello"')}`,
    );
    expect(res.status).toBe(200);

    expect(await searchTexts('"hello"')).toEqual([
      'she said "hello" to the team',
    ]);
  });

  it("finds a non-ASCII term with different case (accepted FTS5 difference)", async () => {
    // Owner decision (2026-10-09): FTS5 folds case for non-ASCII letters.
    // LIKE does not, so this match is a deliberate change.
    addRow("notre ÉCOLE ouvre demain");

    expect(await searchTexts("école")).toEqual(["notre ÉCOLE ouvre demain"]);
  });

  it("treats % and _ in a term as plain text (accepted FTS5 difference)", async () => {
    // Owner decision (2026-10-09): % and _ are plain characters, not LIKE
    // wildcards. Each term below must match only the row with the literal
    // character.
    addRow("discount 50% off today");
    addRow("discount 5000 off today");
    addRow("snake_case name");
    addRow("snakeXcase name");

    expect(await searchTexts("50%")).toEqual(["discount 50% off today"]);
    expect(await searchTexts("e_c")).toEqual(["snake_case name"]);
  });
});
