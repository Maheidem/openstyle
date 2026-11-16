import { DatabaseSync } from "node:sqlite";
import { SETTINGS_KEYS } from "@openstyle/validations";
import { detectAll } from "tinyld";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import createApp from "../src/index.js";
import { getDb, writeSetting } from "../src/lib/db.js";
import {
  buildLanguageSystemPrompt,
  checkTextLanguage,
  knownLanguage,
  LANGUAGE_PENDING_LLM,
  LANGUAGE_UNKNOWN,
  type LanguageCheckDeps,
  languageStepSchema,
  QUIET_MS,
  runLanguageCheck,
  storedFromAnswer,
  waitForQuiet,
} from "../src/lib/dictation-language.js";
import { saveRawHistory } from "../src/lib/history-store.js";
import { pinnedLanguage, toIsoLanguage } from "../src/lib/language.js";
import type { CallProfile } from "../src/lib/llm/model-profiles.js";
import { initSchema } from "../src/lib/schema.js";

// Per-language stats (issue #443): schema v60, the language of each
// dictation (pin > ASR > tinyld > LLM), the background backfill and the
// `by_language` stats.

const app = createApp();

const EN_LONG =
  "Can you check the pull request and merge it after the build is green?";
const PT_LONG =
  "Pode verificar o pull request e fazer o merge depois que o CI ficar verde?";

const profile: CallProfile = {
  taskId: "meetingSummarize",
  provider: "fake",
  modelId: "fake-model",
  contextWindow: null,
  maxOutputTokens: null,
  structured: "json_schema_strict",
  reasoning: {
    mode: "off",
    budgetTokens: 0,
    countsInMaxOutput: false,
    maxBudgetTokens: null,
    boundedLevel: null,
    control: "none",
    force: false,
  },
  warnings: [],
};

/** A fake gateway that answers `answers` in order, one per call. */
function fakeLlm(answers: string[]): {
  deps: LanguageCheckDeps;
  texts: string[];
} {
  const texts: string[] = [];
  const callStructured = vi.fn(
    async (input: { messages: { content: string }[] }) => {
      texts.push(input.messages[0]?.content ?? "");
      const language = answers.shift();
      if (language === undefined) throw new Error("no scripted answer");
      return { object: { language } };
    },
  );
  return {
    deps: {
      callStructured:
        callStructured as unknown as LanguageCheckDeps["callStructured"],
      resolveProfile: async () => profile,
      waitForQuiet: async () => {},
    },
    texts,
  };
}

function addRow(
  rawText: string,
  opts: {
    language?: string | null;
    audioMs?: number;
    createdAt?: string;
    cleaned?: string | null;
  } = {},
): number {
  const result = getDb()
    .prepare(
      `INSERT INTO transcription_history
         (raw_text, cleaned_text, voice_provider, voice_model, duration_ms,
          audio_duration_ms, language, created_at)
       VALUES (?, ?, 'v', 'm', 1000, ?, ?, COALESCE(?, datetime('now')))`,
    )
    .run(
      rawText,
      opts.cleaned ?? null,
      opts.audioMs ?? 60000,
      opts.language === undefined ? null : opts.language,
      opts.createdAt ?? null,
    );
  return Number(result.lastInsertRowid);
}

function languageOf(id: number): string | null {
  return (
    getDb()
      .prepare("SELECT language FROM transcription_history WHERE id = ?")
      .get(id) as { language: string | null }
  ).language;
}

function setLanguages(codes: string[]): void {
  writeSetting(SETTINGS_KEYS.languages, JSON.stringify(codes));
}

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM transcription_history");
  db.exec("DELETE FROM llm_runs");
  setLanguages(["en", "pt"]);
});

// ---------------------------------------------------------------------------
// Schema v60
// ---------------------------------------------------------------------------

describe("schema 60: transcription_history.language", () => {
  it("adds a NULL language column to old rows and the todo index", () => {
    const db = new DatabaseSync(":memory:");
    initSchema(db);
    db.exec(`
      DROP INDEX idx_transcription_history_language_todo;
      ALTER TABLE transcription_history DROP COLUMN language;
      UPDATE schema_version SET version = 59;
      INSERT INTO transcription_history
        (raw_text, voice_provider, voice_model, duration_ms)
        VALUES ('old row', 'v', 'm', 1);
    `);
    initSchema(db);
    expect(
      db.prepare("SELECT raw_text, language FROM transcription_history").all(),
    ).toEqual([{ raw_text: "old row", language: null }]);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
        )
        .get("idx_transcription_history_language_todo"),
    ).toBeTruthy();
    expect(db.prepare("SELECT version FROM schema_version").get()).toEqual({
      version: 60,
    });
    // A second run changes nothing.
    initSchema(db);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Resolution order
// ---------------------------------------------------------------------------

describe("language resolution", () => {
  it("counts a pin only when it is a set language", () => {
    expect(pinnedLanguage(" PT ", ["en", "pt"])).toBe("pt");
    expect(pinnedLanguage("es", ["en", "pt"])).toBeNull();
    expect(pinnedLanguage(null, ["en", "pt"])).toBeNull();
  });

  it("maps ASR names and tags to ISO codes", () => {
    expect(toIsoLanguage("English")).toBe("en");
    expect(toIsoLanguage("pt-BR")).toBe("pt");
    expect(toIsoLanguage("de")).toBe("de");
    expect(toIsoLanguage("Cantonese")).toBeUndefined();
    expect(toIsoLanguage(undefined)).toBeUndefined();
  });

  it("takes the pin first, then the ASR language, else none", () => {
    expect(knownLanguage({ pin: "pt", asr: "en" })).toBe("pt");
    expect(knownLanguage({ pin: null, asr: "en" })).toBe("en");
    expect(knownLanguage({})).toBeNull();
  });

  it("writes the pin or the ASR language at save, else NULL for the check", () => {
    const save = (hint: { pin?: string | null; asr?: string | null }) => {
      saveRawHistory({
        rawText: EN_LONG,
        voiceProvider: "v",
        voiceModel: "m",
        durationMs: 1,
        audioDurationMs: 1,
        languageHint: hint,
      });
      return (
        getDb()
          .prepare(
            "SELECT language FROM transcription_history ORDER BY id DESC LIMIT 1",
          )
          .get() as { language: string | null }
      ).language;
    };
    expect(save({ pin: "pt", asr: "en" })).toBe("pt");
    expect(save({ asr: "en" })).toBe("en");
    expect(save({})).toBeNull();
  });
});

describe("tinyld text check", () => {
  it("decides a clear text in the set", () => {
    expect(checkTextLanguage(EN_LONG, ["en", "pt"], detectAll)).toEqual({
      language: "en",
    });
    expect(checkTextLanguage(PT_LONG, ["en", "pt"], detectAll)).toEqual({
      language: "pt",
    });
  });

  it("is unsure below the word minimum", () => {
    expect(checkTextLanguage("yes please", ["en", "pt"], detectAll)).toEqual({
      language: null,
    });
  });

  it("is unsure with no candidate from the set", () => {
    expect(checkTextLanguage(PT_LONG, ["en", "de"], () => [])).toEqual({
      language: null,
    });
    const onlyFr = () => [{ lang: "fr", accuracy: 1 }];
    expect(checkTextLanguage(PT_LONG, ["en", "pt"], onlyFr)).toEqual({
      language: null,
    });
  });

  it("is unsure when the top two set languages are close", () => {
    const close = () => [
      { lang: "en", accuracy: 0.3 },
      { lang: "pt", accuracy: 0.2 },
    ];
    expect(checkTextLanguage(EN_LONG, ["en", "pt"], close)).toEqual({
      language: null,
    });
    const clear = () => [
      { lang: "en", accuracy: 0.3 },
      { lang: "it", accuracy: 0.29 },
      { lang: "pt", accuracy: 0.1 },
    ];
    // "it" is not in the set, so it does not count.
    expect(checkTextLanguage(EN_LONG, ["en", "pt"], clear)).toEqual({
      language: "en",
    });
  });

  it("uses every language with an empty set", () => {
    const fr = () => [{ lang: "fr", accuracy: 1 }];
    expect(checkTextLanguage(PT_LONG, [], fr)).toEqual({ language: "fr" });
  });
});

describe("LLM check answer", () => {
  it("allows the set, mixed and unknown", () => {
    const schema = languageStepSchema(["en", "pt"]).zod;
    expect(schema.safeParse({ language: "pt" }).success).toBe(true);
    expect(schema.safeParse({ language: "mixed" }).success).toBe(true);
    expect(schema.safeParse({ language: "unknown" }).success).toBe(true);
    expect(schema.safeParse({ language: "es" }).success).toBe(false);
    expect(buildLanguageSystemPrompt(["en", "pt"])).toContain(
      '"pt" (Portuguese)',
    );
  });

  it("stores unknown and outside answers as unknown", () => {
    expect(storedFromAnswer("unknown", ["en"])).toBe(LANGUAGE_UNKNOWN);
    expect(storedFromAnswer("es", ["en"])).toBe(LANGUAGE_UNKNOWN);
    expect(storedFromAnswer("Mixed", ["en"])).toBe("mixed");
    expect(storedFromAnswer("es", [])).toBe("es");
  });
});

// ---------------------------------------------------------------------------
// The background job (backfill)
// ---------------------------------------------------------------------------

describe("language check job", () => {
  // The job yields with setImmediate between batches. The setup file fakes
  // the timers, so this block uses real ones.
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  it("fills old rows with tinyld, then sends unsure rows to the LLM", async () => {
    const en = addRow(EN_LONG);
    const pt = addRow("x", { cleaned: PT_LONG });
    const short = addRow("ok then");
    const kept = addRow(EN_LONG, { language: "pt" });
    const llm = fakeLlm(["mixed"]);

    const counts = await runLanguageCheck({ ...llm.deps, detectAll });

    expect(counts).toEqual({ text: 2, unsure: 1, llm: 1, unknown: 0 });
    expect(languageOf(en)).toBe("en");
    // The check reads the cleaned text first.
    expect(languageOf(pt)).toBe("pt");
    expect(languageOf(short)).toBe("mixed");
    expect(languageOf(kept)).toBe("pt");
    expect(llm.texts).toEqual(["ok then"]);
    // The LLM call has a run record, like the other LLM calls.
    expect(
      getDb()
        .prepare("SELECT scope, scope_id, kind, status FROM llm_runs")
        .all(),
    ).toEqual([
      {
        scope: "dictation",
        scope_id: String(short),
        kind: "dictationLanguage",
        status: "succeeded",
      },
    ]);
  });

  it("is resumable and runs once", async () => {
    const waiting = addRow("ok then", { language: LANGUAGE_PENDING_LLM });
    const fresh = addRow(EN_LONG);
    const first = fakeLlm(["en"]);
    await runLanguageCheck({ ...first.deps, detectAll });
    expect(languageOf(waiting)).toBe("en");
    expect(languageOf(fresh)).toBe("en");

    const second = fakeLlm([]);
    const again = await runLanguageCheck({ ...second.deps, detectAll });
    expect(again).toEqual({ text: 0, unsure: 0, llm: 0, unknown: 0 });
    expect(second.texts).toEqual([]);
  });

  it("leaves unsure rows unknown when no LLM is set up", async () => {
    const a = addRow("ok then");
    const b = addRow("yes");
    const counts = await runLanguageCheck({
      detectAll,
      resolveProfile: async () => {
        throw new Error("no model");
      },
    });
    expect(counts.unknown).toBe(2);
    expect(languageOf(a)).toBe(LANGUAGE_UNKNOWN);
    expect(languageOf(b)).toBe(LANGUAGE_UNKNOWN);
  });

  it("stores unknown for one failed LLM call and goes on", async () => {
    const a = addRow("ok then");
    const b = addRow("yes sure");
    // Newest first: b fails, a gets "pt".
    const llm = fakeLlm([]);
    let n = 0;
    const counts = await runLanguageCheck({
      ...llm.deps,
      detectAll,
      callStructured: (async () => {
        n += 1;
        if (n === 1) throw new Error("timeout");
        return { object: { language: "pt" } };
      }) as unknown as LanguageCheckDeps["callStructured"],
    });
    expect(counts).toMatchObject({ llm: 1, unknown: 1 });
    expect(languageOf(b)).toBe(LANGUAGE_UNKNOWN);
    expect(languageOf(a)).toBe("pt");
  });
});

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

interface ByLanguage {
  language: string | null;
  dictations: number;
  words: number;
  audio_ms: number;
}

async function byLanguage(query = ""): Promise<ByLanguage[]> {
  const res = await app.request(`/api/history/stats${query}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { by_language: ByLanguage[] }).by_language;
}

describe("GET /api/history/stats by_language", () => {
  it("groups by language, folds other languages into Unknown", async () => {
    addRow("one two three", { language: "pt", audioMs: 30000 });
    addRow("one two", { language: "en", audioMs: 60000 });
    addRow("a b c d", { language: "en", audioMs: 60000 });
    addRow("uno dos", { language: "es", audioMs: 10000 });
    addRow("x y", { language: "mixed", audioMs: 20000 });
    addRow("q", { language: LANGUAGE_UNKNOWN, audioMs: 1000 });
    addRow("w", { language: LANGUAGE_PENDING_LLM, audioMs: 1000 });
    addRow("z", { language: null, audioMs: 1000 });

    expect(await byLanguage()).toEqual([
      { language: "en", dictations: 2, words: 6, audio_ms: 120000 },
      { language: "pt", dictations: 1, words: 3, audio_ms: 30000 },
      { language: "mixed", dictations: 1, words: 2, audio_ms: 20000 },
      { language: null, dictations: 4, words: 5, audio_ms: 13000 },
    ]);
  });

  it("keeps set languages with 0 and hides empty Mixed and Unknown", async () => {
    addRow("one two", { language: "en" });
    expect(await byLanguage()).toEqual([
      { language: "en", dictations: 1, words: 2, audio_ms: 60000 },
      { language: "pt", dictations: 0, words: 0, audio_ms: 0 },
    ]);
  });

  it("uses the date filter of the other stats", async () => {
    addRow("old words here", {
      language: "pt",
      createdAt: "2026-01-10 12:00:00",
    });
    addRow("new words", { language: "en", createdAt: "2026-03-10 12:00:00" });
    expect(
      await byLanguage("?start_date=2026-03-01&end_date=2026-03-31"),
    ).toEqual([
      { language: "en", dictations: 1, words: 2, audio_ms: 60000 },
      { language: "pt", dictations: 0, words: 0, audio_ms: 0 },
    ]);
  });

  it("is empty with no dictations in the period", async () => {
    expect(await byLanguage()).toEqual([]);
  });

  it("keeps each detected code with an empty set (auto-detect)", async () => {
    setLanguages([]);
    addRow("a", { language: "pt" });
    addRow("a b", { language: "es" });
    addRow("c", { language: LANGUAGE_UNKNOWN });
    expect((await byLanguage()).map((r) => r.language)).toEqual([
      "es",
      "pt",
      null,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Quiet period before the LLM check
// ---------------------------------------------------------------------------

describe("quiet period before the LLM check", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  const savedAt = Date.UTC(2026, 2, 10, 12, 0, 0);

  function fakeClock(start: number) {
    let t = start;
    const slept: number[] = [];
    return {
      now: () => t,
      sleepMs: async (ms: number) => {
        slept.push(ms);
        t += ms;
      },
      slept,
    };
  }

  it("waits while a dictation is recent, then runs after the quiet period", async () => {
    addRow("x", { createdAt: "2026-03-10 12:00:00", language: "en" });
    const clock = fakeClock(savedAt + 5000);
    await waitForQuiet({
      db: getDb(),
      isDictationActive: () => false,
      ...clock,
    });
    expect(clock.now() - savedAt).toBe(QUIET_MS);
    expect(clock.slept.reduce((a, b) => a + b, 0)).toBe(10_000);
  });

  it("waits while a dictation is in progress", async () => {
    let polls = 0;
    const clock = fakeClock(Date.now());
    await waitForQuiet({
      db: getDb(),
      isDictationActive: () => ++polls <= 2,
      ...clock,
    });
    expect(clock.slept).toHaveLength(2);
  });

  it("does not wait with no dictation saved", async () => {
    const clock = fakeClock(Date.now());
    await waitForQuiet({
      db: getDb(),
      isDictationActive: () => false,
      ...clock,
    });
    expect(clock.slept).toEqual([]);
  });

  it("waits before each LLM call, never before the text step", async () => {
    const events: string[] = [];
    const deps: LanguageCheckDeps = {
      detectAll,
      resolveProfile: async () => profile,
      waitForQuiet: async () => {
        events.push("wait");
      },
      callStructured: (async () => {
        events.push("llm");
        return { object: { language: "en" } };
      }) as unknown as LanguageCheckDeps["callStructured"],
    };
    addRow(EN_LONG);
    await runLanguageCheck(deps);
    // Text step only: no wait.
    expect(events).toEqual([]);

    addRow("ok then");
    addRow("yes sure");
    await runLanguageCheck(deps);
    expect(events).toEqual(["wait", "llm", "wait", "llm"]);
  });
});
