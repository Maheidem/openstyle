// Code stages S1 and S2 (specs/dictation-pipeline.md 4.2): line commands and
// counted lists. Both run on the raw text, before the cleanup LLM, because
// Gemma 4 E2B deletes "new line" and merges counted items (spec 3).

import type { DictationLang } from "../language.js";

const LINE_COMMANDS: Record<DictationLang, RegExp> = {
  en: /\s*(?<![\p{L}])(new paragraph|next paragraph|new line|newline|next line)(?![\p{L}])[.,;:!]?\s*/giu,
  es: /\s*(?<![\p{L}])(punto y aparte|nuevo p[aá]rrafo|nueva l[ií]nea|salto de l[ií]nea)(?![\p{L}])[.,;:!]?\s*/giu,
  pt: /\s*(?<![\p{L}])(ponto par[aá]grafo|novo par[aá]grafo|nova linha|pr[oó]xima linha)(?![\p{L}])[.,;:!]?\s*/giu,
};

const PARAGRAPH = /paragraph|aparte|p[aá]rrafo|par[aá]grafo/i;

/** A list marker word must not touch a letter or a hyphen ("segunda-feira"). */
const word = (alt: string) =>
  new RegExp(`(?<![\\p{L}-])(?:${alt})(?![\\p{L}-])`, "giu");

/** Plain count words first, then ordinals. Alternatives with "|". */
const MARKERS: Record<DictationLang, { plain: boolean; seq: string[] }[]> = {
  en: [
    {
      plain: true,
      seq: "one two three four five six seven eight nine".split(" "),
    },
    {
      plain: false,
      seq: "first second third fourth fifth sixth seventh eighth ninth".split(
        " ",
      ),
    },
  ],
  es: [
    {
      plain: true,
      seq: "un|una|uno dos tres cuatro cinco seis siete ocho nueve".split(" "),
    },
    {
      plain: false,
      seq: "primero|primera segundo|segunda tercero|tercera cuarto|cuarta quinto|quinta sexto|sexta séptimo|séptima octavo|octava noveno|novena".split(
        " ",
      ),
    },
  ],
  pt: [
    {
      plain: true,
      seq: "um|uma dois|duas três|tres quatro cinco seis sete oito nove".split(
        " ",
      ),
    },
    {
      plain: false,
      seq: "primeiro|primeira segundo|segunda terceiro|terceira quarto|quarta quinto|quinta sexto|sexta sétimo|sétima oitavo|oitava nono|nona".split(
        " ",
      ),
    },
  ],
};

/** Words that end in "s" but are not plural nouns. */
const NOT_PLURAL = new Set(
  "this his hers its yes does has was plus less thus always perhaps unless also mais menos depois antes pues mas".split(
    " ",
  ),
);

/**
 * A quantity, not a list item: "two adapters", "dos adaptadores", "dois
 * cabos novos". One of the first two words is a plural noun (it ends in "s",
 * not "ss"). A task starts with a verb: "two notify support".
 */
function isQuantity(item: string): boolean {
  return item
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter(Boolean)
    .slice(0, 2)
    .some(
      (w) =>
        w.length >= 4 &&
        w.endsWith("s") &&
        !w.endsWith("ss") &&
        !NOT_PLURAL.has(w),
    );
}

/**
 * S1: split the raw text at spoken line commands. `seps[i]` follows
 * `parts[i]`: "\n" for a new line, "\n\n" for a new paragraph. No language
 * rules or no command: one part.
 */
export function splitLineCommands(
  raw: string,
  lang: DictationLang | null,
): { parts: string[]; seps: string[] } {
  if (!lang) return { parts: [raw], seps: [] };
  const parts: string[] = [];
  const seps: string[] = [];
  let last = 0;
  for (const m of raw.matchAll(LINE_COMMANDS[lang])) {
    parts.push(raw.slice(last, m.index));
    seps.push(PARAGRAPH.test(m[1] ?? "") ? "\n\n" : "\n");
    last = (m.index ?? 0) + m[0].length;
  }
  parts.push(raw.slice(last));
  return { parts, seps };
}

/** Join the cleaned parts with their separators. Empty parts add no text. */
export function joinParts(
  parts: readonly string[],
  seps: readonly string[],
): string {
  let out = "";
  parts.forEach((p, i) => {
    out += p.trim();
    const sep = seps[i];
    if (sep && out) out = out.replace(/[ \t]+$/, "") + sep;
  });
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

export interface CountedList {
  leadIn: string;
  items: string[];
}

/**
 * S2: split a counted list ("one X two Y three Z") into a lead-in and items.
 * The markers must come in order from the first one. Plain numbers need 3 or
 * more markers, ordinals 2 or more. Every item must have text. Plain numbers
 * before plural nouns are quantities, not a list ("one cable two adapters
 * three batteries" stays a sentence; owner decision 2026-10-27). Else null.
 */
export function splitCountedList(
  raw: string,
  lang: DictationLang | null,
): CountedList | null {
  if (!lang) return null;
  for (const { plain, seq } of MARKERS[lang]) {
    const pos: { at: number; len: number }[] = [];
    let from = 0;
    for (const marker of seq) {
      const re = word(marker);
      re.lastIndex = from;
      const hit = re.exec(raw);
      if (!hit) break;
      pos.push({ at: hit.index, len: hit[0].length });
      from = hit.index + hit[0].length;
    }
    if (pos.length < (plain ? 3 : 2)) continue;
    const items = pos.map((p, i) =>
      raw
        .slice(p.at + p.len, pos[i + 1]?.at)
        .trim()
        .replace(/^[,:.]\s*/, "")
        .replace(/[,;]\s*$/, ""),
    );
    if (items.some((x) => !x)) continue;
    if (plain && items.slice(1).every(isQuantity)) continue;
    return {
      leadIn: raw
        .slice(0, pos[0]?.at)
        .trim()
        .replace(/[,:]\s*$/, ""),
      items,
    };
  }
  return null;
}

/** Build the list text: "Lead-in:\n\n1. Item\n2. Item". */
export function formatCountedList(
  leadIn: string,
  items: readonly string[],
): string {
  const head = leadIn.replace(/[.,:;!]+$/, "").trim();
  const lines = items.map(
    (x, i) =>
      `${i + 1}. ${x
        .trim()
        .replace(/\.+$/, "")
        .replace(/^\p{Ll}/u, (c) => c.toUpperCase())}`,
  );
  return `${head ? `${head}:\n\n` : ""}${lines.join("\n")}`;
}
