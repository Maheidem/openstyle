import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { initSchema } from "../src/lib/schema.js";
import { createVersionedDb } from "./helpers/schema-db.js";

// The table shape before schema 36. It matches `lib/schema.ts` version 1.
const MODEL_CONFIGS_V35 = `
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
`;

let db: DatabaseSync | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

function seed(
  settings: Record<string, string>,
  rows: Array<
    [provider: string, modelId: string, type: "voice" | "llm", isDefault?: 1]
  > = [],
): DatabaseSync {
  db = createVersionedDb(35, MODEL_CONFIGS_V35);
  for (const [key, value] of Object.entries(settings)) {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
      key,
      value,
    );
  }
  for (const [provider, modelId, type, isDefault] of rows) {
    db.prepare(
      "INSERT INTO model_configs (provider, model_id, model_name, type, is_default) VALUES (?, ?, ?, ?, ?)",
    ).run(
      provider,
      modelId,
      modelId.split("/").pop() ?? modelId,
      type,
      isDefault ?? 0,
    );
  }
  initSchema(db);
  return db;
}

interface ServerRow {
  id: string;
  base_url: string;
  api_key: string | null;
  server_key: string;
}

function servers(d: DatabaseSync): ServerRow[] {
  return d
    .prepare(
      "SELECT id, base_url, api_key, server_key FROM own_servers ORDER BY created_at, rowid",
    )
    .all() as unknown as ServerRow[];
}

function configs(d: DatabaseSync) {
  return d
    .prepare(
      "SELECT provider, model_id, type, is_default FROM model_configs ORDER BY id",
    )
    .all() as unknown as Array<{
    provider: string;
    model_id: string;
    type: string;
    is_default: number;
  }>;
}

describe("own_servers migration (schema 36)", () => {
  it("creates the table and bumps the version on a DB with no server settings", () => {
    const d = seed({});

    expect(servers(d)).toEqual([]);
    const version = d
      .prepare("SELECT version FROM schema_version WHERE id = 1")
      .get() as { version: number };
    expect(version.version).toBe(36);
  });

  it("creates the table when the DB has no settings table at all", () => {
    db = createVersionedDb(35, "", { settings: false });
    initSchema(db);

    expect(servers(db)).toEqual([]);
  });

  describe("M1: one server row per distinct server", () => {
    it("merges the three URLs of one server and keeps the first URL text", () => {
      const d = seed({
        omlx_base_url: "http://127.0.0.1:8123",
        local_llm_url: "http://localhost:8123",
        openai_stt_base_url: "http://localhost:8123/v1",
      });

      const rows = servers(d);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.base_url).toBe("http://127.0.0.1:8123");
      expect(rows[0]?.server_key).toBe("http://127.0.0.1:8123");
      expect(rows[0]?.api_key).toBeNull();
      expect(rows[0]?.id).toMatch(/^srv_[0-9a-f]{8}$/);
    });

    it("keeps two servers apart and gives each its own key", () => {
      const d = seed({
        omlx_base_url: "http://127.0.0.1:8123",
        omlx_api_key: "omlx-key",
        local_llm_url: "http://127.0.0.1:1234/v1",
        local_llm_api_key: "lm-key",
      });

      expect(servers(d).map((s) => [s.base_url, s.api_key])).toEqual([
        ["http://127.0.0.1:8123", "omlx-key"],
        ["http://127.0.0.1:1234", "lm-key"],
      ]);
    });

    it("never moves a key to a server with a different identity", () => {
      // Two servers, one key. The key belongs to the oMLX URL only.
      const d = seed({
        omlx_base_url: "http://127.0.0.1:8123",
        omlx_api_key: "omlx-key",
        local_llm_url: "http://127.0.0.1:1234",
      });

      expect(servers(d).map((s) => [s.base_url, s.api_key])).toEqual([
        ["http://127.0.0.1:8123", "omlx-key"],
        ["http://127.0.0.1:1234", null],
      ]);
    });

    it("takes the first non-empty key when candidates merge", () => {
      const d = seed({
        omlx_base_url: "http://127.0.0.1:8123",
        local_llm_url: "http://localhost:8123",
        local_llm_api_key: "second",
        openai_stt_base_url: "http://localhost:8123/v1",
        openai_stt_api_key: "third",
      });

      const rows = servers(d);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.api_key).toBe("second");
    });

    it("treats http and https on one port, and two proxy paths, as two servers", () => {
      const d = seed({
        omlx_base_url: "http://h:8123",
        local_llm_url: "https://h:8123",
        openai_stt_base_url: "https://h:8123/other/v1",
      });

      expect(servers(d).map((s) => s.server_key)).toEqual([
        "http://h:8123",
        "https://h:8123",
        "https://h:8123/other",
      ]);
    });

    it("folds a missing port to the scheme default", () => {
      const d = seed({
        omlx_base_url: "https://engine",
        local_llm_url: "https://engine:443/v1",
      });

      expect(servers(d)).toHaveLength(1);
    });

    it("skips empty and blank URLs", () => {
      const d = seed({
        omlx_base_url: "",
        local_llm_url: "   ",
        openai_stt_base_url: "http://127.0.0.1:8123",
      });

      expect(servers(d).map((s) => s.base_url)).toEqual([
        "http://127.0.0.1:8123",
      ]);
    });
  });

  describe("M2 and M3: omlx and local-llm rows", () => {
    it("rewrites omlx rows to the server of omlx_base_url", () => {
      const d = seed({ omlx_base_url: "http://127.0.0.1:8123" }, [
        ["omlx", "omlx/Qwen3-ASR", "voice", 1],
      ]);

      const [server] = servers(d);
      expect(configs(d)).toEqual([
        {
          provider: "server",
          model_id: `server/${server?.id}/Qwen3-ASR`,
          type: "voice",
          is_default: 1,
        },
      ]);
    });

    it("rewrites local-llm rows to the server of local_llm_url and keeps a slash in the model id", () => {
      const d = seed(
        {
          omlx_base_url: "http://127.0.0.1:8123",
          local_llm_url: "http://127.0.0.1:1234",
        },
        [["local-llm", "local-llm/qwen/qwen3-4b", "llm", 1]],
      );

      const lmStudio = servers(d).find(
        (s) => s.base_url === "http://127.0.0.1:1234",
      );
      expect(configs(d)).toEqual([
        {
          provider: "server",
          model_id: `server/${lmStudio?.id}/qwen/qwen3-4b`,
          type: "llm",
          is_default: 1,
        },
      ]);
    });
  });

  describe("M4: the openai default voice row", () => {
    it("moves the default voice row to the server of openai_stt_base_url", () => {
      const d = seed({ openai_stt_base_url: "http://localhost:8123/v1" }, [
        ["openai", "openai/whisper-1", "voice", 1],
        ["openai", "openai/gpt-4o-transcribe", "voice"],
      ]);

      const [server] = servers(d);
      expect(configs(d)).toEqual([
        {
          provider: "server",
          model_id: `server/${server?.id}/whisper-1`,
          type: "voice",
          is_default: 1,
        },
        {
          provider: "openai",
          model_id: "openai/gpt-4o-transcribe",
          type: "voice",
          is_default: 0,
        },
      ]);
    });

    it("leaves the openai row alone when no STT URL is set", () => {
      const d = seed({}, [["openai", "openai/whisper-1", "voice", 1]]);

      expect(configs(d)).toEqual([
        {
          provider: "openai",
          model_id: "openai/whisper-1",
          type: "voice",
          is_default: 1,
        },
      ]);
    });
  });

  describe("M5: task overrides", () => {
    it("rewrites a local-llm override and leaves other overrides alone", () => {
      const d = seed({
        local_llm_url: "http://127.0.0.1:1234",
        llm_task_assignments: JSON.stringify({
          cleanup: {
            mode: "auto",
            modelOverride: { provider: "local-llm", model_id: "local-llm/m" },
          },
          remix: {
            mode: "auto",
            modelOverride: { provider: "openai", model_id: "gpt-4o-mini" },
          },
          meetingSummarize: { mode: "auto" },
        }),
      });

      const [server] = servers(d);
      const stored = d
        .prepare(
          "SELECT value FROM settings WHERE key = 'llm_task_assignments'",
        )
        .get() as { value: string };
      expect(JSON.parse(stored.value)).toEqual({
        cleanup: {
          mode: "auto",
          modelOverride: {
            provider: "server",
            model_id: `server/${server?.id}/m`,
          },
        },
        remix: {
          mode: "auto",
          modelOverride: { provider: "openai", model_id: "gpt-4o-mini" },
        },
        meetingSummarize: { mode: "auto" },
      });
    });

    it("leaves JSON that does not parse unchanged", () => {
      const d = seed({
        local_llm_url: "http://127.0.0.1:1234",
        llm_task_assignments: "{not json",
      });

      const stored = d
        .prepare(
          "SELECT value FROM settings WHERE key = 'llm_task_assignments'",
        )
        .get() as { value: string };
      expect(stored.value).toBe("{not json");
    });
  });

  describe("M5b: UNIQUE collision", () => {
    it("merges an openai row and an omlx row that map to one id, and keeps the default flag", () => {
      const d = seed(
        {
          omlx_base_url: "http://127.0.0.1:8123",
          openai_stt_base_url: "http://localhost:8123/v1",
        },
        [
          ["omlx", "omlx/Qwen3-ASR", "voice"],
          ["openai", "openai/Qwen3-ASR", "voice", 1],
        ],
      );

      const [server] = servers(d);
      expect(configs(d)).toEqual([
        {
          provider: "server",
          model_id: `server/${server?.id}/Qwen3-ASR`,
          type: "voice",
          is_default: 1,
        },
      ]);
    });
  });

  describe("M6: rows whose old URL is empty", () => {
    it("deletes omlx and local-llm rows with no URL, and leaves no default", () => {
      const d = seed({}, [
        ["omlx", "omlx/Qwen3-ASR", "voice", 1],
        ["local-llm", "local-llm/m", "llm", 1],
        ["groq", "groq/whisper-large-v3", "voice"],
      ]);

      expect(configs(d)).toEqual([
        {
          provider: "groq",
          model_id: "groq/whisper-large-v3",
          type: "voice",
          is_default: 0,
        },
      ]);
    });
  });

  describe("M7: old settings stay in place", () => {
    it("keeps the six old keys unread and unchanged", () => {
      const settings = {
        omlx_base_url: "http://127.0.0.1:8123",
        omlx_api_key: "a",
        local_llm_url: "http://localhost:8123",
        local_llm_api_key: "b",
        openai_stt_base_url: "http://localhost:8123/v1",
        openai_stt_api_key: "c",
      };
      const d = seed(settings);

      for (const [key, value] of Object.entries(settings)) {
        const row = d
          .prepare("SELECT value FROM settings WHERE key = ?")
          .get(key) as { value: string };
        expect(row.value).toBe(value);
      }
    });
  });

  it("migrates the installed data shape (three URLs, six rows)", () => {
    // Copied from the installed app on 2026-10-05 (read-only query).
    const d = seed(
      {
        omlx_base_url: "http://127.0.0.1:8123",
        local_llm_url: "http://localhost:8123",
        openai_stt_base_url: "http://localhost:8123/v1",
        llm_task_assignments: JSON.stringify({
          cleanup: { mode: "preset", presetId: "user_2b1bedf8" },
        }),
      },
      [
        ["local-mlx", "local-mlx/qwen3-1.7b-8bit", "voice"],
        ["local-llm", "local-llm/Qwen3.8-27B", "llm", 1],
        ["omlx", "omlx/mlx-community--Qwen3-ASR-1.7B-8bit", "voice"],
        ["omlx", "omlx/Qwen3-ASR", "voice"],
        ["local-mlx", "local-mlx/qwen3-0.6b-8bit", "voice"],
        ["omlx", "omlx/Qwen3-TTS", "voice", 1],
      ],
    );

    const rows = servers(d);
    expect(rows).toHaveLength(1);
    const sid = rows[0]?.id;
    expect(rows[0]?.base_url).toBe("http://127.0.0.1:8123");
    expect(rows[0]?.api_key).toBeNull();
    expect(configs(d)).toEqual([
      {
        provider: "local-mlx",
        model_id: "local-mlx/qwen3-1.7b-8bit",
        type: "voice",
        is_default: 0,
      },
      {
        provider: "server",
        model_id: `server/${sid}/Qwen3.8-27B`,
        type: "llm",
        is_default: 1,
      },
      {
        provider: "server",
        model_id: `server/${sid}/mlx-community--Qwen3-ASR-1.7B-8bit`,
        type: "voice",
        is_default: 0,
      },
      {
        provider: "server",
        model_id: `server/${sid}/Qwen3-ASR`,
        type: "voice",
        is_default: 0,
      },
      {
        provider: "local-mlx",
        model_id: "local-mlx/qwen3-0.6b-8bit",
        type: "voice",
        is_default: 0,
      },
      {
        provider: "server",
        model_id: `server/${sid}/Qwen3-TTS`,
        type: "voice",
        is_default: 1,
      },
    ]);
  });

  it("runs once: a second initSchema call changes nothing", () => {
    const d = seed({ omlx_base_url: "http://127.0.0.1:8123" }, [
      ["omlx", "omlx/Qwen3-ASR", "voice", 1],
    ]);
    const before = { servers: servers(d), configs: configs(d) };

    initSchema(d);

    expect({ servers: servers(d), configs: configs(d) }).toEqual(before);
  });
});
