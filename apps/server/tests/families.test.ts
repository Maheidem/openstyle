import { describe, expect, it } from "vitest";
import {
  FAMILIES_FOR_WORKER_SPEC,
  isNotTranscriber,
  missingFamilyFiles,
  resolveSttFamily,
  SUPPORTED_STT_FAMILIES,
} from "../src/lib/mlx-asr/families.js";
import { MLX_WORKER_BUILD_SPEC } from "../src/lib/mlx-asr/runtime.js";

describe("FAMILIES_FOR_WORKER_SPEC", () => {
  it("matches the worker build spec the allowlist was reviewed against", () => {
    // Fails after a worker upgrade. Re-check families.ts, then update both.
    expect(FAMILIES_FOR_WORKER_SPEC).toBe(MLX_WORKER_BUILD_SPEC);
  });
});

describe("SUPPORTED_STT_FAMILIES", () => {
  it("holds the v1 allowlist in the curated family spelling", () => {
    expect(
      Object.fromEntries(
        Object.entries(SUPPORTED_STT_FAMILIES).map(([key, v]) => [
          key,
          v.family,
        ]),
      ),
    ).toEqual({
      qwen3_asr: "qwen3-asr",
      sensevoice: "sensevoice",
      parakeet: "parakeet",
      whisper: "whisper",
    });
  });
});

describe("missingFamilyFiles", () => {
  const family = (key: string) => {
    const def = SUPPORTED_STT_FAMILIES[key];
    if (!def) throw new Error(`no family ${key}`);
    return def;
  };

  // File lists of the curated repos (HF API, 2026-10-04). The rule must not
  // reject any of them.
  it.each([
    [
      "qwen3_asr",
      "mlx-community/Qwen3-ASR-0.6B-8bit",
      [
        ".gitattributes",
        "README.md",
        "chat_template.json",
        "config.json",
        "generation_config.json",
        "merges.txt",
        "model.safetensors",
        "model.safetensors.index.json",
        "preprocessor_config.json",
        "tokenizer_config.json",
        "vocab.json",
      ],
    ],
    [
      "sensevoice",
      "mlx-community/SenseVoiceSmall",
      [
        ".gitattributes",
        "README.md",
        "am.mvn",
        "chn_jpn_yue_eng_ko_spectok.bpe.model",
        "config.json",
        "model.safetensors",
      ],
    ],
    [
      "parakeet",
      "mlx-community/parakeet-tdt-0.6b-v3",
      [
        ".gitattributes",
        "README.md",
        "config.json",
        "model.safetensors",
        "tokenizer.model",
        "tokenizer.vocab",
        "vocab.txt",
      ],
    ],
    [
      "whisper",
      "mlx-community/whisper-tiny-asr-fp16",
      [
        "added_tokens.json",
        "config.json",
        "generation_config.json",
        "merges.txt",
        "model.safetensors",
        "model.safetensors.index.json",
        "normalizer.json",
        "preprocessor_config.json",
        "special_tokens_map.json",
        "tokenizer.json",
        "tokenizer_config.json",
        "vocab.json",
      ],
    ],
  ])("finds nothing missing in %s repo %s", (key, _repo, files) => {
    expect(missingFamilyFiles(family(key), files)).toEqual([]);
  });

  it.each([
    [
      "mlx-community/whisper-tiny.en-8bit",
      ["config.json", "gpt2.tiktoken", "model.safetensors"],
    ],
    ["mlx-community/whisper-small-mlx", ["config.json", "weights.npz"]],
    [
      "mlx-community/whisper-large-v3-turbo",
      ["config.json", "weights.safetensors"],
    ],
  ])("lists both processor files for the whisper repo %s", (_repo, files) => {
    expect(missingFamilyFiles(family("whisper"), files)).toEqual([
      "preprocessor_config.json",
      "tokenizer.json",
    ]);
  });

  it("shows a group of alternatives as one entry", () => {
    expect(missingFamilyFiles(family("sensevoice"), ["config.json"])).toEqual([
      "chn_jpn_yue_eng_ko_spectok.bpe.model or tokens.json",
    ]);
    expect(missingFamilyFiles(family("sensevoice"), ["tokens.json"])).toEqual(
      [],
    );
  });

  it("counts only the exact top-level name", () => {
    expect(
      missingFamilyFiles(family("whisper"), [
        "sub/preprocessor_config.json",
        "tokenizer.json.bak",
      ]),
    ).toEqual(["preprocessor_config.json", "tokenizer.json"]);
  });
});

describe("resolveSttFamily", () => {
  it("uses model_type for a repo that is its own key", () => {
    expect(
      resolveSttFamily({ model_type: "qwen3_asr" }, "Qwen3-ASR-0.6B-8bit"),
    ).toBe("qwen3_asr");
  });

  it("maps the parakeet_tdt alias to parakeet", () => {
    expect(
      resolveSttFamily({ model_type: "parakeet_tdt" }, "parakeet-tdt-0.6b-v3"),
    ).toBe("parakeet");
    // The alias holds even when the name points elsewhere.
    expect(
      resolveSttFamily({ model_type: "parakeet_tdt" }, "my-whisper-copy"),
    ).toBe("parakeet");
  });

  it("falls back to the name when config has no model_type", () => {
    expect(resolveSttFamily({}, "parakeet-tdt-0.6b-v3")).toBe("parakeet");
  });

  it("reads the architecture key when model_type is missing", () => {
    expect(resolveSttFamily({ architecture: "sensevoice" }, "x-model")).toBe(
      "sensevoice",
    );
  });

  it("keeps whisper for a whisper repo", () => {
    expect(
      resolveSttFamily({ model_type: "whisper" }, "whisper-tiny-asr-fp16"),
    ).toBe("whisper");
  });

  it("lets a name part override model_type", () => {
    expect(
      resolveSttFamily({ model_type: "whisper" }, "whisper-x-canary"),
    ).toBe("canary");
  });

  it("lets the last stt dir in the name win", () => {
    // nemo, wav2vec and whisper are dirs but not remapping keys.
    expect(
      resolveSttFamily({ model_type: "foo" }, "nemo-wav2vec-whisper-tune"),
    ).toBe("whisper");
    expect(resolveSttFamily({ model_type: "foo" }, "whisper-nemo-tune")).toBe(
      "nemo",
    );
  });

  it("ends the scan at a remapping key", () => {
    // "parakeet" is a remapping key, so the later "whisper" part is not read.
    expect(
      resolveSttFamily({ model_type: "whisper" }, "parakeet-whisper-mix"),
    ).toBe("parakeet");
    // "glm" remaps to glmasr, which stops the scan too.
    expect(resolveSttFamily({ model_type: "whisper" }, "whisper-glm-x")).toBe(
      "glmasr",
    );
  });

  it("finds a dir name that spans dash parts", () => {
    expect(resolveSttFamily({ model_type: "x" }, "qwen3-asr-1.7b")).toBe(
      "qwen3_asr",
    );
  });

  it("does not scan when model_type is an identity key", () => {
    expect(
      resolveSttFamily({ model_type: "qwen3_asr" }, "whisper-qwen3-asr-tuned"),
    ).toBe("qwen3_asr");
  });

  it("resolves a TTS repo to a key outside the allowlist", () => {
    const key = resolveSttFamily({}, "Kokoro-82M-bf16");
    expect(key).toBe("kokoro");
    expect(Object.hasOwn(SUPPORTED_STT_FAMILIES, key ?? "")).toBe(false);
  });

  it("maps a Phonon config to phonon", () => {
    expect(
      resolveSttFamily({ config_schema: "fermion.phonon/1" }, "some-model"),
    ).toBe("phonon");
  });

  it("does not trip on a prototype key in the repo name", () => {
    expect(resolveSttFamily({ model_type: "whisper" }, "constructor-x")).toBe(
      "whisper",
    );
  });
});

describe("isNotTranscriber", () => {
  it("flags the non-transcriber families", () => {
    expect(isNotTranscriber("moss_music", {}, "x")).toBe(true);
    expect(isNotTranscriber("phonon", {}, "x")).toBe(true);
    expect(isNotTranscriber("whisper", {}, "whisper-tiny")).toBe(false);
  });

  it("flags a Qwen3 forced aligner by timestamp_token_id", () => {
    const config = { model_type: "qwen3_asr", timestamp_token_id: 151_000 };
    expect(resolveSttFamily(config, "Qwen3-ForcedAligner-0.6B-8bit")).toBe(
      "qwen3_asr",
    );
    expect(isNotTranscriber("qwen3_asr", config, "model-without-hint")).toBe(
      true,
    );
  });

  it("flags a forced aligner by name", () => {
    expect(
      isNotTranscriber(
        "qwen3_asr",
        { model_type: "qwen3_asr" },
        "Qwen3-ForcedAligner-0.6B-8bit",
      ),
    ).toBe(true);
    expect(isNotTranscriber("qwen3_asr", {}, "my-aligner-v2")).toBe(true);
  });

  it("passes the real Qwen3 ASR config", () => {
    expect(
      isNotTranscriber(
        "qwen3_asr",
        { model_type: "qwen3_asr" },
        "Qwen3-ASR-0.6B-8bit",
      ),
    ).toBe(false);
  });
});
