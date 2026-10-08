import { buildAsrBiasPrompt } from "@openstyle/stt";
import { stripProviderPrefix } from "./streaming/types.js";
import {
  buildVocabularyNoteText,
  loadVocabularyEntries,
} from "./vocabulary.js";

/** ASR-only vocabulary bias (first recognition step). Not used in post-process. */
export type AsrVocabularyBias =
  | { kind: "prompt"; text: string }
  | { kind: "deepgram-keyterms"; terms: string[] }
  | { kind: "deepgram-keywords"; terms: string[] }
  | { kind: "elevenlabs-keyterms"; terms: string[] }
  | { kind: "soniox-context"; terms: string[]; text?: string };

const PROMPT_CHAR_BUDGET = 900;
/**
 * I1 (specs/meeting-transcription-v2.md §3.1, phase 3b): context tail
 * length — the last 200 characters of the previous chunk's cleaned text,
 * about 30 to 40 English words.
 */
export const CONTEXT_TAIL_CHARS = 200;

/**
 * I1 (phase 3b): the context tail — the last {@link CONTEXT_TAIL_CHARS}
 * characters of the previous chunk's cleaned text, starting at the first
 * whole word (a cut mid-word would hand the model a broken token).
 */
export function contextTail(text: string): string {
  const trimmed = text.trim();
  // Short enough to fit whole: it already starts at a word boundary.
  if (trimmed.length <= CONTEXT_TAIL_CHARS) return trimmed;
  const cut = trimmed.length - CONTEXT_TAIL_CHARS;
  const t = trimmed.slice(cut);
  // The slice starts at a word boundary only when the character before it
  // is whitespace; then the first word of the slice is whole and stays.
  const prev = trimmed[cut - 1];
  if (prev !== undefined && !/\s/.test(prev)) {
    const m = t.search(/\s/);
    if (m >= 0) {
      // Mid-word start: drop the broken head up to the first whitespace.
      return t.slice(m + 1);
    }
    // No whitespace at all: keep the slice, but never split a surrogate
    // pair — a lone trailing surrogate is invalid, so drop it.
    const code = t.codePointAt(0) ?? 0;
    if (code >= 0xdc00 && code <= 0xdfff) return t.slice(1);
  }
  return t;
}

/**
 * I1 (specs/meeting-transcription-v2.md §3.1, phase 3b): the five providers
 * whose bias travels as a free-text prompt and therefore takes the
 * previous-chunk context (in the `prompt` field, or `context` for
 * local-mlx, which the worker maps to `system_prompt`). deepgram,
 * elevenlabs and soniox take a term list, not a prompt — no context for
 * them (soniox's `context.text` could take it; out of scope).
 */
const PROMPT_PROVIDERS = new Set([
  "local-whisper",
  "server",
  "openai",
  "groq",
  "local-mlx",
]);

export function providerTakesPrompt(providerId: string): boolean {
  return PROMPT_PROVIDERS.has(providerId);
}

/**
 * I1 (specs/meeting-transcription-v2.md §3.1, phase 3b): join the
 * vocabulary-bias prompt with the previous-chunk context — terms FIRST,
 * context LAST. `buildAsrBiasPrompt` orders context first and terms last,
 * which is not acceptable here: the model gives the most weight to the END
 * of a prompt, so the context — the freshest speech on this channel — must
 * come last. The total never exceeds {@link PROMPT_CHAR_BUDGET} (900):
 * the context gets its 200-char tail (via {@link contextTail} — a longer
 * input is cut at the FRONT, never the tail), the terms the rest (up to
 * ~700), cut at the last ", " that fits.
 */
export function combinePrompt(biasText: string, context: string): string {
  const ctx = context.trim();
  if (!ctx) return biasText;
  const contextPart = contextTail(ctx);
  if (!contextPart) return biasText;
  if (!biasText) return contextPart;
  // The context (plus the separating space) comes last, so the terms get
  // whatever of the 900-char budget is left.
  const termBudget = PROMPT_CHAR_BUDGET - contextPart.length - 1;
  let terms = biasText;
  if (terms.length > termBudget) {
    const slice = terms.slice(0, termBudget);
    const lastComma = slice.lastIndexOf(", ");
    terms = lastComma >= 0 ? slice.slice(0, lastComma) : slice;
  }
  return `${terms} ${contextPart}`;
}
const DEEPGRAM_KEYTERM_MAX = 100;
/** Keep streaming URLs short — long keyterm lists break the WS handshake. */
const DEEPGRAM_STREAMING_KEYTERM_MAX = 25;
const SONIOX_TERM_MAX = 500;
const SONIOX_TERMS_CHAR_BUDGET = 6000;
const ELEVENLABS_BATCH_KEYTERM_MAX = 100;
const ELEVENLABS_REALTIME_KEYTERM_MAX = 50;
const ELEVENLABS_TERM_MAX_CHARS = 20;
const ELEVENLABS_BATCH_TERM_MAX_CHARS = 50;

function capTerms(terms: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of terms) {
    const term = raw.trim();
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= max) break;
  }
  return out;
}

function buildPromptText(terms: string[]): string | null {
  return buildAsrBiasPrompt({ terms }) ?? null;
}

function expandNova2Keywords(terms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const phrase of terms) {
    for (const word of phrase.split(/\s+/)) {
      const w = word.trim();
      if (!w) continue;
      const key = w.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(w);
      if (out.length >= DEEPGRAM_KEYTERM_MAX) return out;
    }
  }
  return out;
}

function capSonioxTerms(terms: string[]): string[] {
  const capped = capTerms(terms, SONIOX_TERM_MAX);
  const out: string[] = [];
  let used = 0;
  for (const term of capped) {
    if (used + term.length > SONIOX_TERMS_CHAR_BUDGET) break;
    out.push(term);
    used += term.length;
  }
  return out;
}

function capElevenLabsTerms(
  terms: string[],
  maxCount: number,
  maxChars: number,
): string[] {
  return capTerms(
    terms.map((t) => (t.length > maxChars ? t.slice(0, maxChars) : t)),
    maxCount,
  );
}

/**
 * Build provider-specific ASR bias from vocabulary terms.
 * Returns null when there is nothing to send or the model does not support bias.
 */
export function buildAsrVocabularyBias(
  providerId: string,
  modelId: string,
  terms: string[],
  streaming = false,
  noteText?: string,
): AsrVocabularyBias | null {
  const capped = capTerms(terms, SONIOX_TERM_MAX);
  if (capped.length === 0) return null;

  const short = stripProviderPrefix(modelId);

  switch (providerId) {
    case "openai":
    case "groq":
    // whisper.cpp accepts the same OpenAI-style initial prompt (224-token budget).
    case "local-whisper": {
      const text = buildPromptText(capped);
      return text ? { kind: "prompt", text } : null;
    }
    case "deepgram": {
      const max = streaming
        ? DEEPGRAM_STREAMING_KEYTERM_MAX
        : DEEPGRAM_KEYTERM_MAX;
      if (short.includes("nova-3")) {
        const keyterms = capTerms(capped, max);
        return keyterms.length > 0
          ? { kind: "deepgram-keyterms", terms: keyterms }
          : null;
      }
      if (short.includes("nova-2")) {
        const keywords = expandNova2Keywords(capTerms(capped, max));
        return keywords.length > 0
          ? { kind: "deepgram-keywords", terms: keywords }
          : null;
      }
      return null;
    }
    case "elevenlabs": {
      if (!short.includes("scribe_v2")) return null;
      const max = streaming
        ? ELEVENLABS_REALTIME_KEYTERM_MAX
        : ELEVENLABS_BATCH_KEYTERM_MAX;
      const maxChars = streaming
        ? ELEVENLABS_TERM_MAX_CHARS
        : ELEVENLABS_BATCH_TERM_MAX_CHARS;
      const keyterms = capElevenLabsTerms(capped, max, maxChars);
      return keyterms.length > 0
        ? { kind: "elevenlabs-keyterms", terms: keyterms }
        : null;
    }
    case "soniox": {
      const sonioxTerms = capSonioxTerms(capped);
      if (sonioxTerms.length === 0) return null;
      return {
        kind: "soniox-context",
        terms: sonioxTerms,
        ...(noteText ? { text: noteText } : {}),
      };
    }
    // Both run MLX ASR models and take the same free-text prompt. A server
    // that the user runs gets the same prompt. It sends the field itself.
    case "local-mlx":
    case "server": {
      const text = `Technical terms: ${capped.join(", ")}`.slice(
        0,
        PROMPT_CHAR_BUDGET,
      );
      return { kind: "prompt", text };
    }
    default:
      return null;
  }
}

export function resolveAsrVocabularyBias(
  providerId: string,
  modelId: string,
  streaming = false,
): AsrVocabularyBias | null {
  const entries = loadVocabularyEntries();
  return buildAsrVocabularyBias(
    providerId,
    modelId,
    entries.map((e) => e.term),
    streaming,
    buildVocabularyNoteText(entries),
  );
}

/**
 * PR #39: the vocabulary bias for ONE meeting that has a free-text
 * context (the calendar invitee list). The terms extracted from the
 * context (see `meetings/context-terms.ts`) are PREPENDED to the global
 * vocabulary terms, so they win every per-provider cap — `capTerms`
 * keeps the first N, and the prompt builders slice the assembled text
 * at the FRONT budget. The owner's 80-term vocabulary overflows the
 * 900-char prompt budget, so the meeting's invitee names must come
 * first within the cap. Dictation (`resolveAsrVocabularyBias`) is
 * untouched.
 */
export function resolveMeetingAsrVocabularyBias(
  providerId: string,
  modelId: string,
  contextTerms: string[],
  streaming = false,
): AsrVocabularyBias | null {
  const entries = loadVocabularyEntries();
  return buildAsrVocabularyBias(
    providerId,
    modelId,
    [...contextTerms, ...entries.map((e) => e.term)],
    streaming,
    buildVocabularyNoteText(entries),
  );
}

/**
 * Recover the vocabulary terms out of an already-resolved {@link
 * AsrVocabularyBias}, for comparing STT output against *what was actually
 * sent* to this request's provider — not a fresh DB read, which could race a
 * mid-request vocabulary edit and disagree with the bias this transcription
 * actually used (dictation leak filter, specs/meeting-transcription-quality.md
 * Phase A extended to the dictation paths).
 *
 * For the `prompt` kind (openai/groq/local-whisper/local-mlx/server) the terms
 * live inlined in the free-text prompt rather than as a list — returning the
 * whole label-stripped prompt text as a single "term" is equivalent for
 * `isVocabLeak`'s purposes, since it tokenizes on word boundaries either way.
 */
export function vocabularyBiasTerms(
  bias: AsrVocabularyBias | null | undefined,
): string[] {
  if (!bias) return [];
  switch (bias.kind) {
    case "prompt":
      return [bias.text.replace(/^(technical\s+)?terms:\s*/i, "")];
    case "deepgram-keyterms":
    case "deepgram-keywords":
    case "elevenlabs-keyterms":
    case "soniox-context":
      return bias.terms;
    default:
      return [];
  }
}
