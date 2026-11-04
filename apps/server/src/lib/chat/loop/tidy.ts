// Clean-up of the answer sentences of the tool loop, before the cites are set.
// A small model can hit the length limit of a sentence in the middle of a word
// or of a bracket, and it can write the same item twice. Both are general
// faults of the output. Code fixes them; no word list is involved.

import { type AnswerSentence, foldWords } from "../cites.js";

/** The length from which a sentence counts as cut by the limit of the schema. */
const CUT_AT = 295;
/** Two sentences with this share of the same words are one sentence. */
const SAME = 0.8;

/** A sentence that the length limit cut ends at a clause, or at a word with "…". */
export function endCleanly(text: string): string {
  // An open bracket at the end ("(S59") holds a label that was cut.
  let t = text.replace(/\s*[([【][^)\]】]{0,12}$/u, "").trimEnd();
  if (t.length < CUT_AT || /[.!?…)"”]$/u.test(t)) return t;
  const floor = Math.floor(t.length * 0.4);
  const stops = [". ", "; ", ": ", ", "].map((s) => t.lastIndexOf(s));
  const stop = Math.max(...stops);
  if (stop >= floor) return `${t.slice(0, stop).trimEnd()}.`;
  const space = t.lastIndexOf(" ");
  t = space >= floor ? t.slice(0, space) : t;
  return `${t.replace(/[,;:\s]+$/u, "")}…`;
}

const jaccard = (a: Set<string>, b: Set<string>): number => {
  let hit = 0;
  for (const w of a) if (b.has(w)) hit++;
  const union = a.size + b.size - hit;
  return union === 0 ? 0 : hit / union;
};

/** Ends cut sentences cleanly and drops a sentence that repeats an earlier one. */
export function tidySentences(xs: AnswerSentence[]): AnswerSentence[] {
  const kept: { s: AnswerSentence; words: Set<string> }[] = [];
  for (const x of xs) {
    const text = endCleanly(x.text);
    if (text === "") continue;
    const words = new Set(foldWords(text));
    if (words.size > 0 && kept.some((k) => jaccard(k.words, words) >= SAME))
      continue;
    kept.push({ s: { ...x, text }, words });
  }
  return kept.map((k) => k.s);
}
