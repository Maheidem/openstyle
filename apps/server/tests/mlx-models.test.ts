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
import { join } from "node:path";
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
  listSize: 2,
}));

vi.mock("@huggingface/hub", () => ({
  // The size sum for the progress bar. One small file.
  listFiles: async function* () {
    yield { type: "file", path: "config.json", size: mocks.listSize };
  },
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

    it("keeps the old any-file rule for a curated model", async () => {
      const snapshot = join(
        cacheDir,
        "models--mlx-community--parakeet-tdt-0.6b-v3",
        "snapshots",
        "abc",
      );
      mkdirSync(snapshot, { recursive: true });
      writeFileSync(join(snapshot, "config.json"), "{}");
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
