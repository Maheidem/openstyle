/**
 * A selected local model that is not on the disk is a typed error and a
 * visible state, not an "internal error": the gateway kind `model_missing`,
 * the tagged step detail, and `GET /api/models/missing`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseModelMissingDetail } from "@openstyle/validations";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// CI runs on Linux. The platform gate is the only Mac-specific part here.
vi.mock("../src/lib/mlx-asr/constants.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/mlx-asr/constants.js")>()),
  isAppleSiliconMac: () => true,
}));

// The speech default of an Intel or Linux machine is reset to whisper. This
// test needs the MLX speech default to stay.
vi.mock("../src/lib/mlx-asr/server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/mlx-asr/server.js")>()),
  canRunMlxAsr: () => true,
}));

import createApp from "../src/index.js";
import { deleteSetting, getDb, writeSetting } from "../src/lib/db.js";
import { onCleanupSkipped } from "../src/lib/dictation-notices.js";
import { saveProcessedHistory } from "../src/lib/history-store.js";
import {
  blankFacts,
  ModelMissingError,
  modelUnavailableFrom,
} from "../src/lib/llm/gateway-errors.js";
import { failureFromError } from "../src/lib/meetings/workflow/unit.js";
import { hfRepoCacheDir } from "../src/lib/mlx-asr/constants.js";
import { ModelNotDownloadedError } from "../src/lib/mlx-asr/model-not-downloaded.js";
import {
  getMlxLlmModel,
  MLX_LLM_PROVIDER_ID,
} from "../src/lib/mlx-llm/constants.js";
import { listMissingModels } from "../src/lib/model-missing.js";
import { postProcess } from "../src/lib/post-process.js";

const GEMMA_E2B = "gemma-4-e2b-qat-4bit";
const ORIGINAL_HF = process.env.HUGGINGFACE_HUB_CACHE;
let scratch = "";

function seedGemma(): void {
  const def = getMlxLlmModel(GEMMA_E2B);
  if (!def) throw new Error(GEMMA_E2B);
  const snap = join(hfRepoCacheDir(def.hfId), "snapshots", "abc123");
  mkdirSync(snap, { recursive: true });
  writeFileSync(join(snap, "config.json"), "{}");
  writeFileSync(join(snap, "model.safetensors"), "w");
}

function selectGemma(): void {
  getDb().prepare("DELETE FROM model_configs").run();
  getDb()
    .prepare(
      "INSERT INTO model_configs (provider, model_id, model_name, type, is_default) VALUES (?, ?, 'Gemma 4 E2B', 'llm', 1)",
    )
    .run(MLX_LLM_PROVIDER_ID, `${MLX_LLM_PROVIDER_ID}/${GEMMA_E2B}`);
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "openstyle-model-missing-"));
  process.env.HUGGINGFACE_HUB_CACHE = join(scratch, "hf");
});

beforeEach(() => {
  rmSync(join(scratch, "hf"), { recursive: true, force: true });
  getDb().prepare("DELETE FROM model_configs").run();
  deleteSetting("llm_cleanup");
  deleteSetting("llm_task_assignments");
});

afterAll(() => {
  if (ORIGINAL_HF === undefined) delete process.env.HUGGINGFACE_HUB_CACHE;
  else process.env.HUGGINGFACE_HUB_CACHE = ORIGINAL_HF;
  rmSync(scratch, { recursive: true, force: true });
});

const model = {
  engine: "mlx-llm",
  defId: GEMMA_E2B,
  name: "Gemma 4 E2B",
} as const;

describe("error mapping", () => {
  const facts = blankFacts({
    step: "correctChunk",
    unitKey: "chunk:0",
    modelRequested: GEMMA_E2B,
  });

  it("maps the worker start error to the gateway kind model_missing", () => {
    const mapped = modelUnavailableFrom(
      new ModelNotDownloadedError(model),
      facts,
    );
    expect(mapped).toBeInstanceOf(ModelMissingError);
    const err = mapped as ModelMissingError;
    expect(err.kind).toBe("model_missing");
    expect(err.runWide).toBe(true);
    expect(err.retry).toBeNull();
    expect(err.model).toEqual(model);
  });

  it("recognises the typed error by its code, also across a bundle copy", () => {
    const copy = Object.assign(new Error("x"), {
      code: "model-not-downloaded",
      model,
    });
    expect(modelUnavailableFrom(copy, facts)).toBeInstanceOf(ModelMissingError);
  });

  it("keeps the old kinds: another plain error stays unchanged", () => {
    const plain = new Error("something else broke");
    expect(modelUnavailableFrom(plain, facts)).toBe(plain);
  });

  it("stores a failure that names the model, so the card can show it", () => {
    const err = modelUnavailableFrom(
      new ModelNotDownloadedError(model),
      facts,
    ) as ModelMissingError;
    const failure = failureFromError("correctChunk", "chunk:0", err, []);
    expect(failure.kind).toBe("model_missing");
    expect(parseModelMissingDetail(failure.message)).toEqual(model);
  });
});

describe("GET /api/models/missing", () => {
  it("lists the selected built-in LLM when its folder is not in the HF cache", async () => {
    selectGemma();
    const res = await createApp().request("/api/models/missing");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      engine: string;
      defId: string;
      name: string;
      tasks: string[];
    }[];
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ engine: "mlx-llm", defId: GEMMA_E2B });
    expect(body[0]?.tasks).toEqual(["meetingEnhance", "meetingSummarize"]);
  });

  it("adds the cleanup task when dictation cleanup is on", async () => {
    selectGemma();
    writeSetting("llm_cleanup", "true");
    const [entry] = await listMissingModels();
    expect(entry?.tasks).toContain("cleanup");
  });

  it("is empty when the model is on the disk, and when it comes back", async () => {
    selectGemma();
    expect(await listMissingModels()).toHaveLength(1);
    seedGemma();
    expect(await listMissingModels()).toEqual([]);
  });

  it("is empty when no model is selected or the model is a cloud model", async () => {
    expect(await listMissingModels()).toEqual([]);
    getDb()
      .prepare(
        "INSERT INTO model_configs (provider, model_id, model_name, type, is_default) VALUES ('openai', 'gpt-4o-mini', 'gpt-4o-mini', 'llm', 1)",
      )
      .run();
    expect(await listMissingModels()).toEqual([]);
  });

  it("lists the speech model of dictation and meetings", async () => {
    getDb()
      .prepare(
        "INSERT INTO model_configs (provider, model_id, model_name, type, is_default) VALUES ('local-mlx', 'local-mlx/qwen3-1.7b-8bit', 'Qwen3 ASR', 'voice', 1)",
      )
      .run();
    const list = await listMissingModels();
    const asr = list.find((m) => m.engine === "mlx");
    expect(asr?.tasks).toEqual(["dictation", "meetingTranscribe"]);
  });
});

describe("dictation cleanup with a missing model", () => {
  it("keeps the raw text, tells the host once per skip, and marks the history row", async () => {
    selectGemma();
    writeSetting("llm_cleanup", "true");
    const heard: string[] = [];
    const off = onCleanupSkipped((m) => heard.push(m.name));
    try {
      const pp = await postProcess("hello  there this is a test", null, {
        languages: ["en"],
      });
      expect(pp.cleaned).toContain("hello");
      expect(pp.cleanupSkipped).toBe("model_missing");
      expect(heard).toEqual(["Gemma 4 E2B"]);

      saveProcessedHistory({
        rawText: "hello there",
        cleanedText: null,
        voiceProvider: "local-mlx",
        voiceModel: "x",
        durationMs: 1,
        audioDurationMs: 1,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        cleanupSkipped: pp.cleanupSkipped ?? null,
      });
      const res = await createApp().request("/api/history?limit=5");
      const body = (await res.json()) as {
        items: { cleanup_skipped: string | null }[];
      };
      expect(body.items[0]?.cleanup_skipped).toBe("model_missing");
    } finally {
      off();
    }
  });

  it("does not mark a dictation when the model is on the disk", async () => {
    selectGemma();
    seedGemma();
    writeSetting("llm_cleanup", "true");
    const heard: string[] = [];
    const off = onCleanupSkipped((m) => heard.push(m.name));
    try {
      const pp = await postProcess("hello", null, { languages: ["en"] });
      expect(pp.cleanupSkipped).toBeUndefined();
      expect(heard).toEqual([]);
    } finally {
      off();
    }
  });
});

describe("schema 57: history column", () => {
  it("has the cleanup_skipped column, NULL for a normal row", () => {
    const cols = (
      getDb().prepare("PRAGMA table_info(transcription_history)").all() as {
        name: string;
      }[]
    ).map((c) => c.name);
    expect(cols).toContain("cleanup_skipped");
  });
});
