// The dictation language for the stages (specs/dictation-pipeline.md 4.3).
// The code stages have rules for en, es and pt (owner decision 2026-10-27).
// Other languages pass through them unchanged.

export type DictationLang = "en" | "es" | "pt";

const RULE_LANGS: readonly DictationLang[] = ["en", "es", "pt"];

/** The rule language of a language code ("pt-BR" -> "pt"), or null. */
export function langOf(code: string | null | undefined): DictationLang | null {
  const base = (code ?? "").trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return (RULE_LANGS as readonly string[]).includes(base)
    ? (base as DictationLang)
    : null;
}

/** Common words that only one of the three languages uses. */
const MARKER_WORDS: Record<DictationLang, Set<string>> = {
  en: new Set(
    "the and to of is for it you i we in on at this that my me with but can be are hi thanks".split(
      " ",
    ),
  ),
  es: new Set(
    "el los las y del al lo se pero como muy esta este hola gracias usted mañana también".split(
      " ",
    ),
  ),
  pt: new Set(
    "o os um uma e é do da dos das no na em não você isso obrigado obrigada olá está também amanhã com".split(
      " ",
    ),
  ),
};
const MARKER_CHARS: Record<DictationLang, RegExp> = {
  en: /$^/,
  es: /[ñ¿¡]/i,
  pt: /[ãõçâêô]/i,
};

/**
 * The language of one dictation.
 *
 * - `rules`: the language for the code stages, or null (no rules apply).
 * - `llm`: the language list for the LLM stages. One language when it is
 *   known. The configured list when the text does not show it.
 *
 * One configured language wins. With several configured languages, common
 * words and letters decide. Detection only runs when every configured
 * language has rules (or the list is empty, which means "auto"), so a German
 * dictation with ["en", "de"] never gets English rules.
 */
export function resolveDictationLanguage(
  text: string,
  languages: readonly string[] | undefined,
): { rules: DictationLang | null; llm: string[] } {
  const codes = (languages ?? [])
    .map((l) => l.trim())
    .filter((l) => l && l.toLowerCase() !== "auto");
  if (codes.length === 1) {
    const only = codes[0] as string;
    return { rules: langOf(only), llm: [only] };
  }
  if (!codes.every((c) => langOf(c) !== null)) {
    return { rules: null, llm: codes };
  }
  const candidates =
    codes.length === 0
      ? RULE_LANGS.map((lang) => ({ lang, code: lang as string }))
      : codes.map((c) => ({ lang: langOf(c) as DictationLang, code: c }));
  const words = text
    .toLowerCase()
    .split(/[^\p{L}']+/u)
    .filter(Boolean);
  const scored = candidates
    .map((c) => {
      let score = MARKER_CHARS[c.lang].test(text) ? 2 : 0;
      for (const w of words) if (MARKER_WORDS[c.lang].has(w)) score += 1;
      return { ...c, score };
    })
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  const second = scored[1];
  if (!best || best.score === 0 || (second && second.score === best.score)) {
    return { rules: null, llm: codes };
  }
  return { rules: best.lang, llm: [best.code] };
}
