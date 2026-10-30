import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLOUD_LLM_LINEUP,
  CLOUD_VOICE_LINEUP,
  CURATED_LLM_IDS,
  dismissRetiredNotice,
  isLineupCloudLlm,
  legacyNotice,
  listRetiredNotices,
  reconcileRetiredCloudLlmModels,
  retiredReplacement,
} from "../src/lib/cloud-models.js";
import { getDb } from "../src/lib/db.js";
import { createChatModel, getDefaultModels } from "../src/lib/providers.js";

const PROVIDERS = ["anthropic", "openai", "google", "groq", "mistral"];

describe("cloud line-up", () => {
  it("holds a capable and a fast model for each provider", () => {
    for (const provider of PROVIDERS) {
      const roles = CLOUD_LLM_LINEUP.filter(
        (m) => m.providerId === provider,
      ).map((m) => m.role);
      expect(roles, provider).toContain("capable");
      expect(roles, provider).toContain("fast");
      expect(roles.filter((r) => r === "capable")).toHaveLength(1);
      expect(roles.filter((r) => r === "fast")).toHaveLength(1);
    }
  });

  it("has no duplicate ids and a price for every model", () => {
    const keys = CLOUD_LLM_LINEUP.map((m) => `${m.providerId}/${m.id}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(CURATED_LLM_IDS.size).toBe(keys.length);
    for (const m of CLOUD_LLM_LINEUP) {
      expect(m.costInput).toBeGreaterThan(0);
      expect(m.costOutput).toBeGreaterThanOrEqual(m.costInput);
    }
  });

  it("never lists a retired or legacy id", () => {
    for (const m of CLOUD_LLM_LINEUP) {
      expect(retiredReplacement(m.providerId, m.id), m.id).toBeNull();
      expect(legacyNotice(m.providerId, m.id), m.id).toBeNull();
    }
    for (const v of CLOUD_VOICE_LINEUP.filter(
      (x) => x.modelId !== "openai/gpt-4o-transcribe",
    )) {
      expect(retiredReplacement(v.providerId, v.modelId), v.modelId).toBeNull();
    }
  });

  it("names the Anthropic Claude 5.5 family and its ids", () => {
    const ids = CLOUD_LLM_LINEUP.filter(
      (m) => m.providerId === "anthropic",
    ).map((m) => m.id);
    expect(ids).toEqual([
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "claude-opus-5-5",
      "claude-fable-5-1",
    ]);
  });

  it("matches a line-up model with or without the provider prefix", () => {
    expect(isLineupCloudLlm("anthropic", "claude-haiku-5-5")).toBe(true);
    expect(isLineupCloudLlm("anthropic", "anthropic/claude-haiku-5-5")).toBe(
      true,
    );
    expect(isLineupCloudLlm("groq", "groq/openai/gpt-oss-20b")).toBe(true);
    expect(isLineupCloudLlm("anthropic", "claude-3-opus-latest")).toBe(false);
  });

  it("offers only OpenAI speech models that exist, newest first", () => {
    const openai = CLOUD_VOICE_LINEUP.filter((v) => v.providerId === "openai");
    expect(openai.map((v) => v.modelId)).toEqual([
      "openai/gpt-live-transcribe",
      "openai/gpt-transcribe",
      "openai/gpt-4o-transcribe",
    ]);
  });
});

describe("retired and legacy models", () => {
  it("maps a retired id to the same tier of the line-up, with a clear message", () => {
    const r = retiredReplacement("anthropic", "claude-sonnet-4-20250514");
    expect(r?.modelId).toBe("claude-sonnet-5-5");
    expect(r?.message).toContain("claude-sonnet-4-20250514");
    expect(r?.message).toContain("claude-sonnet-5-5");
    expect(retiredReplacement("groq", "groq/qwen/qwen3-32b")?.modelId).toBe(
      "openai/gpt-oss-120b",
    );
    expect(retiredReplacement("groq", "mistral-saba-24b")?.modelId).toBe(
      "openai/gpt-oss-120b",
    );
    expect(retiredReplacement("google", "gemini-2.0-flash")?.modelId).toBe(
      "gemini-3.8-flash",
    );
    expect(retiredReplacement("mistral", "mistral-small-2503")?.modelId).toBe(
      "mistral-small-latest",
    );
  });

  it("keeps a legacy id working and only adds a note", () => {
    expect(retiredReplacement("openai", "gpt-4o-mini")).toBeNull();
    expect(legacyNotice("openai", "gpt-4o-mini")).toContain("2027-01-14");
    expect(legacyNotice("openai", "gpt-4o-mini")).toContain("gpt-6-luna");
    expect(legacyNotice("anthropic", "claude-sonnet-4-5")).toContain(
      "2026-11-30",
    );
    expect(legacyNotice("groq", "llama-3.3-70b-versatile")).toContain(
      "openai/gpt-oss-120b",
    );
    expect(legacyNotice("openai", "openai/gpt-4o-transcribe")).toContain(
      "2027-02-26",
    );
  });

  it("returns null for an unknown id", () => {
    expect(retiredReplacement("anthropic", "claude-future-9")).toBeNull();
    expect(legacyNotice("anthropic", "claude-future-9")).toBeNull();
  });

  it("only replaces within the same provider", () => {
    for (const provider of PROVIDERS) {
      const r = retiredReplacement(provider, "nothing");
      expect(r).toBeNull();
    }
  });
});

describe("saved selections of a retired model", () => {
  beforeEach(() => {
    getDb().exec("DELETE FROM model_configs");
    getDb().exec("DELETE FROM api_keys");
  });
  afterEach(() => {
    getDb().exec("DELETE FROM model_configs");
    getDb().exec("DELETE FROM api_keys");
  });

  const add = (provider: string, id: string, isDefault: boolean) =>
    getDb()
      .prepare(
        "INSERT INTO model_configs (provider, model_id, model_name, type, is_default) VALUES (?, ?, ?, 'llm', ?)",
      )
      .run(provider, id, id, isDefault ? 1 : 0);

  it("moves a saved default to the replacement and keeps it the default", () => {
    add("anthropic", "claude-3-5-haiku-20241022", true);
    expect(reconcileRetiredCloudLlmModels()).toBe(1);
    expect(getDefaultModels().llm).toEqual({
      provider: "anthropic",
      model_id: "claude-haiku-5-5",
      model_name: "Claude Haiku 5.5",
    });
  });

  it("keeps the prefix style of the saved row", () => {
    add("groq", "groq/qwen/qwen3-32b", true);
    getDefaultModels();
    const row = getDb()
      .prepare("SELECT model_id FROM model_configs WHERE is_default = 1")
      .get() as { model_id: string };
    expect(row.model_id).toBe("groq/openai/gpt-oss-120b");
  });

  it("merges into an existing replacement row, no duplicate", () => {
    add("openai", "gpt-6-luna", false);
    add("google", "gemini-3-pro-preview", true);
    add("google", "gemini-3.1-pro-preview", false);
    expect(reconcileRetiredCloudLlmModels()).toBe(1);
    const rows = getDb()
      .prepare("SELECT provider, model_id, is_default FROM model_configs")
      .all();
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual({
      provider: "google",
      model_id: "gemini-3.1-pro-preview",
      is_default: 1,
    });
  });

  it("leaves legacy and current rows alone", () => {
    add("openai", "gpt-4o-mini", true);
    add("anthropic", "claude-sonnet-5-5", false);
    expect(reconcileRetiredCloudLlmModels()).toBe(0);
    expect(getDefaultModels().llm?.model_id).toBe("gpt-4o-mini");
  });

  it("builds the replacement model for a call that holds a retired id", async () => {
    getDb()
      .prepare("INSERT INTO api_keys (provider, key) VALUES ('anthropic', 'k')")
      .run();
    const model = await createChatModel(
      "anthropic",
      "anthropic/claude-opus-4-1-20250805",
    );
    expect(typeof model === "string" ? model : model.modelId).toBe(
      "claude-opus-5-5",
    );
  });
});

describe("one-time notice of a replaced default model", () => {
  beforeEach(() => {
    getDb().exec("DELETE FROM model_configs");
    getDb().exec("DELETE FROM settings WHERE key = 'retired_model_notices'");
  });

  const addDefault = (provider: string, id: string) =>
    getDb()
      .prepare(
        "INSERT INTO model_configs (provider, model_id, model_name, type, is_default) VALUES (?, ?, ?, 'llm', 1)",
      )
      .run(provider, id, id);

  it("records the replacement once and returns it until it is dismissed", () => {
    addDefault("groq", "groq/qwen/qwen3-32b");
    reconcileRetiredCloudLlmModels();
    expect(listRetiredNotices()).toEqual([
      { provider: "groq", from: "qwen/qwen3-32b", to: "openai/gpt-oss-120b" },
    ]);
    // A second reconcile finds nothing to replace and adds nothing.
    reconcileRetiredCloudLlmModels();
    expect(listRetiredNotices()).toHaveLength(1);
  });

  it("never shows a dismissed id again, also if the id is saved again", () => {
    addDefault("groq", "qwen/qwen3-32b");
    reconcileRetiredCloudLlmModels();
    dismissRetiredNotice("groq", "qwen/qwen3-32b");
    expect(listRetiredNotices()).toEqual([]);
    getDb().exec("DELETE FROM model_configs");
    addDefault("groq", "groq/qwen/qwen3-32b");
    reconcileRetiredCloudLlmModels();
    expect(listRetiredNotices()).toEqual([]);
  });

  it("gives no notice for a retired id that is not the default", () => {
    getDb()
      .prepare(
        "INSERT INTO model_configs (provider, model_id, model_name, type, is_default) VALUES ('groq', 'qwen/qwen3-32b', 'x', 'llm', 0)",
      )
      .run();
    reconcileRetiredCloudLlmModels();
    expect(listRetiredNotices()).toEqual([]);
  });
});
