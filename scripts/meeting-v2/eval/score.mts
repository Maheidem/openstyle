// score.mts: the gold scorers of the meeting quality eval. Pure functions:
// they take a gold key (gold.mts) and plain database rows, and return
// counts, rates and keys. A key is a channel and a start
// ("system@83400"), a gold id, an output index ("actionItems[2]") or a
// speaker label. A score never holds meeting text.
//
// Stages:
//   asr       WER and CER per channel of the raw segment text vs the gold
//             transcript, for all text and for verified text only. The WER
//             aligns normalized words (normalizeWords: number words are
//             digits, an exact adjacent repeat counts once); werRaw keeps
//             the rule before 2026-10-22, so old baselines compare
//   enhance   the same for the enhanced text, the Enhance delta (ASR WER -
//             Enhance WER), fixes found and missed, must-not-change
//             violations
//   summary   gold decisions and action items matched by keywords, owner
//             and due correct / wrong / missing, unmatched output items,
//             must-not-claim hits (a hit is a hard fail)
//   tags      precision and recall against the expected tags and synonyms
//   speakers  suggested names vs the gold map (a wrong name is a hard fail)
//   spans     silver keys: the share of named spans (terms, products,
//             people, ...) that the ASR text and the Enhance text hold near
//             the span time (scoreSpans). A turn with wer_eligible gives the
//             eligible WER (wordsEligible) next to the WER of all turns.

import { normalizeTagName } from "../../../packages/validations/src/meeting-tags.ts";
import { levenshtein, type SegmentRow } from "./checks.mts";
import {
  CHANNELS,
  type Channel,
  type Gold,
  type GoldItem,
  type GoldSpan,
} from "./gold.mts";

// --- Text normalization ----------------------------------------------------------

/**
 * The words of a text: lower case, every character that is not a letter or
 * a digit is a space. The same rule as `words()` in metrics.mjs and
 * `normalizeText` in packages/stt/src/text.ts.
 */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// --- Score normalization (issue #211, owner decisions 2026-10-22) --------------
//
// The WER of the asr and enhance stages aligns normalized words: number words
// become digits ("twenty one" and "21" are both "21", English and Portuguese),
// and an exact adjacent repeat counts once ("the the" is "the"; Enhance may
// remove such a stutter). The same rule runs on the gold and on the output.
// The raw WER (words() only, the rule before 2026-10-22) stays as `werRaw`.

const UNITS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  um: 1,
  uma: 1,
  dois: 2,
  duas: 2,
  três: 3,
  tres: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
  oito: 8,
  nove: 9,
};
const TEENS: Record<string, number> = {
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  dez: 10,
  onze: 11,
  doze: 12,
  treze: 13,
  catorze: 14,
  quatorze: 14,
  quinze: 15,
  dezesseis: 16,
  dezasseis: 16,
  dezessete: 17,
  dezassete: 17,
  dezoito: 18,
  dezenove: 19,
  dezanove: 19,
};
const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  vinte: 20,
  trinta: 30,
  quarenta: 40,
  cinquenta: 50,
  cinqüenta: 50,
  sessenta: 60,
  setenta: 70,
  oitenta: 80,
  noventa: 90,
};
/** Portuguese hundreds are one word ("duzentos"); English uses "<unit> hundred". */
const PT_HUNDREDS: Record<string, number> = {
  cem: 100,
  cento: 100,
  duzentos: 200,
  duzentas: 200,
  trezentos: 300,
  trezentas: 300,
  quatrocentos: 400,
  quatrocentas: 400,
  quinhentos: 500,
  quinhentas: 500,
  seiscentos: 600,
  seiscentas: 600,
  setecentos: 700,
  setecentas: 700,
  oitocentos: 800,
  oitocentas: 800,
  novecentos: 900,
  novecentas: 900,
};
const SCALES: Record<string, number> = {
  thousand: 1000,
  mil: 1000,
  million: 1_000_000,
  milhão: 1_000_000,
  milhao: 1_000_000,
  milhões: 1_000_000,
  milhoes: 1_000_000,
};
/** "one hundred and five", "cento e vinte", "mil e duzentos". */
const CONNECT = new Set(["and", "e"]);

const has = (o: Record<string, number>, w: string | undefined) =>
  w !== undefined && Object.hasOwn(o, w);
const startsTens = (w: string | undefined) =>
  has(TEENS, w) || has(TENS, w) || (has(UNITS, w) && UNITS[w as string] !== 0);

/** One number below 1000 that starts at ws[i]: its value and the next index. */
function readGroup(ws: string[], i: number): { v: number; j: number } | null {
  let v = 0;
  let j = i;
  let any = false;
  const w = ws[j];
  if (has(UNITS, w) && UNITS[w as string] !== 0 && ws[j + 1] === "hundred") {
    v = (UNITS[w as string] as number) * 100;
    j += 2;
    any = true;
  } else if (w === "hundred") {
    v = 100;
    j += 1;
    any = true;
  } else if (has(PT_HUNDREDS, w)) {
    v = PT_HUNDREDS[w as string] as number;
    j += 1;
    any = true;
  }
  let k = j;
  if (any && CONNECT.has(ws[k] ?? "") && startsTens(ws[k + 1])) k++;
  const t = ws[k];
  if (has(TEENS, t)) {
    v += TEENS[t as string] as number;
    j = k + 1;
    any = true;
  } else if (has(TENS, t)) {
    v += TENS[t as string] as number;
    j = k + 1;
    any = true;
    // "twenty one"; Portuguese "vinte e um".
    const m = ws[j] === "e" ? j + 1 : j;
    const u = ws[m];
    if (has(UNITS, u) && UNITS[u as string] !== 0) {
      v += UNITS[u as string] as number;
      j = m + 1;
    }
  } else if (has(UNITS, t) && !(any && UNITS[t as string] === 0)) {
    v += UNITS[t as string] as number;
    j = k + 1;
    any = true;
  }
  return any ? { v, j } : null;
}

/** The longest number in words that starts at ws[i], or null. */
function readNumber(ws: string[], i: number): { v: number; j: number } | null {
  let total = 0;
  let j = i;
  let lastScale = Number.POSITIVE_INFINITY;
  let any = false;
  let g = readGroup(ws, j);
  for (;;) {
    if (g) j = g.j;
    const s = SCALES[ws[j] ?? ""];
    if (s !== undefined && s < lastScale && (g === null || g.v > 0)) {
      total += (g?.v ?? 1) * s;
      lastScale = s;
      j += 1;
      any = true;
      const m = CONNECT.has(ws[j] ?? "") ? j + 1 : j;
      g = readGroup(ws, m);
      if (!g) break;
      continue;
    }
    if (g) {
      total += g.v;
      any = true;
    }
    break;
  }
  return any && j > i ? { v: total, j } : null;
}

/**
 * The normal form of a word stream for the WER: number words become digits,
 * then an exact adjacent repeat counts once. `flags` (one per word) follow
 * the words: a number keeps the flag only when all its words had it; a
 * removed repeat takes its flag away with it.
 */
export function normalizeWords(
  ws: string[],
  flags: boolean[] = ws.map(() => true),
): { words: string[]; flags: boolean[] } {
  const nums: string[] = [];
  const numFlags: boolean[] = [];
  for (let i = 0; i < ws.length; ) {
    const n = readNumber(ws, i);
    if (n) {
      nums.push(String(n.v));
      numFlags.push(flags.slice(i, n.j).every(Boolean));
      i = n.j;
    } else {
      nums.push(ws[i] as string);
      numFlags.push(flags[i] ?? false);
      i++;
    }
  }
  const out: string[] = [];
  const outFlags: boolean[] = [];
  nums.forEach((w, k) => {
    if (out.length > 0 && out[out.length - 1] === w) return;
    out.push(w);
    outFlags.push(numFlags[k] as boolean);
  });
  return { words: out, flags: outFlags };
}

/**
 * The text without exact immediate repeated tokens: a whitespace token with
 * the same letters and digits as the token before it (any case, any
 * punctuation) goes. Owner rule 2026-10-26: Enhance removes exact repeated
 * words, so the normalized WER ignores them on both sides. normalizeWords
 * collapses repeated words, but words() splits "I'm" into "i m", so it does
 * not see "I'm I'm" as a repeat. This step does.
 */
export function dropRepeatTokens(text: string): string {
  const keyOf = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const out: string[] = [];
  let prev = "";
  for (const tok of text.split(/\s+/).filter(Boolean)) {
    const key = keyOf(tok);
    if (key !== "" && key === prev) continue;
    out.push(tok);
    prev = key;
  }
  return out.join(" ");
}

/**
 * The words of a text for the normalized WER: a thousands separator between
 * digits goes ("1,000" and "1.000" are "1000"), exact repeated tokens go
 * (dropRepeatTokens), then words().
 */
export function scoreWords(text: string): string[] {
  return words(
    dropRepeatTokens(text.replace(/(\d)[.,](?=\d{3}(?!\d))/g, "$1")),
  );
}

const round = (v: number, digits = 4) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};
const rate = (errors: number, ref: number): number | null =>
  ref === 0 ? null : round(errors / ref);

// --- Word alignment, WER and CER ------------------------------------------------------

type Op = "eq" | "sub" | "del" | "ins";
interface Step {
  op: Op;
  /** Index into the reference, or -1 for an insertion. */
  r: number;
  /** Index into the hypothesis, or -1 for a deletion. */
  h: number;
}

/** The largest alignment matrix (reference words x hypothesis words). */
const MAX_CELLS = 400_000_000;

/**
 * A minimal edit alignment of two word arrays (Levenshtein with a
 * backtrace). Ties prefer a match or a substitution, then a deletion, then
 * an insertion, so the result is deterministic.
 */
export function alignWords(ref: string[], hyp: string[]): Step[] {
  const n = ref.length;
  const m = hyp.length;
  if ((n + 1) * (m + 1) > MAX_CELLS)
    throw new Error(
      `alignment too large (${n} x ${m} words); split the channel`,
    );
  // dir: 0 diagonal, 1 up (deletion), 2 left (insertion).
  const dir = new Uint8Array((n + 1) * (m + 1));
  let prev = new Uint32Array(m + 1);
  let cur = new Uint32Array(m + 1);
  for (let j = 0; j <= m; j++) {
    prev[j] = j;
    dir[j] = 2;
  }
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    dir[i * (m + 1)] = 1;
    const ri = ref[i - 1];
    for (let j = 1; j <= m; j++) {
      const diag = (prev[j - 1] as number) + (ri === hyp[j - 1] ? 0 : 1);
      const up = (prev[j] as number) + 1;
      const left = (cur[j - 1] as number) + 1;
      let best = diag;
      let d = 0;
      if (up < best) {
        best = up;
        d = 1;
      }
      if (left < best) {
        best = left;
        d = 2;
      }
      cur[j] = best;
      dir[i * (m + 1) + j] = d;
    }
    [prev, cur] = [cur, prev];
  }
  const steps: Step[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const d = i === 0 ? 2 : j === 0 ? 1 : (dir[i * (m + 1) + j] as number);
    if (d === 0) {
      steps.push({
        op: ref[i - 1] === hyp[j - 1] ? "eq" : "sub",
        r: i - 1,
        h: j - 1,
      });
      i--;
      j--;
    } else if (d === 1) {
      steps.push({ op: "del", r: i - 1, h: -1 });
      i--;
    } else {
      steps.push({ op: "ins", r: -1, h: j - 1 });
      j--;
    }
  }
  return steps.reverse();
}

export interface ErrorRate {
  errors: number;
  ref: number;
  rate: number | null;
}

export interface ChannelScore {
  /** Normalized words (normalizeWords). */
  words: ErrorRate;
  /** Raw words (words() only): the WER before 2026-10-22. */
  wordsRaw: ErrorRate;
  /** Characters of the raw words. */
  chars: ErrorRate;
  wordsVerified: ErrorRate;
  wordsVerifiedRaw: ErrorRate;
  charsVerified: ErrorRate;
  /**
   * Normalized words of the turns with wer_eligible true (silver keys).
   * Absent when no gold turn has the field.
   */
  wordsEligible?: ErrorRate;
  /** Edit counts of the normalized alignment. */
  substitutions: number;
  deletions: number;
  insertions: number;
}

/** The rates of one alignment (errorRates): no raw / normalized split. */
export type ErrorRates = Omit<ChannelScore, "wordsRaw" | "wordsVerifiedRaw">;

const er = (errors: number, ref: number): ErrorRate => ({
  errors,
  ref,
  rate: rate(errors, ref),
});

/** The characters of words joined by one space, with a verified flag per word. */
function charCount(ws: string[], flags: boolean[], onlyVerified: boolean) {
  let n = 0;
  for (let k = 0; k < ws.length; k++) {
    if (onlyVerified && !flags[k]) continue;
    n += Array.from(ws[k] as string).length;
    // One separator to the next word (both verified for the verified count).
    if (k + 1 < ws.length && (!onlyVerified || flags[k + 1])) n += 1;
  }
  return n;
}

/**
 * WER and CER of a hypothesis against a reference. `verified` holds one
 * flag per reference word. An error counts as verified when its reference
 * word is verified; an insertion takes the flag of the reference word
 * before it (or the first word at the start). `eligible` (optional, one
 * flag per reference word) gives `wordsEligible` by the same rule.
 *
 * WER = (substitutions + deletions + insertions) / reference words.
 * CER is computed on the word alignment: the character edit distance of
 * each span between two equal words, over the characters of the reference
 * joined by single spaces. A span with words on one side only also counts
 * the one space that goes with it.
 */
export function errorRates(
  ref: string[],
  hyp: string[],
  verified: boolean[] = ref.map(() => true),
  eligible?: boolean[],
): ErrorRates {
  const steps = alignWords(ref, hyp);
  const flagAt = (r: number) => (r < 0 ? false : (verified[r] ?? false));
  const eligibleAt = (r: number) => (r < 0 ? false : (eligible?.[r] ?? false));
  let werE = 0;
  let lastRef = -1;
  let sub = 0;
  let del = 0;
  let ins = 0;
  let werV = 0;
  const anchors: number[] = [];
  for (const s of steps) {
    const anchor = s.r >= 0 ? s.r : lastRef >= 0 ? lastRef : 0;
    anchors.push(anchor);
    if (s.r >= 0) lastRef = s.r;
    if (s.op === "eq") continue;
    if (s.op === "sub") sub++;
    else if (s.op === "del") del++;
    else ins++;
    if (flagAt(anchor)) werV++;
    if (eligibleAt(anchor)) werE++;
  }
  let charErr = 0;
  let charErrV = 0;
  for (let k = 0; k < steps.length; ) {
    if ((steps[k] as Step).op === "eq") {
      k++;
      continue;
    }
    const start = k;
    const r: string[] = [];
    const h: string[] = [];
    while (k < steps.length && (steps[k] as Step).op !== "eq") {
      const s = steps[k] as Step;
      if (s.r >= 0) r.push(ref[s.r] as string);
      if (s.h >= 0) h.push(hyp[s.h] as string);
      k++;
    }
    let d = levenshtein(Array.from(r.join(" ")), Array.from(h.join(" ")));
    if (r.length === 0 && ref.length > 0) d += 1;
    if (h.length === 0 && hyp.length > 0) d += 1;
    charErr += d;
    if (flagAt(anchors[start] as number)) charErrV += d;
  }
  const nV = verified.filter(Boolean).length;
  return {
    words: er(sub + del + ins, ref.length),
    chars: er(charErr, charCount(ref, verified, false)),
    wordsVerified: er(werV, nV),
    charsVerified: er(charErrV, charCount(ref, verified, true)),
    ...(eligible
      ? { wordsEligible: er(werE, eligible.filter(Boolean).length) }
      : {}),
    substitutions: sub,
    deletions: del,
    insertions: ins,
  };
}

const effective = (s: SegmentRow) => s.enhanced_text ?? s.text ?? "";
const byStart = (a: SegmentRow, b: SegmentRow) =>
  (a.start_ms ?? 0) - (b.start_ms ?? 0) || a.idx - b.idx;

/**
 * Score one channel at meeting level: the words of all gold turns in time
 * order vs the words of all segments of the channel in time order. A new
 * segmentation does not change the score. WER and its edit counts use the
 * normalized words (normalizeWords on both sides); `wordsRaw`,
 * `wordsVerifiedRaw` and the CER use the raw words.
 */
export function scoreChannel(
  gold: Gold,
  channel: Channel,
  rows: SegmentRow[],
  stage: "asr" | "enhance",
): ChannelScore | null {
  const turns = gold.transcript?.[channel];
  if (!turns) return null;
  const ref: string[] = [];
  const flags: boolean[] = [];
  const nRef: string[] = [];
  const nFlags: boolean[] = [];
  const eFlags: boolean[] = [];
  for (const t of turns) {
    for (const w of words(t.text)) {
      ref.push(w);
      flags.push(t.verified);
    }
    for (const w of scoreWords(t.text)) {
      nRef.push(w);
      nFlags.push(t.verified);
      eFlags.push(t.werEligible === true);
    }
  }
  const texts = rows
    .filter((s) => s.source === channel)
    .sort(byStart)
    .map((s) => (stage === "asr" ? (s.text ?? "") : effective(s)));
  const raw = errorRates(ref, texts.flatMap(words), flags);
  const n = normalizeWords(nRef, nFlags);
  // normalizeWords gives the same words for any flags, so the eligible
  // flags line up with n.words.
  const norm = errorRates(
    n.words,
    normalizeWords(texts.flatMap(scoreWords)).words,
    n.flags,
    hasEligible(gold) ? normalizeWords(nRef, eFlags).flags : undefined,
  );
  return {
    ...norm,
    chars: raw.chars,
    charsVerified: raw.charsVerified,
    wordsRaw: raw.words,
    wordsVerifiedRaw: raw.wordsVerified,
  };
}

/** True when a gold turn has wer_eligible (a silver key with the field). */
function hasEligible(gold: Gold): boolean {
  return CHANNELS.some((c) =>
    gold.transcript?.[c]?.some((t) => t.werEligible !== undefined),
  );
}

/**
 * WER or CER of several channels together (sum of errors / sum of words).
 * A channel score without the field (wordsEligible of a v2 key) is left out.
 */
export function pooled(
  scores: (ChannelScore | null)[],
  field: keyof Pick<
    ChannelScore,
    | "words"
    | "wordsRaw"
    | "chars"
    | "wordsVerified"
    | "wordsVerifiedRaw"
    | "charsVerified"
    | "wordsEligible"
  >,
): ErrorRate | null {
  const own = scores.flatMap((s) => (s?.[field] ? [s[field]] : []));
  if (own.length === 0) return null;
  const e = own.reduce((a, x) => a + x.errors, 0);
  const r = own.reduce((a, x) => a + x.ref, 0);
  return er(e, r);
}

// --- Fixes and must-not-change spans (gold v2 keys) ------------------------------------

export interface FixScore {
  fixesFound: number;
  fixesMissed: number;
  missedKeys: string[];
  mustNotChangeViolations: number;
  violationKeys: string[];
  /** Entries with no segment within the tolerance, or a span not in the raw text. */
  badEntries: number;
}

/**
 * A fix is found when a segment of its channel within the time tolerance
 * holds `to` in the enhanced text and no longer holds `from` (`from` may be
 * ""). A must-not-change span is violated when the segments that hold it in
 * the raw text do not hold it in the enhanced text.
 */
export function scoreFixes(gold: Gold, rows: SegmentRow[]): FixScore {
  const near = (channel: Channel, startMs: number) =>
    rows.filter(
      (s) =>
        s.source === channel &&
        s.start_ms !== null &&
        Math.abs(s.start_ms - startMs) <= gold.timeToleranceMs,
    );
  const out: FixScore = {
    fixesFound: 0,
    fixesMissed: 0,
    missedKeys: [],
    mustNotChangeViolations: 0,
    violationKeys: [],
    badEntries: 0,
  };
  for (const f of gold.fixes) {
    const cands = near(f.channel, f.startMs);
    if (cands.length === 0) {
      out.badEntries++;
      continue;
    }
    const found = cands.some((s) => {
      const t = effective(s);
      const gone =
        f.from === "" || f.to.includes(f.from) || !t.includes(f.from);
      return t.includes(f.to) && gone;
    });
    if (found) out.fixesFound++;
    else {
      out.fixesMissed++;
      out.missedKeys.push(`${f.channel}@${f.startMs}`);
    }
  }
  for (const m of gold.mustNotChange) {
    const holders = near(m.channel, m.startMs).filter((s) =>
      (s.text ?? "").includes(m.span),
    );
    if (holders.length === 0) {
      out.badEntries++;
      continue;
    }
    if (!holders.every((s) => effective(s).includes(m.span))) {
      out.mustNotChangeViolations++;
      out.violationKeys.push(`${m.channel}@${m.startMs}`);
    }
  }
  return out;
}

// --- Summary ------------------------------------------------------------------------

/** True when the words of `phrase` appear in order, next to each other, in `text`. */
function holds(textWords: string[], phrase: string): boolean {
  const p = words(phrase);
  if (p.length === 0) return false;
  outer: for (let i = 0; i + p.length <= textWords.length; i++) {
    for (let k = 0; k < p.length; k++)
      if (textWords[i + k] !== p[k]) continue outer;
    return true;
  }
  return false;
}
const holdsAll = (text: string, keywords: string[]) => {
  const w = words(text);
  return keywords.every((k) => holds(w, k));
};

/** Two names or times are the same when the words of one hold all words of the other. */
function sameWords(a: string, b: string): boolean {
  const wa = words(a);
  const wb = words(b);
  if (wa.length === 0 || wb.length === 0) return false;
  const sa = new Set(wa);
  const sb = new Set(wb);
  return wa.every((w) => sb.has(w)) || wb.every((w) => sa.has(w));
}

/**
 * The output value is the gold value. A gold value "A (B)" names one person
 * or time in two forms, for example "Ana (Them 2)" or "Me (Ana)". The output
 * can use either form, so it is compared with the whole value, with A and
 * with B. Issue #273: the output "Ana Lima" for the gold "Ana (Them 2)" was
 * scored wrong, because neither word set held the other.
 */
function sameValue(gold: string, output: string): boolean {
  const forms = /^(.+?)\s*\(([^()]+)\)\s*$/.exec(gold);
  const alternatives = forms ? [gold, forms[1] ?? "", forms[2] ?? ""] : [gold];
  return alternatives.some((g) => sameWords(g, output));
}

export interface ValueScore {
  correct: number;
  wrong: number;
  missing: number;
  /** Gold ids with a wrong value. */
  wrongIds: string[];
}

export interface KindScore {
  gold: number;
  output: number;
  matched: number;
  recall: number | null;
  precision: number | null;
  /** Gold ids that no output item matched. */
  missedIds: string[];
  /** Output items that match no gold item, by index ("actionItems[2]"). */
  unmatchedOutput: string[];
}

export interface SummaryScore {
  /** false when summary_json is missing or not a summary object. */
  parsed: boolean;
  decisions: KindScore;
  actionItems: KindScore;
  owner: ValueScore;
  due: ValueScore;
  /** Must-not-claim ids that the output holds (each one is a hard fail). */
  mustNotClaimHits: string[];
}

interface OutItem {
  text: string;
  owner: string | null;
  due: string | null;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown) =>
  typeof v === "string" && v.trim() !== "" ? v : null;

function parseSummary(json: string | null) {
  try {
    const v = JSON.parse(json ?? "null");
    if (typeof v !== "object" || v === null) return null;
    const list = (x: unknown) => (Array.isArray(x) ? x : []);
    return {
      decisions: list(v.decisions).map(
        (d): OutItem => ({ text: str(d), owner: null, due: null }),
      ),
      actionItems: list(v.actionItems).map(
        (a): OutItem => ({
          text: str(a?.task),
          owner: strOrNull(a?.owner),
          due: strOrNull(a?.due),
        }),
      ),
      other: [str(v.overview), ...list(v.keyPoints), ...list(v.openQuestions)]
        .map(str)
        .filter(Boolean),
    };
  } catch {
    return null;
  }
}

function matchKind(
  kind: "decisions" | "actionItems",
  gold: GoldItem[],
  out: OutItem[],
  owner: ValueScore,
  due: ValueScore,
): KindScore {
  const used = new Set<number>();
  const missedIds: string[] = [];
  const value = (
    s: ValueScore,
    id: string,
    g: string | null,
    o: string | null,
  ) => {
    if (g === null && o === null) s.correct++;
    else if (g === null || (o !== null && !sameValue(g, o))) {
      s.wrong++;
      s.wrongIds.push(id);
    } else if (o === null) s.missing++;
    else s.correct++;
  };
  for (const g of gold) {
    const k = out.findIndex(
      (o, i) => !used.has(i) && holdsAll(o.text, g.keywords),
    );
    if (k < 0) {
      missedIds.push(g.id);
      continue;
    }
    used.add(k);
    const o = out[k] as OutItem;
    value(owner, g.id, g.owner, o.owner);
    value(due, g.id, g.due, o.due);
  }
  const matched = used.size;
  return {
    gold: gold.length,
    output: out.length,
    matched,
    recall: rate(matched, gold.length),
    precision: rate(matched, out.length),
    missedIds,
    unmatchedOutput: out.flatMap((_, i) =>
      used.has(i) ? [] : [`${kind}[${i}]`],
    ),
  };
}

/**
 * Score the summary_json of a run against the gold summary. An output item
 * matches a gold item when its text holds every keyword of the gold item
 * (each keyword as a word sequence). Each output item matches one gold item
 * at most (first match in gold order). Owner and due are scored on the
 * matched items only: a value where the gold has none is wrong (an invented
 * owner or date). A must-not-claim entry is hit when one output text (an
 * action item with its owner and due, a decision, a key point, an open
 * question or the overview) holds all its keywords.
 */
export function scoreSummary(
  gold: Gold,
  summaryJson: string | null,
): SummaryScore | null {
  const g = gold.summary;
  if (!g) return null;
  const parsed = parseSummary(summaryJson);
  const out = parsed ?? { decisions: [], actionItems: [], other: [] };
  const owner: ValueScore = { correct: 0, wrong: 0, missing: 0, wrongIds: [] };
  const due: ValueScore = { correct: 0, wrong: 0, missing: 0, wrongIds: [] };
  const decisions = matchKind(
    "decisions",
    g.decisions,
    out.decisions,
    owner,
    due,
  );
  const actionItems = matchKind(
    "actionItems",
    g.actionItems,
    out.actionItems,
    owner,
    due,
  );
  const texts = [
    ...out.decisions.map((d) => d.text),
    ...out.actionItems.map((a) =>
      [a.text, a.owner ?? "", a.due ?? ""].join(" "),
    ),
    ...out.other,
  ];
  return {
    parsed: parsed !== null,
    decisions,
    actionItems,
    owner,
    due,
    mustNotClaimHits: g.mustNotClaim
      .filter((c) => texts.some((t) => holdsAll(t, c.keywords)))
      .map((c) => c.id),
  };
}

// --- Tags ---------------------------------------------------------------------------

export interface TagScore {
  output: number;
  expected: number;
  /** Output tags that equal an expected tag or a synonym. */
  matchedOutput: number;
  /** Expected tags that an output tag names (by name or synonym). */
  matchedExpected: number;
  precision: number | null;
  recall: number | null;
  /** By index only ("tags[3]", "expected[1]"). */
  unmatchedOutput: string[];
  missedExpected: string[];
}

/** Tag names are compared after normalizeTagName (the app's rule, meeting-tags.ts). */
export function scoreTags(gold: Gold, outputTags: string[]): TagScore | null {
  const g = gold.tags;
  if (!g) return null;
  const forms = g.expected.map(
    (e) =>
      new Set([e.name, ...e.synonyms].map(normalizeTagName).filter(Boolean)),
  );
  const out = outputTags.map(normalizeTagName);
  const outHit = out.map((t) => forms.some((f) => f.has(t)));
  const expHit = forms.map((f) => out.some((t) => f.has(t)));
  const mo = outHit.filter(Boolean).length;
  const me = expHit.filter(Boolean).length;
  return {
    output: out.length,
    expected: forms.length,
    matchedOutput: mo,
    matchedExpected: me,
    precision: rate(mo, out.length),
    recall: rate(me, forms.length),
    unmatchedOutput: outHit.flatMap((h, i) => (h ? [] : [`tags[${i}]`])),
    missedExpected: expHit.flatMap((h, i) => (h ? [] : [`expected[${i}]`])),
  };
}

// --- Speakers -----------------------------------------------------------------------

export interface SpeakerRow {
  label: string;
  suggested_name: string | null;
  suggested_kind?: string | null;
}

export interface SpeakerScore {
  correct: number;
  /** A name that differs from the gold name, or a name where the gold has none. */
  wrong: number;
  missing: number;
  wrongLabels: string[];
  missingLabels: string[];
}

/**
 * Score the speaker suggestions against the gold map (label -> name or
 * null). A suggestion of kind "role" is no name. A gold name with no
 * suggestion is missing. A suggested name that is not the gold name, or a
 * name for a label whose gold is null, is wrong (a hard fail). Labels that
 * the gold does not list are not scored.
 */
export function scoreSpeakers(
  gold: Gold,
  rows: SpeakerRow[],
): SpeakerScore | null {
  const g = gold.speakers;
  if (!g) return null;
  const s: SpeakerScore = {
    correct: 0,
    wrong: 0,
    missing: 0,
    wrongLabels: [],
    missingLabels: [],
  };
  for (const [label, name] of Object.entries(g).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const row = rows.find((r) => r.label === label);
    const said =
      row && row.suggested_kind !== "role"
        ? strOrNull(row.suggested_name)
        : null;
    if (name === null && said === null) s.correct++;
    else if (said === null) {
      s.missing++;
      s.missingLabels.push(label);
    } else if (name !== null && sameValue(name, said)) s.correct++;
    else {
      s.wrong++;
      s.wrongLabels.push(label);
    }
  }
  return s;
}

// --- Named spans (silver keys) ------------------------------------------------------

/** The time window around a span, on each side (ms). */
export const SPAN_TOLERANCE_MS = 3000;
export const SPAN_GROUPS = ["term", "person", "other"] as const;
export type SpanGroup = (typeof SPAN_GROUPS)[number];

export interface SpanCount {
  hits: number;
  n: number;
  /** hits / n, or null when n is 0. */
  rate: number | null;
}

export interface SpanScore {
  /** The scored spans: confidence high or medium. */
  all: SpanCount;
  high: SpanCount;
  /** term = term + product; other = org, place, other. */
  byLabel: Record<SpanGroup, SpanCount>;
  byVocab: { inVocab: SpanCount; notInVocab: SpanCount };
  /** Spans with confidence unsure: not scored. */
  unsure: number;
  /** Spans with no words after normalization: not scored. */
  empty: number;
  /**
   * "<channel>@<startMs>:<label>" of the missed spans, never their text.
   * Each key occurs once per meeting (two missed spans can share a key).
   */
  missedKeys: string[];
}

export const spanGroup = (label: GoldSpan["label"]): SpanGroup =>
  label === "term" || label === "product"
    ? "term"
    : label === "person"
      ? "person"
      : "other";

const spanCount = (hits: number, n: number): SpanCount => ({
  hits,
  n,
  rate: rate(hits, n),
});

/** The sum of span scores (pooled over meetings). */
export function addSpanScores(xs: SpanScore[]): SpanScore {
  const sum = (f: (x: SpanScore) => SpanCount) =>
    spanCount(
      xs.reduce((a, x) => a + f(x).hits, 0),
      xs.reduce((a, x) => a + f(x).n, 0),
    );
  return {
    all: sum((x) => x.all),
    high: sum((x) => x.high),
    byLabel: Object.fromEntries(
      SPAN_GROUPS.map((g) => [g, sum((x) => x.byLabel[g])]),
    ) as Record<SpanGroup, SpanCount>,
    byVocab: {
      inVocab: sum((x) => x.byVocab.inVocab),
      notInVocab: sum((x) => x.byVocab.notInVocab),
    },
    unsure: xs.reduce((a, x) => a + x.unsure, 0),
    empty: xs.reduce((a, x) => a + x.empty, 0),
    missedKeys: xs.flatMap((x) => x.missedKeys),
  };
}

/**
 * The words of a text for span matching: scoreWords, normalizeWords, then
 * the accent fold of the silver vote (normalize_silver3.py): NFKD, and the
 * combining marks go ("José" is "jose"). Python drops the characters with a
 * combining class; this drops \p{Mn}. They differ only for a few marks of
 * other scripts (for example Thai), not for Latin text. The WER does not
 * use this rule.
 */
export function spanWords(text: string): string[] {
  return normalizeWords(scoreWords(text))
    .words.join(" ")
    .normalize("NFKD")
    .replace(/\p{Mn}/gu, "")
    .split(/\s+/)
    .filter(Boolean);
}

/** A span to match: its channel, its time and its words (spanWords). */
export interface SpanTarget {
  channel: Channel;
  startMs: number;
  endMs: number;
  words: string[];
}

/** A segment of the output: its channel, its time and its words (spanWords). */
export interface SpanSegment {
  source: string;
  start: number;
  end: number;
  words: string[];
}

/**
 * The number of window words from `i` whose text without spaces equals
 * `target`, or 0. The vote rule (normalize_silver3.py contains): join whole
 * words from `i` until the length reaches the target length, then compare.
 * So the match starts and ends at word edges, "open style" and "openstyle"
 * match both ways, and "zor" does not match "zorblax".
 */
function joinedMatch(win: string[], i: number, target: string): number {
  let acc = "";
  let j = i;
  while (j < win.length && acc.length < target.length) acc += win[j++];
  return acc === target ? j - i : 0;
}

/**
 * The hit of each span (true or false, in input order). A span is a hit
 * when its words, without spaces, equal a run of whole words of the window:
 * the segments of its channel that overlap [startMs - tolMs, endMs +
 * tolMs], joined in the order of `segs`. One occurrence of the output
 * words counts for one span only: the spans take occurrences in the order
 * of their window end, each the first free occurrence of its window. This
 * greedy order gives the most hits that one-occurrence-per-span allows
 * (two spans of the same words never lose a hit to the order).
 * score_silver.py (span_match.py) uses the same rule. `segs` must be in
 * time order.
 */
export function spanHits(
  spans: SpanTarget[],
  segs: SpanSegment[],
  tolMs: number = SPAN_TOLERANCE_MS,
): boolean[] {
  const offset: number[] = [];
  segs.reduce((n, s, i) => {
    offset[i] = n;
    return n + s.words.length;
  }, 0);
  const used = new Set<string>();
  const hits = spans.map(() => false);
  const order = spans
    .map((_, i) => i)
    .sort((a, b) => {
      const x = spans[a] as SpanTarget;
      const y = spans[b] as SpanTarget;
      return x.endMs - y.endMs || x.startMs - y.startMs || a - b;
    });
  for (const k of order) {
    const sp = spans[k] as SpanTarget;
    const target = sp.words.join("");
    if (target === "") continue;
    // The window words with their position in all of `segs`: the key of
    // an occurrence is the list of positions of its words.
    const win: { w: string; pos: number }[] = [];
    segs.forEach((s, si) => {
      if (
        s.source === sp.channel &&
        s.end >= sp.startMs - tolMs &&
        s.start <= sp.endMs + tolMs
      )
        s.words.forEach((w, wi) => {
          win.push({ w, pos: (offset[si] as number) + wi });
        });
    });
    const ws = win.map((x) => x.w);
    for (let i = 0; !hits[k] && i < win.length; i++) {
      const n = joinedMatch(ws, i, target);
      if (n === 0) continue;
      const key = win
        .slice(i, i + n)
        .map((x) => x.pos)
        .join(",");
      if (used.has(key)) continue;
      used.add(key);
      hits[k] = true;
    }
  }
  return hits;
}

/**
 * Span accuracy of one stage. A span with confidence high or medium is a hit
 * when its words (spanWords: normal words with accents folded) occur in the
 * words of the stage text of the segments of its channel that overlap
 * [startMs - tolMs, endMs + tolMs], as one run or as one run without spaces
 * (spanHits). One output occurrence counts for one span only. Each segment
 * is normalized on its own, then the segments join in time order. A segment
 * without end_ms counts as a point at start_ms. asr reads the raw text;
 * enhance reads the enhanced text (the raw text when there is none). Unsure
 * spans and spans with no words are counted, not scored.
 */
export function scoreSpans(
  spans: GoldSpan[],
  rows: SegmentRow[],
  stage: "asr" | "enhance",
  tolMs: number = SPAN_TOLERANCE_MS,
): SpanScore {
  const segs = rows
    .filter((s) => s.start_ms !== null)
    .sort(byStart)
    .map((s) => ({
      source: s.source,
      start: s.start_ms as number,
      end: Math.max(s.start_ms as number, s.end_ms ?? (s.start_ms as number)),
      words: spanWords(stage === "asr" ? (s.text ?? "") : effective(s)),
    }));
  const targets: { sp: GoldSpan; words: string[] }[] = [];
  let unsure = 0;
  let empty = 0;
  for (const sp of spans) {
    if (sp.confidence === "unsure") {
      unsure++;
      continue;
    }
    const words = spanWords(sp.text);
    if (words.length === 0) {
      empty++;
      continue;
    }
    targets.push({ sp, words });
  }
  const hits = spanHits(
    targets.map(({ sp, words }) => ({
      channel: sp.channel,
      startMs: sp.startMs,
      endMs: sp.endMs,
      words,
    })),
    segs,
    tolMs,
  );
  const scored = targets.map(({ sp }, i) => ({ sp, hit: hits[i] === true }));
  const count = (f: (sp: GoldSpan) => boolean) => {
    const xs = scored.filter((x) => f(x.sp));
    return spanCount(xs.filter((x) => x.hit).length, xs.length);
  };
  return {
    all: count(() => true),
    high: count((sp) => sp.confidence === "high"),
    byLabel: Object.fromEntries(
      SPAN_GROUPS.map((g) => [g, count((sp) => spanGroup(sp.label) === g)]),
    ) as Record<SpanGroup, SpanCount>,
    byVocab: {
      inVocab: count((sp) => sp.inVocab),
      notInVocab: count((sp) => !sp.inVocab),
    },
    unsure,
    empty,
    missedKeys: [
      ...new Set(
        scored
          .filter((x) => !x.hit)
          .map((x) => `${x.sp.channel}@${x.sp.startMs}:${x.sp.label}`),
      ),
    ],
  };
}

// --- Scorecard ----------------------------------------------------------------------

export interface Scorecard {
  goldVersion: number;
  /** null when the gold has no asrHash. */
  asrHashMatch: boolean | null;
  asr: Record<Channel, ChannelScore | null> | null;
  enhance: {
    channels: Record<Channel, ChannelScore | null> | null;
    /** ASR WER - Enhance WER per channel and pooled. Positive = Enhance helped. */
    delta: Record<Channel | "all", number | null> | null;
    /** The same on the raw WER (wordsRaw). */
    deltaRaw: number | null;
    fixes: FixScore;
  };
  summary: SummaryScore | null;
  tags: TagScore | null;
  speakers: SpeakerScore | null;
  /** Span accuracy per stage (silver keys); absent when the gold has no spans. */
  spans?: { asr: SpanScore; enhance: SpanScore };
  /** Gold hard fails: "claim:<id>" and "speaker:<label>". */
  hardFails: string[];
}

export interface RunInput {
  segments: SegmentRow[];
  summaryJson: string | null;
  tags: string[];
  speakers: SpeakerRow[];
}

export function scoreRun(
  gold: Gold,
  run: RunInput,
  asrHash: string | null,
): Scorecard {
  const channels = (stage: "asr" | "enhance") =>
    gold.transcript
      ? (Object.fromEntries(
          CHANNELS.map((c) => [c, scoreChannel(gold, c, run.segments, stage)]),
        ) as Record<Channel, ChannelScore | null>)
      : null;
  const asr = channels("asr");
  const enh = channels("enhance");
  const diff = (
    a: ErrorRate | null | undefined,
    b: ErrorRate | null | undefined,
  ) => (a?.rate == null || b?.rate == null ? null : round(a.rate - b.rate));
  const delta =
    asr && enh
      ? {
          mic: diff(asr.mic?.words, enh.mic?.words),
          system: diff(asr.system?.words, enh.system?.words),
          all: diff(
            pooled(Object.values(asr), "words"),
            pooled(Object.values(enh), "words"),
          ),
        }
      : null;
  const deltaRaw =
    asr && enh
      ? diff(
          pooled(Object.values(asr), "wordsRaw"),
          pooled(Object.values(enh), "wordsRaw"),
        )
      : null;
  const summary = scoreSummary(gold, run.summaryJson);
  const speakers = scoreSpeakers(gold, run.speakers);
  return {
    goldVersion: gold.goldVersion,
    asrHashMatch:
      gold.asrHash === null || asrHash === null
        ? null
        : gold.asrHash === asrHash,
    asr,
    enhance: {
      channels: enh,
      delta,
      deltaRaw,
      fixes: scoreFixes(gold, run.segments),
    },
    summary,
    tags: scoreTags(gold, run.tags),
    speakers,
    ...(gold.spans
      ? {
          spans: {
            asr: scoreSpans(gold.spans, run.segments, "asr"),
            enhance: scoreSpans(gold.spans, run.segments, "enhance"),
          },
        }
      : {}),
    hardFails: [
      ...(summary?.mustNotClaimHits ?? []).map((id) => `claim:${id}`),
      ...(speakers?.wrongLabels ?? []).map((l) => `speaker:${l}`),
    ],
  };
}

// --- Stage metrics (numbers only; report and baseline) -----------------------------------

export const STAGES = [
  "asr",
  "enhance",
  "summary",
  "tags",
  "speakers",
] as const;
export type Stage = (typeof STAGES)[number];
export type StageMetrics = Record<string, number | null>;

function channelMetrics(
  ch: Record<Channel, ChannelScore | null> | null,
): StageMetrics {
  if (!ch) return {};
  const out: StageMetrics = {
    wer: pooled(Object.values(ch), "words")?.rate ?? null,
    cer: pooled(Object.values(ch), "chars")?.rate ?? null,
    werVerified: pooled(Object.values(ch), "wordsVerified")?.rate ?? null,
    cerVerified: pooled(Object.values(ch), "charsVerified")?.rate ?? null,
    werRaw: pooled(Object.values(ch), "wordsRaw")?.rate ?? null,
    werVerifiedRaw: pooled(Object.values(ch), "wordsVerifiedRaw")?.rate ?? null,
  };
  const eligible = pooled(Object.values(ch), "wordsEligible");
  if (eligible) out.werEligible = eligible.rate;
  for (const c of CHANNELS) {
    const s = ch[c];
    if (eligible) out[`werEligible.${c}`] = s?.wordsEligible?.rate ?? null;
    out[`wer.${c}`] = s?.words.rate ?? null;
    out[`cer.${c}`] = s?.chars.rate ?? null;
    out[`werVerified.${c}`] = s?.wordsVerified.rate ?? null;
    out[`cerVerified.${c}`] = s?.charsVerified.rate ?? null;
    out[`werRaw.${c}`] = s?.wordsRaw.rate ?? null;
    out[`werVerifiedRaw.${c}`] = s?.wordsVerifiedRaw.rate ?? null;
  }
  return out;
}

/** The span rates of one stage (spanAcc*), or none without spans. */
function spanMetrics(s: SpanScore | undefined): StageMetrics {
  if (!s) return {};
  return {
    spanAcc: s.all.rate,
    spanAccHigh: s.high.rate,
    spanAccTerm: s.byLabel.term.rate,
    spanAccPerson: s.byLabel.person.rate,
    spanAccOther: s.byLabel.other.rate,
    spanAccInVocab: s.byVocab.inVocab.rate,
    spanAccNotInVocab: s.byVocab.notInVocab.rate,
  };
}

/** The flat metrics of a scorecard, per stage. A stage with no gold has no metrics. */
export function stageMetrics(sc: Scorecard): Record<Stage, StageMetrics> {
  const s = sc.summary;
  const t = sc.tags;
  const sp = sc.speakers;
  const f = sc.enhance.fixes;
  return {
    asr: { ...channelMetrics(sc.asr), ...spanMetrics(sc.spans?.asr) },
    enhance: {
      ...channelMetrics(sc.enhance.channels),
      ...spanMetrics(sc.spans?.enhance),
      ...(sc.enhance.delta
        ? { delta: sc.enhance.delta.all, deltaRaw: sc.enhance.deltaRaw }
        : {}),
      fixesFound: f.fixesFound,
      fixesMissed: f.fixesMissed,
      mustNotChangeViolations: f.mustNotChangeViolations,
    },
    summary: s
      ? {
          decisionsRecall: s.decisions.recall,
          decisionsPrecision: s.decisions.precision,
          actionItemsRecall: s.actionItems.recall,
          actionItemsPrecision: s.actionItems.precision,
          ownerCorrect: s.owner.correct,
          ownerWrong: s.owner.wrong,
          ownerMissing: s.owner.missing,
          dueCorrect: s.due.correct,
          dueWrong: s.due.wrong,
          dueMissing: s.due.missing,
          mustNotClaimHits: s.mustNotClaimHits.length,
        }
      : {},
    tags: t ? { precision: t.precision, recall: t.recall } : {},
    speakers: sp
      ? { correct: sp.correct, wrong: sp.wrong, missing: sp.missing }
      : {},
  };
}
