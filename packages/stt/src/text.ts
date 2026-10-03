/** Remove a trailing paragraph duplicated from earlier in the output. */
export function stripTrailingDuplicate(text: string): string {
  const trimmed = text.trim();
  const parts = trimmed
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return trimmed;

  const last = parts[parts.length - 1]!;
  const earlier = parts.slice(0, -1).join("\n\n");
  if (last.length >= 12 && earlier.includes(last)) {
    return parts.slice(0, -1).join("\n\n");
  }
  return trimmed;
}

export function stripWrappingQuotes(text: string): string {
  const stripped = text.trim();
  if (
    stripped.length >= 2 &&
    stripped[0] === stripped.at(-1) &&
    (stripped[0] === '"' || stripped[0] === "'")
  ) {
    return stripped.slice(1, -1).trim();
  }
  return stripped;
}

function stripTrailingFinTags(text: string): string {
  return text.replace(/(?:\s*<\/?fin>\s*)+$/gi, "").trim();
}

/**
 * Collapse spurious line breaks emitted by local ASR engines.
 *
 * whisper.cpp and MLX ASR put each decoded speech segment on its own line, so
 * a single dictated paragraph comes back peppered with `\n` between segments.
 * Those breaks are decoder artifacts, not content, and an ASR-time prompt
 * cannot suppress them. Collapse single line breaks into spaces while keeping
 * blank-line paragraph breaks intact.
 */
export function collapseAsrLineBreaks(text: string): string {
  // Replace each run of whitespace that spans one or more line breaks with a
  // single space, unless the run contains a blank line (two or more breaks),
  // in which case keep a single paragraph break.
  return text.replace(/[^\S\n]*(?:\r?\n[^\S\n]*)+/g, (run) => {
    const breaks = (run.match(/\r?\n/g) ?? []).length;
    return breaks >= 2 ? "\n\n" : " ";
  });
}

const THINK_TAG = /<\s*\/?\s*think\s*>/i;
const THINK_BLOCK = /<\s*think\s*>[\s\S]*?<\s*\/\s*think\s*>/gi;
const THINK_UNCLOSED = /<\s*think\s*>[\s\S]*$/i;
const THINK_CLOSE = /<\s*\/\s*think\s*>/gi;

/**
 * Remove chain-of-thought a reasoning model emitted inline in its visible
 * output. Qwen and DeepSeek wrap it in `<think>…</think>`; servers normally
 * split that into a separate `reasoning_content` field, but the tags do leak
 * into `content`, and when they do the pair often arrives incomplete.
 *
 * Three shapes, stripped in this order so each pass only sees what the last
 * one left behind:
 *   1. complete `<think>…</think>` blocks, anywhere in the text;
 *   2. an opener with no closer — the model ran out of tokens mid-reasoning,
 *      so everything from the tag onwards is reasoning;
 *   3. a closer with no opener — the chat template emitted reasoning first and
 *      swallowed the opening tag, so everything up to it is reasoning.
 *
 * Text containing no such tag is returned byte-identical.
 */
export function stripThinkingBlocks(text: string): string {
  if (!THINK_TAG.test(text)) return text;

  let out = text.replace(THINK_BLOCK, "").replace(THINK_UNCLOSED, "");

  // Any `</think>` still standing has no opener left to match it.
  let lastEnd = -1;
  for (const match of out.matchAll(THINK_CLOSE)) {
    lastEnd = match.index + match[0].length;
  }
  if (lastEnd >= 0) out = out.slice(lastEnd);

  return out;
}

export function sanitizeTranscriptText(text: string): string {
  let cleaned = stripThinkingBlocks(text);
  cleaned = stripWrappingQuotes(cleaned);
  cleaned = stripTrailingFinTags(cleaned);
  return stripTrailingDuplicate(cleaned);
}

/** Lowercase, strip punctuation, collapse whitespace. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Token-based Jaccard similarity over normalized text. */
export function textSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeText(a).split(" ").filter(Boolean));
  const tb = new Set(normalizeText(b).split(" ").filter(Boolean));
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** Fraction of the text's distinct words that are vocabulary words. */
export const VOCAB_LEAK_OVERLAP_THRESHOLD = 0.6;

/**
 * True when a chunk of ASR output looks like the model echoed the
 * vocabulary-bias prompt back as fake speech, instead of transcribing real
 * audio. Provider-agnostic by design: the same prompt is sent as `prompt`
 * (omlx, whisper.cpp, local-mlx) or `context`/`keyterms` (deepgram,
 * elevenlabs, soniox) depending on provider (vocabulary-bias.ts), but the
 * leak always shows up the same way on the *output* side — text whose words
 * are overwhelmingly drawn from the vocabulary list, which real speech is
 * not. Strips the "Terms: " / "Technical terms: " prompt-boilerplate
 * prefixes before comparing, so a leak that echoes the label too still
 * matches on content, not the label.
 */
export function isVocabLeak(text: string, vocabTerms: string[]): boolean {
  if (vocabTerms.length === 0) return false;
  const norm = normalizeText(text).replace(/^(technical )?terms\s*/, "");
  const textTokens = new Set(norm.split(" ").filter(Boolean));
  if (textTokens.size === 0) return false;
  const termTokens = new Set(
    vocabTerms.flatMap((t) => normalizeText(t).split(" ")).filter(Boolean),
  );
  if (termTokens.size === 0) return false;
  let matched = 0;
  for (const tok of textTokens) if (termTokens.has(tok)) matched++;
  return matched / textTokens.size >= VOCAB_LEAK_OVERLAP_THRESHOLD;
}

/** Marks the "Terms:" / "Technical terms:" prompt-boilerplate label
 * (asr-bias.ts / vocabulary-bias.ts). The injected prompt always carries
 * this label, so a leak's onset is normally findable directly. */
const TERMS_MARKER = /\b(?:technical\s+)?terms:\s*/i;

/** A leak chunk shorter than this (in normalized tokens) is never flagged —
 * real speech that happens to be a couple of vocabulary words ("Claude
 * Code.") is common and indistinguishable from a leak at this length; the
 * actual ~80-term prompt echo is always far longer. Only applies to the
 * label-less fallback path below; the marker-anchored and single-chunk
 * checks have no such guard, matching {@link isVocabLeak}'s semantics. */
const MIN_LEAK_CHUNK_TOKENS = 4;

/**
 * Strip a vocabulary-bias prompt echo out of dictation output.
 *
 * Two passes:
 *
 * 1. Marker-anchored (the common case, matching the confirmed production
 *    incident): find the "Terms:"/"Technical terms:" label; if the text
 *    from there to the end is confirmed leak-shaped by {@link isVocabLeak},
 *    cut it and keep whatever came before. Real speech, when present, comes
 *    *before* the label — the ASR either echoes the whole prompt (nothing
 *    worth keeping) or trails off from genuine transcription into the echo
 *    partway through; it does not resume transcribing real audio after
 *    hallucinating the prompt, so nothing needs to survive past the marker.
 *
 * 2. Sentence-chunk fallback, for a leak with no label at all (the model
 *    echoed the term list without its boilerplate prefix): split into
 *    sentence-ish chunks and drop the ones that are individually
 *    leak-shaped, guarded by {@link MIN_LEAK_CHUNK_TOKENS} so a short real
 *    sentence that happens to be all vocabulary words survives.
 *
 * Unlike `isVocabLeak` (built for meeting-transcript segments, which the
 * ASR already chunks into one utterance per segment), dictation hands back
 * one flat string with no segment boundaries — so this does its own
 * splitting. Returns the input unchanged when nothing is flagged, and `""`
 * when the whole thing is a leak (including the common case: the entire
 * output is nothing but the echoed prompt).
 */
export function stripVocabLeak(text: string, vocabTerms: string[]): string {
  if (vocabTerms.length === 0 || !text.trim()) return text;

  const marker = TERMS_MARKER.exec(text);
  if (marker) {
    const before = text.slice(0, marker.index).trim();
    const after = text.slice(marker.index);
    if (isVocabLeak(after, vocabTerms)) return before;
  }

  const chunks = text
    .split(/(?<=[.!?])\s+(?=\S)/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (chunks.length <= 1) {
    return isVocabLeak(text, vocabTerms) ? "" : text;
  }

  const kept = chunks.filter((chunk) => {
    const tokenCount = normalizeText(chunk).split(" ").filter(Boolean).length;
    if (tokenCount < MIN_LEAK_CHUNK_TOKENS) return true;
    return !isVocabLeak(chunk, vocabTerms);
  });
  if (kept.length === chunks.length) return text;
  return kept.join(" ").trim();
}
