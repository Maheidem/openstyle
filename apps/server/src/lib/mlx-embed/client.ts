import { z } from "zod";
import {
  EMBED_DOC_PROMPT,
  EMBED_QUERY_PROMPT,
  type MlxEmbedModelDef,
} from "./constants.js";
import {
  ensureMlxEmbedWorker,
  getSearchEmbeddingModelId,
  trackMlxEmbedFetch,
} from "./server.js";

// The server client of the embedding worker (specs/local-semantic-search.md
// 5.4). It adds the prompts (D9, S10), sends batches to POST /v1/embeddings
// and checks the reply. The int8 quantization (S6) is the indexer's job (#86).
// Plain fetch with a Zod check: there is no structured output and no retry
// ladder to reuse from the AI SDK.

export type EmbedKind = "document" | "query";

/** Inputs per request. One batch takes about 80 ms on an M5 Max (#233 spike). */
export const EMBED_BATCH = 16;

export type EmbedErrorKind = "no_model" | "embed_failed" | "embed_bad_response";

export class EmbedError extends Error {
  constructor(
    readonly kind: EmbedErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "EmbedError";
  }
}

const responseSchema = z.object({
  data: z.array(
    z.object({ index: z.number().int(), embedding: z.array(z.number()) }),
  ),
  openstyle: z.object({ tokens: z.array(z.number().int()) }).optional(),
});

export function promptFor(kind: EmbedKind, text: string): string {
  return (kind === "query" ? EMBED_QUERY_PROMPT : EMBED_DOC_PROMPT) + text;
}

export interface EmbedResult {
  vectors: Float32Array[];
  /** Real token count of each input before truncation (0 when unknown). */
  tokens: number[];
  /** The catalog id of the model, stored with each vector (D4). */
  modelId: string;
}

async function embedBatch(
  baseURL: string,
  def: MlxEmbedModelDef,
  inputs: string[],
  signal?: AbortSignal,
): Promise<{ vectors: Float32Array[]; tokens: number[] }> {
  const res = await trackMlxEmbedFetch(fetch)(`${baseURL}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: def.hfId, input: inputs }),
    signal,
  });
  if (!res.ok) {
    throw new EmbedError(
      "embed_failed",
      `The embedding worker answered ${res.status}: ${await res.text()}`,
    );
  }
  const parsed = responseSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new EmbedError("embed_bad_response", parsed.error.message);
  }
  const rows = [...parsed.data.data].sort((a, b) => a.index - b.index);
  if (
    rows.length !== inputs.length ||
    rows.some((row, i) => row.index !== i || row.embedding.length !== def.dims)
  ) {
    throw new EmbedError(
      "embed_bad_response",
      `Expected ${inputs.length} vectors of ${def.dims} dims`,
    );
  }
  const tokens = parsed.data.openstyle?.tokens;
  return {
    vectors: rows.map((row) => Float32Array.from(row.embedding)),
    tokens: tokens?.length === inputs.length ? tokens : inputs.map(() => 0),
  };
}

/**
 * Embed `texts` with the search model: add the prompt of `kind`, send
 * batches of EMBED_BATCH, and check the count and the dims of each reply. A
 * bad reply is an error, never a partial result. `signal` is checked
 * between batches.
 */
export async function embedTexts(
  texts: string[],
  kind: EmbedKind,
  signal?: AbortSignal,
): Promise<EmbedResult> {
  const modelId = getSearchEmbeddingModelId();
  if (!modelId) {
    throw new EmbedError("no_model", "No search model is set up yet.");
  }
  const { baseURL, def } = await ensureMlxEmbedWorker(modelId);
  const out: EmbedResult = { vectors: [], tokens: [], modelId };
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    signal?.throwIfAborted();
    const batch = texts
      .slice(i, i + EMBED_BATCH)
      .map((t) => promptFor(kind, t));
    const { vectors, tokens } = await embedBatch(baseURL, def, batch, signal);
    out.vectors.push(...vectors);
    out.tokens.push(...tokens);
  }
  return out;
}
