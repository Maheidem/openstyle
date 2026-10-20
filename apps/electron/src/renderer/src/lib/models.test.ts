import { describe, expect, it } from "vitest";
import { buildLocalLlmItems, type MlxLlmStatus } from "./models";

function status(platformSupported: boolean): MlxLlmStatus {
  return {
    platformSupported,
    blockedReason: null,
    runtime: { available: true, downloading: false, url: null },
    keepAliveMinutes: 5,
    models: [
      {
        model: "qwen3.5-4b-4bit",
        hfId: "mlx-community/Qwen3.5-4B-4bit",
        displayName: "Qwen3.5 4B",
        family: "qwen3_5",
        sizeBytes: 3_061_130_647,
        contextTokens: 32_768,
        maxOutputTokens: 8_192,
        recommended: true,
        status: "ready",
      },
      {
        model: "gemma-4-e2b-4bit",
        hfId: "mlx-community/gemma-4-e2b-it-4bit",
        displayName: "Gemma 4 E2B",
        family: "gemma4",
        sizeBytes: 3_583_088_661,
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
      "local-mlx-llm/qwen3.5-4b-4bit",
      "local-mlx-llm/gemma-4-e2b-4bit",
    ]);
    expect(items.map((it) => it.recommended)).toEqual([true, false]);
    expect(items.every((it) => !it.selected)).toBe(true);
  });

  it("selects the row of the default LLM only", () => {
    const items = buildLocalLlmItems(status(true), {
      provider: "local-mlx-llm",
      model_id: "local-mlx-llm/qwen3.5-4b-4bit",
    });
    expect(items.map((it) => it.selected)).toEqual([true, false]);
    const other = buildLocalLlmItems(status(true), {
      provider: "server",
      model_id: "local-mlx-llm/qwen3.5-4b-4bit",
    });
    expect(other.some((it) => it.selected)).toBe(false);
  });
});
