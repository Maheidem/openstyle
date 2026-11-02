import type { ChatCite } from "@openstyle/validations";
import type { Source, SourceMap } from "./types.js";

// Answer validation in code (specs/meeting-chat-agent.md 6.2). No model runs
// here. Grounding is not optional: a sentence with no valid cite is removed,
// and a number, date, name or quote that no cited source holds is reported.

// ---------------------------------------------------------------------------
// Normalization (like scripts/chat-eval/keys.mts `normalize`)
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {};
[
  // en
  "january february march april may june july august september october november december",
  // pt
  "janeiro fevereiro marco abril maio junho julho agosto setembro outubro novembro dezembro",
  // es
  "enero febrero marzo abril mayo junio julio agosto septiembre octubre noviembre diciembre",
  // de
  "januar februar marz april mai juni juli august september oktober november dezember",
  // fr
  "janvier fevrier mars avril mai juin juillet aout septembre octobre novembre decembre",
  // it
  "gennaio febbraio marzo aprile maggio giugno luglio agosto settembre ottobre novembre dicembre",
].forEach((line) => {
  line.split(" ").forEach((name, i) => {
    MONTHS[name] = i + 1;
  });
});
// Short English forms. Short forms of other languages ("out", "set", "mar")
// are also common words, so they are not here.
Object.assign(MONTHS, {
  jan: 1,
  feb: 2,
  apr: 4,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
  setiembre: 9,
});

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

const RE_ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const RE_MONTH_DAY = new RegExp(
  `\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`,
  "g",
);
const RE_DAY_MONTH = new RegExp(
  `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+|de\\s+|del\\s+)?(${MONTH_RE})\\b`,
  "g",
);

const fold = (t: string) =>
  t
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();

/** Dates become `d:MM-DD` (the year of an ISO date stays as a number). */
function dateTokens(t: string): string {
  return t
    .replace(RE_ISO, (_m, y, mo, d) => ` d:${mo}-${d} ${y} `)
    .replace(
      RE_MONTH_DAY,
      (_m, mo: string, d: string) =>
        ` d:${pad(MONTHS[mo] as number)}-${pad(Number(d))} `,
    )
    .replace(
      RE_DAY_MONTH,
      (_m, d: string, mo: string) =>
        ` d:${pad(MONTHS[mo] as number)}-${pad(Number(d))} `,
    );
}

/** 41,500 and 41.500 and 41 500 become 41500. A decimal comma becomes a point. */
function numberForms(t: string): string {
  return t
    .replace(/\b(\d{1,3})(?:[.,]\d{3})+\b/g, (m) => m.replace(/[.,]/g, ""))
    .replace(/\b(\d{1,3}) (\d{3})\b/g, "$1$2")
    .replace(/(\d),(\d)/g, "$1.$2");
}

/**
 * Lower case, accents folded, dates to `d:MM-DD`, thousands separators out,
 * other punctuation to one space. `numberWords` turns "two" into "2". It is
 * on for the text of sources and off for the sentence of the answer: "um" is a
 * Portuguese article and not a number there.
 */
export function normalizeText(text: string, numberWords = false): string {
  let t = numberForms(dateTokens(fold(text)));
  t = t.replace(/[^a-z0-9:.\-\s]/g, " ");
  t = t.replace(/(?<!\d)[.-]|[.-](?!\d)/g, " ");
  // A colon is a separator unless a digit follows it (a time "6:58" or a date
  // token "d:12-04"). "Tomasz Wieczorek: Eu proponho" must hold the name.
  t = t.replace(/:(?!\d)/g, " ");
  const words = t.split(/\s+/).filter(Boolean);
  return (
    numberWords
      ? words.map((w) => (w in NUMBER_WORDS ? String(NUMBER_WORDS[w]) : w))
      : words
  ).join(" ");
}

/** `text` holds the words of `needle` in a row (both normalized). */
const holds = (haystack: string, needle: string): boolean =>
  needle !== "" && ` ${haystack} `.includes(` ${needle} `);

// ---------------------------------------------------------------------------
// Facts of a sentence
// ---------------------------------------------------------------------------

export interface FactToken {
  kind: "number" | "date" | "name" | "quote";
  /** The normalized form that is looked up. */
  norm: string;
  /** A second form that also counts (a day/month date may be month/day). */
  alt?: string;
  /** The form that the answer shows, for the retry note. */
  shown: string;
}

const QUOTES = /"([^"]{2,})"|“([^”]{2,})”|«([^»]{2,})»/g;

/** Numbers, dates, quoted strings and known names of one sentence. */
export function extractFacts(
  sentence: string,
  knownNames: readonly string[],
): FactToken[] {
  const out: FactToken[] = [];
  const seen = new Set<string>();
  const push = (t: FactToken) => {
    const key = `${t.kind}:${t.norm}`;
    if (t.norm && !seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  };

  // A list marker at the start is not a fact.
  let s = sentence.replace(/^\s*(?:\d+[.)]|[-*•])\s+/, "");

  // Quoted strings first. They leave the sentence.
  s = s.replace(QUOTES, (_m, a?: string, b?: string, c?: string) => {
    const q = (a ?? b ?? c ?? "").trim();
    push({ kind: "quote", norm: normalizeText(q, true), shown: q });
    return " ";
  });

  // Names (before the numbers, so a title with a number stays one name).
  const ns = normalizeText(s);
  for (const name of knownNames) {
    const n = normalizeText(name);
    if (n.length >= 2 && holds(ns, n))
      push({ kind: "name", norm: n, shown: name });
  }

  // Dates. Each match leaves the text so its digits are not read again.
  let rest = fold(s);
  const dates = (re: RegExp, month: number, day: number, year?: number) => {
    rest = rest.replace(re, (...m: string[]) => {
      const mo = MONTHS[m[month] as string] ?? Number(m[month]);
      push({
        kind: "date",
        norm: `d:${pad(mo)}-${pad(Number(m[day]))}`,
        shown: (m[0] as string).trim(),
      });
      if (year !== undefined)
        push({
          kind: "number",
          norm: m[year] as string,
          shown: m[year] as string,
        });
      return " ";
    });
  };
  // 04/08/2026 or 4/8: the order day/month or month/day is not known, so both count.
  rest = rest.replace(
    /(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?![\d/])/g,
    (m, a: string, b: string, y?: string) => {
      const x = pad(Number(a));
      const z = pad(Number(b));
      if (Number(a) > 31 || Number(b) > 31) return m;
      push({
        kind: "date",
        norm: `d:${z}-${x}`,
        alt: `d:${x}-${z}`,
        shown: m.trim(),
      });
      if (y && y.length === 4) push({ kind: "number", norm: y, shown: y });
      return " ";
    },
  );
  dates(new RegExp(RE_ISO.source, "g"), 2, 3, 1);
  dates(new RegExp(RE_MONTH_DAY.source, "g"), 1, 2);
  dates(new RegExp(RE_DAY_MONTH.source, "g"), 2, 1);

  // Numbers.
  // A number inside a word ("p95", "v2", "Q3") is part of that word.
  for (const m of rest.matchAll(
    /(?<![\p{L}\d])\d[\d.,:]*\d|(?<![\p{L}\d])\d/gu,
  )) {
    push({ kind: "number", norm: normalizeText(m[0]), shown: m[0] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Source text
// ---------------------------------------------------------------------------

const mmss = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
};
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** What a source can support: its text, its title, its date and its time. */
function sourceHaystack(s: Source): string {
  return normalizeText(
    [
      s.text,
      s.title ?? "",
      s.startedAt === null ? "" : dayOf(s.startedAt),
      s.startMs === null ? "" : mmss(s.startMs),
    ].join(" "),
    true,
  );
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

export interface AnswerSentence {
  text: string;
  cites: string[];
  /** A bullet of a lead-plus-bullets answer. */
  bullet?: boolean;
}

export interface CiteCheck {
  /** Cleaned: only valid cites. A sentence with no valid cite is gone. */
  sentences: AnswerSentence[];
  removedSentences: number;
  /** Labels that are not in the map or out of scope. */
  badLabels: string[];
  /** The `shown` form of each fact that no source holds. */
  unsupportedTokens: string[];
  /** Cites that code added because another source holds the fact. */
  repairedCites: number;
  ok: boolean;
}

export interface CheckInput {
  sentences: readonly AnswerSentence[];
  sources: SourceMap;
  question: string;
  allowedMeetingIds: ReadonlySet<string> | "all";
  /** Names of people, meeting titles and folders. */
  knownNames: readonly string[];
  /**
   * A sentence with a fact that no source holds is removed and the check goes
   * on (a broad answer, last attempt: unsupported claims go, never stay).
   */
  dropUnsupported?: boolean;
}

export function checkAnswer(input: CheckInput): CiteCheck {
  const { sources, allowedMeetingIds } = input;
  const questionHay = normalizeText(input.question, true);
  const hay = new Map<string, string>();
  const hayOf = (s: Source) => {
    let h = hay.get(s.label);
    if (h === undefined) {
      h = sourceHaystack(s);
      hay.set(s.label, h);
    }
    return h;
  };
  const inScope = (s: Source) =>
    allowedMeetingIds === "all" || allowedMeetingIds.has(s.meetingId);

  const badLabels: string[] = [];
  const unsupported: string[] = [];
  const kept: AnswerSentence[] = [];
  let removed = 0;
  let repaired = 0;

  for (const sentence of input.sentences) {
    // 1 and 2: the label exists and its meeting is in the scope.
    const valid: Source[] = [];
    for (const label of new Set(sentence.cites)) {
      const src = sources.get(label);
      if (!src || !inScope(src)) {
        if (!badLabels.includes(label)) badLabels.push(label);
        continue;
      }
      valid.push(src);
    }
    // 4: coverage.
    if (valid.length === 0 || sentence.text.trim() === "") {
      removed++;
      continue;
    }

    // 3: fact check.
    const cites = valid.map((s) => s.label);
    const mine: string[] = [];
    for (const fact of extractFacts(sentence.text, input.knownNames)) {
      const forms = fact.alt ? [fact.norm, fact.alt] : [fact.norm];
      const held = (hay: string) => forms.some((f) => holds(hay, f));
      const supported =
        held(questionHay) ||
        cites.some((l) => held(hayOf(sources.get(l) as Source)));
      if (supported) continue;
      const other = sources
        .all()
        .find((s) => !cites.includes(s.label) && inScope(s) && held(hayOf(s)));
      if (other) {
        cites.push(other.label);
        repaired++;
      } else {
        mine.push(fact.shown);
      }
    }
    if (mine.length > 0 && input.dropUnsupported) {
      removed++;
      continue;
    }
    for (const f of mine) if (!unsupported.includes(f)) unsupported.push(f);
    kept.push({
      text: sentence.text,
      cites,
      ...(sentence.bullet ? { bullet: true } : {}),
    });
  }

  return {
    sentences: kept,
    removedSentences: removed,
    badLabels,
    unsupportedTokens: unsupported,
    repairedCites: repaired,
    ok: kept.length > 0 && unsupported.length === 0,
  };
}

/** The unique cites of the sentences, in the order of first use. */
export function citeFromSentences(
  sentences: readonly AnswerSentence[],
  sources: SourceMap,
): ChatCite[] {
  const seen = new Set<string>();
  const out: ChatCite[] = [];
  for (const s of sentences) {
    for (const label of s.cites) {
      if (seen.has(label)) continue;
      seen.add(label);
      const cite = sources.toCite(label);
      if (cite) out.push(cite);
    }
  }
  return out;
}

/** The note for the answer retry (spec 6.2, "remove or fix"). */
export function failureNote(check: CiteCheck): string {
  const parts: string[] = [];
  if (check.unsupportedTokens.length > 0) {
    parts.push(
      `Remove or fix: ${check.unsupportedTokens.map((t) => `"${t}"`).join(", ")}. No cited source holds them.`,
    );
  }
  if (check.badLabels.length > 0) {
    parts.push(
      `Do not use these labels: ${check.badLabels.join(", ")}. They are not sources of this turn.`,
    );
  }
  if (check.sentences.length === 0) {
    parts.push("Cite at least one source label for each sentence.");
  } else if (check.removedSentences > 0) {
    parts.push(
      `${check.removedSentences} sentence(s) had no valid cite. Cite a source label in each sentence.`,
    );
  }
  return parts.join(" ");
}

const WORD = /[\p{L}\p{N}]{2,}/gu;
const foldWords = (t: string): string[] =>
  (
    t
      .normalize("NFD")
      .replace(/\p{M}+/gu, "")
      .toLowerCase()
      .match(WORD) ?? []
  ).filter((w) => w.length > 2 || /\d/.test(w));

/** Two answers with this share of the same words are the same answer. */
const REPEAT_JACCARD = 0.8;

/** The first sentence of a text. */
const firstSentence = (t: string): string =>
  t.trim().split(/(?<=[.!?])\s+/u)[0] ?? "";

/**
 * The earlier question whose answer the new answer repeats, or null. A new
 * question must get a new answer: a small model gave the earlier answer again
 * to "Why?" because the same chunk came back (P1.2). The same question asked
 * again may get the same answer. Only the first sentence is compared.
 */
export function repeatedEarlierAnswer(
  question: string,
  answer: string,
  turns: readonly { question: string; answer: string }[],
): string | null {
  const now = new Set(foldWords(firstSentence(answer)));
  if (now.size < 3) return null;
  const same = foldWords(question).join(" ");
  for (const t of turns.slice(-4)) {
    if (foldWords(t.question).join(" ") === same) continue;
    const old = new Set(foldWords(firstSentence(t.answer)));
    if (old.size < 3) continue;
    let both = 0;
    for (const w of now) if (old.has(w)) both++;
    if (both / (now.size + old.size - both) >= REPEAT_JACCARD)
      return t.question;
  }
  return null;
}

const jaccardWords = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  return both / (a.size + b.size - both);
};

/** Two sentences with this share of the same words say the same thing. */
const SENTENCE_REPEAT = 0.6;

/**
 * Splits earlier answer texts into sentences (a bullet marker is not a sentence start).
 */
export function sentencesOf(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?。])\s+/u)
    .map((t) => t.replace(/^\s*[-*•]\s*/, "").trim())
    .filter((t) => t.length > 0);
}

/**
 * Removes the sentences that repeat a fact the thread already told (same
 * words, Jaccard >= 0.6), and a sentence that repeats an earlier sentence of
 * the same answer. Returns the sentences that stay. The caller treats an empty
 * result as a repeat (owner report 2026-11-01: a follow-up gave the same reply).
 */
export function dropToldSentences<T extends { text: string }>(
  sentences: readonly T[],
  told: readonly string[],
): T[] {
  const old = told.map((t) => new Set(foldWords(t)));
  const kept: { s: T; w: Set<string> }[] = [];
  for (const s of sentences) {
    const w = new Set(foldWords(s.text));
    if (w.size < 3) {
      kept.push({ s, w });
      continue;
    }
    const dup =
      old.some((o) => jaccardWords(w, o) >= SENTENCE_REPEAT) ||
      kept.some((k) => jaccardWords(w, k.w) >= SENTENCE_REPEAT);
    if (!dup) kept.push({ s, w });
  }
  return kept.map((k) => k.s);
}

/**
 * The text of a summary source without the clauses that the thread told
 * already. A clause is a part between "; " or sentence ends. A clause is told
 * when every date and number in it appears in the told text, or when most of
 * its words appear in one told sentence. The label of the first clause
 * ("Key points:") stays. Empty when nothing new is left.
 */
export function withoutTold(text: string, told: readonly string[]): string {
  if (told.length === 0) return text;
  const toldNorm = normalizeText(told.join(" "), true);
  const toldWords = told.map((t) => new Set(foldWords(t)));
  const label = text.match(/^([\p{L} ]{3,24}:)\s+/u)?.[1] ?? "";
  const body = label ? text.slice(label.length).trim() : text;
  const clauses = body.split(/;\s+|(?<=[.!?])\s+/u).filter(Boolean);
  const fresh = clauses.filter((c) => {
    const nums = extractFacts(c, []).filter(
      (f) => f.kind === "number" || f.kind === "date",
    );
    if (nums.length > 0 && nums.every((f) => holds(toldNorm, f.norm)))
      return false;
    const w = new Set(foldWords(c));
    return !toldWords.some((o) => jaccardWords(w, o) >= 0.5);
  });
  if (fresh.length === 0) return "";
  return `${label ? `${label} ` : ""}${fresh.join("; ")}`;
}

/**
 * The chip opens the meeting at the line that the sentence is about: for each
 * transcript source, the segment with the most words of the sentence (spec 7.3
 * point 1, applied to the answer and not to the query).
 */
export function refineCiteTimes(
  sentences: { text: string; cites: string[] }[],
  sources: SourceMap,
): void {
  for (const sentence of sentences) {
    const words = new Set(foldWords(sentence.text));
    for (const label of sentence.cites) {
      const segs = sources.segments.get(label);
      const src = sources.get(label);
      if (!segs || !src || (src.kind !== "transcript" && src.kind !== "window"))
        continue;
      let best = segs[0];
      let bestScore = -1;
      for (const seg of segs) {
        const score = foldWords(seg.text).filter((w) => words.has(w)).length;
        if (score > bestScore) {
          best = seg;
          bestScore = score;
        }
      }
      if (best && bestScore > 0) src.startMs = best.startMs;
    }
  }
}

/**
 * A cite marker the model wrote inside the sentence text: "[S1]", "[S1, S2]",
 * "[S1][S2]", "(S1)", "【S1】", "[Source 1]", "[source: S2]". The cites are in
 * the `cites` field, so the visible text must not hold the marker (P1.2: the
 * owner saw a raw "[S1]" in an answer).
 */
const CITE_MARKER_RE =
  /[ \t]*[[(【]\s*(?:(?:sources?|fonte|fuente|quelle)\s*:?\s*)?S?\d+(?:\s*(?:[,;&]|and|e|y|und)\s*S?\d+)*\s*[\])】]/giu;

/** True for a marker group that holds a label like S1 (not a bare number such as "(2)"). */
function isLabelMarker(m: string): boolean {
  return /S\s*\d|source|fonte|fuente|quelle/i.test(m);
}

export function stripCiteMarkers(text: string): string {
  return text
    .replace(CITE_MARKER_RE, (m) => (isLabelMarker(m) ? "" : m))
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}

/**
 * One cite for each sentence: the source that shares most content words with
 * the sentence. A transcript line of a cited meeting wins over a summary line
 * that says the same (the chip then opens the meeting at the spoken line).
 */
export function tidyCites(
  sentences: { text: string; cites: string[] }[],
  sources: SourceMap,
): void {
  for (const sentence of sentences) {
    const words = new Set(foldWords(sentence.text));
    if (words.size === 0 || sentence.cites.length === 0) continue;
    const meetings = new Set(
      sentence.cites
        .map((l) => sources.get(l)?.meetingId)
        .filter((m): m is string => !!m),
    );
    const candidates = new Set(sentence.cites);
    for (const src of sources.all()) {
      if (
        (src.kind === "transcript" || src.kind === "window") &&
        meetings.has(src.meetingId)
      )
        candidates.add(src.label);
    }
    let best = sentence.cites[0] as string;
    let bestScore = -1;
    for (const label of candidates) {
      const src = sources.get(label);
      if (!src) continue;
      const have = new Set(foldWords(src.text));
      let hit = 0;
      for (const w of words) if (have.has(w)) hit++;
      const spoken = src.kind === "transcript" || src.kind === "window";
      const score = hit / words.size + (spoken ? 0.15 : 0);
      if (score > bestScore) {
        best = label;
        bestScore = score;
      }
    }
    sentence.cites = [best];
  }
}

/**
 * A sentence with no valid cite gets the source that shares most of its words,
 * when the share is at least a half. Code verifies the match; the fact check
 * runs after this. A sentence with no such source stays uncited and the cite
 * check removes it (spec 6.2 rule 4).
 */
export function assignMissingCites(
  sentences: { text: string; cites: string[] }[],
  sources: SourceMap,
): void {
  for (const sentence of sentences) {
    if (sentence.cites.some((l) => sources.get(l))) continue;
    const words = new Set(foldWords(sentence.text));
    if (words.size === 0) continue;
    let best: string | null = null;
    let bestShare = 0;
    for (const src of sources.all()) {
      if (src.kind === "folder") continue;
      const have = new Set(foldWords(src.text));
      let hit = 0;
      for (const w of words) if (have.has(w)) hit++;
      const share = hit / words.size;
      if (share > bestShare) {
        best = src.label;
        bestShare = share;
      }
    }
    if (best && bestShare >= 0.5) sentence.cites = [best];
  }
}

/**
 * Scores texts against a query. One score for each text, or null when no
 * ranker is available. The pipeline passes the reranker.
 */
export type Ranker = (
  query: string,
  texts: string[],
) => Promise<number[] | null>;

/** The most segment texts that one ranker call gets (the reranker limit is 64). */
const RANK_MAX_TEXTS = 60;

/**
 * The chip opens the meeting at the line that answers the question. The word
 * count of `refineCiteTimes` follows the words of the answer sentence: it
 * fails when the answer is in another language than the meeting, or when the
 * line that states the fact shares few words with the sentence. The ranker
 * scores the segments of each cited transcript source against the query in
 * one call, and the best segment gives the start (P1.1, #402). No ranker
 * result leaves the start of `refineCiteTimes`.
 */
export async function pickCiteTimes(
  sentences: { cites: string[] }[],
  sources: SourceMap,
  query: string,
  rank: Ranker,
): Promise<void> {
  const labels: string[] = [];
  for (const s of sentences)
    for (const l of s.cites) {
      const src = sources.get(l);
      if (
        !labels.includes(l) &&
        src &&
        (src.kind === "transcript" || src.kind === "window") &&
        (sources.segments.get(l)?.length ?? 0) > 1
      )
        labels.push(l);
    }
  const used: string[] = [];
  const texts: string[] = [];
  for (const l of labels) {
    const segs = sources.segments.get(l) ?? [];
    if (texts.length + segs.length > RANK_MAX_TEXTS) break;
    used.push(l);
    texts.push(...segs.map((g) => g.text));
  }
  if (texts.length === 0) return;
  const scores = await rank(query, texts);
  if (!scores || scores.length !== texts.length) return;
  let i = 0;
  for (const l of used) {
    const segs = sources.segments.get(l) ?? [];
    const src = sources.get(l);
    let best = 0;
    for (let k = 0; k < segs.length; k++)
      if ((scores[i + k] as number) > (scores[i + best] as number)) best = k;
    i += segs.length;
    const seg = segs[best];
    if (src && seg) src.startMs = seg.startMs;
  }
}
