// The safety check after the polish and tone stages (specs/dictation-pipeline.md
// 4.2). A stage answer must keep every protected token of its input: numbers,
// emails, URLs, paths, and date words (today, tomorrow, weekdays, months). The
// research found a tone answer that dropped "tomorrow". When a token is lost,
// the stage gives back its input.

import type { DictationLang } from "./language.js";

const TOKEN_RE =
  /[^\s@]+@[^\s@]+\.[a-z]{2,}|https?:\/\/\S+|(?:\/[\w.-]+){2,}|\d[\d,.:-]*\d|\d/giu;

const DATE_WORDS: Record<DictationLang, RegExp> = {
  en: /\b(today|tomorrow|tonight|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|june|july|august|september|october|november|december)\b/giu,
  es: /(?<![\p{L}])(hoy|mañana|ayer|lunes|martes|miércoles|jueves|viernes|sábado|domingo|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)(?![\p{L}])/giu,
  pt: /(?<![\p{L}])(hoje|amanhã|ontem|segunda|terça|quarta|quinta|sexta|sábado|domingo|janeiro|fevereiro|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(?![\p{L}])/giu,
};

function dateWords(text: string, lang: DictationLang | null): string[] {
  if (!lang) return [];
  return (text.match(DATE_WORDS[lang]) ?? []).map((w) => w.toLowerCase());
}

/** The protected tokens of a text. */
export function protectedTokens(
  text: string,
  lang: DictationLang | null,
): string[] {
  const forms = (text.match(TOKEN_RE) ?? []).map((t) =>
    t.replace(/[.,;:!?)]+$/, "").toLowerCase(),
  );
  return [...new Set([...forms, ...dateWords(text, lang)])];
}

/** The protected tokens of `before` that `after` lost. Empty: the answer is safe. */
export function lostTokens(
  before: string,
  after: string,
  lang: DictationLang | null,
): string[] {
  const lower = after.toLowerCase();
  const afterDates = new Set(dateWords(after, lang));
  return protectedTokens(before, lang).filter((t) =>
    /\d|@|\//.test(t) ? !lower.includes(t) : !afterDates.has(t),
  );
}
