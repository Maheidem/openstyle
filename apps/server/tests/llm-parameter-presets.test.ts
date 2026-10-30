import {
  BUILTIN_LLM_PRESET_IDS,
  BUILTIN_LLM_PRESETS,
  CLEANUP_SAMPLING_MAX_TOKENS_LIMIT,
  cleanupSamplingSchema,
  LLM_PRESET_COUNT_MAX,
  LLM_PRESET_NAME_MAX,
  llmParameterPresetsSettingSchema,
  parseCleanupSampling,
  parseLlmProfileLinks,
  parseLlmTaskAssignments,
  remapRetiredPresetId,
} from "@openstyle/validations";
import { describe, expect, it } from "vitest";
import createApp from "../src/index.js";
import { jsonRequest } from "./helpers/http.js";

// ---------------------------------------------------------------------------
// llmParameterPresetsSettingSchema (§13.2)
// ---------------------------------------------------------------------------

function preset(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "user_abc",
    name: "Mine",
    params: { temperature: 0.5 },
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
}

describe("llmParameterPresetsSettingSchema", () => {
  it("accepts a well-formed 2-preset list", () => {
    const result = llmParameterPresetsSettingSchema.safeParse({
      presets: [preset({ id: "user_1" }), preset({ id: "user_2" })],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a builtin:-prefixed id — built-ins are never stored (§4.1)", () => {
    const result = llmParameterPresetsSettingSchema.safeParse({
      presets: [preset({ id: "builtin:qwen-thinking" })],
    });
    expect(result.success).toBe(false);
  });

  it("rejects more than LLM_PRESET_COUNT_MAX presets", () => {
    const presets = Array.from({ length: LLM_PRESET_COUNT_MAX + 1 }, (_, i) =>
      preset({ id: `user_${i}` }),
    );
    expect(
      llmParameterPresetsSettingSchema.safeParse({ presets }).success,
    ).toBe(false);
    expect(
      llmParameterPresetsSettingSchema.safeParse({
        presets: presets.slice(0, LLM_PRESET_COUNT_MAX),
      }).success,
    ).toBe(true);
  });

  it("rejects a name longer than LLM_PRESET_NAME_MAX", () => {
    const result = llmParameterPresetsSettingSchema.safeParse({
      presets: [preset({ name: "x".repeat(LLM_PRESET_NAME_MAX + 1) })],
    });
    expect(result.success).toBe(false);
  });
});

describe("BUILTIN_LLM_PRESETS (§4.2)", () => {
  it("the two starter presets are retired: not listed, ids reserved, a stored link reads as the Qwen 3.8 built-in", () => {
    const ids = BUILTIN_LLM_PRESETS.map((p) => p.id);
    expect(ids).not.toContain("builtin:qwen-thinking");
    expect(ids).not.toContain("builtin:qwen-fast");
    expect(BUILTIN_LLM_PRESET_IDS.has("builtin:qwen-fast")).toBe(true);
    expect(remapRetiredPresetId("builtin:qwen-thinking")).toBe(
      "builtin:model:qwen3.8:thinking",
    );
    expect(remapRetiredPresetId("builtin:qwen-fast")).toBe(
      "builtin:model:qwen3.8:instruct",
    );
    expect(remapRetiredPresetId("user_x")).toBe("user_x");
    expect(
      parseLlmTaskAssignments(
        JSON.stringify({
          cleanup: { mode: "preset", presetId: "builtin:qwen-fast" },
        }),
      ).cleanup?.presetId,
    ).toBe("builtin:model:qwen3.8:instruct");
    expect(
      parseLlmProfileLinks(
        JSON.stringify({
          "local-mlx-llm::x": {
            meetingEnhance: {
              mode: "preset",
              presetId: "builtin:qwen-thinking",
            },
          },
        }),
      )["local-mlx-llm::x"]?.meetingEnhance?.presetId,
    ).toBe("builtin:model:qwen3.8:thinking");
  });

  it("no built-in profile sets max_tokens (it stays task-derived)", () => {
    for (const p of BUILTIN_LLM_PRESETS) {
      expect(p.params).not.toHaveProperty("max_tokens");
    }
  });
});

// ---------------------------------------------------------------------------
// parseLlmTaskAssignments (§13.2, §5.1)
// ---------------------------------------------------------------------------

describe("parseLlmTaskAssignments", () => {
  it("drops an unknown task-id key without rejecting the rest of the object", () => {
    const value = JSON.stringify({
      cleanup: { mode: "auto" },
      someFutureTask: { mode: "custom", params: { a: 1 } },
    });
    expect(parseLlmTaskAssignments(value)).toEqual({
      cleanup: { mode: "auto" },
    });
  });

  it("skips an unknown task key and keeps the other tasks", () => {
    const value = JSON.stringify({
      retiredTask: { mode: "auto" },
      cleanup: { mode: "auto" },
    });
    expect(parseLlmTaskAssignments(value)).toEqual({
      cleanup: { mode: "auto" },
    });
  });

  it("returns {} on malformed JSON, non-object JSON, and missing/empty input", () => {
    expect(parseLlmTaskAssignments("{not json")).toEqual({});
    expect(parseLlmTaskAssignments("[1,2,3]")).toEqual({});
    expect(parseLlmTaskAssignments("null")).toEqual({});
    expect(parseLlmTaskAssignments(undefined)).toEqual({});
    expect(parseLlmTaskAssignments(null)).toEqual({});
    expect(parseLlmTaskAssignments("")).toEqual({});
  });

  it("drops a known task key whose entry itself fails its schema", () => {
    const value = JSON.stringify({
      cleanup: { mode: "not-a-real-mode" },
      meetingEnhance: { mode: "auto" },
    });
    expect(parseLlmTaskAssignments(value)).toEqual({
      meetingEnhance: { mode: "auto" },
    });
  });

  it("keeps a full preset/custom/modelOverride assignment intact", () => {
    const value = JSON.stringify({
      meetingSummarize: {
        mode: "custom",
        params: { max_tokens: 8000 },
        modelOverride: { provider: "anthropic", model_id: "claude-x" },
      },
    });
    expect(parseLlmTaskAssignments(value)).toEqual({
      meetingSummarize: {
        mode: "custom",
        params: { max_tokens: 8000 },
        modelOverride: { provider: "anthropic", model_id: "claude-x" },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// PUT routes (§13.2) — same test shape as the retired
// `PUT /api/settings/cleanup_sampling` suite.
// ---------------------------------------------------------------------------

describe("PUT /api/settings/llm_parameter_presets", () => {
  const app = createApp();

  function put(value: string) {
    return jsonRequest(app, "PUT", "/api/settings/llm_parameter_presets", {
      value,
    });
  }

  it("accepts a valid config and stores it verbatim", async () => {
    const value = JSON.stringify({ presets: [preset()] });
    expect((await put(value)).status).toBe(200);
    const res = await app.request("/api/settings/llm_parameter_presets");
    expect(await res.json()).toEqual({
      key: "llm_parameter_presets",
      value,
    });
  });

  it("accepts an empty preset list so the user can clear every custom preset", async () => {
    expect((await put(JSON.stringify({ presets: [] }))).status).toBe(200);
  });

  it("rejects malformed JSON, an out-of-enum mode is n/a here, but a bad shape 400s", async () => {
    expect((await put("{not json")).status).toBe(400);
    expect((await put(JSON.stringify({ presets: "nope" }))).status).toBe(400);
  });

  it("400s a preset id that spoofs the builtin: namespace", async () => {
    const value = JSON.stringify({
      presets: [preset({ id: "builtin:qwen-thinking", params: {} })],
    });
    expect((await put(value)).status).toBe(400);
  });

  it("400s a preset whose serialized params exceed the byte cap", async () => {
    const value = JSON.stringify({
      presets: [preset({ params: { blob: "x".repeat(9000) } })],
    });
    expect((await put(value)).status).toBe(400);
  });
});

describe("PUT /api/settings/llm_task_assignments", () => {
  const app = createApp();

  function put(value: string) {
    return jsonRequest(app, "PUT", "/api/settings/llm_task_assignments", {
      value,
    });
  }

  it("accepts a valid assignments blob and stores it verbatim", async () => {
    const value = JSON.stringify({ cleanup: { mode: "auto" } });
    expect((await put(value)).status).toBe(200);
    const res = await app.request("/api/settings/llm_task_assignments");
    expect(await res.json()).toEqual({
      key: "llm_task_assignments",
      value,
    });
  });

  it("accepts a preset-mode assignment", async () => {
    const value = JSON.stringify({
      cleanup: { mode: "preset", presetId: "user_abc" },
    });
    expect((await put(value)).status).toBe(200);
  });

  it("drops an unknown task id on write and still returns 200", async () => {
    const value = JSON.stringify({
      cleanup: { mode: "auto" },
      someFutureTask: { mode: "auto" },
    });
    expect((await put(value)).status).toBe(200);
  });

  it("rejects malformed JSON, a non-object body, and an out-of-enum mode", async () => {
    expect((await put("{not json")).status).toBe(400);
    expect((await put(JSON.stringify([1, 2, 3]))).status).toBe(400);
    expect(
      (await put(JSON.stringify({ cleanup: { mode: "bogus" } }))).status,
    ).toBe(400);
  });
});

// The `cleanup_sampling` PUT branch is removed (§10) — a stray write now
// falls through to the generic INSERT with no shape check, same as any other
// unrecognized-but-unhandled key, rather than being specially validated.
describe("PUT /api/settings/cleanup_sampling — validation branch removed (§10)", () => {
  const app = createApp();

  it("no longer 400s malformed sampling JSON (nothing validates this key anymore)", async () => {
    const res = await jsonRequest(
      app,
      "PUT",
      "/api/settings/cleanup_sampling",
      { value: "not even json" },
    );
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// parseCleanupSampling / cleanupSamplingSchema — moved from the retired
// apps/server/tests/cleanup-sampling.test.ts (§15). The function and schema
// are retained (kept in @openstyle/validations, §10) because §12.7's
// read-time fallback (apps/server/src/lib/llm/task-profiles.ts) depends on
// them for the `cleanup` task's legacy-setting resolution.
// ---------------------------------------------------------------------------

describe("parseCleanupSampling (retained for the §12.7 legacy fallback)", () => {
  it("keeps a fully specified sampling config", () => {
    const value = JSON.stringify({
      temperature: 0.3,
      top_p: 0.95,
      top_k: 40,
      min_p: 0.05,
      repetition_penalty: 1.05,
      presence_penalty: 0,
      max_tokens: 1024,
      thinking_budget: 256,
      reasoning_effort: "low",
      chat_template_kwargs: {
        enable_thinking: false,
        reasoning_effort: "low",
        preserve_thinking: false,
      },
    });
    expect(parseCleanupSampling(value)).toEqual({
      temperature: 0.3,
      top_p: 0.95,
      top_k: 40,
      min_p: 0.05,
      repetition_penalty: 1.05,
      presence_penalty: 0,
      max_tokens: 1024,
      thinking_budget: 256,
      reasoning_effort: "low",
      chat_template_kwargs: {
        enable_thinking: false,
        reasoning_effort: "low",
        preserve_thinking: false,
      },
    });
  });

  it("treats missing, empty and `{}` settings as no overrides", () => {
    expect(parseCleanupSampling(undefined)).toEqual({});
    expect(parseCleanupSampling(null)).toEqual({});
    expect(parseCleanupSampling("")).toEqual({});
    expect(parseCleanupSampling("{}")).toEqual({});
  });

  it("falls back to no overrides on malformed JSON", () => {
    expect(parseCleanupSampling("{not json")).toEqual({});
    expect(parseCleanupSampling("[1,2,3]")).toEqual({});
    expect(parseCleanupSampling("null")).toEqual({});
  });

  it("rejects the whole object when any field is out of bounds", () => {
    expect(parseCleanupSampling('{"temperature":9}')).toEqual({});
    expect(parseCleanupSampling('{"min_p":0.9}')).toEqual({});
  });

  it("bounds the number fields the dialog used to clamp to", () => {
    expect(cleanupSamplingSchema.safeParse({ top_k: 500 }).success).toBe(true);
    expect(cleanupSamplingSchema.safeParse({ top_k: 501 }).success).toBe(false);
    expect(
      cleanupSamplingSchema.safeParse({
        thinking_budget: CLEANUP_SAMPLING_MAX_TOKENS_LIMIT,
      }).success,
    ).toBe(true);
  });

  it("drops unknown keys rather than putting them on the wire", () => {
    expect(parseCleanupSampling('{"top_p":0.9,"nonsense":true}')).toEqual({
      top_p: 0.9,
    });
  });
});
