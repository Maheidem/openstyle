import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MLX_ASR_MODELS } from "../src/lib/mlx-asr/constants.js";

const mocks = vi.hoisted(() => ({
  blocker: "runtime missing" as string | null,
  ensureRuntime: vi.fn(),
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
