/**
 * Code stage of Enhance: remove exact repeated words (owner decision
 * 2026-10-26: the enhanced transcript removes them, and code does it, not the
 * LLM). The rule works on one segment text, so it never crosses a segment or
 * a speaker boundary:
 *
 * - Two words next to each other are a repeat when their letters and digits
 *   are the same, in any case ("The the", "I, I"). The second word goes,
 *   and the punctuation after it replaces the punctuation between the two
 *   ("I, I think" gives "I think", "the the," gives "the,").
 * - A sentence end between the two words (".", "?", "!", "…") keeps both
 *   words: "No. No." is two sentences.
 * - A word with leading punctuation (a quote or a bracket) is kept.
 * - A number is kept ("20 20" or "twenty twenty" can be a year or a score).
 *   A removed number would also change the numbers of the line.
 * - A negation is kept ("No, no." stays): the 4.2.3 meaning_flip check and
 *   the eval negation check count negations, and a removed one fails both
 *   (gold eval 2026-10-26, ca70f895).
 * - When the first word is lower case and the second has a capital ("the The
 *   step"), the kept word takes the capital: the second word starts the
 *   sentence or is a name (gold eval 2026-10-26, a names hard fail).
 * - A run of three or more repeats keeps one word ("we we we" gives "we").
 *   An emphatic double such as "very very" also goes: the owner rule has no
 *   exception, and code cannot tell emphasis from a stutter.
 */

const NUMBER_WORDS = new Set(
  (
    "zero one two three four five six seven eight nine ten eleven twelve " +
    "thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty " +
    "thirty forty fifty sixty seventy eighty ninety hundred thousand million " +
    "billion"
  ).split(" "),
);

interface Token {
  lead: string;
  core: string;
  trail: string;
}

function splitToken(raw: string): Token {
  const m = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u.exec(raw);
  return { lead: m?.[1] ?? "", core: m?.[2] ?? raw, trail: m?.[3] ?? "" };
}

function keyOf(core: string): string {
  return core.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

const NEGATIONS = new Set(["no", "not", "never", "nothing", "none", "nobody"]);

function isNegation(core: string): boolean {
  const w = core.toLowerCase().replace(/[\u2018\u2019\u02bc]/g, "'");
  return NEGATIONS.has(w) || w.endsWith("n't");
}

function isNumber(key: string): boolean {
  return /\p{N}/u.test(key) || NUMBER_WORDS.has(key);
}

/** The text without exact immediate repeated words. Unchanged text keeps its spacing. */
export function removeRepeatedWords(text: string): string {
  const raw = text.trim().split(/\s+/).filter(Boolean);
  const out: Token[] = [];
  let changed = false;
  for (const word of raw) {
    const tok = splitToken(word);
    const prev = out[out.length - 1];
    const key = keyOf(tok.core);
    const repeat =
      prev !== undefined &&
      key !== "" &&
      key === keyOf(prev.core) &&
      !tok.lead &&
      !/[.!?…]/u.test(prev.trail) &&
      !isNumber(key) &&
      !isNegation(tok.core);
    if (repeat) {
      prev.trail = tok.trail;
      if (!/\p{Lu}/u.test(prev.core) && /\p{Lu}/u.test(tok.core)) {
        prev.core = tok.core;
      }
      changed = true;
      continue;
    }
    out.push(tok);
  }
  if (!changed) return text;
  return out.map((t) => `${t.lead}${t.core}${t.trail}`).join(" ");
}
