import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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

const mocks = vi.hoisted(() => ({
  blocker: "runtime missing" as string | null,
  ensureRuntime: vi.fn(),
  snapshotDownload: vi.fn(),
}));

vi.mock("@huggingface/hub", () => ({
  // The size sum for the progress bar. One small file.
  listFiles: async function* () {
    yield { type: "file", path: "config.json", size: 2 };
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
    insertCustomModel({
      hfId: CUSTOM_HF_ID,
      family: "whisper",
      modelType: "whisper",
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
        family: "whisper",
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
