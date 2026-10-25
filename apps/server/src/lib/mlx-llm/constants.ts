// The built-in local MLX LLM catalog (specs/local-mlx-llm.md section 1 and
// 3.1). Owner decision 2026-10-20: the catalog holds the two Gemma 4 models.
// Owner decision 2026-10-24: a third, optional model (Nemotron 3.5 Bolt E4B).
// The sizes are the sums of the files that match
// MLX_LLM_ALLOW_PATTERNS, from the HF API tree of each repo (2026-10-20).

/** The LLM provider id. No other provider id starts with it (registry prefix match). */
export const MLX_LLM_PROVIDER_ID = "local-mlx-llm";

export const MLX_LLM_PROVIDER_NAME = "On-device · MLX";

export type MlxLlmFamily =
  | "gemma4"
  // overnight sweep candidate 2026-10-25, not for release
  | "qwen3_5"
  | "qwen3_5_moe"
  | "mistral3"
  | "qwen3";

export interface MlxLlmModelDef {
  id: string;
  /** Hugging Face repo id passed to the worker as `--model <hfId>`. */
  hfId: string;
  displayName: string;
  family: MlxLlmFamily;
  sizeBytes: number;
  /** The context window the app plans with. */
  contextTokens: number;
  /** The output limit the app plans with. */
  maxOutputTokens: number;
  recommended?: boolean;
}

/**
 * The files that mlx-lm loads: `DEFAULT_ALLOW_PATTERNS` of mlx-lm 0.32.2
 * (`mlx_lm/utils.py`). The LLM download fetches only these files, so it skips
 * README files and extra weights such as `optiq/mtp.safetensors` and
 * `optiq_vision.safetensors`.
 */
export const MLX_LLM_ALLOW_PATTERNS: readonly string[] = [
  "*.json",
  "model*.safetensors",
  "*.py",
  "tokenizer.model",
  "*.tiktoken",
  "tiktoken.model",
  "*.txt",
  "*.jsonl",
  "*.jinja",
];

export const MLX_LLM_MODELS: readonly MlxLlmModelDef[] = [
  {
    id: "gemma-4-e2b-qat-4bit",
    hfId: "mlx-community/gemma-4-E2B-it-qat-4bit",
    displayName: "Gemma 4 E2B",
    family: "gemma4",
    sizeBytes: 4_361_680_121,
    contextTokens: 32_768,
    maxOutputTokens: 8_192,
    recommended: true,
  },
  {
    id: "gemma-4-e4b-qat-4bit",
    hfId: "mlx-community/gemma-4-E4B-it-qat-4bit",
    displayName: "Gemma 4 E4B",
    family: "gemma4",
    sizeBytes: 6_830_817_013,
    contextTokens: 32_768,
    maxOutputTokens: 8_192,
  },
  // License note (2026-10-25). The catalog has no license field.
  // - Quant repo (lmstudio-community): its card has no license field.
  // - NVIDIA source repo: license "other", name openmdw-1.1
  //   (https://openmdw.ai/license/1-1/), card
  //   https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Bolt-E4B-BF16
  // - That card names the base model google/gemma-4-E4B-it. The Gemma 4
  //   terms on top of OpenMDW-1.1 need a legal read (not done).
  // Owner decision 2026-10-25: Nemotron stays an option; Gemma E2B stays the default.
  {
    id: "nemotron-3.5-bolt-e4b-4bit",
    hfId: "lmstudio-community/NVIDIA-Nemotron-3.5-Bolt-E4B-MLX-4bit",
    displayName: "Nemotron 3.5 Bolt E4B",
    family: "gemma4",
    sizeBytes: 4_231_265_397,
    contextTokens: 32_768,
    maxOutputTokens: 8_192,
  },
  // overnight sweep candidate 2026-10-25, not for release
  {
    id: "qwen3.5-4b-4bit",
    hfId: "mlx-community/Qwen3.5-4B-MLX-4bit",
    displayName: "Qwen3.5 4B",
    family: "qwen3_5",
    sizeBytes: 3_061_129_077,
    contextTokens: 32_768,
    maxOutputTokens: 8_192,
  },
  // overnight sweep candidate 2026-10-25, not for release
  {
    id: "qwen3.5-9b-6bit",
    hfId: "mlx-community/Qwen3.5-9B-6bit",
    displayName: "Qwen3.5 9B",
    family: "qwen3_5",
    sizeBytes: 8_215_256_416,
    contextTokens: 32_768,
    maxOutputTokens: 8_192,
  },
  // overnight sweep candidate 2026-10-25, not for release
  {
    id: "qwen3.6-35b-a3b-4bit",
    hfId: "mlx-community/Qwen3.6-35B-A3B-4bit",
    displayName: "Qwen3.6 35B A3B",
    family: "qwen3_5_moe",
    sizeBytes: 20_429_166_969,
    contextTokens: 32_768,
    maxOutputTokens: 8_192,
  },
  // overnight sweep candidate 2026-10-25, not for release
  {
    id: "gemma-4-26b-a4b-qat-4bit",
    hfId: "mlx-community/gemma-4-26B-A4B-it-qat-4bit",
    displayName: "Gemma 4 26B A4B",
    family: "gemma4",
    sizeBytes: 15_641_239_295,
    contextTokens: 32_768,
    maxOutputTokens: 8_192,
  },
  // overnight sweep candidate 2026-10-25, not for release
  {
    id: "qwen3.6-27b-4bit",
    hfId: "mlx-community/Qwen3.6-27B-4bit",
    displayName: "Qwen3.6 27B",
    family: "qwen3_5",
    sizeBytes: 16_081_487_798,
    contextTokens: 32_768,
    maxOutputTokens: 8_192,
  },
  // overnight sweep candidate 2026-10-25, not for release
  {
    id: "mistral-small-3.2-24b-4bit",
    hfId: "mlx-community/Mistral-Small-3.2-24B-Instruct-2506-4bit",
    displayName: "Mistral Small 3.2 24B",
    family: "mistral3",
    sizeBytes: 13_277_585_038,
    contextTokens: 32_768,
    maxOutputTokens: 8_192,
  },
  // overnight sweep candidate 2026-10-25, not for release
  {
    id: "qwen3-8b-4bit",
    hfId: "mlx-community/Qwen3-8B-4bit",
    displayName: "Qwen3 8B",
    family: "qwen3",
    sizeBytes: 4_623_782_544,
    contextTokens: 32_768,
    maxOutputTokens: 8_192,
  },
];

export function getMlxLlmModel(id: string): MlxLlmModelDef | undefined {
  return MLX_LLM_MODELS.find((m) => m.id === id);
}
