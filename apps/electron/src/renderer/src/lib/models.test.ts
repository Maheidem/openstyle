import { describe, expect, it } from "vitest";
import {
  buildLocalLlmItems,
  fallbackAfterDelete,
  type MlxLlmStatus,
} from "./models";

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
