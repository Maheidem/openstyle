// The built-in local MLX embedding model catalog (specs/local-semantic-search.md
// 5.3, owner decisions D7, D19, D20). Every Mac gets the bf16 text-only
// EmbeddingGemma 2 for now. A 4-bit model for 8 GB Macs comes only when a
// provider publishes a text-only 4-bit MLX repo (D20).

/** The embedding provider id. It is stored as the model id of each vector (D4). */
export const MLX_EMBED_PROVIDER_ID = "local-mlx-embed";

export interface MlxEmbedModelDef {
  /** Catalog id, stored as the model id of each vector (D4). */
  id: string;
  /** Hugging Face repo id passed to the worker as `--model <hfId>`. */
  hfId: string;
  /** The pinned commit. The download and the worker use only this snapshot. */
  revision: string;
  displayName: string;
  dims: 768;
  quant: "bf16" | "4bit";
  /** The sum of the files that match MLX_EMBED_ALLOW_PATTERNS at `revision`. */
  sizeBytes: number;
  /** true for a 4-bit text-only model for Macs with 8 GB RAM or less. */
  forLowMemory: boolean;
}

/**
 * The files that the embed worker loads: the config files (also the
 * sentence-transformers pooling and normalize configs), the weights and the
 * tokenizer. The download skips README, LICENSE, NOTICE and the chat template.
 */
export const MLX_EMBED_ALLOW_PATTERNS: readonly string[] = [
  "*.json",
  "model*.safetensors",
  "tokenizer.model",
];

/**
 * Document and query prompts of EmbeddingGemma 2 (D9, from the model's
 * `config_sentence_transformers.json`). The server adds them (spec S10). The
 * meeting title never goes in `title:`.
 */
export const EMBED_DOC_PROMPT = "title: none | text: ";
export const EMBED_QUERY_PROMPT = "task: search result | query: ";

export const MLX_EMBED_MODELS: readonly MlxEmbedModelDef[] = [
  {
    id: "embeddinggemma-2-bf16-text",
    // Text tower only (413 tensors, 0.542 GB), Apache-2.0, not gated. The
    // byte-equal mirror `gahabeen/embeddinggemma-2-text-270m-mlx-bf16`
    // (commit e51e6be543491ab3119cc54664e6a62b81a3af53, same LFS sha256
    // 7bb43077...) is the fallback source if this repo goes away (D19).
    hfId: "jayyun98/embeddinggemma-2-text-270m-mlx-bf16",
    revision: "186ecf2d29e743e0e9de0da677b13d54f76de6b3",
    displayName: "EmbeddingGemma 2",
    dims: 768,
    quant: "bf16",
    // HF API tree at the revision, read 2026-10-20.
    sizeBytes: 578_960_922,
    forLowMemory: false,
  },
];

export function getMlxEmbedModel(id: string): MlxEmbedModelDef | undefined {
  return MLX_EMBED_MODELS.find((m) => m.id === id);
}
