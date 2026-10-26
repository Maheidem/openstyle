import { distanceAtMostOne } from "./speaker-spelling.js";

/**
 * Code stage of Enhance: the spelling of vocabulary terms (the owner rule
 * "specialization over over-prompting", AGENTS.md). Rule-like spelling fixes
 * are done here, not by the model. This step changes a word only when the
 * match with one vocabulary term is certain:
 *
 * 1. Join: two or three words that make one term ("open style" to
 *    "Openstyle", "git hub" to "GitHub").
 * 2. Case: a word that is a term in another case, when the term has a capital
 *    letter after its first letter ("openai" to "OpenAI"). A term such as
 *    "Go" is not used: "go" is also a common word.
 * 3. Name: a capitalized word inside a sentence that is one letter away from
 *    a capitalized term of 6 letters or more ("Heidemen" to "Heidemann").
 *
 * When two terms match the same words, nothing changes. Misheard words that
 * sound like a term ("cooper netties") stay for the LLM stage.
 */

/** A term or a word must have this many letters for the one-letter rule. */
export const MIN_FUZZY_TERM = 6;
/** A join must make a term of this many characters or more. */
const MIN_JOIN_TERM = 5;
const MAX_JOIN_WORDS = 3;

/** Lowercase letters and digits only: the compare form of a word or a term. */
function keyOf(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** True when the term has a capital letter after its first character. */
function hasMarkedCase(term: string): boolean {
  return /\p{Lu}/u.test(term.slice(1));
}

interface Token {
  /** Leading punctuation, for example an opening quote. */
  lead: string;
  /** The word: letters, digits, inner apostrophes and hyphens. */
  core: string;
  /** Trailing punctuation, for example a comma or a full stop. */
  trail: string;
}

function splitToken(raw: string): Token {
  const m = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u.exec(raw);
  return { lead: m?.[1] ?? "", core: m?.[2] ?? raw, trail: m?.[3] ?? "" };
}

/** The single-word terms, cleaned, without duplicates (case-insensitive). */
function singleWordTerms(vocabTerms: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of vocabTerms) {
    for (const word of raw.trim().split(/\s+/)) {
      const term = splitToken(word).core;
      const key = keyOf(term);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(term);
    }
  }
  return out;
}

/** The one term that `pick` accepts, or null for no match or two matches. */
function only(terms: readonly string[], pick: (t: string) => boolean) {
  const hits = terms.filter(pick);
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

/** Returns the text with certain vocabulary spelling fixes, else the text unchanged. */
export function fixVocabSpelling(
  text: string,
  vocabTerms: readonly string[],
): string {
  const terms = singleWordTerms(vocabTerms);
  if (terms.length === 0 || !text.trim()) return text;
  const raw = text.trim().split(/\s+/);
  const tokens = raw.map(splitToken);
  const out: string[] = [];
  let changed = false;
  let i = 0;
  while (i < tokens.length) {
    const join = joinAt(tokens, i, terms);
    if (join) {
      out.push(join.text);
      i += join.count;
      changed = true;
      continue;
    }
    const tok = tokens[i]!;
    const sentenceStart = i === 0 || /[.!?…]["')\]]*$/u.test(raw[i - 1]!);
    const fixed = fixWord(tok.core, terms, sentenceStart);
    if (fixed !== null) {
      out.push(`${tok.lead}${fixed}${tok.trail}`);
      changed = true;
    } else {
      out.push(raw[i]!);
    }
    i += 1;
  }
  return changed ? out.join(" ") : text;
}

/** A join of 2 or 3 tokens at `i` into one term, or null. */
function joinAt(
  tokens: readonly Token[],
  i: number,
  terms: readonly string[],
): { text: string; count: number } | null {
  for (let n = MAX_JOIN_WORDS; n >= 2; n--) {
    const group = tokens.slice(i, i + n);
    if (group.length < n) continue;
    // Punctuation inside the group means the words are not one term.
    const inner =
      group.slice(0, -1).some((t) => t.trail) ||
      group.slice(1).some((t) => t.lead);
    if (inner || group.some((t) => !t.core)) continue;
    const key = keyOf(group.map((t) => t.core).join(""));
    if (key.length < MIN_JOIN_TERM) continue;
    const term = only(terms, (t) => keyOf(t) === key);
    if (!term) continue;
    const first = group[0]!;
    const last = group[n - 1]!;
    return { text: `${first.lead}${term}${last.trail}`, count: n };
  }
  return null;
}

/** The fixed word, or null when no rule is certain. */
function fixWord(
  core: string,
  terms: readonly string[],
  sentenceStart: boolean,
): string | null {
  if (!core) return null;
  const key = keyOf(core);
  const exact = only(terms, (t) => keyOf(t) === key);
  if (exact) {
    return exact !== core && hasMarkedCase(exact) ? exact : null;
  }
  // The name rule: a capitalized word inside a sentence, letters only.
  if (sentenceStart || !/^\p{Lu}\p{L}+$/u.test(core)) return null;
  if (core.length < MIN_FUZZY_TERM) return null;
  const lower = core.toLowerCase();
  return only(
    terms,
    (t) =>
      /^\p{Lu}\p{L}+$/u.test(t) &&
      t.length >= MIN_FUZZY_TERM &&
      distanceAtMostOne(lower, t.toLowerCase()) === 1,
  );
}
