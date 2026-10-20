/**
 * The built-in local MLX LLM (specs/local-mlx-llm.md 3): catalog, provider
 * resolution, the `local` / `ownServer` split, the worker lifecycle with a
 * fake worker binary, and the /api/mlx-llm routes.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateText } from "ai";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { writeFakeLlmWorker } from "./helpers/fake-llm-worker.js";
import { jsonRequest } from "./helpers/http.js";

// CI runs on Linux. The platform gate is the only Mac-specific part here.
vi.mock("../src/lib/mlx-asr/constants.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/mlx-asr/constants.js")>()),
  isAppleSiliconMac: () => true,
}));

import createApp from "../src/index.js";
import { deleteSetting, getDb, writeSetting } from "../src/lib/db.js";
import { llmLaneKeyForProvider } from "../src/lib/llm/lane.js";
import {
  modeLadder,
  reasoningWire,
  resolveCallProfile,
  withReasoningOff,
} from "../src/lib/llm/model-profiles.js";
import {
  getLlmProvider,
  isLocalProvider,
  isOwnServerProvider,
} from "../src/lib/llm/registry.js";
import { resolveTaskCall } from "../src/lib/llm/task-profiles.js";
import { hfRepoCacheDir } from "../src/lib/mlx-asr/constants.js";
import {
  getMlxLlmModel,
  MLX_LLM_MODELS,
  MLX_LLM_PROVIDER_ID,
} from "../src/lib/mlx-llm/constants.js";
import { getMlxLlmModelStatus } from "../src/lib/mlx-llm/models.js";
import {
  ensureMlxLlmWorker,
  getMlxLlmKeepAliveMinutes,
  getMlxLlmWorkerState,
  stopMlxLlmWorker,
} from "../src/lib/mlx-llm/server.js";
import { createChatModel } from "../src/lib/providers.js";

const QWEN_4B = "qwen3.5-4b-4bit";
const QWEN_08B = "qwen3.5-0.8b-4bit";

let scratch = "";
let workerLog = "";
const ORIGINAL_ENV = {
  hfCache: process.env.HUGGINGFACE_HUB_CACHE,
  worker: process.env.OPENSTYLE_MLX_LLM_WORKER,
};

/** Put a non-empty snapshot of the model into the scratch HF cache. */
function seedModel(id: string): void {
  const def = getMlxLlmModel(id);
  if (!def) throw new Error(id);
  const snap = join(hfRepoCacheDir(def.hfId), "snapshots", "abc123");
  mkdirSync(snap, { recursive: true });
  writeFileSync(join(snap, "config.json"), "{}");
}

function loggedRequests(): Array<Record<string, unknown>> {
  if (!existsSync(workerLog)) return [];
  return readFileSync(workerLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeAll(() => {
  // The worker is a real child process. Its timers must be real.
  vi.useRealTimers();
  scratch = mkdtempSync(join(tmpdir(), "openstyle-mlx-llm-"));
  workerLog = join(scratch, "worker.log");
  process.env.HUGGINGFACE_HUB_CACHE = join(scratch, "hf");
  process.env.OPENSTYLE_MLX_LLM_WORKER = writeFakeLlmWorker(scratch);
  process.env.FAKE_LLM_LOG = workerLog;
});

afterEach(async () => {
  await stopMlxLlmWorker();
  delete process.env.FAKE_LLM_FAIL;
  getDb()
    .prepare("DELETE FROM settings WHERE key = ?")
    .run("mlx_llm_keep_alive_minutes");
});

afterAll(() => {
  if (ORIGINAL_ENV.hfCache === undefined)
    delete process.env.HUGGINGFACE_HUB_CACHE;
  else process.env.HUGGINGFACE_HUB_CACHE = ORIGINAL_ENV.hfCache;
  if (ORIGINAL_ENV.worker === undefined)
    delete process.env.OPENSTYLE_MLX_LLM_WORKER;
  else process.env.OPENSTYLE_MLX_LLM_WORKER = ORIGINAL_ENV.worker;
  delete process.env.FAKE_LLM_LOG;
  rmSync(scratch, { recursive: true, force: true });
});

describe("catalog (spec 1 decision 4, 3.1)", () => {
  it("has the 5 curated models with the HF ids and byte sizes", () => {
    expect(
      MLX_LLM_MODELS.map((m) => [m.id, m.hfId, m.family, m.sizeBytes]),
    ).toEqual([
      [
        "qwen3.5-0.8b-4bit",
        "mlx-community/Qwen3.5-0.8B-4bit",
        "qwen3_5",
        652_029_391,
      ],
      [
        "qwen3.5-4b-4bit",
        "mlx-community/Qwen3.5-4B-4bit",
        "qwen3_5",
        3_061_130_647,
      ],
      [
        "qwen3.5-9b-4bit",
        "mlx-community/Qwen3.5-9B-4bit",
        "qwen3_5",
        5_977_073_303,
      ],
      [
        "gemma-4-e2b-4bit",
        "mlx-community/gemma-4-e2b-it-4bit",
        "gemma4",
        3_583_088_661,
      ],
      [
        "gemma-4-e4b-4bit",
        "mlx-community/gemma-4-e4b-it-4bit",
        "gemma4",
        5_179_241_512,
      ],
    ]);
    for (const m of MLX_LLM_MODELS) {
      expect(m.contextTokens).toBe(32_768);
      expect(m.maxOutputTokens).toBe(8_192);
    }
  });

  it("recommends only qwen3.5-4b-4bit", () => {
    expect(
      MLX_LLM_MODELS.filter((m) => m.recommended).map((m) => m.id),
    ).toEqual([QWEN_4B]);
  });
});

describe("provider resolution and the local / ownServer split (3.4)", () => {
  it("resolves local-mlx-llm by id and by a prefixed model id", () => {
    expect(getLlmProvider(MLX_LLM_PROVIDER_ID)?.providerId).toBe(
      MLX_LLM_PROVIDER_ID,
    );
    expect(
      getLlmProvider(`${MLX_LLM_PROVIDER_ID}/${QWEN_4B}`)?.providerId,
    ).toBe(MLX_LLM_PROVIDER_ID);
    // The speech provider id is a prefix of the LLM id, not the other way.
    expect(getLlmProvider("local-mlx")).toBeNull();
  });

  it("is local (no key, verbatim sampling) but not an own server", () => {
    expect(isLocalProvider(MLX_LLM_PROVIDER_ID)).toBe(true);
    expect(isOwnServerProvider(MLX_LLM_PROVIDER_ID)).toBe(false);
    expect(isLocalProvider("server")).toBe(true);
    expect(isOwnServerProvider("server")).toBe(true);
    expect(isOwnServerProvider("openai")).toBe(false);
  });

  it("gets its own lane with one slot", async () => {
    await expect(
      llmLaneKeyForProvider(
        MLX_LLM_PROVIDER_ID,
        `${MLX_LLM_PROVIDER_ID}/${QWEN_4B}`,
      ),
    ).resolves.toEqual({ key: "lane:local-mlx-llm", limit: 1 });
  });

  it("a task override to a local LLM needs no API key and gets verbatim sampling", async () => {
    // The app default is a cloud model without a key. Before the split the
    // override failed the key check and fell back to it.
    getDb()
      .prepare(
        "INSERT INTO model_configs (provider, model_id, model_name, type, is_default) VALUES ('openai', 'gpt-4o-mini', 'gpt-4o-mini', 'llm', 1)",
      )
      .run();
    writeSetting(
      "llm_task_assignments",
      JSON.stringify({
        cleanup: {
          mode: "auto",
          modelOverride: {
            provider: MLX_LLM_PROVIDER_ID,
            model_id: `${MLX_LLM_PROVIDER_ID}/${QWEN_4B}`,
          },
        },
      }),
    );
    try {
      const resolved = await resolveTaskCall("cleanup", {
        autoMaxOutputTokens: 512,
      });
      expect(resolved.provider).toBe(MLX_LLM_PROVIDER_ID);
      expect(resolved.modelId).toBe(`${MLX_LLM_PROVIDER_ID}/${QWEN_4B}`);
      expect(resolved.samplingParams).toEqual({
        chat_template_kwargs: { enable_thinking: false },
      });
    } finally {
      deleteSetting("llm_task_assignments");
      getDb().prepare("DELETE FROM model_configs").run();
    }
  });

  it("uses the own-server mode ladder and template_kwargs reasoning", async () => {
    expect(modeLadder(MLX_LLM_PROVIDER_ID)).toEqual([
      "json_schema_strict",
      "prompt_only",
    ]);
    const profile = await resolveCallProfile({
      taskId: "meetingEnhance",
      step: "correctChunk",
      maxReasoningTokens: 0,
      pin: {
        provider: MLX_LLM_PROVIDER_ID,
        modelId: `${MLX_LLM_PROVIDER_ID}/${QWEN_4B}`,
      },
    });
    expect(profile.structured).toBe("json_schema_strict");
    expect(profile.reasoning.control).toBe("template_kwargs");
    expect(profile.contextWindow).toBe(32_768);
    expect(profile.maxOutputTokens).toBe(8_192);
    expect(profile.warnings).toEqual([]);
    expect(reasoningWire(withReasoningOff(profile)).overrides.force).toEqual({
      chatTemplateKwargs: { enable_thinking: false },
      removeChatTemplateKwargs: ["reasoning_effort"],
      remove: ["reasoning_effort", "thinking_budget"],
    });
  });
});

describe("status and worker lifecycle with a fake worker (3.2, 3.3)", () => {
  it("reports not_downloaded, then ready after the snapshot exists", () => {
    expect(getMlxLlmModelStatus(QWEN_08B)?.status).toBe("not_downloaded");
    seedModel(QWEN_08B);
    const state = getMlxLlmModelStatus(QWEN_08B);
    expect(state?.status).toBe("ready");
    expect(state?.hfId).toBe("mlx-community/Qwen3.5-0.8B-4bit");
    expect(getMlxLlmModelStatus("nope")).toBeNull();
  });

  it("never starts a worker for a model that is not on disk (G4)", async () => {
    await expect(ensureMlxLlmWorker("qwen3.5-9b-4bit")).rejects.toThrow(
      /not downloaded/,
    );
    expect(getMlxLlmWorkerState().state).toBe("stopped");
  });

  it("starts the worker, sends the request with the sampling body, and reads the answer", async () => {
    seedModel(QWEN_4B);
    const before = loggedRequests().length;
    const model = await createChatModel(
      MLX_LLM_PROVIDER_ID,
      `${MLX_LLM_PROVIDER_ID}/${QWEN_4B}`,
      {
        task: "cleanup",
        sampling: {
          chat_template_kwargs: { enable_thinking: false },
          top_k: 20,
        },
      },
    );
    const state = getMlxLlmWorkerState();
    expect(state.state).toBe("ready");
    expect(state.model).toBe(QWEN_4B);
    expect(state.port).toBeGreaterThan(0);

    const result = await generateText({ model, prompt: "hello there" });
    expect(result.text).toBe("Fake worker reply.");
    expect(result.finishReason).toBe("stop");
    expect(result.response.modelId).toBe("mlx-community/Qwen3.5-4B-4bit");

    const posted = loggedRequests()
      .slice(before)
      .filter((r) => r.method === "POST");
    expect(posted).toHaveLength(1);
    const body = posted[0]?.body as Record<string, unknown>;
    expect(body.model).toBe("mlx-community/Qwen3.5-4B-4bit");
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.top_k).toBe(20);
    expect(posted[0]?.hf_hub_offline).toBe("1");
  });

  it("reuses a running worker, and a different model replaces it", async () => {
    seedModel(QWEN_4B);
    seedModel(QWEN_08B);
    const a = await ensureMlxLlmWorker(QWEN_4B);
    const again = await ensureMlxLlmWorker(QWEN_4B);
    expect(again.baseURL).toBe(a.baseURL);
    const b = await ensureMlxLlmWorker(QWEN_08B);
    expect(b.hfId).toBe("mlx-community/Qwen3.5-0.8B-4bit");
    expect(getMlxLlmWorkerState().model).toBe(QWEN_08B);
    // The old worker no longer answers.
    await expect(fetch(`${a.baseURL}/models`)).rejects.toThrow();
  });

  it("keep-alive 0 unloads the worker after the request", async () => {
    seedModel(QWEN_4B);
    writeSetting("mlx_llm_keep_alive_minutes", "0");
    expect(getMlxLlmKeepAliveMinutes()).toBe(0);
    const model = await createChatModel(
      MLX_LLM_PROVIDER_ID,
      `${MLX_LLM_PROVIDER_ID}/${QWEN_4B}`,
    );
    expect(getMlxLlmWorkerState().state).toBe("ready");
    await generateText({ model, prompt: "x" });
    expect(getMlxLlmWorkerState().state).toBe("stopped");
  });

  it("the default keep-alive is 5 minutes", () => {
    expect(getMlxLlmKeepAliveMinutes()).toBe(5);
  });

  it("an error line before ready becomes a typed start error", async () => {
    seedModel(QWEN_4B);
    process.env.FAKE_LLM_FAIL = "1";
    await expect(ensureMlxLlmWorker(QWEN_4B)).rejects.toThrow(
      "fake load failure",
    );
    expect(getMlxLlmWorkerState()).toMatchObject({
      state: "error",
      model: QWEN_4B,
      error: "fake load failure",
    });
  });
});

describe("/api/mlx-llm routes (3.5)", () => {
  const app = createApp();

  it("GET /status lists the catalog, the keep-alive and the worker", async () => {
    const res = await app.request("/api/mlx-llm/status");
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.platformSupported).toBe(true);
    expect(data.blockedReason).toBeNull();
    expect(data.keepAliveMinutes).toBe(5);
    expect(data.worker).toEqual({ model: null, state: "stopped", port: null });
    const models = data.models as Array<Record<string, unknown>>;
    expect(models.map((m) => m.model)).toEqual(MLX_LLM_MODELS.map((m) => m.id));
    expect(Object.keys(models[0] ?? {}).sort()).toEqual(
      [
        "contextTokens",
        "displayName",
        "family",
        "hfId",
        "maxOutputTokens",
        "model",
        "recommended",
        "sizeBytes",
        "status",
      ].sort(),
    );
    expect(data.runtime).toBeTypeOf("object");
  });

  it("rejects an unknown model and a start of a model that is not on disk", async () => {
    expect(
      (
        await app.request("/api/mlx-llm/models/nope/download", {
          method: "POST",
        })
      ).status,
    ).toBe(400);
    const res = await jsonRequest(app, "POST", "/api/mlx-llm/server/start", {
      model: "gemma-4-e4b-4bit",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "The MLX LLM model is not downloaded yet.",
    });
  });

  it("POST /server/start starts the worker in the background, /server/stop stops it", async () => {
    seedModel(QWEN_4B);
    const res = await jsonRequest(app, "POST", "/api/mlx-llm/server/start", {
      model: QWEN_4B,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    let worker: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      const s = (await (await app.request("/api/mlx-llm/status")).json()) as {
        worker: Record<string, unknown>;
      };
      worker = s.worker;
      if (worker.state === "ready") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(worker).toMatchObject({ model: QWEN_4B, state: "ready" });
    const stop = await app.request("/api/mlx-llm/server/stop", {
      method: "POST",
    });
    expect(await stop.json()).toEqual({ ok: true });
    expect(getMlxLlmWorkerState().state).toBe("stopped");
  });

  it("PUT of the keep-alive setting is applied", async () => {
    const res = await jsonRequest(
      app,
      "PUT",
      "/api/settings/mlx_llm_keep_alive_minutes",
      {
        value: "-1",
      },
    );
    expect(res.status).toBe(200);
    expect(getMlxLlmKeepAliveMinutes()).toBe(-1);
  });

  it("/api/models/available lists only ready local LLM models", async () => {
    seedModel(QWEN_4B);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    try {
      const res = await app.request("/api/models/available");
      const local = (
        (await res.json()) as Array<Record<string, unknown>>
      ).filter((m) => m.provider_id === MLX_LLM_PROVIDER_ID);
      expect(local.map((m) => m.model_id)).toContain(
        `${MLX_LLM_PROVIDER_ID}/${QWEN_4B}`,
      );
      expect(local.map((m) => m.model_id)).not.toContain(
        `${MLX_LLM_PROVIDER_ID}/gemma-4-e4b-4bit`,
      );
      expect(
        local.find((m) => m.model_id === `${MLX_LLM_PROVIDER_ID}/${QWEN_4B}`),
      ).toEqual({
        provider_id: MLX_LLM_PROVIDER_ID,
        provider_name: "On-device · MLX",
        model_id: `${MLX_LLM_PROVIDER_ID}/${QWEN_4B}`,
        model_name: "Qwen3.5 4B",
        family: "qwen3_5",
        type: "llm",
        cost_input: 0,
        cost_output: 0,
        curated: true,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("DELETE /models/:id removes the files and the default LLM row", async () => {
    seedModel(QWEN_08B);
    getDb()
      .prepare(
        "INSERT INTO model_configs (provider, model_id, model_name, type, is_default) VALUES (?, ?, ?, 'llm', 1)",
      )
      .run(
        MLX_LLM_PROVIDER_ID,
        `${MLX_LLM_PROVIDER_ID}/${QWEN_08B}`,
        "Qwen3.5 0.8B",
      );
    const res = await app.request(`/api/mlx-llm/models/${QWEN_08B}`, {
      method: "DELETE",
    });
    expect(await res.json()).toEqual({ ok: true });
    expect(getMlxLlmModelStatus(QWEN_08B)?.status).toBe("not_downloaded");
    const rows = getDb()
      .prepare("SELECT COUNT(*) AS n FROM model_configs WHERE provider = ?")
      .get(MLX_LLM_PROVIDER_ID) as { n: number };
    expect(rows.n).toBe(0);
  });
});
