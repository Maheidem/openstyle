// Code layout stages (specs/dictation-pipeline.md 4.2): the light format of
// low intensity, list markers (S8), the end of a contact form, and short
// fragments (S9).

import type { DictationLang } from "../language.js";

const FILLERS: Record<DictationLang, RegExp> = {
  en: /(?<![\p{L}'])(?:um+|uh+|uhm+|erm+|er|ah+|hmm+|mm+)(?![\p{L}'])[,.]?\s*/giu,
  es: /(?<![\p{L}])(?:eh+|em+|mmm+|ehm+)(?![\p{L}])[,.]?\s*/giu,
  pt: /(?<![\p{L}])(?:hã+|hum+|ahn+|uhm+|éh+)(?![\p{L}])[,.]?\s*/giu,
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
  if (out && !/[.!?:…;,]$/u.test(out)) out += ".";
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
  pt: [
    /(?<![\p{L}])um(?![\p{L}])/iu,
    /(?<![\p{L}])dois(?![\p{L}])/iu,
    /(?<![\p{L}])três(?![\p{L}])/iu,
    /(?<![\p{L}])primeiro(?![\p{L}])/iu,
    /(?<![\p{L}])segundo(?![\p{L}])/iu,
    /(?<![\p{L}])terceiro(?![\p{L}])/iu,
  ],
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
  if (!/^\s*\d+\.\s/m.test(text) || countsItems(raw, lang)) return text;
  return text.replace(/^(\s*)\d+\.\s+/gm, "$1- ");
}

/**
 * A period right after an email, URL, path or file name at the end of the
 * text reads as part of it, so it goes. The blind judges of the first bench
 * run chose the answer without that period.
 */
export function contactEnd(text: string): string {
  const m = /(\S+)\.$/u.exec(text);
  const last = m?.[1] ?? "";
  if (!/@|:\/\/|^www\.|^\/|\.[a-z][a-z0-9]{1,4}$/i.test(last)) return text;
  if (!/[a-z0-9/]$/i.test(last)) return text;
  return text.slice(0, -1);
}

/**
 * S9: a short fragment keeps no final period (owner rule: 3 words or less).
 * Only a single-line answer with no other sentence mark changes. A short text
 * with a digit is a statement ("Cuesta 25 dólares.", "It's 3 PM."), not a
 * title, so it keeps its period (owner review 2026-10-27).
 */
export function fragments(text: string, raw: string): string {
  const words = raw.trim().split(/\s+/).filter(Boolean).length;
  if (words > 3 || text.includes("\n") || /\d/.test(text)) return text;
  const body = text.replace(/\.$/, "");
  if (/[.!?]/.test(body)) return text;
  return body;
}
