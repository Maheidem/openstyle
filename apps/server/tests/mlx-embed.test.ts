/**
 * The built-in local MLX embedding model (specs/local-semantic-search.md
 * 5.3-5.5): catalog, status at the pinned revision, the worker lifecycle and
 * the client with a fake worker binary, and the /api/mlx-embed routes.
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
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { writeFakeEmbedWorker } from "./helpers/fake-embed-worker.js";

// CI runs on Linux. The platform gate is the only Mac-specific part here.
vi.mock("../src/lib/mlx-asr/constants.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/mlx-asr/constants.js")>()),
  isAppleSiliconMac: () => true,
}));

import createApp from "../src/index.js";
import { deleteSetting, readSetting, writeSetting } from "../src/lib/db.js";
import { hfRepoCacheDir } from "../src/lib/mlx-asr/constants.js";
import {
  EmbedError,
  embedTexts,
  promptFor,
} from "../src/lib/mlx-embed/client.js";
import {
  getMlxEmbedModel,
  MLX_EMBED_ALLOW_PATTERNS,
  MLX_EMBED_MODELS,
} from "../src/lib/mlx-embed/constants.js";
import { getMlxEmbedModelStatus } from "../src/lib/mlx-embed/models.js";
import {
  ensureMlxEmbedWorker,
  getMlxEmbedWorkerState,
  stopMlxEmbedWorker,
} from "../src/lib/mlx-embed/server.js";
import { getDefaultModels } from "../src/lib/providers.js";

const EG2 = "embeddinggemma-2-bf16-text";
const SETTING = "search_embedding_model";

let scratch = "";
let workerLog = "";
const ORIGINAL_ENV = {
  hfCache: process.env.HUGGINGFACE_HUB_CACHE,
  worker: process.env.OPENSTYLE_MLX_EMBED_WORKER,
};

/** Put a non-empty snapshot of the model into the scratch HF cache. */
function seedModel(revision?: string): void {
  const def = getMlxEmbedModel(EG2);
  if (!def) throw new Error(EG2);
  const snap = join(
    hfRepoCacheDir(def.hfId),
    "snapshots",
    revision ?? def.revision,
  );
  mkdirSync(snap, { recursive: true });
  writeFileSync(join(snap, "config.json"), "{}");
  writeFileSync(join(snap, "model.safetensors"), "w");
}

function unseedModel(): void {
  const def = getMlxEmbedModel(EG2);
  if (!def) throw new Error(EG2);
  rmSync(hfRepoCacheDir(def.hfId), { recursive: true, force: true });
}

function loggedRequests(): Array<Record<string, unknown>> {
  if (!existsSync(workerLog)) return [];
  return readFileSync(workerLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitFor(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(() => {
  // The worker is a real child process. Its timers must be real.
  vi.useRealTimers();
  scratch = mkdtempSync(join(tmpdir(), "openstyle-mlx-embed-"));
  workerLog = join(scratch, "worker.log");
  process.env.HUGGINGFACE_HUB_CACHE = join(scratch, "hf");
  process.env.OPENSTYLE_MLX_EMBED_WORKER = writeFakeEmbedWorker(scratch);
  process.env.FAKE_EMBED_LOG = workerLog;
});

afterEach(async () => {
  await stopMlxEmbedWorker();
  delete process.env.FAKE_EMBED_FAIL;
  delete process.env.FAKE_EMBED_DIMS;
  deleteSetting(SETTING);
  unseedModel();
});

afterAll(() => {
  if (ORIGINAL_ENV.hfCache === undefined)
    delete process.env.HUGGINGFACE_HUB_CACHE;
  else process.env.HUGGINGFACE_HUB_CACHE = ORIGINAL_ENV.hfCache;
  if (ORIGINAL_ENV.worker === undefined)
    delete process.env.OPENSTYLE_MLX_EMBED_WORKER;
  else process.env.OPENSTYLE_MLX_EMBED_WORKER = ORIGINAL_ENV.worker;
  delete process.env.FAKE_EMBED_LOG;
  rmSync(scratch, { recursive: true, force: true });
});

describe("catalog (5.3, D19, D20)", () => {
  it("has one bf16 text-only EmbeddingGemma 2 at the pinned revision", () => {
    expect(
      MLX_EMBED_MODELS.map((m) => [
        m.id,
        m.hfId,
        m.revision,
        m.dims,
        m.quant,
        m.sizeBytes,
        m.forLowMemory,
      ]),
    ).toEqual([
      [
        EG2,
        "jayyun98/embeddinggemma-2-text-270m-mlx-bf16",
        "186ecf2d29e743e0e9de0da677b13d54f76de6b3",
        768,
        "bf16",
        578_960_922,
        false,
      ],
    ]);
    expect(MLX_EMBED_ALLOW_PATTERNS).toEqual([
      "*.json",
      "model*.safetensors",
      "tokenizer.model",
    ]);
  });

  it("uses the D9 document and query prompts", () => {
    expect(promptFor("document", "a")).toBe("title: none | text: a");
    expect(promptFor("query", "b")).toBe("task: search result | query: b");
  });
});

describe("status at the pinned revision (5.3)", () => {
  it("is ready only with the snapshot of the pinned commit", () => {
    expect(getMlxEmbedModelStatus(EG2)?.status).toBe("not_downloaded");
    seedModel("some-other-commit");
    expect(getMlxEmbedModelStatus(EG2)?.status).toBe("not_downloaded");
    seedModel();
    expect(getMlxEmbedModelStatus(EG2)?.status).toBe("ready");
  });
});

describe("worker lifecycle and client with a fake worker (5.2, 5.4)", () => {
  it("works with no LLM model (D6)", async () => {
    expect(getDefaultModels().llm).toBeNull();
    seedModel();
    writeSetting(SETTING, EG2);
    const out = await embedTexts(["one"], "query");
    expect(out.vectors).toHaveLength(1);
  });

  it("never starts a worker for a model that is not on disk", async () => {
    await expect(ensureMlxEmbedWorker(EG2)).rejects.toThrow(/not downloaded/);
    expect(getMlxEmbedWorkerState().state).toBe("stopped");
  });

  it("with no search model, the client fails with no_model", async () => {
    seedModel();
    await expect(embedTexts(["x"], "query")).rejects.toMatchObject({
      kind: "no_model",
    });
  });

  it("starts the worker with --embed and --revision, offline, and reads dims from the ready line", async () => {
    seedModel();
    const def = getMlxEmbedModel(EG2);
    const { baseURL } = await ensureMlxEmbedWorker(EG2);
    expect(getMlxEmbedWorkerState()).toMatchObject({
      model: EG2,
      state: "ready",
      dims: 768,
    });
    const models = await (await fetch(`${baseURL}/models`)).json();
    expect(models.data[0].id).toBe(def?.hfId);

    writeSetting(SETTING, EG2);
    const before = loggedRequests().length;
    await embedTexts(["x"], "document");
    const [req] = loggedRequests().slice(before);
    const args = req?.args as string[];
    expect(args.slice(0, 5)).toEqual([
      "--embed",
      "--model",
      def?.hfId,
      "--revision",
      def?.revision,
    ]);
    expect(req?.hf_hub_offline).toBe("1");
  });

  it("adds the prompt, sends batches of 16 and keeps the input order", async () => {
    seedModel();
    writeSetting(SETTING, EG2);
    const texts = Array.from({ length: 40 }, (_, i) => "w".repeat(i + 1));
    const before = loggedRequests().length;

    const out = await embedTexts(texts, "document");

    const posted = loggedRequests().slice(before);
    expect(
      posted.map((r) => (r.body as { input: string[] }).input.length),
    ).toEqual([16, 16, 8]);
    const first = (posted[0]?.body as { input: string[] }).input[0];
    expect(first).toBe("title: none | text: w");
    expect(out.modelId).toBe(EG2);
    expect(out.vectors).toHaveLength(40);
    expect(out.tokens).toHaveLength(40);
    for (const [i, v] of out.vectors.entries()) {
      expect(v).toBeInstanceOf(Float32Array);
      expect(v.length).toBe(768);
      // The fake puts 1 at (prompt + text length) mod 768.
      expect(v.indexOf(1)).toBe(("title: none | text: ".length + i + 1) % 768);
    }
  });

  it("a reply with the wrong dims is embed_bad_response, never a partial result", async () => {
    seedModel();
    writeSetting(SETTING, EG2);
    process.env.FAKE_EMBED_DIMS = "256";
    const err = await embedTexts(["a", "b"], "query").catch((e) => e);
    expect(err).toBeInstanceOf(EmbedError);
    expect(err.kind).toBe("embed_bad_response");
  });

  it("checks the abort signal between batches", async () => {
    seedModel();
    writeSetting(SETTING, EG2);
    const controller = new AbortController();
    controller.abort();
    await expect(
      embedTexts(["a"], "document", controller.signal),
    ).rejects.toThrow();
  });

  it("an error line before ready becomes a typed start error", async () => {
    seedModel();
    process.env.FAKE_EMBED_FAIL = "1";
    await expect(ensureMlxEmbedWorker(EG2)).rejects.toThrow(
      "fake load failure",
    );
    expect(getMlxEmbedWorkerState()).toMatchObject({
      state: "error",
      model: EG2,
      error: "fake load failure",
      dims: null,
    });
  });
});

describe("/api/mlx-embed routes (5.5)", () => {
  const app = createApp();

  it("GET /status lists the catalog, the search model and the worker", async () => {
    const res = await app.request("/api/mlx-embed/status");
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.platformSupported).toBe(true);
    expect(data.blockedReason).toBeNull();
    expect(data.selected).toBeNull();
    expect(data.worker).toEqual({
      model: null,
      state: "stopped",
      port: null,
      dims: null,
    });
    const models = data.models as Array<Record<string, unknown>>;
    expect(models.map((m) => [m.model, m.status, m.selected])).toEqual([
      [EG2, "not_downloaded", false],
    ]);
  });

  it("Use refuses an unknown model and a model that is not on disk", async () => {
    expect(
      (await app.request("/api/mlx-embed/models/nope/use", { method: "POST" }))
        .status,
    ).toBe(400);
    const res = await app.request(`/api/mlx-embed/models/${EG2}/use`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
    expect(readSetting(SETTING)).toBeUndefined();
  });

  it("Use writes the setting and loads the model in the background", async () => {
    seedModel();
    const res = await app.request(`/api/mlx-embed/models/${EG2}/use`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(readSetting(SETTING)).toBe(EG2);
    await waitFor(() => getMlxEmbedWorkerState().state === "ready");
    const data = (await (
      await app.request("/api/mlx-embed/status")
    ).json()) as {
      selected: string;
      worker: { state: string; dims: number; port: number };
      models: Array<{ selected: boolean; status: string }>;
    };
    expect(data.selected).toBe(EG2);
    expect(data.models[0]).toMatchObject({ selected: true, status: "ready" });
    expect(data.worker).toMatchObject({ state: "ready", dims: 768 });
    expect(data.worker.port).toBeGreaterThan(0);
  });

  it("DELETE removes the files, clears the search model and stops the worker", async () => {
    seedModel();
    writeSetting(SETTING, EG2);
    await ensureMlxEmbedWorker(EG2);
    const def = getMlxEmbedModel(EG2);
    const res = await app.request(`/api/mlx-embed/models/${EG2}`, {
      method: "DELETE",
    });
    expect(await res.json()).toEqual({ ok: true });
    expect(existsSync(hfRepoCacheDir(def?.hfId ?? ""))).toBe(false);
    expect(readSetting(SETTING)).toBeUndefined();
    await waitFor(() => getMlxEmbedWorkerState().state === "stopped");
  });

  it("an unknown model is 400 for download", async () => {
    const res = await app.request("/api/mlx-embed/models/nope/download", {
      method: "POST",
    });
    expect(res.status).toBe(400);
  });
});
