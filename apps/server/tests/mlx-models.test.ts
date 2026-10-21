import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../src/lib/db.js";
import { MLX_ASR_MODELS } from "../src/lib/mlx-asr/constants.js";
import {
  getCustomMlxDef,
  insertCustomModel,
} from "../src/lib/mlx-asr/custom-models.js";
import { whisperProcessorSource } from "../src/lib/mlx-asr/whisper-processor.js";
import {
  pinnedBody,
  TOKENIZER_FOR_N_VOCAB,
} from "./helpers/whisper-tokenizer.js";

const mocks = vi.hoisted(() => ({
  blocker: "runtime missing" as string | null,
  ensureRuntime: vi.fn(),
  snapshotDownload: vi.fn(),
  downloadFileToCacheDir: vi.fn(),
  listSize: 2,
  listEntries: null as null | Array<{ path: string; size: number }>,
}));

vi.mock("@huggingface/hub", () => ({
  // The size sum for the progress bar. One small file, or `listEntries`.
  listFiles: async function* () {
    if (mocks.listEntries) {
      for (const e of mocks.listEntries) yield { type: "file", ...e };
      return;
    }
    yield { type: "file", path: "config.json", size: mocks.listSize };
  },
  modelInfo: async () => ({ sha: "sha-1" }),
  downloadFileToCacheDir: mocks.downloadFileToCacheDir,
  snapshotDownload: mocks.snapshotDownload,
}));

vi.mock("../src/lib/mlx-asr/python.js", () => ({
  describeMlxSetupBlocker: () => mocks.blocker,
  mlxSetupBlocker: () => null,
  resetPythonProbe: () => {},
}));

vi.mock("../src/lib/mlx-asr/runtime.js", () => ({
  cancelMlxRuntimeDownload: () => {},
  ensureMlxRuntimeDownloaded: mocks.ensureRuntime,
  getMlxRuntimeDownloadStatus: () => ({}),
  isMlxRuntimeInstallable: () => true,
  updateManagedMlxRuntimeIfNeeded: async () => {},
}));

vi.mock("../src/lib/mlx-asr/server.js", () => ({
  stopMlxServer: async () => {},
}));

describe("MLX ASR model catalog", () => {
  it("includes SenseVoice Small as a local MLX transcription model", () => {
    const model = MLX_ASR_MODELS.find((m) => m.id === "sensevoice-small");

    expect(model).toMatchObject({
      hfId: "mlx-community/SenseVoiceSmall",
      family: "sensevoice",
      displayName: "SenseVoice",
      quantized: false,
    });
  });
});

describe("downloadMlxModel with cached weights", () => {
  let cacheDir = "";
  const originalCache = process.env.HUGGINGFACE_HUB_CACHE;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "mlx-models-"));
    process.env.HUGGINGFACE_HUB_CACHE = cacheDir;
    const snapshot = join(
      cacheDir,
      "models--mlx-community--SenseVoiceSmall",
      "snapshots",
      "abc",
    );
    mkdirSync(snapshot, { recursive: true });
    writeFileSync(join(snapshot, "config.json"), "{}");
    writeFileSync(join(snapshot, "model.safetensors"), "w");
    mocks.blocker = "runtime missing";
    mocks.ensureRuntime.mockReset();
    mocks.ensureRuntime.mockImplementation(async () => {
      mocks.blocker = null;
    });
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
    if (originalCache === undefined) delete process.env.HUGGINGFACE_HUB_CACHE;
    else process.env.HUGGINGFACE_HUB_CACHE = originalCache;
  });

  it("installs the runtime when the weights are already cached", async () => {
    const { downloadMlxModel, getMlxModelStatus } = await import(
      "../src/lib/mlx-asr/models.js"
    );

    await downloadMlxModel("sensevoice-small");

    expect(mocks.ensureRuntime).toHaveBeenCalledTimes(1);
    expect(getMlxModelStatus("sensevoice-small")?.status).toBe("ready");
  });

  it("reports a runtime install error when the weights are cached", async () => {
    mocks.ensureRuntime.mockRejectedValue(new Error("install failed"));
    const { downloadMlxModel, getMlxModelStatus } = await import(
      "../src/lib/mlx-asr/models.js"
    );

    await expect(downloadMlxModel("sensevoice-small")).rejects.toThrow(
      "install failed",
    );
    expect(getMlxModelStatus("sensevoice-small")?.status).toBe("error");
  });
});

const CUSTOM_HF_ID = "someone/whisper-tiny";
const CUSTOM_ID = "custom--someone--whisper-tiny";
const FILES = [
  { path: "config.json", size: 2 },
  { path: "model.safetensors", size: 5 },
  { path: "sub/extra.txt", size: 3 },
];

/**
 * Write a snapshot the way the hub does: files in blobs/, symlinks in
 * snapshots/<revision>/. `sizes` overrides the size of single files.
 */
function writeSnapshot(
  cacheDir: string,
  revision: string,
  files = FILES,
  sizes: Record<string, number> = {},
): string {
  const repoDir = join(cacheDir, "models--someone--whisper-tiny");
  const snapshotDir = join(repoDir, "snapshots", revision);
  mkdirSync(join(repoDir, "blobs"), { recursive: true });
  for (const file of files) {
    const blob = join(
      repoDir,
      "blobs",
      `${revision}-${file.path.replace("/", "_")}`,
    );
    writeFileSync(blob, "");
    truncateSync(blob, sizes[file.path] ?? file.size);
    const link = join(snapshotDir, file.path);
    mkdirSync(join(link, ".."), { recursive: true });
    symlinkSync(blob, link);
  }
  mkdirSync(snapshotDir, { recursive: true });
  return snapshotDir;
}

describe("custom MLX models", () => {
  let cacheDir = "";
  const originalCache = process.env.HUGGINGFACE_HUB_CACHE;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "mlx-custom-"));
    process.env.HUGGINGFACE_HUB_CACHE = cacheDir;
    getDb().exec("DELETE FROM custom_mlx_models");
    getDb().exec("DELETE FROM model_configs");
    mocks.blocker = null;
    mocks.snapshotDownload.mockReset();
    mocks.listSize = 2;
    insertCustomModel({
      hfId: CUSTOM_HF_ID,
      family: "qwen3-asr",
      modelType: "qwen3_asr",
      totalBytes: 10,
      revision: "rev-1",
      files: FILES,
    });
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
    if (originalCache === undefined) delete process.env.HUGGINGFACE_HUB_CACHE;
    else process.env.HUGGINGFACE_HUB_CACHE = originalCache;
  });

  describe("completeness check", () => {
    it("is ready when every file has its stored size", async () => {
      writeSnapshot(cacheDir, "rev-1");
      const { getMlxModelStatus } = await import(
        "../src/lib/mlx-asr/models.js"
      );

      expect(getMlxModelStatus(CUSTOM_ID)?.status).toBe("ready");
    });

    it("is not downloaded when the snapshot dir is missing", async () => {
      const { getMlxModelStatus } = await import(
        "../src/lib/mlx-asr/models.js"
      );

      expect(getMlxModelStatus(CUSTOM_ID)?.status).toBe("not_downloaded");
    });

    it("is not downloaded when the snapshot dir is empty", async () => {
      mkdirSync(
        join(cacheDir, "models--someone--whisper-tiny", "snapshots", "rev-1"),
        { recursive: true },
      );
      const { getMlxModelStatus } = await import(
        "../src/lib/mlx-asr/models.js"
      );

      expect(getMlxModelStatus(CUSTOM_ID)?.status).toBe("not_downloaded");
    });

    it("is not downloaded when a file is missing", async () => {
      writeSnapshot(cacheDir, "rev-1", FILES.slice(0, 2));
      const { getMlxModelStatus } = await import(
        "../src/lib/mlx-asr/models.js"
      );

      expect(getMlxModelStatus(CUSTOM_ID)?.status).toBe("not_downloaded");
    });

    it("is not downloaded when a file is truncated", async () => {
      writeSnapshot(cacheDir, "rev-1", FILES, { "model.safetensors": 2 });
      const { getMlxModelStatus } = await import(
        "../src/lib/mlx-asr/models.js"
      );

      expect(getMlxModelStatus(CUSTOM_ID)?.status).toBe("not_downloaded");
    });

    it("ignores a complete snapshot of another revision", async () => {
      writeSnapshot(cacheDir, "other-rev");
      const { getMlxModelStatus } = await import(
        "../src/lib/mlx-asr/models.js"
      );

      expect(getMlxModelStatus(CUSTOM_ID)?.status).toBe("not_downloaded");
    });

    it("accepts a curated snapshot with weights and no manifest", async () => {
      const snapshot = join(
        cacheDir,
        "models--mlx-community--parakeet-tdt-0.6b-v3",
        "snapshots",
        "abc",
      );
      mkdirSync(snapshot, { recursive: true });
      writeFileSync(join(snapshot, "config.json"), "{}");
      writeFileSync(join(snapshot, "model.safetensors"), "w");
      const { getMlxModelStatus } = await import(
        "../src/lib/mlx-asr/models.js"
      );

      expect(getMlxModelStatus("parakeet-tdt-0.6b-v3")?.status).toBe("ready");
    });
  });

  describe("catalog", () => {
    it("lists the custom model after the curated ones, with its status", async () => {
      const { getAllMlxModelStatuses, getMlxCatalogModels } = await import(
        "../src/lib/mlx-asr/models.js"
      );

      const catalog = getMlxCatalogModels();
      expect(catalog.map((m) => m.id)).toEqual([
        ...MLX_ASR_MODELS.map((m) => m.id),
        CUSTOM_ID,
      ]);
      expect(catalog.at(-1)).toMatchObject({
        hfId: CUSTOM_HF_ID,
        family: "qwen3-asr",
        quantized: false,
        custom: { revision: "rev-1", files: FILES },
      });
      expect(getAllMlxModelStatuses().at(-1)).toMatchObject({
        model: CUSTOM_ID,
        displayName: "whisper-tiny",
        sizeBytes: 10,
        status: "not_downloaded",
      });
    });

    it("counts the custom repo dir in the local model dirs", async () => {
      const { getLocalModelCacheDirs } = await import(
        "../src/lib/local-model-dirs.js"
      );

      const dirs = getLocalModelCacheDirs();

      expect(dirs).toContain(join(cacheDir, "models--someone--whisper-tiny"));
      expect(dirs).toContain(
        join(cacheDir, "models--mlx-community--SenseVoiceSmall"),
      );
    });
  });

  describe("download", () => {
    it("reads as ready after a download when main moved since the add", async () => {
      // The row says rev-1. The hub fetched rev-2, a different file set.
      const newFiles = [
        { path: "config.json", size: 2 },
        { path: "model.safetensors", size: 9 },
      ];
      mocks.snapshotDownload.mockImplementation(async () =>
        writeSnapshot(cacheDir, "rev-2", newFiles),
      );
      const { downloadMlxModel, getMlxModelStatus } = await import(
        "../src/lib/mlx-asr/models.js"
      );
      expect(getMlxModelStatus(CUSTOM_ID)?.status).toBe("not_downloaded");

      await downloadMlxModel(CUSTOM_ID);

      expect(getMlxModelStatus(CUSTOM_ID)?.status).toBe("ready");
      expect(getCustomMlxDef(CUSTOM_ID)?.custom).toEqual({
        revision: "rev-2",
        files: newFiles,
      });
    });

    it.each([
      ["a .py file", "modeling.py", "x = 1"],
      [
        "an auto_map in processor_config.json",
        "processor_config.json",
        '{"auto_map":{}}',
      ],
    ])("blocks and removes a download that holds %s", async (_name, file, content) => {
      mocks.snapshotDownload.mockImplementation(async () => {
        const dir = writeSnapshot(cacheDir, "rev-2");
        writeFileSync(join(dir, file), content);
        return dir;
      });
      const { downloadMlxModel, getMlxModelStatus } = await import(
        "../src/lib/mlx-asr/models.js"
      );

      await expect(downloadMlxModel(CUSTOM_ID)).rejects.toThrow(
        /holds its own code files/,
      );

      expect(existsSync(join(cacheDir, "models--someone--whisper-tiny"))).toBe(
        false,
      );
      expect(getCustomMlxDef(CUSTOM_ID)?.custom?.revision).toBe("rev-1");
      expect(getMlxModelStatus(CUSTOM_ID)).toMatchObject({
        status: "error",
        error: expect.stringContaining("own code files"),
      });
    });

    it("keeps a download whose json files have no auto_map", async () => {
      mocks.snapshotDownload.mockImplementation(async () => {
        const dir = writeSnapshot(cacheDir, "rev-2");
        writeFileSync(join(dir, "tokenizer_config.json"), '{"a":1}');
        return dir;
      });
      const { downloadMlxModel, getMlxModelStatus } = await import(
        "../src/lib/mlx-asr/models.js"
      );

      await downloadMlxModel(CUSTOM_ID);

      expect(getMlxModelStatus(CUSTOM_ID)?.status).toBe("ready");
    });

    it("does not download a repo that grew above 8 GiB", async () => {
      mocks.listSize = 8 * 1024 ** 3 + 1;
      const { downloadMlxModel, getMlxModelStatus } = await import(
        "../src/lib/mlx-asr/models.js"
      );

      await expect(downloadMlxModel(CUSTOM_ID)).rejects.toThrow(/8 GiB/);

      expect(mocks.snapshotDownload).not.toHaveBeenCalled();
      expect(getMlxModelStatus(CUSTOM_ID)?.status).toBe("error");
    });

    it("keeps the row and the stored snapshot when the download fails", async () => {
      mocks.snapshotDownload.mockRejectedValue(new Error("network down"));
      const { downloadMlxModel, getMlxModelStatus } = await import(
        "../src/lib/mlx-asr/models.js"
      );

      await expect(downloadMlxModel(CUSTOM_ID)).rejects.toThrow("network down");

      expect(getMlxModelStatus(CUSTOM_ID)?.status).toBe("error");
      expect(getCustomMlxDef(CUSTOM_ID)?.custom?.revision).toBe("rev-1");
    });

    it("keeps the row when the user cancels", async () => {
      writeSnapshot(cacheDir, "rev-1", FILES.slice(0, 1));
      mocks.snapshotDownload.mockReturnValue(new Promise(() => {}));
      const { cancelMlxDownload, downloadMlxModel, getMlxModelStatus } =
        await import("../src/lib/mlx-asr/models.js");

      void downloadMlxModel(CUSTOM_ID).catch(() => {});
      for (let i = 0; i < 100; i++) {
        if (getMlxModelStatus(CUSTOM_ID)?.phase === "downloading_model") break;
        await Promise.resolve();
      }
      expect(getMlxModelStatus(CUSTOM_ID)?.phase).toBe("downloading_model");

      expect(cancelMlxDownload(CUSTOM_ID)).toBe(true);

      expect(existsSync(join(cacheDir, "models--someone--whisper-tiny"))).toBe(
        false,
      );
      expect(getCustomMlxDef(CUSTOM_ID)).toBeDefined();
      expect(getMlxModelStatus(CUSTOM_ID)?.status).toBe("not_downloaded");
    });
  });

  describe("a download that is aborted", () => {
    async function startAndWait(modelId: string) {
      const models = await import("../src/lib/mlx-asr/models.js");
      const calls = mocks.snapshotDownload.mock.calls.length;
      const done = models.downloadMlxModel(modelId).catch(() => {});
      // Wait until the download reaches `snapshotDownload`.
      await vi.waitFor(() =>
        expect(mocks.snapshotDownload.mock.calls.length).toBeGreaterThan(calls),
      );
      return { models, done };
    }

    it("removes the files that a late write recreated after the delete", async () => {
      let fail: (err: Error) => void = () => {};
      mocks.snapshotDownload.mockReturnValue(
        new Promise((_, reject) => {
          fail = reject;
        }),
      );
      const { models, done } = await startAndWait(CUSTOM_ID);

      expect(models.deleteMlxModel(CUSTOM_ID)).toBe(true);
      // The in-flight writer creates a partial blob after the delete.
      writeSnapshot(cacheDir, "late");
      fail(new Error("aborted"));
      await done;

      expect(existsSync(join(cacheDir, "models--someone--whisper-tiny"))).toBe(
        false,
      );
    });

    it("keeps the files of a newer download of the same repo", async () => {
      const failers: ((err: Error) => void)[] = [];
      mocks.snapshotDownload.mockImplementation(
        () =>
          new Promise((_, reject) => {
            failers.push(reject);
          }),
      );
      const { models, done } = await startAndWait(CUSTOM_ID);
      models.cancelMlxDownload(CUSTOM_ID);
      const second = await startAndWait(CUSTOM_ID);
      writeSnapshot(cacheDir, "new");

      failers[0]?.(new Error("aborted"));
      await done;

      expect(existsSync(join(cacheDir, "models--someone--whisper-tiny"))).toBe(
        true,
      );
      expect(models.getMlxModelStatus(CUSTOM_ID)?.status).toBe("downloading");
      second.models.cancelMlxDownload(CUSTOM_ID);
      failers[1]?.(new Error("aborted"));
      await second.done;
    });
  });

  describe("whisper processor fill-in", () => {
    const WHISPER_CONFIG = {
      model_type: "whisper",
      n_vocab: 51866,
      n_mels: 128,
    };
    const CONFIG_JSON = JSON.stringify(WHISPER_CONFIG);
    const PROCESSOR_FILES = [
      "preprocessor_config.json",
      "tokenizer.json",
      "tokenizer_config.json",
    ];
    let tokenizer = "";
    let tokenizerConfig = "{}";
    let fetched: string[] = [];

    /** An old mlx-whisper snapshot: config.json and weights. `own` adds processor files of the repo. */
    function writeOldWhisperSnapshot(
      revision: string,
      config = CONFIG_JSON,
      own = false,
    ): string {
      const repoDir = join(cacheDir, "models--someone--whisper-tiny");
      const snapshotDir = join(repoDir, "snapshots", revision);
      mkdirSync(join(repoDir, "blobs"), { recursive: true });
      mkdirSync(snapshotDir, { recursive: true });
      const files: Record<string, string> = {
        "config.json": config,
        "weights.npz": "12345",
        ...(own
          ? Object.fromEntries(PROCESSOR_FILES.map((f) => [f, "{}"]))
          : {}),
      };
      for (const [name, content] of Object.entries(files)) {
        const blob = join(repoDir, "blobs", `${revision}-${name}`);
        writeFileSync(blob, content);
        symlinkSync(blob, join(snapshotDir, name));
      }
      return snapshotDir;
    }

    /** The row that validation writes for an old whisper repo. */
    function insertWhisperRow(
      config: Record<string, unknown> = WHISPER_CONFIG,
    ) {
      const source = whisperProcessorSource(config, ["config.json"]);
      getDb().exec("DELETE FROM custom_mlx_models");
      insertCustomModel({
        hfId: CUSTOM_HF_ID,
        family: "whisper",
        modelType: "whisper",
        totalBytes: 10,
        revision: "rev-1",
        files: [
          { path: "config.json", size: CONFIG_JSON.length },
          { path: "weights.npz", size: 5 },
          ...(source?.files ?? []),
        ],
      });
    }

    beforeEach(() => {
      tokenizer = TOKENIZER_FOR_N_VOCAB[51866]();
      tokenizerConfig = "{}";
      fetched = [];
      insertWhisperRow();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL) => {
          const url = String(input);
          fetched.push(url);
          if (url.endsWith("/tokenizer.json")) {
            return new Response(pinnedBody(url, tokenizer));
          }
          if (url.endsWith("/tokenizer_config.json")) {
            return new Response(pinnedBody(url, tokenizerConfig));
          }
          return new Response(pinnedBody(url, "{}"));
        }),
      );
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("is not ready while the added files are missing, and ready after the download adds them", async () => {
      const snapshotDir = writeOldWhisperSnapshot("rev-1");
      mocks.snapshotDownload.mockResolvedValue(snapshotDir);
      const { downloadMlxModel, getMlxModelStatus } = await import(
        "../src/lib/mlx-asr/models.js"
      );
      // The weights are all there. The three added files are not.
      expect(getMlxModelStatus(CUSTOM_ID)?.status).toBe("not_downloaded");

      await downloadMlxModel(CUSTOM_ID);

      expect(getMlxModelStatus(CUSTOM_ID)?.status).toBe("ready");
      for (const name of PROCESSOR_FILES) {
        expect(lstatSync(join(snapshotDir, name)).isFile()).toBe(true);
      }
      expect(
        readFileSync(join(snapshotDir, "tokenizer.json"), "utf8").trimEnd(),
      ).toBe(tokenizer);
      // The row lists what is on disk now: the pinned sizes of the added files.
      expect(getCustomMlxDef(CUSTOM_ID)?.custom).toEqual({
        revision: "rev-1",
        files: [
          { path: "config.json", size: CONFIG_JSON.length },
          ...(whisperProcessorSource(WHISPER_CONFIG, ["config.json"])?.files ??
            []),
          { path: "weights.npz", size: 5 },
        ],
      });
      expect(fetched).toHaveLength(3);
      expect(
        fetched.every((url) =>
          url.includes("/openai/whisper-large-v3-turbo/resolve/"),
        ),
      ).toBe(true);
    });

    it("fills in a new snapshot when main moved", async () => {
      writeOldWhisperSnapshot("rev-1");
      const moved = writeOldWhisperSnapshot("rev-2");
      mocks.snapshotDownload.mockResolvedValue(moved);
      const { downloadMlxModel, getMlxModelStatus } = await import(
        "../src/lib/mlx-asr/models.js"
      );

      await downloadMlxModel(CUSTOM_ID);

      expect(getMlxModelStatus(CUSTOM_ID)?.status).toBe("ready");
      expect(getCustomMlxDef(CUSTOM_ID)?.custom?.revision).toBe("rev-2");
      expect(existsSync(join(moved, "tokenizer.json"))).toBe(true);
    });

    it("refuses a tokenizer of the wrong length and the model does not read as ready", async () => {
      tokenizer = TOKENIZER_FOR_N_VOCAB[51865]();
      const snapshotDir = writeOldWhisperSnapshot("rev-1");
      mocks.snapshotDownload.mockResolvedValue(snapshotDir);
      const { clearMlxDownloadError, downloadMlxModel, getMlxModelStatus } =
        await import("../src/lib/mlx-asr/models.js");

      await expect(downloadMlxModel(CUSTOM_ID)).rejects.toThrow(
        /has 51865 tokens\. The model needs 51866/,
      );

      expect(getMlxModelStatus(CUSTOM_ID)).toMatchObject({
        status: "error",
        error: expect.stringContaining("51866"),
      });
      clearMlxDownloadError(CUSTOM_ID);
      expect(getMlxModelStatus(CUSTOM_ID)?.status).toBe("not_downloaded");
      expect(existsSync(join(snapshotDir, "tokenizer.json"))).toBe(false);
    });

    it("blocks and removes a download when an added file has an auto_map", async () => {
      tokenizerConfig = '{"auto_map":{}}';
      mocks.snapshotDownload.mockResolvedValue(
        writeOldWhisperSnapshot("rev-1"),
      );
      const { downloadMlxModel } = await import("../src/lib/mlx-asr/models.js");

      await expect(downloadMlxModel(CUSTOM_ID)).rejects.toThrow(
        /holds its own code files/,
      );

      expect(existsSync(join(cacheDir, "models--someone--whisper-tiny"))).toBe(
        false,
      );
    });

    it("keeps a model whose layout is not a standard one blocked at download", async () => {
      insertWhisperRow({ n_vocab: 51867, n_mels: 128 });
      mocks.snapshotDownload.mockResolvedValue(
        writeOldWhisperSnapshot(
          "rev-1",
          JSON.stringify({ n_vocab: 51867, n_mels: 128 }),
        ),
      );
      const { downloadMlxModel, getMlxModelStatus } = await import(
        "../src/lib/mlx-asr/models.js"
      );

      await expect(downloadMlxModel(CUSTOM_ID)).rejects.toThrow(
        /no standard tokenizer/,
      );

      expect(getMlxModelStatus(CUSTOM_ID)?.status).toBe("error");
      expect(fetched).toEqual([]);
    });

    it("fetches nothing for a repo that has its own processor files", async () => {
      const snapshotDir = writeOldWhisperSnapshot("rev-1", CONFIG_JSON, true);
      mocks.snapshotDownload.mockResolvedValue(snapshotDir);
      const { downloadMlxModel, getMlxModelStatus } = await import(
        "../src/lib/mlx-asr/models.js"
      );

      await downloadMlxModel(CUSTOM_ID);

      expect(fetched).toEqual([]);
      expect(getMlxModelStatus(CUSTOM_ID)?.status).toBe("ready");
      expect(
        lstatSync(join(snapshotDir, "tokenizer.json")).isSymbolicLink(),
      ).toBe(true);
    });
  });

  describe("deleteMlxModel", () => {
    it("removes a custom row that has no dir and returns true", async () => {
      const { deleteMlxModel } = await import("../src/lib/mlx-asr/models.js");

      expect(deleteMlxModel(CUSTOM_ID)).toBe(true);

      expect(getCustomMlxDef(CUSTOM_ID)).toBeUndefined();
      expect(deleteMlxModel(CUSTOM_ID)).toBe(false);
    });

    it("removes the dir, the custom row and the configured model", async () => {
      writeSnapshot(cacheDir, "rev-1");
      getDb()
        .prepare(
          `INSERT INTO model_configs (provider, model_id, model_name, type, is_default)
           VALUES ('local-mlx', ?, 'whisper-tiny', 'voice', 1)`,
        )
        .run(`local-mlx/${CUSTOM_ID}`);
      const { deleteMlxModel, getAllMlxModelStatuses } = await import(
        "../src/lib/mlx-asr/models.js"
      );

      expect(deleteMlxModel(CUSTOM_ID)).toBe(true);

      expect(existsSync(join(cacheDir, "models--someone--whisper-tiny"))).toBe(
        false,
      );
      expect(getCustomMlxDef(CUSTOM_ID)).toBeUndefined();
      expect(getAllMlxModelStatuses().map((s) => s.model)).not.toContain(
        CUSTOM_ID,
      );
      expect(
        getDb()
          .prepare("SELECT COUNT(*) AS n FROM model_configs WHERE model_id = ?")
          .get(`local-mlx/${CUSTOM_ID}`),
      ).toEqual({ n: 0 });
    });

    it("keeps a curated model definition and returns false when no dir existed", async () => {
      const { deleteMlxModel, getMlxCatalogModels } = await import(
        "../src/lib/mlx-asr/models.js"
      );

      expect(deleteMlxModel("sensevoice-small")).toBe(false);

      expect(getMlxCatalogModels().map((m) => m.id)).toContain(
        "sensevoice-small",
      );
    });
  });
});

/**
 * A curated repo the way a download leaves it: the expected file list, blobs
 * and the snapshot symlinks. `stored` is the subset that reached the snapshot.
 */
function writeCuratedRepo(
  cacheDir: string,
  stored: Record<string, number>,
  incomplete = false,
): string {
  const repoDir = join(cacheDir, "models--mlx-community--SenseVoiceSmall");
  const snapshotDir = join(repoDir, "snapshots", "sha1");
  mkdirSync(join(repoDir, "blobs"), { recursive: true });
  mkdirSync(snapshotDir, { recursive: true });
  writeFileSync(
    join(repoDir, "openstyle-expected-files.json"),
    JSON.stringify({
      files: [
        { path: "config.json", size: 2 },
        { path: "model.safetensors", size: 8 },
      ],
    }),
  );
  for (const [path, size] of Object.entries(stored)) {
    const blob = join(repoDir, "blobs", `etag-${path}`);
    writeFileSync(blob, "");
    truncateSync(blob, size);
    symlinkSync(blob, join(snapshotDir, path));
  }
  if (incomplete) {
    writeFileSync(join(repoDir, "blobs", "etag-weights.incomplete"), "par");
  }
  return snapshotDir;
}

describe("curated snapshot completeness and download retries", () => {
  const SENSE = "sensevoice-small";
  let cacheDir = "";
  const originalCache = process.env.HUGGINGFACE_HUB_CACHE;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "mlx-curated-"));
    process.env.HUGGINGFACE_HUB_CACHE = cacheDir;
    mocks.blocker = null;
    mocks.listSize = 2;
    mocks.snapshotDownload.mockReset();
    // Fake only the retry waits. The disk check needs real I/O callbacks.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    rmSync(cacheDir, { recursive: true, force: true });
    if (originalCache === undefined) delete process.env.HUGGINGFACE_HUB_CACHE;
    else process.env.HUGGINGFACE_HUB_CACHE = originalCache;
  });

  it("is ready when every expected file has its size", async () => {
    writeCuratedRepo(cacheDir, { "config.json": 2, "model.safetensors": 8 });
    const { getMlxModelStatus } = await import("../src/lib/mlx-asr/models.js");

    expect(getMlxModelStatus(SENSE)?.status).toBe("ready");
  });

  it.each([
    ["the weights are missing", { "config.json": 2 }, false],
    [
      "the weights have the wrong size",
      { "config.json": 2, "model.safetensors": 3 },
      false,
    ],
    [
      "an .incomplete blob is left",
      { "config.json": 2, "model.safetensors": 8 },
      true,
    ],
  ])("is not downloaded when %s", async (_name, stored, incomplete) => {
    writeCuratedRepo(cacheDir, stored, incomplete);
    const { getMlxModelStatus } = await import("../src/lib/mlx-asr/models.js");

    expect(getMlxModelStatus(SENSE)?.status).toBe("not_downloaded");
  });

  it("is not downloaded when a snapshot with no manifest has no weights", async () => {
    const snapshot = join(
      cacheDir,
      "models--mlx-community--SenseVoiceSmall",
      "snapshots",
      "abc",
    );
    mkdirSync(snapshot, { recursive: true });
    writeFileSync(join(snapshot, "config.json"), "{}");
    const { getMlxModelStatus } = await import("../src/lib/mlx-asr/models.js");

    expect(getMlxModelStatus(SENSE)?.status).toBe("not_downloaded");
  });

  /** The undici error of a reset body stream. */
  function terminated(): Error {
    return Object.assign(new TypeError("terminated"), {
      cause: Object.assign(new Error("other side closed"), {
        code: "UND_ERR_SOCKET",
      }),
    });
  }

  /** Write the files that the mocked `listFiles` expects (config.json, 2 bytes). */
  function writeDownloadedSnapshot(): string {
    const repoDir = join(cacheDir, "models--mlx-community--SenseVoiceSmall");
    const snapshotDir = join(repoDir, "snapshots", "sha1");
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(join(snapshotDir, "config.json"), "{}");
    return snapshotDir;
  }

  /** Run real I/O and fake retry waits until `tries` tries have started. */
  async function passRetryWaits(tries: number): Promise<void> {
    for (let i = 0; i < 500; i++) {
      if (mocks.snapshotDownload.mock.calls.length >= tries) return;
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(500);
    }
    throw new Error(`only ${mocks.snapshotDownload.mock.calls.length} tries`);
  }

  it("tries again after a dropped connection and reads as ready", async () => {
    mocks.snapshotDownload
      .mockRejectedValueOnce(terminated())
      .mockRejectedValueOnce(terminated())
      .mockImplementationOnce(async () => writeDownloadedSnapshot());
    const { downloadMlxModel, getMlxModelStatus } = await import(
      "../src/lib/mlx-asr/models.js"
    );

    const done = downloadMlxModel(SENSE);
    await passRetryWaits(3);
    await done;

    expect(mocks.snapshotDownload).toHaveBeenCalledTimes(3);
    expect(getMlxModelStatus(SENSE)?.status).toBe("ready");
  });

  it("reports an error, not ready, when every try drops", async () => {
    mocks.snapshotDownload.mockImplementation(async () => {
      // The config arrived. The weights stay a partial blob.
      const dir = writeDownloadedSnapshot();
      writeFileSync(join(dir, "..", "..", "blobs", "etag-w.incomplete"), "p");
      throw terminated();
    });
    mkdirSync(
      join(cacheDir, "models--mlx-community--SenseVoiceSmall", "blobs"),
      {
        recursive: true,
      },
    );
    const { downloadMlxModel, getMlxModelStatus, clearMlxDownloadError } =
      await import("../src/lib/mlx-asr/models.js");

    const done = downloadMlxModel(SENSE).catch((err: Error) => err);
    await passRetryWaits(4);

    expect(await done).toBeInstanceOf(TypeError);
    expect(mocks.snapshotDownload).toHaveBeenCalledTimes(4);
    expect(getMlxModelStatus(SENSE)?.status).toBe("error");
    // A new status read after the error is cleared still sees the partial blob.
    clearMlxDownloadError(SENSE);
    expect(getMlxModelStatus(SENSE)?.status).toBe("not_downloaded");
  });

  it("does not try again after an error that is not a dropped connection", async () => {
    mocks.snapshotDownload.mockRejectedValue(new Error("404 Not Found"));
    const { downloadMlxModel, getMlxModelStatus } = await import(
      "../src/lib/mlx-asr/models.js"
    );

    await expect(downloadMlxModel(SENSE)).rejects.toThrow("404");

    expect(mocks.snapshotDownload).toHaveBeenCalledTimes(1);
    expect(getMlxModelStatus(SENSE)?.status).toBe("error");
  });
});

describe("downloadHfSnapshot with allow patterns (LLM text-only files)", () => {
  // The real file list of mlx-community/Qwen3.5-4B-OptiQ-4bit (HF API tree).
  const OPTIQ_FILES = [
    { path: ".gitattributes", size: 1570 },
    { path: "README.md", size: 5101 },
    { path: "chat_template.jinja", size: 7756 },
    { path: "config.json", size: 55537 },
    { path: "generation_config.json", size: 148 },
    { path: "kv_config.json", size: 528 },
    { path: "model.safetensors", size: 3269669552 },
    { path: "model.safetensors.index.json", size: 99163 },
    { path: "optiq/mtp.safetensors", size: 86701044 },
    { path: "optiq_metadata.json", size: 26224 },
    { path: "optiq_vision.safetensors", size: 667061501 },
    { path: "preprocessor_config.json", size: 390 },
    { path: "processor_config.json", size: 1300 },
    { path: "tokenizer.json", size: 19989343 },
    { path: "tokenizer_config.json", size: 1135 },
    { path: "video_preprocessor_config.json", size: 385 },
  ];
  const KEPT = OPTIQ_FILES.filter(
    (f) =>
      ![
        ".gitattributes",
        "README.md",
        "optiq/mtp.safetensors",
        "optiq_vision.safetensors",
      ].includes(f.path),
  );
  let cacheDir = "";
  const originalCache = process.env.HUGGINGFACE_HUB_CACHE;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "mlx-allow-"));
    process.env.HUGGINGFACE_HUB_CACHE = cacheDir;
    mocks.snapshotDownload.mockReset();
    mocks.downloadFileToCacheDir.mockReset();
    mocks.listEntries = OPTIQ_FILES;
  });

  afterEach(() => {
    mocks.listEntries = null;
    if (originalCache === undefined) delete process.env.HUGGINGFACE_HUB_CACHE;
    else process.env.HUGGINGFACE_HUB_CACHE = originalCache;
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("keeps the mlx-lm files and drops README and the optiq extras", async () => {
    const { filterRepoFiles } = await import("../src/lib/mlx-asr/models.js");
    const { MLX_LLM_ALLOW_PATTERNS } = await import(
      "../src/lib/mlx-llm/constants.js"
    );

    const kept = filterRepoFiles(OPTIQ_FILES, MLX_LLM_ALLOW_PATTERNS);

    expect(kept).toEqual(KEPT);
    expect(kept.reduce((sum, f) => sum + f.size, 0)).toBe(3_289_851_461);
  });

  it("fetches only the matching files and writes them into the manifest", async () => {
    const { downloadHfSnapshot, isHfSnapshotPresent, newActiveMlxDownload } =
      await import("../src/lib/mlx-asr/models.js");
    const { MLX_LLM_ALLOW_PATTERNS } = await import(
      "../src/lib/mlx-llm/constants.js"
    );
    const hfId = "mlx-community/Qwen3.5-4B-OptiQ-4bit";
    const repoDir = join(
      cacheDir,
      "models--mlx-community--Qwen3.5-4B-OptiQ-4bit",
    );
    const active = newActiveMlxDownload();

    const snapshot = await downloadHfSnapshot(active, hfId, {
      allowPatterns: MLX_LLM_ALLOW_PATTERNS,
    });

    expect(mocks.snapshotDownload).not.toHaveBeenCalled();
    expect(
      mocks.downloadFileToCacheDir.mock.calls.map((c) => c[0].path),
    ).toEqual(KEPT.map((f) => f.path));
    expect(mocks.downloadFileToCacheDir.mock.calls[0][0].revision).toBe(
      "sha-1",
    );
    expect(snapshot).toBe(join(repoDir, "snapshots", "sha-1"));
    expect(readFileSync(join(repoDir, "refs", "main"), "utf8")).toBe("sha-1");
    expect(active.bytesTotal).toBe(3_289_851_461);
    const manifest = JSON.parse(
      readFileSync(join(repoDir, "openstyle-expected-files.json"), "utf8"),
    );
    expect(manifest.files).toEqual(KEPT);

    // The completeness check uses the filtered list: the snapshot is ready
    // with no optiq file, and not ready with one kept file missing.
    mkdirSync(snapshot, { recursive: true });
    for (const f of KEPT.slice(1)) {
      writeFileSync(join(snapshot, f.path), "");
      truncateSync(join(snapshot, f.path), f.size);
    }
    expect(isHfSnapshotPresent(hfId)).toBe(false);
    writeFileSync(join(snapshot, KEPT[0].path), "");
    truncateSync(join(snapshot, KEPT[0].path), KEPT[0].size);
    expect(isHfSnapshotPresent(hfId)).toBe(true);
  });
});

describe("downloadHfSnapshot at a pinned revision (built-in embedding model)", () => {
  // The real file list of jayyun98/embeddinggemma-2-text-270m-mlx-bf16 at
  // 186ecf2d (HF API tree, 2026-10-20).
  const EMBED_FILES = [
    { path: ".gitattributes", size: 1570 },
    { path: "1_Pooling/config.json", size: 90 },
    { path: "2_Normalize/config.json", size: 97 },
    { path: "LICENSE", size: 11358 },
    { path: "NOTICE", size: 577 },
    { path: "README.md", size: 4505 },
    { path: "chat_template.jinja", size: 1016 },
    { path: "config.json", size: 2359 },
    { path: "config_sentence_transformers.json", size: 1565 },
    { path: "conversion.json", size: 614 },
    { path: "model.safetensors", size: 542056154 },
    { path: "model.safetensors.index.json", size: 34557 },
    { path: "modules.json", size: 413 },
    { path: "preprocessor_config.json", size: 511 },
    { path: "processor_config.json", size: 1788 },
    { path: "sentence_bert_config.json", size: 214 },
    { path: "tokenizer.json", size: 32170510 },
    { path: "tokenizer.model", size: 4689013 },
    { path: "tokenizer_config.json", size: 1599 },
    { path: "verification.json", size: 1438 },
  ];
  const DROPPED = [
    ".gitattributes",
    "LICENSE",
    "NOTICE",
    "README.md",
    "chat_template.jinja",
  ];
  let cacheDir = "";
  const originalCache = process.env.HUGGINGFACE_HUB_CACHE;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "mlx-embed-pin-"));
    process.env.HUGGINGFACE_HUB_CACHE = cacheDir;
    mocks.snapshotDownload.mockReset();
    mocks.downloadFileToCacheDir.mockReset();
    mocks.listEntries = EMBED_FILES;
  });

  afterEach(() => {
    mocks.listEntries = null;
    if (originalCache === undefined) delete process.env.HUGGINGFACE_HUB_CACHE;
    else process.env.HUGGINGFACE_HUB_CACHE = originalCache;
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("fetches the catalog files at the pinned commit and writes no refs/main", async () => {
    const { downloadHfSnapshot, isHfSnapshotPresent, newActiveMlxDownload } =
      await import("../src/lib/mlx-asr/models.js");
    const { MLX_EMBED_ALLOW_PATTERNS, MLX_EMBED_MODELS } = await import(
      "../src/lib/mlx-embed/constants.js"
    );
    const def = MLX_EMBED_MODELS[0];
    const repoDir = join(
      cacheDir,
      "models--jayyun98--embeddinggemma-2-text-270m-mlx-bf16",
    );
    const kept = EMBED_FILES.filter((f) => !DROPPED.includes(f.path));
    const active = newActiveMlxDownload();

    const snapshot = await downloadHfSnapshot(active, def.hfId, {
      allowPatterns: MLX_EMBED_ALLOW_PATTERNS,
      revision: def.revision,
    });

    expect(snapshot).toBe(join(repoDir, "snapshots", def.revision));
    expect(
      mocks.downloadFileToCacheDir.mock.calls.map((c) => c[0].path),
    ).toEqual(kept.map((f) => f.path));
    for (const call of mocks.downloadFileToCacheDir.mock.calls) {
      expect(call[0].revision).toBe(def.revision);
    }
    expect(existsSync(join(repoDir, "refs", "main"))).toBe(false);
    // The catalog size is the sum of the kept files.
    expect(active.bytesTotal).toBe(def.sizeBytes);

    // Ready only with every kept file in the snapshot of the pinned commit.
    const write = (dir: string) => {
      for (const f of kept) {
        mkdirSync(dirname(join(dir, f.path)), { recursive: true });
        writeFileSync(join(dir, f.path), "");
        truncateSync(join(dir, f.path), f.size);
      }
    };
    write(join(repoDir, "snapshots", "other-commit"));
    expect(isHfSnapshotPresent(def.hfId)).toBe(true);
    expect(isHfSnapshotPresent(def.hfId, def.revision)).toBe(false);
    write(snapshot);
    expect(isHfSnapshotPresent(def.hfId, def.revision)).toBe(true);
  });
});
