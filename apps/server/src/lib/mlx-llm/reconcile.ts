import { createAppLogger } from "@openstyle/utils";
import { getDb } from "../db.js";
import { MLX_LLM_MODELS, MLX_LLM_PROVIDER_ID } from "./constants.js";

const log = createAppLogger("mlx-llm");

/**
 * Delete the model rows of local MLX LLM models that are no longer in the
 * catalog (the Qwen3.5 models left it on 2026-10-20). A stale default then
 * reads as "no AI model", and the person picks a model again under Models.
 * Without this, every call failed with "Unknown local MLX LLM model".
 */
export function reconcileRemovedMlxLlmModels(): boolean {
  const known = MLX_LLM_MODELS.map((m) => `${MLX_LLM_PROVIDER_ID}/${m.id}`);
  const result = getDb()
    .prepare(
      `DELETE FROM model_configs WHERE type = 'llm' AND provider = ? AND model_id NOT IN (${known.map(() => "?").join(", ")})`,
    )
    .run(MLX_LLM_PROVIDER_ID, ...known);
  if (result.changes === 0) return false;
  log.info(
    `Removed ${result.changes} model row(s) of local LLM models that left the catalog`,
  );
  return true;
}
