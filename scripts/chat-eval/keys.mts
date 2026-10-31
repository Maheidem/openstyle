// keys.mts: the answer-key scorers (spec 8.1, 8.3, 8.4). Pure functions. A
// key is code, not a judge: normalized text with must-contain groups and
// must-not-contain tokens, id sets with precision and recall, integers.

import type {
  AnswerKey,
  CountKey,
  SetKey,
  TextKey,
  WriteKey,
} from "./types.mts";

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
  janeiro: 1,
  fevereiro: 2,
  marco: 3,
  abril: 4,
  maio: 5,
  junho: 6,
  julho: 7,
  agosto: 8,
  setembro: 9,
  outubro: 10,
  novembro: 11,
  dezembro: 12,
  fev: 2,
  abr: 4,
  ago: 8,
  set: 9,
  out: 10,
  dez: 12,
};

const NUMBER_WORDS: Record<string, number> = {
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
  twenty: 20,
  um: 1,
  uma: 1,
  dois: 2,
  duas: 2,
  tres: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
  oito: 8,
  nove: 9,
  dez: 10,
  onze: 11,
  doze: 12,
  treze: 13,
  quatorze: 14,
  catorze: 14,
  quinze: 15,
  dezesseis: 16,
  dezessete: 17,
  dezoito: 18,
  dezenove: 19,
  vinte: 20,
};

const MONTH_RE = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join("|");

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Normalize a text for key matching: lower case, accents folded, dates to
 * `d:MM-DD`, thousands separators removed, number words 0..20 to digits,
 * other punctuation to one space.
 */
export function normalize(text: string): string {
  let t = text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
  // Dates first, before the punctuation goes.
  t = t.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_m, _y, mo, d) => ` d:${mo}-${d} `);
  t = t.replace(
    new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "g"),
    (_m, mo: string, d: string) =>
      ` d:${pad(MONTHS[mo] as number)}-${pad(Number(d))} `,
  );
  t = t.replace(
    new RegExp(
      `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+|de\\s+)?(${MONTH_RE})\\b`,
      "g",
    ),
    (_m, d: string, mo: string) =>
      ` d:${pad(MONTHS[mo] as number)}-${pad(Number(d))} `,
  );
  // Thousands: 41,500 and 41.500 and 41 500 become 41500.
  t = t.replace(/\b(\d{1,3})(?:[.,]\d{3})+\b/g, (m) => m.replace(/[.,]/g, ""));
  t = t.replace(/\b(\d{1,3}) (\d{3})\b/g, "$1$2");
  t = t.replace(/[^a-z0-9:.\-\s]/g, " ");
  // A full stop or a dash that is not inside a number or a date is a space.
  t = t.replace(/(?<!\d)[.\-]|[.\-](?!\d)/g, " ");
  const words = t.split(/\s+/).filter(Boolean);
  return words
    .map((w) => (w in NUMBER_WORDS ? String(NUMBER_WORDS[w]) : w))
    .join(" ");
}

function hasToken(haystack: string, needle: string): boolean {
  const n = normalize(needle);
  if (!n) return false;
  return ` ${haystack} `.includes(` ${n} `);
}

export interface TextScore {
  pass: boolean;
  missing: number;
  forbidden: string[];
}

export function scoreText(answer: string, key: TextKey): TextScore {
  const a = normalize(answer);
  const missing = key.must.filter(
    (group) => !group.some((alt) => hasToken(a, alt)),
  ).length;
  const forbidden = key.mustNot.filter((t) => hasToken(a, t));
  return { pass: missing === 0 && forbidden.length === 0, missing, forbidden };
}

export interface SetScore {
  precision: number;
  recall: number;
  f1: number;
  pass: boolean;
}

export function scoreSet(got: readonly string[], truth: readonly string[]): SetScore {
  const g = new Set(got);
  const t = new Set(truth);
  const hit = [...g].filter((x) => t.has(x)).length;
  const precision = g.size === 0 ? (t.size === 0 ? 1 : 0) : hit / g.size;
  const recall = t.size === 0 ? 1 : hit / t.size;
  const f1 =
    precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    precision,
    recall,
    f1,
    pass: g.size === t.size && hit === t.size,
  };
}

/** The integers of an answer text, after normalization. */
export function integersIn(answer: string): number[] {
  return (normalize(answer).match(/\b\d+\b/g) ?? []).map(Number);
}

export function scoreCount(answer: string, key: CountKey): boolean {
  const ns = integersIn(answer);
  return ns.length > 0 && ns[0] === key.n;
}

/** What a harness run returns for one question, reduced to what a key reads. */
export interface Answer {
  /** A not_found block (no text answer). */
  notFound: boolean;
  text: string;
  ids: string[];
  proposal: {
    kind: WriteKey["change"];
    ids: string[];
    arg: WriteKey["arg"];
  } | null;
}

export interface KeyResult {
  pass: boolean;
  f1: number | null;
}

/** Score one answer against its key. */
export function scoreAnswer(answer: Answer, key: AnswerKey): KeyResult {
  switch (key.kind) {
    case "not_found":
      return { pass: answer.notFound, f1: null };
    case "text":
      return {
        pass: !answer.notFound && scoreText(answer.text, key).pass,
        f1: null,
      };
    case "set": {
      const s = scoreSet(answer.ids, (key as SetKey).ids);
      return { pass: !answer.notFound && s.pass, f1: s.f1 };
    }
    case "count":
      return { pass: !answer.notFound && scoreCount(answer.text, key), f1: null };
    case "write": {
      const p = answer.proposal;
      if (!p || p.kind !== key.change) return { pass: false, f1: 0 };
      const s = scoreSet(p.ids, key.ids);
      const argOk =
        key.arg === null ||
        JSON.stringify(p.arg) === JSON.stringify(key.arg);
      return { pass: s.pass && argOk, f1: s.f1 };
    }
  }
}

// --- Retrieval metrics (spec 7.4.6) --------------------------------------

/** recall@k over queries: 1 when a graded-2 chunk is in the top k. */
export function recallAt(
  rankedGrades: readonly number[],
  k: number,
  minGrade = 2,
): number {
  return rankedGrades.slice(0, k).some((g) => g >= minGrade) ? 1 : 0;
}

export function mrrAt(rankedGrades: readonly number[], k: number): number {
  const i = rankedGrades.slice(0, k).findIndex((g) => g >= 2);
  return i < 0 ? 0 : 1 / (i + 1);
}

/** nDCG@k with graded gains (2 = exact line, 1 = same window). */
export function ndcgAt(
  rankedGrades: readonly number[],
  idealGrades: readonly number[],
  k: number,
): number {
  const dcg = (gs: readonly number[]) =>
    gs.slice(0, k).reduce((s, g, i) => s + (2 ** g - 1) / Math.log2(i + 2), 0);
  const ideal = dcg([...idealGrades].sort((a, b) => b - a));
  return ideal === 0 ? 0 : dcg(rankedGrades) / ideal;
}

export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i] as number;
}

export const mean = (xs: readonly number[]) =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Reciprocal rank fusion (spec 7.4.2): score = sum over channels of
 * 1 / (k + rank), ranks from 1. Ties break by the id for a stable order.
 */
export function rrf(
  lists: readonly (readonly number[])[],
  k = 60,
  weights?: readonly number[],
): number[] {
  const score = new Map<number, number>();
  lists.forEach((list, li) => {
    const w = weights?.[li] ?? 1;
    list.forEach((id, i) => {
      score.set(id, (score.get(id) ?? 0) + w / (k + i + 1));
    });
  });
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([id]) => id);
}
