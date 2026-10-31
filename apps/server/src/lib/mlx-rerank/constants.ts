// The built-in local MLX reranker (specs/meeting-chat-agent.md 7.4.3, owner
// decision 2026-10-31): Qwen3-Reranker-0.6B, Apache-2.0, not gated. The chat
// agent scores the top candidates of the hybrid search with it.

/** The model id of the reranker. */
export const MLX_RERANK_MODEL_ID = "qwen3-reranker-0.6b";

/**
 * Candidates that go to the reranker. P0 chose 15 (one forward pass per pair).
 * With batched forward passes (RERANK_BATCH) the P1 run measured 30 candidates
 * at an added p95 under 400 ms, and the owner rule (spec 7.4.3) is: switch to
 * 30 then. This is the one place of the default.
 */
export const RERANK_CANDIDATES = 30;

/**
 * Pairs per forward pass of the worker. The P1 run measured the added time of
 * several batch sizes (scripts/chat-eval/retrieve-prod.mts); this is the chosen
 * value.
 */
export const RERANK_BATCH = 8;

export interface MlxRerankModelDef {
  id: string;
  /** Hugging Face repo id passed to the worker as `--model <hfId>`. */
  hfId: string;
  /** The pinned commit. The download and the worker use only this snapshot. */
  revision: string;
  displayName: string;
  /** The sum of the files that match MLX_RERANK_ALLOW_PATTERNS at `revision`. */
  sizeBytes: number;
}

/** The files that the worker loads. The download skips README and the templates. */
export const MLX_RERANK_ALLOW_PATTERNS: readonly string[] = [
  "config.json",
  "generation_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "vocab.json",
  "merges.txt",
  "model.safetensors",
];

export const MLX_RERANK_MODELS: readonly MlxRerankModelDef[] = [
  {
    id: MLX_RERANK_MODEL_ID,
    hfId: "Qwen/Qwen3-Reranker-0.6B",
    // The commit that the P0 run measured (refs/main on 2026-10-31).
    revision: "e61197ed45024b0ed8a2d74b80b4d909f1255473",
    displayName: "Qwen3 Reranker 0.6B",
    // File sizes of the snapshot that the P0 run downloaded.
    sizeBytes: 1_207_470_267,
  },
];

export function getMlxRerankModel(id: string): MlxRerankModelDef | undefined {
  return MLX_RERANK_MODELS.find((m) => m.id === id);
}
