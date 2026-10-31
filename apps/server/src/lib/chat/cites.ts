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
  dates(new RegExp(RE_ISO.source, "g"), 2, 3, 1);
  dates(new RegExp(RE_MONTH_DAY.source, "g"), 1, 2);
  dates(new RegExp(RE_DAY_MONTH.source, "g"), 2, 1);

  // Numbers.
  for (const m of rest.matchAll(/\d[\d.,:]*\d|\d/g)) {
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
    for (const fact of extractFacts(sentence.text, input.knownNames)) {
      const supported =
        holds(questionHay, fact.norm) ||
        cites.some((l) => holds(hayOf(sources.get(l) as Source), fact.norm));
      if (supported) continue;
      const other = sources
        .all()
        .find(
          (s) =>
            !cites.includes(s.label) &&
            inScope(s) &&
            holds(hayOf(s), fact.norm),
        );
      if (other) {
        cites.push(other.label);
        repaired++;
      } else if (!unsupported.includes(fact.shown)) {
        unsupported.push(fact.shown);
      }
    }
    kept.push({ text: sentence.text, cites });
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
