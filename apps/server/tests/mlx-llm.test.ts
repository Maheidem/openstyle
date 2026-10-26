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
import { claimJob, releaseJob } from "../src/lib/meetings/job-registry.js";
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
import { diskUsageBytes } from "../src/lib/model-disk-usage.js";
import { createChatModel, getDefaultModels } from "../src/lib/providers.js";

const GEMMA_E2B = "gemma-4-e2b-qat-4bit";
const GEMMA_E4B = "gemma-4-e4b-qat-4bit";

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
  writeFileSync(join(snap, "model.safetensors"), "w");
}

/** Remove the model from the scratch HF cache. */
function unseedModel(id: string): void {
  const def = getMlxLlmModel(id);
  if (!def) throw new Error(id);
  rmSync(hfRepoCacheDir(def.hfId), { recursive: true, force: true });
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
  it("has the 5 models with the HF ids and byte sizes", () => {
    expect(
      MLX_LLM_MODELS.map((m) => [m.id, m.hfId, m.family, m.sizeBytes]),
    ).toEqual([
      [
        "gemma-4-e2b-qat-4bit",
        "mlx-community/gemma-4-E2B-it-qat-4bit",
        "gemma4",
        4_361_680_121,
      ],
      [
        "gemma-4-e4b-qat-4bit",
        "mlx-community/gemma-4-E4B-it-qat-4bit",
        "gemma4",
        6_830_817_013,
      ],
      [
        "nemotron-3.5-bolt-e4b-4bit",
        "lmstudio-community/NVIDIA-Nemotron-3.5-Bolt-E4B-MLX-4bit",
        "gemma4",
        4_231_265_397,
      ],
      [
        "gemma-4-26b-a4b-qat-4bit",
        "mlx-community/gemma-4-26B-A4B-it-qat-4bit",
        "gemma4",
        15_641_239_295,
      ],
      [
        "qwen3.8-27b-4bit",
        "mlx-community/Qwen3.8-27B-4bit",
        "qwen3_5",
        16_081_488_731,
      ],
    ]);
    for (const m of MLX_LLM_MODELS) {
      expect(m.contextTokens).toBe(32_768);
      expect(m.maxOutputTokens).toBe(8_192);
    }
  });

  it("recommends only gemma-4-e2b-qat-4bit", () => {
    expect(
      MLX_LLM_MODELS.filter((m) => m.recommended).map((m) => m.id),
    ).toEqual([GEMMA_E2B]);
  });
});

describe("provider resolution and the local / ownServer split (3.4)", () => {
  it("resolves local-mlx-llm by id and by a prefixed model id", () => {
    expect(getLlmProvider(MLX_LLM_PROVIDER_ID)?.providerId).toBe(
      MLX_LLM_PROVIDER_ID,
    );
    expect(
      getLlmProvider(`${MLX_LLM_PROVIDER_ID}/${GEMMA_E2B}`)?.providerId,
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
        `${MLX_LLM_PROVIDER_ID}/${GEMMA_E2B}`,
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
            model_id: `${MLX_LLM_PROVIDER_ID}/${GEMMA_E2B}`,
          },
        },
      }),
    );
    try {
      const resolved = await resolveTaskCall("cleanup", {
        autoMaxOutputTokens: 512,
      });
      expect(resolved.provider).toBe(MLX_LLM_PROVIDER_ID);
      expect(resolved.modelId).toBe(`${MLX_LLM_PROVIDER_ID}/${GEMMA_E2B}`);
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
        modelId: `${MLX_LLM_PROVIDER_ID}/${GEMMA_E2B}`,
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
    expect(getMlxLlmModelStatus(GEMMA_E4B)?.status).toBe("not_downloaded");
    seedModel(GEMMA_E4B);
    const state = getMlxLlmModelStatus(GEMMA_E4B);
    expect(state?.status).toBe("ready");
    expect(state?.hfId).toBe("mlx-community/gemma-4-E4B-it-qat-4bit");
    expect(getMlxLlmModelStatus("nope")).toBeNull();
  });

  it("reports not_downloaded for a partial snapshot (an .incomplete blob)", () => {
    const def = getMlxLlmModel("gemma-4-e2b-qat-4bit");
    if (!def) throw new Error("gemma-4-e2b-qat-4bit");
    const repo = hfRepoCacheDir(def.hfId);
    mkdirSync(join(repo, "snapshots", "abc123"), { recursive: true });
    mkdirSync(join(repo, "blobs"), { recursive: true });
    writeFileSync(join(repo, "snapshots", "abc123", "config.json"), "{}");
    writeFileSync(join(repo, "blobs", "abc.incomplete"), "part");
    expect(getMlxLlmModelStatus("gemma-4-e2b-qat-4bit")?.status).toBe(
      "not_downloaded",
    );
    rmSync(repo, { recursive: true, force: true });
  });

  it("never starts a worker for a model that is not on disk (G4)", async () => {
    await expect(ensureMlxLlmWorker(GEMMA_E2B)).rejects.toThrow(
      /not downloaded/,
    );
    expect(getMlxLlmWorkerState().state).toBe("stopped");
  });

  it("starts the worker, sends the request with the sampling body, and reads the answer", async () => {
    seedModel(GEMMA_E2B);
    const before = loggedRequests().length;
    const model = await createChatModel(
      MLX_LLM_PROVIDER_ID,
      `${MLX_LLM_PROVIDER_ID}/${GEMMA_E2B}`,
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
    expect(state.model).toBe(GEMMA_E2B);
    expect(state.port).toBeGreaterThan(0);

    const result = await generateText({ model, prompt: "hello there" });
    expect(result.text).toBe("Fake worker reply.");
    expect(result.finishReason).toBe("stop");
    expect(result.response.modelId).toBe(
      "mlx-community/gemma-4-E2B-it-qat-4bit",
    );

    const posted = loggedRequests()
      .slice(before)
      .filter((r) => r.method === "POST");
    expect(posted).toHaveLength(1);
    const body = posted[0]?.body as Record<string, unknown>;
    expect(body.model).toBe("mlx-community/gemma-4-E2B-it-qat-4bit");
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.top_k).toBe(20);
    expect(posted[0]?.hf_hub_offline).toBe("1");
    // Cleanup turns on the worker prefix cache (specs/llm-runtime-tuning.md 9 item 1).
    expect(posted[0]?.prefix_cache).toBe("on");
  });

  it("sends the prefix cache header for cleanup only", async () => {
    seedModel(GEMMA_E2B);
    const before = loggedRequests().length;
    for (const task of ["meetingEnhance", "meetingSummarize"]) {
      const model = await createChatModel(
        MLX_LLM_PROVIDER_ID,
        `${MLX_LLM_PROVIDER_ID}/${GEMMA_E2B}`,
        { task, sampling: {} },
      );
      await generateText({ model, prompt: "x" });
    }
    const posted = loggedRequests()
      .slice(before)
      .filter((r) => r.method === "POST");
    expect(posted.map((r) => r.prefix_cache)).toEqual([null, null]);
  });

  it("reuses a running worker, and a different model replaces it", async () => {
    seedModel(GEMMA_E2B);
    seedModel(GEMMA_E4B);
    const a = await ensureMlxLlmWorker(GEMMA_E2B);
    const again = await ensureMlxLlmWorker(GEMMA_E2B);
    expect(again.baseURL).toBe(a.baseURL);
    const b = await ensureMlxLlmWorker(GEMMA_E4B);
    expect(b.hfId).toBe("mlx-community/gemma-4-E4B-it-qat-4bit");
    expect(getMlxLlmWorkerState().model).toBe(GEMMA_E4B);
    // The old worker no longer answers.
    await expect(fetch(`${a.baseURL}/models`)).rejects.toThrow();
  });

  it("keep-alive 0 unloads the worker after the request", async () => {
    seedModel(GEMMA_E2B);
    writeSetting("mlx_llm_keep_alive_minutes", "0");
    expect(getMlxLlmKeepAliveMinutes()).toBe(0);
    const model = await createChatModel(
      MLX_LLM_PROVIDER_ID,
      `${MLX_LLM_PROVIDER_ID}/${GEMMA_E2B}`,
    );
    expect(getMlxLlmWorkerState().state).toBe("ready");
    await generateText({ model, prompt: "x" });
    expect(getMlxLlmWorkerState().state).toBe("stopped");
  });

  it("the default keep-alive is 5 minutes", () => {
    expect(getMlxLlmKeepAliveMinutes()).toBe(5);
  });

  it("an error line before ready becomes a typed start error", async () => {
    seedModel(GEMMA_E2B);
    process.env.FAKE_LLM_FAIL = "1";
    await expect(ensureMlxLlmWorker(GEMMA_E2B)).rejects.toThrow(
      "fake load failure",
    );
    expect(getMlxLlmWorkerState()).toMatchObject({
      state: "error",
      model: GEMMA_E2B,
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
    expect(data.worker).toMatchObject({
      model: null,
      state: "stopped",
      port: null,
    });
    const models = data.models as Array<Record<string, unknown>>;
    expect(models.map((m) => m.model)).toEqual(MLX_LLM_MODELS.map((m) => m.id));
    expect(Object.keys(models[0] ?? {}).sort()).toEqual(
      [
        "contextTokens",
        "displayName",
        "family",
        "fit",
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
    unseedModel(GEMMA_E4B);
    expect(
      (
        await app.request("/api/mlx-llm/models/nope/download", {
          method: "POST",
        })
      ).status,
    ).toBe(400);
    const res = await jsonRequest(app, "POST", "/api/mlx-llm/server/start", {
      model: GEMMA_E4B,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "The MLX LLM model is not downloaded yet.",
    });
  });

  it("POST /server/start starts the worker in the background, /server/stop stops it", async () => {
    seedModel(GEMMA_E2B);
    const res = await jsonRequest(app, "POST", "/api/mlx-llm/server/start", {
      model: GEMMA_E2B,
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
    expect(worker).toMatchObject({ model: GEMMA_E2B, state: "ready" });
    // The Metal facts of the ready line (specs/llm-runtime-tuning.md, step 1).
    expect(worker.gpu).toEqual({
      maxRecommendedWorkingSetBytes: 107374182400,
      memoryBytes: 137438953472,
    });
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
    seedModel(GEMMA_E2B);
    unseedModel(GEMMA_E4B);
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
        `${MLX_LLM_PROVIDER_ID}/${GEMMA_E2B}`,
      );
      expect(local.map((m) => m.model_id)).not.toContain(
        `${MLX_LLM_PROVIDER_ID}/${GEMMA_E4B}`,
      );
      expect(
        local.find((m) => m.model_id === `${MLX_LLM_PROVIDER_ID}/${GEMMA_E2B}`),
      ).toEqual({
        provider_id: MLX_LLM_PROVIDER_ID,
        provider_name: "On-device · MLX",
        model_id: `${MLX_LLM_PROVIDER_ID}/${GEMMA_E2B}`,
        model_name: "Gemma 4 E2B",
        family: "gemma4",
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
    unseedModel(GEMMA_E2B);
    seedModel(GEMMA_E4B);
    getDb()
      .prepare(
        "INSERT INTO model_configs (provider, model_id, model_name, type, is_default) VALUES (?, ?, ?, 'llm', 1)",
      )
      .run(
        MLX_LLM_PROVIDER_ID,
        `${MLX_LLM_PROVIDER_ID}/${GEMMA_E4B}`,
        "Gemma 4 E4B",
      );
    const res = await app.request(`/api/mlx-llm/models/${GEMMA_E4B}`, {
      method: "DELETE",
    });
    expect(await res.json()).toEqual({ ok: true });
    expect(getMlxLlmModelStatus(GEMMA_E4B)?.status).toBe("not_downloaded");
    const rows = getDb()
      .prepare("SELECT COUNT(*) AS n FROM model_configs WHERE provider = ?")
      .get(MLX_LLM_PROVIDER_ID) as { n: number };
    expect(rows.n).toBe(0);
  });
});

describe("delete of the model in use", () => {
  const app = createApp();
  const E2B_ID = `${MLX_LLM_PROVIDER_ID}/${GEMMA_E2B}`;
  const E4B_ID = `${MLX_LLM_PROVIDER_ID}/${GEMMA_E4B}`;

  function setDefault(modelId: string, name: string): void {
    getDb()
      .prepare("UPDATE model_configs SET is_default = 0 WHERE type = 'llm'")
      .run();
    getDb()
      .prepare(
        "INSERT INTO model_configs (provider, model_id, model_name, type, is_default) VALUES (?, ?, ?, 'llm', 1)",
      )
      .run(MLX_LLM_PROVIDER_ID, modelId, name);
  }

  afterEach(() => {
    releaseJob("delete-test");
    deleteSetting("llm_task_assignments");
    getDb().prepare("DELETE FROM model_configs").run();
    unseedModel(GEMMA_E2B);
    unseedModel(GEMMA_E4B);
  });

  it("switches the default to Gemma 4 E2B when it is on disk, and unloads the deleted model", async () => {
    seedModel(GEMMA_E2B);
    seedModel(GEMMA_E4B);
    setDefault(E4B_ID, "Gemma 4 E4B");
    await ensureMlxLlmWorker(GEMMA_E4B);
    expect(getMlxLlmWorkerState().model).toBe(GEMMA_E4B);

    const res = await app.request(`/api/mlx-llm/models/${GEMMA_E4B}`, {
      method: "DELETE",
    });
    expect(await res.json()).toEqual({ ok: true });
    expect(getMlxLlmModelStatus(GEMMA_E4B)?.status).toBe("not_downloaded");
    expect(getMlxLlmWorkerState().model).toBeNull();
    expect(getDefaultModels().llm?.model_id).toBe(E2B_ID);
    expect(getDefaultModels().llm?.model_name).toBe("Gemma 4 E2B");
  });

  it("leaves no default when the deleted model is Gemma 4 E2B itself", async () => {
    seedModel(GEMMA_E2B);
    setDefault(E2B_ID, "Gemma 4 E2B");
    const res = await app.request(`/api/mlx-llm/models/${GEMMA_E2B}`, {
      method: "DELETE",
    });
    expect(await res.json()).toEqual({ ok: true });
    expect(getDefaultModels().llm).toBeNull();
    await expect(
      resolveTaskCall("cleanup", { autoMaxOutputTokens: 512 }),
    ).rejects.toThrow(/No AI model is set up yet/);
  });

  it("leaves no default when Gemma 4 E2B is not on disk", async () => {
    seedModel(GEMMA_E4B);
    setDefault(E4B_ID, "Gemma 4 E4B");
    await app.request(`/api/mlx-llm/models/${GEMMA_E4B}`, { method: "DELETE" });
    expect(getDefaultModels().llm).toBeNull();
  });

  it("keeps the default when a model that is not the default is deleted", async () => {
    seedModel(GEMMA_E2B);
    seedModel(GEMMA_E4B);
    setDefault(E2B_ID, "Gemma 4 E2B");
    await app.request(`/api/mlx-llm/models/${GEMMA_E4B}`, { method: "DELETE" });
    expect(getDefaultModels().llm?.model_id).toBe(E2B_ID);
    expect(getMlxLlmModelStatus(GEMMA_E2B)?.status).toBe("ready");
  });

  it("removes a task model override to the deleted model", async () => {
    seedModel(GEMMA_E4B);
    writeSetting(
      "llm_task_assignments",
      JSON.stringify({
        meetingSummarize: {
          mode: "auto",
          modelOverride: { provider: MLX_LLM_PROVIDER_ID, model_id: E4B_ID },
        },
      }),
    );
    await app.request(`/api/mlx-llm/models/${GEMMA_E4B}`, { method: "DELETE" });
    const raw = getDb()
      .prepare("SELECT value FROM settings WHERE key = 'llm_task_assignments'")
      .get() as { value: string };
    expect(JSON.parse(raw.value)).toEqual({
      meetingSummarize: { mode: "auto" },
    });
  });

  it("refuses with 409 while a meeting Enhance job runs on the loaded model", async () => {
    seedModel(GEMMA_E4B);
    setDefault(E4B_ID, "Gemma 4 E4B");
    await ensureMlxLlmWorker(GEMMA_E4B);
    claimJob("delete-test", "enhance", { done: 0, total: 1, failed: 0 });

    const res = await app.request(`/api/mlx-llm/models/${GEMMA_E4B}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: "in_use" });
    expect(getMlxLlmModelStatus(GEMMA_E4B)?.status).toBe("ready");
    expect(getDefaultModels().llm?.model_id).toBe(E4B_ID);
  });
});

describe("GET /api/models/disk-usage", () => {
  afterEach(() => unseedModel(GEMMA_E2B));

  it("lists a ready model with the du size of its folder and the total", async () => {
    unseedModel(GEMMA_E4B);
    seedModel(GEMMA_E2B);
    const def = getMlxLlmModel(GEMMA_E2B);
    if (!def) throw new Error(GEMMA_E2B);
    const dir = hfRepoCacheDir(def.hfId);
    writeFileSync(
      join(dir, "snapshots", "abc123", "big.bin"),
      Buffer.alloc(200_000, 1),
    );

    const res = await createApp().request("/api/models/disk-usage");
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      models: Array<{ engine: string; model: string; bytes: number }>;
      totalBytes: number;
    };
    const llm = data.models.filter((m) => m.engine === "mlx-llm");
    expect(llm.map((m) => m.model)).toEqual([GEMMA_E2B]);
    expect(llm[0]?.bytes).toBe(diskUsageBytes(dir));
    expect(llm[0]?.bytes).toBeGreaterThanOrEqual(200_000);
    expect(data.totalBytes).toBe(
      data.models.reduce((sum, m) => sum + m.bytes, 0),
    );
  });
});

describe("a model that left the catalog (owner decision 2026-10-20)", () => {
  // A tester who chose a Qwen3.5 model before the catalog change.
  const REMOVED = `${MLX_LLM_PROVIDER_ID}/qwen3.5-4b-optiq-4bit`;

  afterEach(() => {
    deleteSetting("llm_task_assignments");
    getDb().prepare("DELETE FROM model_configs").run();
  });

  it("removes the stale default row, so no call goes to an unknown model", async () => {
    const app = createApp();
    getDb()
      .prepare(
        "INSERT INTO model_configs (provider, model_id, model_name, type, is_default) VALUES (?, ?, 'Qwen3.5 4B', 'llm', 1), (?, ?, 'Gemma 4 E2B', 'llm', 0)",
      )
      .run(
        MLX_LLM_PROVIDER_ID,
        REMOVED,
        MLX_LLM_PROVIDER_ID,
        `${MLX_LLM_PROVIDER_ID}/${GEMMA_E2B}`,
      );
    expect(getDefaultModels().llm).toBeNull();
    const rows = (await (
      await app.request("/api/models/configured")
    ).json()) as Array<{ model_id: string }>;
    expect(rows.map((r) => r.model_id)).toEqual([
      `${MLX_LLM_PROVIDER_ID}/${GEMMA_E2B}`,
    ]);
    await expect(
      resolveTaskCall("cleanup", { autoMaxOutputTokens: 512 }),
    ).rejects.toThrow(/No AI model is set up yet/);
  });

  it("a task override to a removed model falls back to the app default", async () => {
    getDb()
      .prepare(
        "INSERT INTO model_configs (provider, model_id, model_name, type, is_default) VALUES (?, ?, 'Gemma 4 E2B', 'llm', 1)",
      )
      .run(MLX_LLM_PROVIDER_ID, `${MLX_LLM_PROVIDER_ID}/${GEMMA_E2B}`);
    writeSetting(
      "llm_task_assignments",
      JSON.stringify({
        cleanup: {
          mode: "auto",
          modelOverride: { provider: MLX_LLM_PROVIDER_ID, model_id: REMOVED },
        },
      }),
    );
    const resolved = await resolveTaskCall("cleanup", {
      autoMaxOutputTokens: 512,
    });
    expect(resolved.modelId).toBe(`${MLX_LLM_PROVIDER_ID}/${GEMMA_E2B}`);
  });
});
