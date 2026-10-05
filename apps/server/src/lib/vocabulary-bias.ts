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
