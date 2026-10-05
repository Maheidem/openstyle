import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { customModelFailureText } from "./custom-models";
import { buildVoiceItems, type MlxAsrStatus } from "./models";

const en = JSON.parse(
  readFileSync(new URL("../locales/en.json", import.meta.url), "utf8"),
) as { models: { custom: { errors: Record<string, string> } } };

// Codes of specs/custom-mlx-models.md section 6.3.
const CODES = [
  "invalid_input",
  "offline",
  "hf_error",
  "not_found",
  "gated",
  "no_config",
  "unsupported_family",
  "not_transcriber",
  "remote_code",
  "no_weights",
  "too_large",
  "no_disk",
  "already_added",
];

describe("customModelFailureText", () => {
  it.each(CODES)("maps %s to a key that exists in en.json", (code) => {
    const { key } = customModelFailureText({ code });
    expect(key).toBe(`models.custom.errors.${code}`);
    expect(en.models.custom.errors[code]).toBeTruthy();
  });

  it("maps an unknown code to the generic text", () => {
    const { key } = customModelFailureText({ code: "boom" });
    expect(key).toBe("models.custom.errors.unknown");
    expect(en.models.custom.errors.unknown).toBeTruthy();
  });

  it("passes the values the texts need", () => {
    const { values } = customModelFailureText({
      code: "no_disk",
      modelType: "kokoro",
      needBytes: 2_500_000_000,
      freeBytes: 1_200_000_000,
      totalBytes: 9_400_000_000,
    });
    expect(values).toEqual({
      type: "kokoro",
      need: "2.5",
      free: "1.2",
      size: "9.4",
    });
  });
});

describe("buildVoiceItems custom models", () => {
  const def = {
    hfId: "mlx-community/whisper-tiny-asr-fp16",
    family: "whisper",
    ramRequired: "~1 GB",
    speed: "",
    quality: "",
    quantized: false,
    sizeBytes: 78_774_283,
  };
  const mlxStatus: MlxAsrStatus = {
    platformSupported: true,
    canRun: true,
    blockedReason: null,
    keepAliveMinutes: 5,
    models: [],
    setupHint: null,
    modelDefinitions: [
      {
        ...def,
        id: "qwen3-0.6b-8bit",
        hfId: "mlx-community/Qwen3-ASR-0.6B-8bit",
        displayName: "Qwen3 0.6B",
        family: "qwen3-asr",
        custom: undefined,
      },
      {
        ...def,
        id: "custom--mlx-community--whisper-tiny-asr-fp16",
        displayName: "whisper-tiny-asr-fp16",
        custom: { revision: "77fa3f52", files: [] },
      },
    ],
  };

  it("marks only the custom definition and names its repo", () => {
    const items = buildVoiceItems([], null, mlxStatus, {
      keyProviders: new Set(),
    });
    const curated = items.find((i) => i.defId === "qwen3-0.6b-8bit");
    const custom = items.find((i) => i.defId?.startsWith("custom--"));
    expect(curated?.custom).toBe(false);
    expect(custom?.custom).toBe(true);
    expect(custom?.note).toBe("mlx-community/whisper-tiny-asr-fp16");
  });
});
