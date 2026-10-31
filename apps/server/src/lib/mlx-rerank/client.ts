import { z } from "zod";
import {
  getMlxRerankModel,
  MLX_RERANK_MODEL_ID,
  RERANK_BATCH,
} from "./constants.js";
import { isMlxRerankModelDownloaded } from "./models.js";
import { ensureMlxRerankWorker, trackMlxRerankFetch } from "./server.js";

// The server client of the reranker worker. It sends the pairs to
// POST /v1/rerank and checks the reply. Plain fetch with a Zod check, like
// the embed client.

export type RerankErrorKind =
  | "no_model"
  | "rerank_failed"
  | "rerank_bad_response";

export class RerankError extends Error {
  constructor(
    readonly kind: RerankErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "RerankError";
  }
}

const responseSchema = z.object({
  scores: z.array(z.number()),
  ms: z.number().optional(),
});

/**
 * Score each document against the query. Returns one score per document, in
 * the order of `documents`; a higher score is a better match (0..1, the
 * probability of "yes"). Throws a RerankError with kind "no_model" when the
 * model is not on disk or the worker cannot start, so the caller can fall
 * back to the fused order.
 */
export async function rerankPairs(
  query: string,
  documents: readonly string[],
  signal?: AbortSignal,
  batch: number = RERANK_BATCH,
): Promise<number[]> {
  if (documents.length === 0) return [];
  const def = getMlxRerankModel(MLX_RERANK_MODEL_ID);
  if (!def || !isMlxRerankModelDownloaded(def)) {
    throw new RerankError("no_model", "The reranker model is not downloaded.");
  }
  signal?.throwIfAborted();
  let baseURL: string;
  try {
    ({ baseURL } = await ensureMlxRerankWorker(def.id));
  } catch (err) {
    throw new RerankError(
      "no_model",
      `The reranker worker did not start: ${(err as Error).message}`,
    );
  }
  const res = await trackMlxRerankFetch(fetch)(`${baseURL}/rerank`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, documents, batch }),
    signal,
  });
  if (!res.ok) {
    throw new RerankError(
      "rerank_failed",
      `The reranker worker answered ${res.status}: ${await res.text()}`,
    );
  }
  const parsed = responseSchema.safeParse(await res.json());
  if (!parsed.success || parsed.data.scores.length !== documents.length) {
    throw new RerankError(
      "rerank_bad_response",
      `Expected ${documents.length} scores`,
    );
  }
  if (parsed.data.scores.some((s) => !Number.isFinite(s))) {
    throw new RerankError("rerank_bad_response", "A score is not finite");
  }
  return parsed.data.scores;
}
