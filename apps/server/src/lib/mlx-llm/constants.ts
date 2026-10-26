// The built-in local MLX LLM catalog (specs/local-mlx-llm.md section 1 and
// 3.1). Owner decision 2026-10-20: the catalog holds the two Gemma 4 models.
// Owner decision 2026-10-24: a third, optional model (Nemotron 3.5 Bolt E4B).
// Owner decision 2026-10-26: two large, optional models (Gemma 4 26B-A4B and
// Qwen3.8 27B) for better Summarize quality on Macs with 32 GB or more.
// The sizes are the sums of the files that match
// MLX_LLM_ALLOW_PATTERNS, from the HF API tree of each repo (2026-10-20).

/** The LLM provider id. No other provider id starts with it (registry prefix match). */
export const MLX_LLM_PROVIDER_ID = "local-mlx-llm";

export const MLX_LLM_PROVIDER_NAME = "On-device · MLX";

export const GIB = 1024 ** 3;

/**
 * The request header that turns on the worker prefix cache (value "on"). The
 * worker reads `X-Openstyle-Prefix-Cache` in scripts/mlx_asr_server.py.
 */
export const MLX_LLM_PREFIX_CACHE_HEADER = "X-Openstyle-Prefix-Cache";

/** `config.model_type` of the HF repo. The worker loads each with mlx-lm. */
export type MlxLlmFamily = "gemma4" | "qwen3_5";

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
  /**
   * P(model) of the fit label (specs/llm-runtime-tuning.md 5.1): the MLX peak
   * of a 28k-token Summarize plus the KV of 4.8k more tokens, rounded up to
   * 0.1 GiB. It is the MLX peak, not the RSS: RSS is lower for big models.
   */
  peakBytes: number;
  /** The default model. The fit label never shows it as "Won't fit". */
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
    peakBytes: Math.round(5.1 * GIB),
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
    peakBytes: Math.round(7.5 * GIB),
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
    peakBytes: Math.round(6.0 * GIB),
  },
  // License note (2026-10-26). The catalog has no license field (issue #331).
  // - Quant repo (mlx-community): its card has no license field.
  // - Google source repo google/gemma-4-26B-A4B-it: license "apache-2.0",
  //   license link https://ai.google.dev/gemma/docs/gemma_4_license. The two
  //   values differ, so this needs a legal read (not done), as for E2B and E4B.
  // Peak worker RSS is about 14.8 GiB (overnight eval 2026-10-25).
  {
    id: "gemma-4-26b-a4b-qat-4bit",
    hfId: "mlx-community/gemma-4-26B-A4B-it-qat-4bit",
    displayName: "Gemma 4 26B-A4B",
    family: "gemma4",
    sizeBytes: 15_641_239_295,
    contextTokens: 32_768,
    maxOutputTokens: 8_192,
    peakBytes: Math.round(16.3 * GIB),
  },
  // License note (2026-10-26). The catalog has no license field (issue #331).
  // - Quant repo (mlx-community): license "apache-2.0", base model
  //   Qwen/Qwen3.8-27B.
  // - Qwen source repo Qwen/Qwen3.8-27B: license "apache-2.0" (card and
  //   LICENSE file, https://huggingface.co/Qwen/Qwen3.8-27B).
  // The worker turns thinking off: the chat template gets
  // enable_thinking=false and the answer drops an empty <think> block.
  {
    id: "qwen3.8-27b-4bit",
    hfId: "mlx-community/Qwen3.8-27B-4bit",
    displayName: "Qwen3.8 27B",
    family: "qwen3_5",
    sizeBytes: 16_081_488_731,
    contextTokens: 32_768,
    maxOutputTokens: 8_192,
    peakBytes: Math.round(18.7 * GIB),
  },
];

export function getMlxLlmModel(id: string): MlxLlmModelDef | undefined {
  return MLX_LLM_MODELS.find((m) => m.id === id);
}
