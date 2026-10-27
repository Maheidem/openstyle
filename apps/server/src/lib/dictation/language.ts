// The dictation language for the stages (specs/dictation-pipeline.md 4.3).
// The code stages have rules for en, es and zh. Other languages pass through
// them unchanged.

export type DictationLang = "en" | "es" | "zh";

/** The rule language of a language code ("zh-Hans" -> "zh"), or null. */
export function langOf(code: string | null | undefined): DictationLang | null {
  const c = (code ?? "").trim().toLowerCase();
  if (c.startsWith("en")) return "en";
  if (c.startsWith("es")) return "es";
  if (c.startsWith("zh")) return "zh";
  return null;
}

const ES_WORDS = new Set([
  "el",
  "la",
  "los",
  "las",
  "de",
  "del",
  "que",
  "y",
  "en",
  "es",
  "para",
  "por",
  "con",
  "una",
  "un",
  "al",
  "lo",
  "se",
  "mi",
  "su",
  "pero",
  "como",
  "muy",
  "esta",
  "este",
  "hola",
  "gracias",
]);
const EN_WORDS = new Set([
  "the",
  "and",
  "to",
  "of",
  "is",
  "for",
  "it",
  "you",
  "i",
  "we",
  "a",
  "in",
  "on",
  "at",
  "this",
  "that",
  "my",
  "me",
  "with",
  "but",
  "can",
  "be",
  "are",
  "hi",
  "thanks",
]);

/**
 * The language of one dictation.
 *
 * - `rules`: the language for the code stages, or null (no rules apply).
 * - `llm`: the language list for the LLM stages. One language when it is
 *   known. The configured list when the text does not show it.
 *
 * One configured language wins. With several configured languages, the text
 * decides: Chinese characters give zh; otherwise common words decide between
 * en and es. Detection only runs when every configured language has rules
 * (or the list is empty, which means "auto"), so a German dictation with
 * ["en", "de"] never gets English rules.
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
  const supported = codes.every((c) => langOf(c) !== null);
  if (!supported) return { rules: null, llm: codes };
  const candidates: { lang: DictationLang; code: string }[] =
    codes.length === 0
      ? [
          { lang: "en", code: "en" },
          { lang: "es", code: "es" },
          { lang: "zh", code: "zh" },
        ]
      : codes.map((c) => ({ lang: langOf(c) as DictationLang, code: c }));
  const has = (lang: DictationLang) => candidates.find((c) => c.lang === lang);
  const han = (text.match(/\p{Script=Han}/gu) ?? []).length;
  const latin = (text.match(/\p{Script=Latin}/gu) ?? []).length;
  const zh = has("zh");
  if (zh && han > 0 && han >= latin / 3) return { rules: "zh", llm: [zh.code] };
  const en = has("en");
  const es = has("es");
  if (en && es) {
    const words = text
      .toLowerCase()
      .split(/[^\p{L}']+/u)
      .filter(Boolean);
    let score = /[ñáéíóú¿¡]/i.test(text) ? 2 : 0;
    for (const w of words) {
      if (ES_WORDS.has(w)) score += 1;
      if (EN_WORDS.has(w)) score -= 1;
    }
    if (score > 0) return { rules: "es", llm: [es.code] };
    if (score < 0) return { rules: "en", llm: [en.code] };
    return { rules: null, llm: codes };
  }
  const latinOnly = en ?? es;
  if (latinOnly && han === 0) {
    return { rules: latinOnly.lang, llm: [latinOnly.code] };
  }
  return { rules: null, llm: codes };
}
