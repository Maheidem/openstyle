import { getMlxLlmModel, MLX_LLM_PROVIDER_ID } from "../mlx-llm/constants.js";
import { stripModelPrefix } from "../model-id.js";
import { getModelContextCached } from "../model-registry.js";

// The context guard of every LLM caller (specs/llm-runtime-tuning.md 7 step 4
// and 9 item 5). A caller keeps `prompt tokens + max_tokens` at or under the
// context window of the model before it sends. A refusal from the model is a
// fault of the app, so the guard uses an estimate that is high, not low.
//
// Why an estimate and not the tokenizer: the server has no tokenizer, and the
// MLX worker has no tokenize endpoint. A request to count tokens would also
// add a round trip to each dictation. The estimate below is calibrated on the
// real tokenizers of the 5 catalog models (2026-10-26, fictional texts in 13
// languages and 7 app locales). For natural text it is 1.15x to 1.71x the
// real count (English 1.22x, Chinese 1.39x, Japanese 1.61x). The old
// `chars / 4` estimate was 0.37x to 1.01x (Chinese 0.39x). A long run of
// digits or hex is the only measured case under the real count (0.83x). The
// worker refusal (ContextExceededError) covers that case.

/** Chat template tokens of one call (turn markers, BOS). Measured: about 10. */
export const CALL_OVERHEAD_TOKENS = 32;
/** Chat template tokens of one message. */
export const MESSAGE_OVERHEAD_TOKENS = 8;

/**
 * An estimate of the tokens of `text` that is high for natural text in every
 * measured language. Weights per UTF-16 code unit: ASCII 1/3, an ASCII digit
 * 1, Latin, Greek, Cyrillic, Hebrew and Arabic 1/2, any other character
 * (CJK, Hangul, kana, Devanagari, Thai and others) 1, each half of a
 * surrogate pair (emoji) 1.
 */
export function estimatePromptTokens(text: string): number {
  let ascii = 0;
  let half = 0;
  let full = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) {
      if (c >= 0x30 && c <= 0x39) full++;
      else ascii++;
    } else if (c <= 0x024f || (c >= 0x0370 && c <= 0x06ff)) half++;
    else full++;
  }
  return Math.ceil(ascii / 3 + half / 2 + full);
}

/** The estimated prompt tokens of one chat call. */
export function estimateCallTokens(call: {
  instructions: string;
  messages: readonly { content: string }[];
}): number {
  let sum = CALL_OVERHEAD_TOKENS + estimatePromptTokens(call.instructions);
  for (const m of call.messages) {
    sum += MESSAGE_OVERHEAD_TOKENS + estimatePromptTokens(m.content);
  }
  return sum;
}

/** True when the call fits the window. `contextWindow` null: always true. */
export function fitsWindow(
  promptTokens: number,
  maxOutputTokens: number,
  contextWindow: number | null,
): boolean {
  if (contextWindow === null) return true;
  return promptTokens + maxOutputTokens <= contextWindow;
}

/**
 * The context window of a model, with no network call: the catalog of the
 * local MLX LLM, else the cached models.dev entry. null when it is not known
 * (an own server, or a cold models.dev cache). Then no guard runs, and only a
 * refusal from the provider starts a split.
 */
export function contextWindowFor(
  provider: string,
  modelId: string,
): number | null {
  if (provider === MLX_LLM_PROVIDER_ID) {
    return (
      getMlxLlmModel(stripModelPrefix(provider, modelId))?.contextTokens ?? null
    );
  }
  return getModelContextCached(provider, modelId);
}

const PARAGRAPH = /\n\s*\n/;
const LINE = /\n/;
// A sentence end: Latin punctuation and a space, or CJK punctuation.
const SENTENCE = /(?<=[.!?…])\s+|(?<=[。！？])/;
const SPACE = /\s+/;

/** Split `text` at the first separator that gives two or more parts. */
function splitOnce(text: string): string[] {
  for (const re of [PARAGRAPH, LINE, SENTENCE, SPACE]) {
    const parts = splitKeep(text, re);
    if (parts.length > 1) return parts;
  }
  // One long word: cut it in two halves.
  const mid = Math.ceil(text.length / 2);
  return [text.slice(0, mid), text.slice(mid)];
}

/** Split and keep each separator at the end of the part before it. */
function splitKeep(text: string, re: RegExp): string[] {
  const global = new RegExp(re.source, "g");
  const out: string[] = [];
  let last = 0;
  for (const m of text.matchAll(global)) {
    const end = (m.index ?? 0) + m[0].length;
    if (end <= last || end >= text.length) continue;
    out.push(text.slice(last, end));
    last = end;
  }
  out.push(text.slice(last));
  return out.filter((p) => p.length > 0);
}

/**
 * Cut `text` into pieces in order, each piece accepted by `fits`. The cuts
 * go at paragraph ends first, then line ends, sentence ends and spaces. Each
 * piece keeps the separator that follows it, so `pieces.join("")` is `text`.
 * A text that fits gives one piece: the text itself.
 */
export function splitTextToFit(
  text: string,
  fits: (piece: string) => boolean,
): string[] {
  if (fits(text) || text.length < 2) return [text];
  const out: string[] = [];
  let cur = "";
  for (const part of splitOnce(text)) {
    if (cur && fits(cur + part)) {
      cur += part;
      continue;
    }
    if (cur) out.push(cur);
    if (fits(part)) cur = part;
    else {
      out.push(...splitTextToFit(part, fits));
      cur = "";
    }
  }
  if (cur) out.push(cur);
  return out;
}
