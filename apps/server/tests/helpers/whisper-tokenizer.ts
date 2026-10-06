import { whisperProcessorSource } from "../../src/lib/mlx-asr/whisper-processor.js";

/**
 * A `tokenizer.json` with the shape that matters for the Whisper processor
 * fill-in: `model.vocab` and `added_tokens`. `overlap` added tokens are also
 * in the vocabulary, as `<|endoftext|>` is in the real files.
 */
export function fakeTokenizer(
  vocab: number,
  added: number,
  overlap: number,
): string {
  const entries: Record<string, number> = {};
  for (let i = 0; i < vocab; i++) entries[`t${i}`] = i;
  const addedTokens = Array.from({ length: added }, (_, i) => ({
    id: vocab + i,
    content: i < overlap ? `t${i}` : `<|a${i}|>`,
  }));
  return JSON.stringify({
    model: { vocab: entries },
    added_tokens: addedTokens,
  });
}

/**
 * The three real files, in the number of tokens that the transformers
 * tokenizer reports for them (checked with transformers 5.18.0).
 */
export const TOKENIZER_FOR_N_VOCAB = {
  51864: () => fakeTokenizer(50257, 1608, 1),
  51865: () => fakeTokenizer(50258, 1608, 1),
  51866: () => fakeTokenizer(50257, 1609, 0),
} as const;

/**
 * `body` as the pinned file of `url` would serve it: padded with spaces to the
 * pinned size, which stays valid JSON. Other URLs get `body` as it is.
 */
export function pinnedBody(url: string, body: string): string {
  for (const [n_vocab, n_mels] of [
    [51864, 80],
    [51865, 80],
    [51866, 128],
  ]) {
    const source = whisperProcessorSource({ n_vocab, n_mels }, []);
    if (!source || !url.includes(`/${source.repo}/resolve/`)) continue;
    const file = source.files.find((f) => url.endsWith(`/${f.path}`));
    if (file) return body.padEnd(file.size);
  }
  return body;
}
