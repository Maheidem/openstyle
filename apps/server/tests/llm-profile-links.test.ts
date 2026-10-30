import {
  BUILTIN_MODEL_PRESETS,
  builtinProfile,
  profileLinkKey,
  qwenFamilyKey,
  serverModelId,
} from "@openstyle/validations";
import { beforeEach, describe, expect, it } from "vitest";
import createApp from "../src/index.js";
import {
  deleteSetting,
  getDb,
  readSetting,
  writeSetting,
} from "../src/lib/db.js";
import {
  builtinProfileFor,
  readProfileLinks,
} from "../src/lib/llm/profile-links.js";
import { mergeSamplingIntoBody } from "../src/lib/llm/registry.js";
import { resolveTaskCall } from "../src/lib/llm/task-profiles.js";
import { MLX_LLM_MODELS } from "../src/lib/mlx-llm/constants.js";
import { insertOwnServer } from "../src/lib/own-servers.js";
import { jsonRequest } from "./helpers/http.js";

const E2B = "local-mlx-llm/gemma-4-e2b-qat-4bit";
const QWEN = "local-mlx-llm/qwen3.8-27b-4bit";

function seedDefault(modelId: string): void {
  const db = getDb();
  db.exec("DELETE FROM model_configs WHERE type = 'llm'");
  db.prepare(
    `INSERT INTO model_configs (provider, model_id, model_name, type, is_default)
     VALUES ('local-mlx-llm', ?, ?, 'llm', 1)`,
  ).run(modelId, modelId);
}

beforeEach(() => {
  for (const key of [
    "llm_task_assignments",
    "llm_profile_links",
    "llm_profile_links_migrated",
    "llm_parameter_presets",
  ]) {
    deleteSetting(key);
  }
});

describe("built-in model profiles", () => {
  it("each built-in MLX model resolves to an Instruct and a Thinking profile with no max_tokens", () => {
    for (const m of MLX_LLM_MODELS) {
      for (const mode of ["instruct", "thinking"] as const) {
        const p = builtinProfileFor(
          "local-mlx-llm",
          `local-mlx-llm/${m.id}`,
          mode,
        );
        expect(p, `${m.id} ${mode}`).toBeDefined();
        expect(p?.params).not.toHaveProperty("max_tokens");
        expect(
          (p?.params.chat_template_kwargs as Record<string, unknown>)
            .enable_thinking,
        ).toBe(mode === "thinking");
      }
    }
  });

  it("every profile has a partner of the other mode", () => {
    const keys = new Set(BUILTIN_MODEL_PRESETS.map((p) => p.model));
    for (const k of keys) {
      expect(
        BUILTIN_MODEL_PRESETS.filter((p) => p.model === k)
          .map((p) => p.mode)
          .sort(),
      ).toEqual(["instruct", "thinking"]);
    }
  });
});

describe("Qwen matcher for own-server and cloud model ids", () => {
  const cases: [string, string | null][] = [
    ["Qwen3.6-35B-A3B", "qwen3.6-35b-a3b"],
    ["qwen3.6-35b-a3b-4bit", "qwen3.6-35b-a3b"],
    ["mlx-community/Qwen3.6-27B-4bit", "qwen3.6-27b"],
    ["Qwen3.6-35B-A3B-UD-Q4_K_M.gguf", "qwen3.6-35b-a3b"],
    ["qwen3.5-27b", "qwen3.5"],
    ["Qwen3.5-122B-A10B-FP8", "qwen3.5"],
    ["qwen-3.5-9b-instruct", "qwen3.5"],
    ["Qwen3.8-27B", "qwen3.8"],
    ["Qwen3.8-Flash", "qwen3.8"],
    ["qwen3.8-flash-next", "qwen3.8"],
    ["qwen3.8-27b-4bit", "qwen3.8"],
    // No match, no automatic profile:
    ["Qwen3.6-14B", null],
    ["Qwen3.5-397B-A17B", null],
    ["Qwen3.8-2.4T", null],
    ["Qwen3.6-27B-VL", null],
    ["Qwen3.6-27B-Base", null],
    ["Qwen3.5-Coder-27B", null],
    ["Qwen3-30B-A3B", null],
    ["Qwen2.5-72B", null],
    ["llama-3.3-70b", null],
    ["gpt-4o-mini", null],
    ["notqwen3.6-27b", null],
  ];
  it.each(cases)("%s -> %s", (id, key) => {
    expect(qwenFamilyKey(id)).toBe(key);
  });

  it("an own-server model named like Qwen3.6-35B-A3B gets the 3.6-35B Instruct body", async () => {
    getDb().exec("DELETE FROM own_servers");
    const serverId = insertOwnServer({
      baseUrl: "http://127.0.0.1:8123",
      apiKey: null,
      flavor: "omlx",
    }).id;
    const db = getDb();
    db.exec("DELETE FROM model_configs WHERE type = 'llm'");
    const id = serverModelId(serverId, "Qwen3.6-35B-A3B");
    db.prepare(
      "INSERT INTO model_configs (provider, model_id, model_name, type, is_default) VALUES ('server', ?, ?, 'llm', 1)",
    ).run(id, id);
    const resolved = await resolveTaskCall("meetingEnhance", {
      autoMaxOutputTokens: 900,
    });
    expect(resolved.source.presetId).toBe(
      "builtin:model:qwen3.6-35b-a3b:instruct",
    );
    const body = JSON.parse(
      mergeSamplingIntoBody(
        JSON.stringify({ model: "m", max_tokens: 900 }),
        resolved.samplingParams,
      ),
    );
    expect(body).toMatchObject({
      temperature: 0.7,
      top_p: 0.8,
      top_k: 20,
      presence_penalty: 1.5,
      chat_template_kwargs: { enable_thinking: false },
      max_tokens: 900,
    });
    expect(body.chat_template_kwargs).not.toHaveProperty("reasoning_effort");
  });

  it("a user link wins over the automatic profile", async () => {
    const db = getDb();
    db.exec("DELETE FROM model_configs WHERE type = 'llm'");
    const id = serverModelId(
      (db.prepare("SELECT id FROM own_servers").get() as { id: string }).id,
      "Qwen3.6-35B-A3B",
    );
    db.prepare(
      "INSERT INTO model_configs (provider, model_id, model_name, type, is_default) VALUES ('server', ?, ?, 'llm', 1)",
    ).run(id, id);
    writeSetting("llm_profile_links_migrated", "1");
    writeSetting(
      "llm_profile_links",
      JSON.stringify({
        [profileLinkKey("server", id)]: {
          meetingEnhance: {
            mode: "preset",
            presetId: "builtin:model:qwen3.6-35b-a3b:thinking",
          },
        },
      }),
    );
    const resolved = await resolveTaskCall("meetingEnhance", {
      autoMaxOutputTokens: 900,
    });
    expect(resolved.source.presetId).toBe(
      "builtin:model:qwen3.6-35b-a3b:thinking",
    );
    expect(resolved.samplingParams.chat_template_kwargs).toMatchObject({
      enable_thinking: true,
    });
  });
});

describe("migration of the old task assignments", () => {
  it("binds by the model override, then by the name of the preset, else leaves it unbound", () => {
    writeSetting(
      "llm_parameter_presets",
      JSON.stringify({
        presets: [
          {
            id: "user_q",
            name: "qwen3.8-thinking-high",
            params: { max_tokens: 32000 },
          },
          { id: "user_x", name: "mine", params: { top_p: 0.5 } },
        ].map((p) => ({ ...p, createdAt: "x", updatedAt: "x" })),
      }),
    );
    writeSetting(
      "llm_task_assignments",
      JSON.stringify({
        meetingEnhance: { mode: "preset", presetId: "user_q" },
        meetingSummarize: {
          mode: "preset",
          presetId: "user_x",
          modelOverride: { provider: "local-mlx-llm", model_id: E2B },
        },
        cleanup: { mode: "preset", presetId: "user_x" },
      }),
    );
    const links = readProfileLinks();
    expect(
      links[profileLinkKey("local-mlx-llm", QWEN)]?.meetingEnhance,
    ).toEqual({ mode: "preset", presetId: "user_q" });
    expect(
      links[profileLinkKey("local-mlx-llm", E2B)]?.meetingSummarize,
    ).toEqual({ mode: "preset", presetId: "user_x" });
    // Not bound: no override, and the name of the preset names no model.
    expect(JSON.stringify(links)).not.toContain("cleanup");
    expect(readSetting("llm_profile_links_migrated")).toBe("1");
  });

  it("the owner case: a Qwen-linked Enhance does not stay active on Gemma", async () => {
    writeSetting(
      "llm_parameter_presets",
      JSON.stringify({
        presets: [
          {
            id: "user_q",
            name: "qwen3.8-fast",
            params: { max_tokens: 32768 },
            createdAt: "x",
            updatedAt: "x",
          },
        ],
      }),
    );
    writeSetting(
      "llm_task_assignments",
      JSON.stringify({
        meetingEnhance: { mode: "preset", presetId: "user_q" },
      }),
    );
    seedDefault(E2B);
    const onGemma = await resolveTaskCall("meetingEnhance", {
      autoMaxOutputTokens: 900,
    });
    expect(onGemma.maxOutputTokens).toBe(900);
    seedDefault(QWEN);
    const onQwen = await resolveTaskCall("meetingEnhance", {
      autoMaxOutputTokens: 900,
    });
    expect(onQwen.maxOutputTokens).toBe(32768);
  });
});

describe("PUT /api/settings/llm_task_assignments", () => {
  const app = createApp();
  const put = (value: unknown) =>
    jsonRequest(app, "PUT", "/api/settings/llm_task_assignments", {
      value: JSON.stringify(value),
    });

  it("links the profile to the model the task runs on, and the link stays with that model", async () => {
    writeSetting("llm_profile_links_migrated", "1");
    seedDefault(QWEN);
    expect(
      (
        await put({
          meetingEnhance: { mode: "preset", presetId: "builtin:qwen-fast" },
        })
      ).status,
    ).toBe(200);
    const qwenKey = profileLinkKey("local-mlx-llm", QWEN);
    expect(readProfileLinks()[qwenKey]?.meetingEnhance?.presetId).toBe(
      "builtin:qwen-fast",
    );

    // The page switches the task to Gemma. The entry still holds the Qwen
    // profile fields; they do not become a link of Gemma.
    const override = { provider: "local-mlx-llm", model_id: E2B };
    await put({
      meetingEnhance: {
        mode: "preset",
        presetId: "builtin:qwen-fast",
        modelOverride: override,
      },
    });
    const links = readProfileLinks();
    expect(links[profileLinkKey("local-mlx-llm", E2B)]).toBeUndefined();
    expect(links[qwenKey]?.meetingEnhance?.presetId).toBe("builtin:qwen-fast");

    // Back to Qwen: the link is active again.
    await put({ meetingEnhance: { mode: "auto" } });
    expect(readProfileLinks()[qwenKey]?.meetingEnhance?.presetId).toBe(
      "builtin:qwen-fast",
    );
  });
});

describe("built-in profile values", () => {
  it("Gemma sends its own temperature, over the task default of 0", async () => {
    seedDefault(E2B);
    const resolved = await resolveTaskCall("meetingEnhance", {
      autoMaxOutputTokens: 900,
    });
    expect(resolved.temperature).toBe(0); // SDK fallback of the task
    const body = JSON.parse(
      mergeSamplingIntoBody(
        JSON.stringify({
          model: "m",
          temperature: resolved.temperature,
          max_tokens: 900,
        }),
        resolved.samplingParams,
      ),
    );
    expect(body).toMatchObject({
      temperature: 1.0,
      top_p: 0.95,
      top_k: 64,
      max_tokens: 900,
    });
    expect(body).not.toHaveProperty("presence_penalty");
  });

  it("Qwen 3.8 Instruct is the default and sends no reasoning_effort; Thinking is a second profile", async () => {
    seedDefault(QWEN);
    const fast = await resolveTaskCall("meetingEnhance", {
      autoMaxOutputTokens: 900,
    });
    expect(fast.samplingParams).toMatchObject({
      temperature: 0.7,
      top_p: 0.8,
      presence_penalty: 1.5,
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(fast.samplingParams.chat_template_kwargs).not.toHaveProperty(
      "reasoning_effort",
    );
    expect(fast.samplingParams).not.toHaveProperty("max_tokens");
    const thinking = builtinProfile("qwen3.8", "thinking");
    expect(thinking?.name).toBe("Qwen 3.8 \u2013 Thinking");
    expect(thinking?.params).toMatchObject({
      temperature: 1.0,
      presence_penalty: 0,
      chat_template_kwargs: {
        enable_thinking: true,
        reasoning_effort: "xhigh",
        preserve_thinking: false,
      },
    });
  });
});
