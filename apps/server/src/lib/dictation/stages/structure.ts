// Code stages S1 and S2 (specs/dictation-pipeline.md 4.2): line commands and
// counted lists. Both run on the raw text, before the cleanup LLM, because
// Gemma 4 E2B deletes "new line" and merges counted items (spec 3).

import type { DictationLang } from "../language.js";

const LINE_COMMANDS: Record<DictationLang, RegExp> = {
  en: /\s*(?<![\p{L}])(new paragraph|next paragraph|new line|newline|next line)(?![\p{L}])[.,;:!]?\s*/giu,
  es: /\s*(?<![\p{L}])(punto y aparte|nuevo p[aá]rrafo|nueva l[ií]nea|salto de l[ií]nea)(?![\p{L}])[.,;:!]?\s*/giu,
  zh: /[，,。]?\s*(新段落|另起一段|下一段|换行)[，,。：:]?\s*/gu,
};

const PARAGRAPH = /paragraph|aparte|p[aá]rrafo|段/i;

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

const MARKERS: Record<DictationLang, string[][]> = {
  en: [
    ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"],
    [
      "first",
      "second",
      "third",
      "fourth",
      "fifth",
      "sixth",
      "seventh",
      "eighth",
      "ninth",
    ],
  ],
  es: [
    [
      "un|una|uno",
      "dos",
      "tres",
      "cuatro",
      "cinco",
      "seis",
      "siete",
      "ocho",
      "nueve",
    ],
    [
      "primero",
      "segundo",
      "tercero",
      "cuarto",
      "quinto",
      "sexto",
      "séptimo",
      "octavo",
      "noveno",
    ],
  ],
  zh: [
    [
      "一个",
      "两个|二个",
      "三个",
      "四个",
      "五个",
      "六个",
      "七个",
      "八个",
      "九个",
    ],
    ["第一", "第二", "第三", "第四", "第五", "第六", "第七", "第八", "第九"],
  ],
};

export interface CountedList {
  leadIn: string;
  items: string[];
}

/**
 * S2: split a counted list ("one X two Y three Z") into a lead-in and items.
 * The markers must come in order from the first one. Plain numbers need 3 or
 * more markers, ordinals 2 or more. Every item must have text. Else null.
 */
export function splitCountedList(
  raw: string,
  lang: DictationLang | null,
): CountedList | null {
  if (!lang) return null;
  for (const seq of MARKERS[lang]) {
    const plain = ["one", "un|una|uno", "一个"].includes(seq[0] ?? "");
    const min = plain ? 3 : 2;
    const pos: { at: number; len: number }[] = [];
    let from = 0;
    for (const marker of seq) {
      const re =
        lang === "zh"
          ? new RegExp(`(?<![第一二两三四五六七八九十])(?:${marker})`, "g")
          : new RegExp(`(?<![\\p{L}])(?:${marker})(?![\\p{L}])`, "giu");
      re.lastIndex = from;
      const hit = re.exec(raw);
      if (!hit) break;
      pos.push({ at: hit.index, len: hit[0].length });
      from = hit.index + hit[0].length;
    }
    if (pos.length < min) continue;
    const items = pos.map((p, i) =>
      raw
        .slice(p.at + p.len, pos[i + 1]?.at)
        .trim()
        .replace(/^[,，、:：.]\s*/, "")
        .replace(/[,，、;；]\s*$/, ""),
    );
    if (items.some((x) => !x)) continue;
    return {
      leadIn: raw
        .slice(0, pos[0]?.at)
        .trim()
        .replace(/[,，、:：]\s*$/, ""),
      items,
    };
  }
  return null;
}

/** Build the list text: "Lead-in:\n\n1. Item\n2. Item". */
export function formatCountedList(
  leadIn: string,
  items: readonly string[],
  lang: DictationLang | null,
): string {
  const head = leadIn.replace(/[.。,，:：;；!！]+$/, "").trim();
  const lines = items.map(
    (x, i) =>
      `${i + 1}. ${x
        .trim()
        .replace(/[.。]+$/, "")
        .replace(/^\p{Ll}/u, (c) => c.toUpperCase())}`,
  );
  return `${head ? `${head}${lang === "zh" ? "：" : ":"}\n\n` : ""}${lines.join("\n")}`;
}
