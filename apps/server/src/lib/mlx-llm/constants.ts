// The built-in local MLX LLM catalog (specs/local-mlx-llm.md section 1 and
// 3.1). The sizes are the sums of the files that match
// MLX_LLM_ALLOW_PATTERNS, from the HF API tree of each repo (2026-10-20).

/** The LLM provider id. No other provider id starts with it (registry prefix match). */
export const MLX_LLM_PROVIDER_ID = "local-mlx-llm";

export const MLX_LLM_PROVIDER_NAME = "On-device · MLX";

export type MlxLlmFamily = "qwen3_5" | "gemma4";

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
    id: "qwen3.5-0.8b-8bit",
    hfId: "mlx-community/Qwen3.5-0.8B-8bit",
    displayName: "Qwen3.5 0.8B",
    family: "qwen3_5",
    sizeBytes: 1_027_974_615,
    contextTokens: 32_768,
    maxOutputTokens: 8_192,
  },
  {
    id: "qwen3.5-4b-optiq-4bit",
    hfId: "mlx-community/Qwen3.5-4B-OptiQ-4bit",
    displayName: "Qwen3.5 4B",
    family: "qwen3_5",
    sizeBytes: 3_289_851_461,
    contextTokens: 32_768,
    maxOutputTokens: 8_192,
    recommended: true,
  },
  {
    id: "qwen3.5-9b-6bit",
    hfId: "mlx-community/Qwen3.5-9B-6bit",
    displayName: "Qwen3.5 9B",
    family: "qwen3_5",
    sizeBytes: 8_215_256_416,
    contextTokens: 32_768,
    maxOutputTokens: 8_192,
  },
  {
    id: "gemma-4-e2b-qat-4bit",
    hfId: "mlx-community/gemma-4-E2B-it-qat-4bit",
    displayName: "Gemma 4 E2B",
    family: "gemma4",
    sizeBytes: 4_361_680_121,
    contextTokens: 32_768,
    maxOutputTokens: 8_192,
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
];

export function getMlxLlmModel(id: string): MlxLlmModelDef | undefined {
  return MLX_LLM_MODELS.find((m) => m.id === id);
}
