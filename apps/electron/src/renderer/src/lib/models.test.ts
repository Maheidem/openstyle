import { describe, expect, it } from "vitest";
import {
  buildLocalLlmItems,
  fallbackAfterDelete,
  formatMemoryGb,
  hiddenByFit,
  type MlxLlmFit,
  type MlxLlmStatus,
} from "./models";

const GIB = 1024 ** 3;

function fit(label: MlxLlmFit["label"]): MlxLlmFit {
  return {
    label,
    raised: false,
    peakBytes: 7.5 * GIB,
    ramBytes: 16 * GIB,
    budgetBytes: 8.79 * GIB,
    gpuCapBytes: null,
  };
}

function status(platformSupported: boolean): MlxLlmStatus {
  return {
    platformSupported,
    blockedReason: null,
    runtime: { available: true, downloading: false, url: null },
    keepAliveMinutes: 5,
    models: [
      {
        model: "gemma-4-e2b-qat-4bit",
        hfId: "mlx-community/gemma-4-E2B-it-qat-4bit",
        displayName: "Gemma 4 E2B",
        family: "gemma4",
        sizeBytes: 4_361_680_121,
        contextTokens: 32_768,
        maxOutputTokens: 8_192,
        recommended: true,
        status: "ready",
        fit: fit("runs_well"),
      },
      {
        model: "gemma-4-e4b-qat-4bit",
        hfId: "mlx-community/gemma-4-E4B-it-qat-4bit",
        displayName: "Gemma 4 E4B",
        family: "gemma4",
        sizeBytes: 6_830_817_013,
        contextTokens: 32_768,
        maxOutputTokens: 8_192,
        recommended: false,
        status: "not_downloaded",
        fit: fit("tight"),
      },
    ],
    worker: { model: null, state: "stopped", port: null },
  } as MlxLlmStatus;
}

describe("buildLocalLlmItems", () => {
  it("returns no rows when the Mac cannot run MLX", () => {
    expect(buildLocalLlmItems(status(false), undefined)).toEqual([]);
    expect(buildLocalLlmItems(null, undefined)).toEqual([]);
  });

  it("keys each row by the provider model id and keeps the badge", () => {
    const items = buildLocalLlmItems(status(true), undefined);
    expect(items.map((it) => it.key)).toEqual([
      "local-mlx-llm/gemma-4-e2b-qat-4bit",
      "local-mlx-llm/gemma-4-e4b-qat-4bit",
    ]);
    expect(items.map((it) => it.recommended)).toEqual([true, false]);
    expect(items.every((it) => !it.selected)).toBe(true);
  });

  it("selects the row of the default LLM only", () => {
    const items = buildLocalLlmItems(status(true), {
      provider: "local-mlx-llm",
      model_id: "local-mlx-llm/gemma-4-e2b-qat-4bit",
    });
    expect(items.map((it) => it.selected)).toEqual([true, false]);
    const other = buildLocalLlmItems(status(true), {
      provider: "server",
      model_id: "local-mlx-llm/gemma-4-e2b-qat-4bit",
    });
    expect(other.some((it) => it.selected)).toBe(false);
  });
});

describe("fit label helpers (specs/llm-runtime-tuning.md 5)", () => {
  it("passes the fit of each model to its row", () => {
    const items = buildLocalLlmItems(status(true), undefined);
    expect(items.map((it) => it.fit.label)).toEqual(["runs_well", "tight"]);
  });

  it("hides only a Won't fit row that is not on disk and not selected", () => {
    const row = (
      label: MlxLlmFit["label"],
      rowStatus: Parameters<typeof hiddenByFit>[0]["status"],
      selected = false,
    ) => hiddenByFit({ fit: fit(label), status: rowStatus, selected });
    expect(row("wont_fit", "not_downloaded")).toBe(true);
    // On disk, downloading, failed or selected: the row stays, so it can be deleted.
    expect(row("wont_fit", "ready")).toBe(false);
    expect(row("wont_fit", "downloading")).toBe(false);
    expect(row("wont_fit", "error")).toBe(false);
    expect(row("wont_fit", "not_downloaded", true)).toBe(false);
    expect(row("tight", "not_downloaded")).toBe(false);
    expect(row("runs_well", "not_downloaded")).toBe(false);
  });

  it("shows memory as Apple names it (GiB as GB)", () => {
    expect(formatMemoryGb(16 * GIB)).toBe("16");
    expect(formatMemoryGb(Math.round(5.1 * GIB), 1)).toBe("5.1");
    expect(formatMemoryGb(Math.round(18.7 * GIB), 1)).toBe("18.7");
  });
});

describe("fallbackAfterDelete", () => {
  const E2B = "local-mlx-llm/gemma-4-e2b-qat-4bit";
  const E4B = "local-mlx-llm/gemma-4-e4b-qat-4bit";
  const items = (e2bStatus: string) => [
    { key: E2B, name: "Gemma 4 E2B", status: e2bStatus },
    { key: E4B, name: "Gemma 4 E4B", status: "ready" },
  ];

  it("names the recommended model when it is on disk", () => {
    expect(fallbackAfterDelete(items("ready"), E2B, E4B)).toBe("Gemma 4 E2B");
  });

  it("is null when the recommended model is not on disk", () => {
    expect(fallbackAfterDelete(items("not_downloaded"), E2B, E4B)).toBeNull();
  });

  it("is null when the deleted model is the recommended model", () => {
    expect(fallbackAfterDelete(items("ready"), E2B, E2B)).toBeNull();
  });

  it("is null when the type has no recommended model", () => {
    expect(fallbackAfterDelete(items("ready"), undefined, E4B)).toBeNull();
  });
});
