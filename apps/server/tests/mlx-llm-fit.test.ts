/**
 * The fit label of the built-in LLMs (specs/llm-runtime-tuning.md 5): the
 * formula of 5.1, the table of 5.2, the owner rule for Gemma 4 E2B, and the
 * label in GET /api/mlx-llm/status.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// CI runs on Linux. The platform gate is the only Mac-specific part here.
vi.mock("../src/lib/mlx-asr/constants.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/mlx-asr/constants.js")>()),
  isAppleSiliconMac: () => true,
}));

import createApp from "../src/index.js";
import { getDb } from "../src/lib/db.js";
import { GIB, MLX_LLM_MODELS } from "../src/lib/mlx-llm/constants.js";
import {
  computeMlxLlmFit,
  fitMachine,
  type MlxLlmFitLabel,
} from "../src/lib/mlx-llm/fit.js";

const W: MlxLlmFitLabel = "runs_well";
const T: MlxLlmFitLabel = "tight";
const X: MlxLlmFitLabel = "wont_fit";

/** The measured GPU cap of the 128 GiB Mac (spec section 2). */
const MEASURED_CAP_128 = 115_448_725_504;

/**
 * Spec 5.2, local ASR loaded. Columns: E2B, E4B, Nemotron, 26B-A4B, 27B (the
 * catalog order). gpu_cap is 0.84 x RAM, except the measured 128 GiB value.
 */
const TABLE: Array<[number, number, MlxLlmFitLabel[]]> = [
  [8, 0.84 * 8 * GIB, [T, X, X, X, X]],
  [16, 0.84 * 16 * GIB, [W, T, W, X, X]],
  [24, 0.84 * 24 * GIB, [W, W, W, X, X]],
  [32, 0.84 * 32 * GIB, [W, W, W, W, W]],
  [64, 0.84 * 64 * GIB, [W, W, W, W, W]],
  [128, MEASURED_CAP_128, [W, W, W, W, W]],
];

function labels(
  ramGib: number,
  gpuCapBytes: number | null,
  localAsr = true,
): MlxLlmFitLabel[] {
  return MLX_LLM_MODELS.map(
    (def) =>
      computeMlxLlmFit({
        peakBytes: def.peakBytes,
        ramBytes: ramGib * GIB,
        gpuCapBytes,
        localAsr,
        neverWontFit: def.recommended === true,
      }).label,
  );
}

describe("P(model) (spec 5.1)", () => {
  it("uses the MLX peak values of the spec, in catalog order", () => {
    expect(
      MLX_LLM_MODELS.map((m) => [m.id, Math.round((m.peakBytes / GIB) * 10)]),
    ).toEqual([
      ["gemma-4-e2b-qat-4bit", 51],
      ["gemma-4-e4b-qat-4bit", 75],
      ["nemotron-3.5-bolt-e4b-4bit", 60],
      ["gemma-4-26b-a4b-qat-4bit", 163],
      ["qwen3.8-27b-4bit", 187],
    ]);
  });
});

describe("fit table (spec 5.2, local ASR loaded)", () => {
  it.each(TABLE)("%i GiB matches the table", (ram, cap, expected) => {
    expect(labels(ram, cap)).toEqual(expected);
  });

  it.each(
    TABLE,
  )("%i GiB before the first worker start (no GPU cap) gives the same labels", (ram, _cap, expected) => {
    expect(labels(ram, null)).toEqual(expected);
  });

  it("budget = RAM - reserve - app - ASR (the budget column)", () => {
    const budgets = [8, 16, 24, 32, 64, 128].map((ram) => {
      const fit = computeMlxLlmFit({
        peakBytes: GIB,
        ramBytes: ram * GIB,
        gpuCapBytes: null,
        localAsr: true,
        neverWontFit: false,
      });
      return Math.round((fit.budgetBytes / GIB) * 100) / 100;
    });
    expect(budgets).toEqual([0.79, 8.79, 15.79, 23.79, 55.79, 119.79]);
  });
});

describe("owner rule and edge cases", () => {
  it("raises Gemma 4 E2B to Tight fit at 8 GiB, also with a cloud ASR model", () => {
    for (const localAsr of [true, false]) {
      const e2b = MLX_LLM_MODELS.find((m) => m.recommended);
      if (!e2b) throw new Error("no recommended model");
      const fit = computeMlxLlmFit({
        peakBytes: e2b.peakBytes,
        ramBytes: 8 * GIB,
        gpuCapBytes: 0.84 * 8 * GIB,
        localAsr,
        neverWontFit: true,
      });
      expect(fit.label).toBe("tight");
      expect(fit.raised).toBe(true);
    }
  });

  it("does not raise a model that fits", () => {
    const fit = computeMlxLlmFit({
      peakBytes: 5.1 * GIB,
      ramBytes: 16 * GIB,
      gpuCapBytes: null,
      localAsr: true,
      neverWontFit: true,
    });
    expect(fit).toMatchObject({ label: "runs_well", raised: false });
  });

  it("without a local ASR model the budget grows by 2.56 GiB", () => {
    // 16 GiB: E4B 7.5 <= 0.8 x 11.35, so it runs well without local ASR.
    expect(labels(16, null, false)).toEqual([W, W, W, X, X]);
    // 24 GiB: budget 18.35. 26B-A4B 16.3 is a tight fit, 27B 18.7 is not.
    expect(labels(24, null, false)).toEqual([W, W, W, T, X]);
  });

  it("a small GPU cap lowers the label", () => {
    const base = {
      peakBytes: 16.3 * GIB,
      ramBytes: 64 * GIB,
      localAsr: true,
      neverWontFit: false,
    };
    // 0.9 x 17 = 15.3 < 16.3 <= 17: tight.
    expect(computeMlxLlmFit({ ...base, gpuCapBytes: 17 * GIB }).label).toBe(
      "tight",
    );
    expect(computeMlxLlmFit({ ...base, gpuCapBytes: 16 * GIB }).label).toBe(
      "wont_fit",
    );
  });
});

describe("fitMachine (operator overrides)", () => {
  afterEach(() => {
    delete process.env.OPENSTYLE_MLX_LLM_FIT_RAM_GIB;
    delete process.env.OPENSTYLE_MLX_LLM_FIT_GPU_CAP_GIB;
  });

  it("uses the total RAM and the worker GPU cap without overrides", async () => {
    const { totalmem } = await import("node:os");
    expect(fitMachine(123)).toEqual({ ramBytes: totalmem(), gpuCapBytes: 123 });
    expect(fitMachine(null).gpuCapBytes).toBeNull();
  });

  it("a RAM override drops the real worker GPU cap", () => {
    process.env.OPENSTYLE_MLX_LLM_FIT_RAM_GIB = "16";
    expect(fitMachine(123)).toEqual({ ramBytes: 16 * GIB, gpuCapBytes: null });
    process.env.OPENSTYLE_MLX_LLM_FIT_GPU_CAP_GIB = "13.44";
    expect(fitMachine(123)).toEqual({
      ramBytes: 16 * GIB,
      gpuCapBytes: Math.round(13.44 * GIB),
    });
  });

  it("ignores a value that is not a positive number", () => {
    process.env.OPENSTYLE_MLX_LLM_FIT_RAM_GIB = "lots";
    process.env.OPENSTYLE_MLX_LLM_FIT_GPU_CAP_GIB = "-1";
    expect(fitMachine(7).gpuCapBytes).toBe(7);
  });
});

describe("GET /api/mlx-llm/status fit", () => {
  const app = createApp();

  afterEach(() => {
    delete process.env.OPENSTYLE_MLX_LLM_FIT_RAM_GIB;
    getDb().prepare("DELETE FROM model_configs WHERE type = 'voice'").run();
  });

  async function statusLabels(): Promise<string[]> {
    const res = await app.request("/api/mlx-llm/status");
    const data = (await res.json()) as {
      models: Array<{ fit: { label: string; ramBytes: number } }>;
    };
    return data.models.map((m) => m.fit.label);
  }

  it("follows the selected voice model and the RAM override", async () => {
    process.env.OPENSTYLE_MLX_LLM_FIT_RAM_GIB = "16";
    // No voice model: no ASR worker in the budget.
    expect(await statusLabels()).toEqual([W, W, W, X, X]);
    getDb()
      .prepare(
        "INSERT INTO model_configs (provider, model_id, model_name, type, is_default) VALUES (?, ?, ?, 'voice', 1)",
      )
      .run("local-mlx", "local-mlx/qwen3-1.7b-8bit", "Qwen3 ASR 1.7B");
    // A local ASR model: the 16 GiB row of the table.
    expect(await statusLabels()).toEqual([W, T, W, X, X]);
  });
});
