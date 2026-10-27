// Code layout stages (specs/dictation-pipeline.md 4.2): the light format of
// low intensity, list markers (S8) and short fragments (S9).

import type { DictationLang } from "../language.js";

const FILLERS: Record<DictationLang, RegExp> = {
  en: /(?<![\p{L}'])(?:um+|uh+|uhm+|erm+|er|ah+|hmm+|mm+)(?![\p{L}'])[,.]?\s*/giu,
  es: /(?<![\p{L}])(?:eh+|em+|mmm+|ehm+)(?![\p{L}])[,.]?\s*/giu,
  zh: /[呃嗯][，,]?/gu,
};

/**
 * The light format: the text of low intensity, and the fallback of a failed
 * cleanup call. It removes filler sounds, writes the first letter of each
 * sentence and line as a capital (and the English "i" as "I"), and ends the
 * text with a period when it has no end mark. It does not add commas or fix
 * grammar.
 */
export function lightFormat(text: string, lang: DictationLang | null): string {
  let out = lang ? text.replace(FILLERS[lang], "") : text;
  if (lang === "en") {
    out = out.replace(
      /(?<![\p{L}'])i(?=(?:'(?:m|ll|ve|d))?(?![\p{L}]))/gu,
      "I",
    );
  }
  out = out
    .split("\n")
    .map((line) =>
      line
        .replace(/[ \t]+/g, " ")
        .trim()
        .replace(
          /(^|[.!?]\s+)(\p{Ll})/gu,
          (_m, pre: string, c: string) => pre + c.toUpperCase(),
        ),
    )
    .join("\n")
    .trim();
  if (out && !/[.!?。！？:：…;；,，]$/u.test(out)) {
    out += lang === "zh" || /\p{Script=Han}$/u.test(out) ? "。" : ".";
  }
  return out;
}

const COUNT_CUES: Record<DictationLang, RegExp[]> = {
  en: [
    /\bone\b/i,
    /\btwo\b/i,
    /\bthree\b/i,
    /\bfirst(ly)?\b/i,
    /\bsecond(ly)?\b/i,
    /\bthird(ly)?\b/i,
  ],
  es: [
    /\buno\b/i,
    /\bdos\b/i,
    /\btres\b/i,
    /\bprimero\b/i,
    /\bsegundo\b/i,
    /\btercero\b/i,
  ],
  zh: [/第一/, /第二/, /第三/, /一个/, /两个/, /三个/],
};

/** True when the raw text counts its items (2 or more counting words). */
function countsItems(raw: string, lang: DictationLang | null): boolean {
  if (!lang) return true;
  return COUNT_CUES[lang].filter((r) => r.test(raw)).length >= 2;
}

/**
 * S8 (high intensity only): a numbered list becomes bullets when the speaker
 * did not count the items (owner rule: bullets for uncounted lists only at
 * high).
 */
export function listMarkers(
  text: string,
  raw: string,
  lang: DictationLang | null,
): string {
  if (!/^\s*\d+[.．、]\s/m.test(text) || countsItems(raw, lang)) return text;
  return text.replace(/^(\s*)\d+[.．、]\s+/gm, "$1- ");
}

/**
 * S9: a short fragment keeps no final period (owner rule: 3 words or less;
 * Chinese: 6 characters or less). Only a single-line answer with no other
 * sentence mark changes.
 */
export function fragments(
  text: string,
  raw: string,
  lang: DictationLang | null,
): string {
  const words = raw.trim().split(/\s+/).filter(Boolean).length;
  const han = (raw.match(/\p{Script=Han}/gu) ?? []).length;
  const short = lang === "zh" || han > 0 ? han > 0 && han <= 6 : words <= 3;
  if (!short || text.includes("\n")) return text;
  const body = text.replace(/[.。]$/, "");
  if (/[.!?。！？]/.test(body)) return text;
  return body;
}
