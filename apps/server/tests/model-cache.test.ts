import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getMlxRuntimeDir } from "../src/lib/mlx-asr/constants.js";
import { modelCacheDir } from "../src/lib/model-cache.js";

const saved = process.env.OPENSTYLE_MODEL_CACHE_DIR;
afterEach(() => {
  if (saved === undefined) delete process.env.OPENSTYLE_MODEL_CACHE_DIR;
  else process.env.OPENSTYLE_MODEL_CACHE_DIR = saved;
});

describe("modelCacheDir", () => {
  it("uses ~/.cache/freestyle by default", () => {
    delete process.env.OPENSTYLE_MODEL_CACHE_DIR;
    expect(modelCacheDir("mlx-asr")).toBe(
      join(homedir(), ".cache", "freestyle", "mlx-asr"),
    );
  });

  it("uses OPENSTYLE_MODEL_CACHE_DIR (the Openstyle Dev build) for every cache path", () => {
    process.env.OPENSTYLE_MODEL_CACHE_DIR = "/tmp/dev-cache";
    expect(modelCacheDir("whisper-models")).toBe(
      "/tmp/dev-cache/whisper-models",
    );
    expect(getMlxRuntimeDir()).toBe(
      `/tmp/dev-cache/mlx-asr/runtime/${process.platform}-${process.arch}`,
    );
  });
});
