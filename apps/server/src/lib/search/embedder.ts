import { EmbedError, type EmbedKind, embedTexts } from "../mlx-embed/client.js";

// The int8 step of the search index (specs/local-semantic-search.md 5.4, S6,
// D16). The mlx-embed client adds the prompts and checks count and dims. This
// file turns its float vectors into the int8 vectors that vec0 stores.

/**
 * clamp(round(x * 127), -127, 127) on the L2-normalized vector (S6, D16). A
 * fixed scale, not vec_quantize_int8(): an index that grows one meeting at a
 * time cannot use a corpus-wide scale. A non-finite value is
 * `embed_bad_response`, never a write.
 */
export function quantizeInt8(v: Float32Array): Int8Array {
  let norm = 0;
  for (const x of v) {
    if (!Number.isFinite(x)) {
      throw new EmbedError("embed_bad_response", "The vector has NaN or Inf");
    }
    norm += x * x;
  }
  norm = Math.sqrt(norm);
  const scale = norm > 0 ? 127 / norm : 0;
  const out = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) {
    out[i] = Math.max(
      -127,
      Math.min(127, Math.round((v[i] as number) * scale)),
    );
  }
  return out;
}

export interface Int8EmbedResult {
  vectors: Int8Array[];
  tokens: number[];
  modelId: string;
}

/** Embed and quantize. One call to the client, which batches by 16. */
export async function embedInt8(
  texts: string[],
  kind: EmbedKind,
  signal?: AbortSignal,
): Promise<Int8EmbedResult> {
  const res = await embedTexts(texts, kind, signal);
  return {
    vectors: res.vectors.map(quantizeInt8),
    tokens: res.tokens,
    modelId: res.modelId,
  };
}
