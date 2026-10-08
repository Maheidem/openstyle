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

/** Trailing closing quotes/apostrophes that never decide a sentence end. */
const CLOSING_QUOTE = /["\u201d'\u2019\u00bb\u203a]/;

/**
 * Whether a word token ends a sentence: it ends in one of `. ? !` after
 * dropping trailing closing quotes (spec 3.6, Decision (owner,
 * 2026-10-07) — the align-then-split cut snap rule). Portuguese and
 * Spanish use the same sentence-final marks (¿ ¡ only OPEN sentences),
 * and a closing quote after the mark (`"stop."`) still counts.
 */
export function wordEndsSentence(word: string): boolean {
  const w = word.trim();
  if (w.length === 0) return false;
  let end = w.length - 1;
  while (end >= 0 && CLOSING_QUOTE.test(w.charAt(end))) {
    end -= 1;
  }
  return end >= 0 && ".?!".includes(w.charAt(end));
}

/**
 * The Portuguese tag questions that end a CLAUSE but not the TURN
 * (spec 3.6, 2.14.1): "…sabe?", "…tá?". A cut snapped onto one lands
 * inside one speaker's own explanation, so the cut rule must not treat
 * them as sentence ends. Compared lowercase with accents as written
 * (ASR text carries both "tá" and "ta"), after stripping the same
 * closing quotes wordEndsSentence ignores.
 */
// Council round 5 (owner, 2026-10-08): "beleza" is NOT a tag question —
// at 9742105a #148 it is a hand-off question (speaker 6 asks, speaker 1
// answers), so it ends the turn and the cut after it is kept.
const TAG_QUESTION_WORDS = new Set([
  "sabe",
  "tá",
  "ta",
  "né",
  "ne",
  "certo",
  "entendeu",
  "viu",
  "ok",
]);

/**
 * Whether a word token ends a TURN for the §3.6 cut rule (2.14.1): it
 * ends a sentence (wordEndsSentence) AND it is not a Portuguese tag
 * question ending in "?" (sabe? tá? né? — the same speaker continues).
 * Every other sentence end still ends a turn, including an English
 * question ("Are you?"). wordEndsSentence keeps its own meaning for
 * the other callers.
 */
export function wordEndsTurn(word: string): boolean {
  const w = word.trim();
  if (w.length === 0) return false;
  if (!wordEndsSentence(w)) return false;
  let end = w.length - 1;
  while (end >= 0 && CLOSING_QUOTE.test(w.charAt(end))) {
    end -= 1;
  }
  // A period or exclamation mark always ends the turn; only a "?" can
  // be a tag question.
  if (end < 0 || w.charAt(end) !== "?") return true;
  return !TAG_QUESTION_WORDS.has(w.slice(0, end).toLowerCase());
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

/**
 * True when an ASR result looks like the model echoed the previous-chunk
 * CONTEXT back as fake speech instead of transcribing the audio (I1,
 * specs/meeting-transcription-v2.md §3.1, phase 3b). The context is speech
 * text from the same channel — unlike the vocabulary terms (a list of
 * discrete words, guarded by {@link isVocabLeak}), an echo of it is
 * contiguous speech. True when the normalized result has at least 3 words
 * and any of these holds:
 *
 * - it is a contiguous run of the normalized context;
 * - it starts with 4 or more of the last words of the context;
 * - {@link textSimilarity}(result, context) is at least 0.8.
 */
export function isContextEcho(text: string, context: string): boolean {
  const normText = normalizeText(text);
  const words = normText.split(/\s/).filter(Boolean);
  if (words.length < 3) return false;
  const contextWords = normalizeText(context).split(/\s/).filter(Boolean);
  if (contextWords.length === 0) return false;
  // A word-aligned contiguous run of the context words (matched on the
  // word arrays, so a string match can never straddle a word boundary).
  for (let i = 0; i + words.length <= contextWords.length; i++) {
    let match = true;
    for (let j = 0; j < words.length; j++) {
      if (contextWords[i + j] !== words[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  // Starts with 4 or more of the last words of the context: the text
  // begins with a suffix of the context that is at least 4 words long.
  // Word-aligned: the reference must end at a word boundary of the text.
  const maxK = Math.min(contextWords.length, words.length);
  for (let k = 4; k <= maxK; k++) {
    const ref = contextWords.slice(-k).join(" ");
    if (normText === ref || normText.startsWith(`${ref} `)) return true;
  }
  return textSimilarity(text, context) >= 0.8;
}

/** Marks the "Terms:" / "Technical terms:" prompt-boilerplate label
 * (asr-bias.ts / vocabulary-bias.ts). The injected prompt always carries
 * this label, so a leak's onset is normally findable directly. Exported
 * for the meeting context (phase 3b, specs/meeting-transcription-v2.md
 * §3.1): text carrying the label is prompt boilerplate, never speech. */
export const TERMS_MARKER = /\b(?:technical\s+)?terms:\s*/i;

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
