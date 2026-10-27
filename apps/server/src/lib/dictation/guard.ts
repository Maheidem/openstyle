// The safety check after the polish and tone stages (specs/dictation-pipeline.md
// 4.2). A stage answer must keep every protected token of its input: numbers,
// emails, URLs, paths, and date words (today, tomorrow, weekdays, months). The
// research found a tone answer that dropped 明天 ("tomorrow"). When a token is
// lost, the stage gives back its input.

import type { DictationLang } from "./language.js";

const TOKEN_RE =
  /[^\s@]+@[^\s@]+\.[a-z]{2,}|https?:\/\/\S+|(?:\/[\w.-]+){2,}|\d[\d,.:-]*\d|\d/giu;

const EN_DATE_WORDS =
  /\b(today|tomorrow|tonight|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|june|july|august|september|october|november|december)\b/giu;
const ES_DATE_WORDS =
  /(?<![\p{L}])(hoy|mañana|ayer|lunes|martes|miércoles|jueves|viernes|sábado|domingo|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)(?![\p{L}])/giu;
const ZH_DATE_WORDS =
  /今天|明天|后天|昨天|前天|今晚|明早|下周|上周|这周|本周|周[一二三四五六日天]|星期[一二三四五六日天]|礼拜[一二三四五六日天]/gu;

/** One spelling per zh date word: 星期三 = 礼拜三 = 周三, 本周 = 这周. */
function zhCanonical(w: string): string {
  return w
    .replace(/^(星期|礼拜)/, "周")
    .replace("周天", "周日")
    .replace("本周", "这周");
}

function dateWords(text: string, lang: DictationLang | null): string[] {
  const res =
    lang === "zh"
      ? [ZH_DATE_WORDS]
      : lang === "es"
        ? [ES_DATE_WORDS]
        : lang === "en"
          ? [EN_DATE_WORDS]
          : [];
  return res.flatMap((re) =>
    (text.match(re) ?? []).map((w) =>
      lang === "zh" ? zhCanonical(w) : w.toLowerCase(),
    ),
  );
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
