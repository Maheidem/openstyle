// Model profile and ledger tests (specs/meeting-enhance-agentic.md 10.5.3 and
// W14). The reasoning profile of 5.5 is checked for each provider, the mode
// resolution of 5.4, and the rule that a models.dev failure never stops a run.
import { serverModelId } from "@openstyle/validations";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../src/lib/db.js";
import { callStructured } from "../src/lib/llm/gateway.js";
import { ModelUnavailableError } from "../src/lib/llm/gateway-errors.js";
import { __resetLlmLanesForTests } from "../src/lib/llm/lane.js";
import {
  __clearModeCacheForTests,
  type CallProfile,
  lowerMode,
  modeLadder,
  reasoningWire,
  resolveCallProfile,
  resolveModels,
  withReasoningOff,
} from "../src/lib/llm/model-profiles.js";
import { groqCleanupProviderOptions } from "../src/lib/llm/registry.js";
import { CORRECT_CHUNK_STEP_SCHEMA } from "../src/lib/meetings/workflow/schemas.js";
import { fetchModelsFromRegistry } from "../src/lib/model-registry.js";
import { insertOwnServer } from "../src/lib/own-servers.js";
import { okReply, scriptedModel, seamFor } from "./helpers/fake-model.js";

vi.mock("../src/lib/model-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/model-registry.js")>()),
  fetchModelsFromRegistry: vi.fn(),
}));

const registryMock = vi.mocked(fetchModelsFromRegistry);

/** A small models.dev answer. Real entries carry more keys (`[key: string]: unknown`). */
const REGISTRY = {
  openai: {
    models: {
      "gpt-4o-mini": {
        id: "gpt-4o-mini",
        structured_output: true,
        reasoning: false,
        limit: { context: 128000, output: 16384 },
      },
      "o4-mini": {
        id: "o4-mini",
        structured_output: true,
        reasoning: true,
        reasoning_options: { efforts: ["low", "medium", "high"] },
        limit: { context: 200000, output: 100000 },
      },
      "gpt-5-mini": {
        id: "gpt-5-mini",
        structured_output: true,
        reasoning: true,
        reasoning_options: { efforts: ["none", "low", "medium", "high"] },
        limit: { context: 400000, output: 128000 },
      },
      "no-schema": { id: "no-schema", structured_output: false },
    },
  },
  anthropic: {
    models: {
      "claude-opus-4-8": { limit: { context: 1000000, output: 64000 } },
      "claude-sonnet-4-5": { limit: { context: 200000, output: 64000 } },
    },
  },
  google: { models: { "gemini-2.5-flash": { structured_output: true } } },
};

let serverId = "";

function seedDefaultLlm(provider: string, id: string): void {
  const db = getDb();
  db.exec("DELETE FROM model_configs WHERE type = 'llm'");
  db.prepare(
    `INSERT INTO model_configs (provider, model_id, model_name, type, is_default)
     VALUES (?, ?, ?, 'llm', 1)`,
  ).run(provider, id, id);
}

function useModel(provider: string, modelId: string): void {
  if (provider !== "server") {
    getDb()
      .prepare("INSERT OR REPLACE INTO api_keys (provider, key) VALUES (?, ?)")
      .run(provider, `key-${provider}`);
  }
  seedDefaultLlm(provider, modelId);
}

async function profileFor(
  provider: string,
  modelId: string,
  over: {
    step?: "correctChunk" | "identifySpeakers" | "summarize";
    bounded?: boolean;
    tokens?: number;
  } = {},
): Promise<CallProfile> {
  useModel(provider, modelId);
  const step = over.step ?? "identifySpeakers";
  return resolveCallProfile({
    taskId: step === "summarize" ? "meetingSummarize" : "meetingEnhance",
    step,
    maxReasoningTokens: over.tokens ?? 1024,
    ...(over.bounded ? { reasoningSteps: { [step]: "bounded" as const } } : {}),
  });
}

beforeEach(() => {
  registryMock.mockReset();
  registryMock.mockResolvedValue(REGISTRY);
  getDb().prepare("DELETE FROM api_keys").run();
  getDb().exec("DELETE FROM own_servers");
  serverId = insertOwnServer({
    baseUrl: "http://127.0.0.1:8123",
    apiKey: null,
    flavor: "omlx",
  }).id;
  __resetLlmLanesForTests();
  __clearModeCacheForTests();
});

describe("reasoning profile per provider (5.5)", () => {
  it("server Qwen: the seed switches thinking off; a bounded plan writes the gateway keys", async () => {
    const off = await profileFor(
      "server",
      serverModelId(serverId, "Qwen3.8-27B"),
    );
    expect(off.reasoning).toMatchObject({
      mode: "off",
      control: "template_kwargs",
      budgetTokens: 0,
    });
    expect(reasoningWire(off).overrides).toEqual({});
    const bounded = await profileFor(
      "server",
      serverModelId(serverId, "Qwen3.8-27B"),
      {
        bounded: true,
        tokens: 2048,
      },
    );
    expect(bounded.reasoning.mode).toBe("bounded");
    expect(bounded.reasoning.budgetTokens).toBe(2048);
    expect(reasoningWire(bounded).overrides.bounded).toEqual({
      chatTemplateKwargs: { enable_thinking: true },
      set: { thinking_budget: 2048 },
    });
    const forced = reasoningWire(withReasoningOff(bounded)).overrides;
    expect(forced.bounded).toBeUndefined();
    expect(forced.force?.chatTemplateKwargs).toEqual({
      enable_thinking: false,
    });
    expect(forced.force?.remove).toEqual([
      "reasoning_effort",
      "thinking_budget",
    ]);
  });

  it("groq: byte for byte as today's switch, 'medium' when bounded, no control for an unknown model", async () => {
    for (const id of [
      "qwen/qwen3.8-27b",
      "openai/gpt-oss-20b",
      "openai/gpt-oss-120b",
    ]) {
      const p = await profileFor("groq", `groq/${id}`);
      expect(reasoningWire(p).providerOptions.groq).toEqual(
        groqCleanupProviderOptions(id, false)?.groq,
      );
      const b = await profileFor("groq", `groq/${id}`, { bounded: true });
      expect(reasoningWire(b).providerOptions.groq).toEqual(
        groqCleanupProviderOptions(id, true)?.groq,
      );
    }
    expect(
      reasoningWire(await profileFor("groq", "groq/vendor/unknown-model"))
        .providerOptions.groq,
    ).toBeUndefined();
    expect(
      reasoningWire(await profileFor("groq", "groq/vendor/unknown-model"))
        .noControl,
    ).toBe(true);
  });

  it("openai: none if listed, else the lowest listed, no option when reasoning is false", async () => {
    const none = reasoningWire(await profileFor("openai", "openai/gpt-5-mini"));
    expect(none.providerOptions.openai).toEqual({ reasoningEffort: "none" });
    const lowest = reasoningWire(await profileFor("openai", "openai/o4-mini"));
    expect(lowest.providerOptions.openai).toEqual({ reasoningEffort: "low" });
    const plain = reasoningWire(
      await profileFor("openai", "openai/gpt-4o-mini"),
    );
    expect(plain.providerOptions.openai).toBeUndefined();
    expect(plain.noControl).toBe(true);
    const med = reasoningWire(
      await profileFor("openai", "openai/o4-mini", {
        bounded: true,
        tokens: 3000,
      }),
    );
    expect(med.providerOptions.openai).toEqual({ reasoningEffort: "medium" });
  });

  it("anthropic: disabled; bounded is a token budget before 4.7 and adaptive from 4.7", async () => {
    const off = reasoningWire(
      await profileFor("anthropic", "anthropic/claude-sonnet-4-5"),
    );
    expect(off.providerOptions.anthropic).toEqual({
      thinking: { type: "disabled" },
    });
    const old = await profileFor("anthropic", "anthropic/claude-sonnet-4-5", {
      bounded: true,
      tokens: 500,
    });
    expect(old.reasoning.countsInMaxOutput).toBe(false);
    expect(reasoningWire(old).providerOptions.anthropic).toEqual({
      thinking: { type: "enabled", budgetTokens: 1024 },
    });
    const adaptive = reasoningWire(
      await profileFor("anthropic", "anthropic/claude-opus-4-8", {
        bounded: true,
      }),
    );
    expect(adaptive.providerOptions.anthropic).toMatchObject({
      thinking: { type: "adaptive" },
      effort: "low",
    });
  });

  it("google: Gemini 2.5 budget 0; Gemini 3 lowest level with a warning", async () => {
    const g25 = reasoningWire(
      await profileFor("google", "google/gemini-2.5-flash"),
    );
    expect(g25.providerOptions.google).toEqual({
      thinkingConfig: { thinkingBudget: 0 },
    });
    const g3 = reasoningWire(await profileFor("google", "google/gemini-3-pro"));
    expect(g3.providerOptions.google).toEqual({
      thinkingConfig: { thinkingLevel: "low" },
    });
    expect(g3.warnings[0]).toContain("cannot be turned off");
  });

  it("mistral, openrouter and vercel", async () => {
    expect(
      reasoningWire(await profileFor("mistral", "mistral/mistral-small-latest"))
        .providerOptions.mistral,
    ).toEqual({ reasoningEffort: "none" });
    expect(
      reasoningWire(
        await profileFor("mistral", "mistral/mistral-small-latest", {
          bounded: true,
        }),
      ).providerOptions.mistral,
    ).toEqual({ reasoningEffort: "high" });
    expect(
      reasoningWire(
        await profileFor(
          "openrouter",
          "openrouter/meta-llama/llama-3.1-8b-instruct",
        ),
      ).bodyExtra,
    ).toEqual({ reasoning: { effort: "none" } });
    const v = reasoningWire(
      await profileFor("vercel", "vercel/anthropic/claude-haiku-4.5"),
    );
    expect(v.noControl).toBe(true);
    expect(v.providerOptions).toEqual({});
  });

  it("the table is empty: every step reasons off", async () => {
    for (const step of [
      "correctChunk",
      "identifySpeakers",
      "summarize",
    ] as const) {
      const p = await profileFor(
        "server",
        serverModelId(serverId, "Qwen3.8-27B"),
        { step },
      );
      expect(p.reasoning.mode).toBe("off");
    }
    // A step in the table gets bounded only when the provider has a bounded shape.
    const none = await profileFor(
      "vercel",
      "vercel/anthropic/claude-haiku-4.5",
      { bounded: true },
    );
    expect(none.reasoning.mode).toBe("off");
  });
});

describe("structured mode resolution (5.4)", () => {
  it("each provider starts at the first mode of its row", async () => {
    const start = async (provider: string, model: string) =>
      (await profileFor(provider, model)).structured;
    expect(await start("openai", "openai/gpt-4o-mini")).toBe(
      "json_schema_strict",
    );
    expect(await start("openrouter", "openrouter/a/b")).toBe(
      "json_schema_strict",
    );
    expect(await start("vercel", "vercel/a/b")).toBe("json_schema_strict");
    expect(await start("groq", "groq/openai/gpt-oss-20b")).toBe(
      "json_schema_strict",
    );
    expect(await start("groq", "groq/llama-3.3-70b-versatile")).toBe(
      "json_object",
    );
    expect(await start("anthropic", "anthropic/claude-sonnet-4-5")).toBe(
      "json_schema",
    );
    expect(await start("anthropic", "anthropic/claude-3-opus-latest")).toBe(
      "json_tool",
    );
    expect(await start("google", "google/gemini-2.5-flash")).toBe(
      "json_schema",
    );
    expect(await start("mistral", "mistral/mistral-small-latest")).toBe(
      "json_schema",
    );
    expect(await start("server", serverModelId(serverId, "Qwen3.8-27B"))).toBe(
      "json_schema_strict",
    );
  });

  it("models.dev structured_output false starts one mode lower", async () => {
    expect((await profileFor("openai", "openai/no-schema")).structured).toBe(
      "json_object",
    );
  });

  it("the ladder of each provider ends at prompt_only; server skips json_object", () => {
    for (const p of [
      "openai",
      "groq",
      "anthropic",
      "google",
      "mistral",
      "openrouter",
      "vercel",
      "server",
    ]) {
      expect(modeLadder(p).at(-1)).toBe("prompt_only");
    }
    expect(modeLadder("server")).toEqual(["json_schema_strict", "prompt_only"]);
    expect(lowerMode("server", "prompt_only")).toBeNull();
    expect(lowerMode("anthropic", "json_schema")).toBe("json_tool");
  });

  it("limits come from models.dev for a cloud model", async () => {
    const p = await profileFor("openai", "openai/gpt-4o-mini");
    expect(p.contextWindow).toBe(128000);
    expect(p.maxOutputTokens).toBe(16384);
  });
});

describe("W14, the models.dev read is best effort (5.1)", () => {
  const faults: [string, () => void][] = [
    [
      "a network fault",
      () => registryMock.mockRejectedValue(new TypeError("fetch failed")),
    ],
    [
      "a bad status",
      () =>
        registryMock.mockRejectedValue(
          new Error("Failed to fetch models.dev: 500"),
        ),
    ],
  ];

  it.each(
    faults,
  )("(a) a server profile resolves with %s and reads nothing", async (_n, fault) => {
    fault();
    const p = await profileFor(
      "server",
      serverModelId(serverId, "Qwen3.8-27B"),
    );
    expect(p.contextWindow).toBeNull();
    expect(p.maxOutputTokens).toBeNull();
    expect(p.warnings).toEqual([]);
    expect(registryMock).not.toHaveBeenCalled();
  });

  it.each(
    faults,
  )("(b, c) a cloud profile resolves with %s: hand tables, warning, no ModelUnavailableError", async (_n, fault) => {
    fault();
    const p = await profileFor("openai", "openai/gpt-4o-mini");
    expect(p.structured).toBe("json_schema_strict");
    expect(p.contextWindow).toBeNull();
    expect(p.maxOutputTokens).toBeNull();
    expect(p.warnings).toEqual(["registry_unavailable"]);
    expect(p.reasoning.control).toBe("effort");
    expect(p.reasoning.mode).toBe("off");

    // Every call record of the run holds the warning (b).
    const fake = scriptedModel("gpt-4o-mini", [okReply('{"corrections":[]}')]);
    const records: { params: { warnings: string[] } }[] = [];
    await callStructured({
      step: "correctChunk",
      runId: "run-w14",
      unitKey: "chunk:0",
      chunkIndex: 0,
      schema: CORRECT_CHUNK_STEP_SCHEMA,
      instructions: "x",
      messages: [{ role: "user", content: "y" }],
      profile: p,
      maxOutputTokens: 100,
      signal: new AbortController().signal,
      sink: {
        startAttempt: () => undefined,
        recordCall: (c) => {
          records.push(c);
          return { id: 1, attempt: 1 };
        },
      },
      createModel: seamFor(fake.model),
    });
    expect(records[0]?.params.warnings).toContain("registry_unavailable");
  });

  it("(c) the unavailable registry is not a model setup fault; a missing model still is", async () => {
    registryMock.mockRejectedValue(new TypeError("fetch failed"));
    getDb().exec("DELETE FROM model_configs WHERE type = 'llm'");
    await expect(
      resolveCallProfile({
        taskId: "meetingEnhance",
        step: "correctChunk",
        maxReasoningTokens: 0,
      }),
    ).rejects.toBeInstanceOf(ModelUnavailableError);
  });

  it("(d) resolveModels reads the registry once for the four profiles", async () => {
    useModel("openai", "openai/gpt-4o-mini");
    const models = await resolveModels({
      maxReasoningTokens: {
        correctChunk: 0,
        identifySpeakers: 1024,
        summarize: 0,
        suggestTags: 0,
      },
    });
    expect(Object.keys(models).sort()).toEqual([
      "correctChunk",
      "identifySpeakers",
      "suggestTags",
      "summarize",
    ]);
    expect(models.suggestTags.taskId).toBe("meetingEnhance");
    expect(registryMock).toHaveBeenCalledTimes(1);
    expect(models.correctChunk.taskId).toBe("meetingEnhance");
    expect(models.summarize.taskId).toBe("meetingSummarize");
    expect(models.summarize.contextWindow).toBe(128000);
  });

  it("(d) a server model makes resolveModels read nothing at all", async () => {
    useModel("server", serverModelId(serverId, "Qwen3.8-27B"));
    await resolveModels({
      maxReasoningTokens: {
        correctChunk: 0,
        identifySpeakers: 0,
        summarize: 0,
        suggestTags: 0,
      },
    });
    expect(registryMock).not.toHaveBeenCalled();
  });
});

describe("cloud line-up of 2026-10-30, reasoning switches that the provider accepts", () => {
  const off = async (provider: string, id: string) =>
    reasoningWire(await profileFor(provider, `${provider}/${id}`));

  it("claude: models that cannot stop thinking get the lowest effort", async () => {
    for (const id of ["claude-opus-5-5", "claude-fable-5-1"]) {
      expect((await off("anthropic", id)).providerOptions.anthropic).toEqual({
        thinking: { type: "disabled" },
        effort: "low",
      });
    }
  });

  it("claude: models that stop thinking keep the plain disabled switch", async () => {
    for (const id of ["claude-haiku-5-5", "claude-sonnet-5-5"]) {
      expect((await off("anthropic", id)).providerOptions.anthropic).toEqual({
        thinking: { type: "disabled" },
      });
    }
  });

  it("claude 5.x uses adaptive thinking with an effort when bounded", async () => {
    const p = await profileFor("anthropic", "anthropic/claude-sonnet-5-5", {
      bounded: true,
      tokens: 4096,
    });
    expect(reasoningWire(p).providerOptions.anthropic).toEqual({
      thinking: { type: "adaptive" },
      effort: "medium",
    });
  });

  it("gemini 3.8 and gemini 4 use thinkingLevel, never a budget", async () => {
    for (const id of ["gemini-3.8-flash", "gemini-4-argon"]) {
      expect((await off("google", id)).providerOptions.google).toEqual({
        thinkingConfig: { thinkingLevel: "low" },
      });
    }
    expect(
      (await off("google", "gemini-3.5-flash-lite")).providerOptions.google,
    ).toEqual({ thinkingConfig: { thinkingLevel: "low" } });
  });

  it("mistral: Large 4 has no 'none' level, Small 4 has", async () => {
    expect(
      (await off("mistral", "mistral-large-4")).providerOptions.mistral,
    ).toEqual({ reasoningEffort: "low" });
    expect(
      (await off("mistral", "mistral-small-latest")).providerOptions.mistral,
    ).toEqual({ reasoningEffort: "none" });
  });

  it("groq: Qwen 3.8 27B switches reasoning off with 'none'", async () => {
    expect(
      (await off("groq", "qwen/qwen3.8-27b")).providerOptions.groq,
    ).toEqual({ reasoningFormat: "hidden", reasoningEffort: "none" });
  });
});
