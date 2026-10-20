// The built-in local MLX LLM catalog (specs/local-mlx-llm.md section 1 and
// 3.1). The sizes are the repo totals from the HF API.

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

export const MLX_LLM_MODELS: readonly MlxLlmModelDef[] = [
  {
    id: "qwen3.5-0.8b-4bit",
    hfId: "mlx-community/Qwen3.5-0.8B-4bit",
    displayName: "Qwen3.5 0.8B",
    family: "qwen3_5",
    sizeBytes: 652_029_391,
    contextTokens: 32_768,
    maxOutputTokens: 8_192,
  },
  {
    id: "qwen3.5-4b-4bit",
    hfId: "mlx-community/Qwen3.5-4B-4bit",
    displayName: "Qwen3.5 4B",
    family: "qwen3_5",
    sizeBytes: 3_061_130_647,
    contextTokens: 32_768,
    maxOutputTokens: 8_192,
    recommended: true,
  },
  {
    id: "qwen3.5-9b-4bit",
    hfId: "mlx-community/Qwen3.5-9B-4bit",
    displayName: "Qwen3.5 9B",
    family: "qwen3_5",
    sizeBytes: 5_977_073_303,
    contextTokens: 32_768,
    maxOutputTokens: 8_192,
  },
  {
    id: "gemma-4-e2b-4bit",
    hfId: "mlx-community/gemma-4-e2b-it-4bit",
    displayName: "Gemma 4 E2B",
    family: "gemma4",
    sizeBytes: 3_583_088_661,
    contextTokens: 32_768,
    maxOutputTokens: 8_192,
  },
  {
    id: "gemma-4-e4b-4bit",
    hfId: "mlx-community/gemma-4-e4b-it-4bit",
    displayName: "Gemma 4 E4B",
    family: "gemma4",
    sizeBytes: 5_179_241_512,
    contextTokens: 32_768,
    maxOutputTokens: 8_192,
  },
];

export function getMlxLlmModel(id: string): MlxLlmModelDef | undefined {
  return MLX_LLM_MODELS.find((m) => m.id === id);
}
