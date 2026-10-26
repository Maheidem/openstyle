import type { DetectAllFn } from "./language.js";

/**
 * Code stage of Enhance: find the lines that are in another language than
 * the pinned meeting language (the owner rule "specialization over
 * over-prompting", AGENTS.md). A speech recognizer sometimes writes a line in
 * another language. Only these lines go to the `retranscribeLines` LLM stage.
 *
 * The check is careful on purpose: a real line in the meeting language that
 * goes to that stage is changed, so a doubtful line is never flagged.
 */

/**
 * The languages that a meeting line can really be in: the app languages and
 * the other big languages of the speech recognizer. tinyld can name a rare
 * language for a line with many repeats ("ber" for an English line in a test),
 * so a top language outside this set never flags a line.
 */
const LINE_LANGUAGES: ReadonlySet<string> = new Set([
  "de",
  "en",
  "es",
  "fr",
  "it",
  "ja",
  "ko",
  "nl",
  "pt",
  "ru",
  "zh",
]);

/** A line needs at least this many words for a language decision. */
export const MIN_LINE_WORDS = 5;
/** The top language must have at least this tinyld accuracy. */
const MIN_TOP_ACCURACY = 0.5;
/** The meeting language must not be a candidate above this accuracy. */
const MAX_TARGET_ACCURACY = 0.1;

/** "pt-BR" to "pt". null for no language or a blank one. */
export function baseLanguage(language: string | null): string | null {
  const base = language?.trim().toLowerCase().split(/[-_]/)[0];
  return base ? base : null;
}

function wordCount(text: string): number {
  return (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;
}

/**
 * True when the line is clearly in another language than `target` (a base
 * code such as "en"): enough words, a sure top language that is not the
 * target, and the target not a real candidate.
 */
export function isOffLanguage(
  text: string,
  target: string,
  detectAll: DetectAllFn,
): boolean {
  if (wordCount(text) < MIN_LINE_WORDS) return false;
  const ranked = detectAll(text);
  const top = ranked[0];
  if (
    !top ||
    top.lang === target ||
    !LINE_LANGUAGES.has(top.lang) ||
    top.accuracy < MIN_TOP_ACCURACY
  ) {
    return false;
  }
  return !ranked.some(
    (c) => c.lang === target && c.accuracy > MAX_TARGET_ACCURACY,
  );
}

/**
 * True when a rewritten line is in the target language: the top tinyld
 * language is the target. The check after the `retranscribeLines` call.
 */
export function isInLanguage(
  text: string,
  target: string,
  detectAll: DetectAllFn,
): boolean {
  return detectAll(text)[0]?.lang === target;
}

/**
 * The ids of the lines in another language than the pinned meeting language.
 * No pinned language: no line (a meeting with no pin can have more than one
 * real language).
 */
export function offLanguageIds(
  lines: readonly { id: string; text: string }[],
  language: string | null,
  detectAll: DetectAllFn,
): string[] {
  const target = baseLanguage(language);
  if (!target) return [];
  return lines
    .filter((l) => isOffLanguage(l.text, target, detectAll))
    .map((l) => l.id);
}

/** tinyld's `detectAll`, imported once on first use. */
let loaded: DetectAllFn | null = null;
export async function loadDetectAll(): Promise<DetectAllFn> {
  if (!loaded) loaded = (await import("tinyld")).detectAll;
  return loaded;
}
