import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { initSchema } from "../src/lib/schema.js";

let db: DatabaseSync | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

function createV13Db(startVersion = 13): DatabaseSync {
  const instance = new DatabaseSync(":memory:");
  instance.exec(`
    CREATE TABLE schema_version (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      version INTEGER NOT NULL
    );
    INSERT INTO schema_version (id, version) VALUES (1, ${startVersion});

    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE model_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      model_id TEXT NOT NULL,
      model_name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('voice', 'llm')),
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(provider, model_id, type)
    );

    CREATE TABLE transcription_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_text TEXT NOT NULL,
      cleaned_text TEXT,
      voice_provider TEXT NOT NULL,
      voice_model TEXT NOT NULL,
      llm_provider TEXT,
      llm_model TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      audio_duration_ms INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return instance;
}

function insertModel(
  instance: DatabaseSync,
  provider: string,
  modelId: string,
  type: "voice" | "llm",
  isDefault: number,
): void {
  instance
    .prepare(
      `INSERT INTO model_configs (provider, model_id, model_name, type, is_default)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(provider, modelId, modelId, type, isDefault);
}

describe("retired hosted-provider migration", () => {
  it("drops the retired provider's models and re-points the voice default at a local engine", () => {
    db = createV13Db();
    insertModel(db, "freestyle-cloud", "freestyle-cloud/stt", "voice", 1);
    insertModel(
      db,
      "freestyle-cloud",
      "freestyle-cloud/post-process",
      "llm",
      1,
    );
    insertModel(db, "local-mlx", "local-mlx/parakeet", "voice", 0);
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('llm_cleanup', 'true')",
    ).run();

    initSchema(db);

    // Nothing may reference a provider no registry can resolve — a leftover
    // row here would fail every dictation and show a phantom model entry.
    const leftovers = db
      .prepare(
        "SELECT id FROM model_configs WHERE provider = 'freestyle-cloud'",
      )
      .all();
    expect(leftovers).toHaveLength(0);

    const voiceDefault = db
      .prepare(
        "SELECT provider FROM model_configs WHERE type = 'voice' AND is_default = 1",
      )
      .get() as { provider: string };
    expect(voiceDefault.provider).toBe("local-mlx");

    // Cleanup pointed at the retired model, so it gets turned off rather than
    // left aimed at nothing.
    const cleanup = db
      .prepare("SELECT value FROM settings WHERE key = 'llm_cleanup'")
      .get() as { value: string };
    expect(cleanup.value).toBe("false");
  });

  it("leaves no voice default when the machine has no local engine set up", () => {
    db = createV13Db();
    insertModel(db, "freestyle-cloud", "freestyle-cloud/stt", "voice", 1);

    initSchema(db);

    const voiceDefault = db
      .prepare(
        "SELECT provider FROM model_configs WHERE type = 'voice' AND is_default = 1",
      )
      .get();
    expect(voiceDefault).toBeUndefined();
  });

  it("leaves a BYOK default and llm_cleanup untouched", () => {
    db = createV13Db();
    insertModel(db, "groq", "groq/llama-3.1-8b-instant", "llm", 1);
    insertModel(db, "openai", "openai/gpt-4o-transcribe", "voice", 1);
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('llm_cleanup', 'true')",
    ).run();

    initSchema(db);

    const llmRows = db
      .prepare("SELECT provider FROM model_configs WHERE type = 'llm'")
      .all() as { provider: string }[];
    expect(llmRows).toHaveLength(1);
    expect(llmRows[0]!.provider).toBe("groq");

    const voiceDefault = db
      .prepare(
        "SELECT provider FROM model_configs WHERE type = 'voice' AND is_default = 1",
      )
      .get() as { provider: string };
    expect(voiceDefault.provider).toBe("openai");

    const cleanup = db
      .prepare("SELECT value FROM settings WHERE key = 'llm_cleanup'")
      .get() as { value: string };
    expect(cleanup.value).toBe("true");
  });

  it("still runs for a database carrying upstream's higher schema version", () => {
    // Upstream's 0.8.x line bumped the shared schema_version past this fork's
    // own numbering: a database that ran 0.8.5 reports 26. Migrations are gated
    // on `currentVersion < SCHEMA_VERSION`, so anyone arriving from upstream
    // skips every migration numbered below that and keeps the retired provider.
    db = createV13Db(26);
    insertModel(db, "freestyle-cloud", "freestyle-cloud/stt", "voice", 1);
    insertModel(
      db,
      "freestyle-cloud",
      "freestyle-cloud/post-process",
      "llm",
      1,
    );
    insertModel(
      db,
      "local-mlx",
      "mlx-community/Qwen3-ASR-1.7B-8bit",
      "voice",
      0,
    );

    initSchema(db);

    const rows = db
      .prepare("SELECT provider, type, is_default FROM model_configs")
      .all() as { provider: string; type: string; is_default: number }[];

    expect(rows.some((r) => r.provider === "freestyle-cloud")).toBe(false);
    expect(rows).toContainEqual({
      provider: "local-mlx",
      type: "voice",
      is_default: 1,
    });
  });
});
