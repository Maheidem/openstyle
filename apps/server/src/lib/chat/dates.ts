// Date words of a question, read by code (specs/meeting-chat-agent.md 2.3,
// stage 2b). No model. The function never reads the system clock: the caller
// passes `todayMs`.
//
// Languages: EN and PT in full. DE, ES, FR, IT and JA for the relative words
// and the month names. A text with no date gives nulls.
//
// Rules:
// - The calendar is UTC. `todayMs` gives the day of "today". A caller that
//   works in a local time zone passes `utcOffsetMinutes` (minutes east of UTC).
// - A week starts on Monday. "this week" ends today. "last week" is the
//   whole week before. "this month" ends today. "last month" is the whole
//   month before.
// - A named month gives the whole month ("in October" is 10-01 to 10-31).
// - YEAR RULE: with no explicit year, the year is the year of today. If the
//   range then starts after today, the year before is used. Example: today is
//   2026-10-26. "in December" is December 2025. "September 12" is 2026-09-12.
//   "November 3" is 2025-11-03. An explicit year ("September 12, 2025") is
//   always kept.
// - A month name that is also a common word ("may", "march", "marco") counts
//   only after a preposition or next to a day number.

export interface DateRange {
  dateFrom: string | null;
  dateTo: string | null;
}

const DAY_MS = 86_400_000;
const NONE: DateRange = { dateFrom: null, dateTo: null };
const MAX_TEXT = 2000;

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const daysIn = (y: number, m: number) =>
  new Date(Date.UTC(y, m, 0)).getUTCDate();

// ---------------------------------------------------------------------------
// Month names (accents and case are already folded)
// ---------------------------------------------------------------------------

const MONTH_LISTS: string[][] = [
  // en
  [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ],
  // pt
  [
    "janeiro",
    "fevereiro",
    "marco",
    "abril",
    "maio",
    "junho",
    "julho",
    "agosto",
    "setembro",
    "outubro",
    "novembro",
    "dezembro",
  ],
  // es
  [
    "enero",
    "febrero",
    "marzo",
    "abril",
    "mayo",
    "junio",
    "julio",
    "agosto",
    "septiembre",
    "octubre",
    "noviembre",
    "diciembre",
  ],
  // de
  [
    "januar",
    "februar",
    "marz",
    "april",
    "mai",
    "juni",
    "juli",
    "august",
    "september",
    "oktober",
    "november",
    "dezember",
  ],
  // fr
  [
    "janvier",
    "fevrier",
    "mars",
    "avril",
    "mai",
    "juin",
    "juillet",
    "aout",
    "septembre",
    "octobre",
    "novembre",
    "decembre",
  ],
  // it
  [
    "gennaio",
    "febbraio",
    "marzo",
    "aprile",
    "maggio",
    "giugno",
    "luglio",
    "agosto",
    "settembre",
    "ottobre",
    "novembre",
    "dicembre",
  ],
];

const MONTH_NUMBER = new Map<string, number>();
for (const list of MONTH_LISTS) {
  list.forEach((name, i) => {
    MONTH_NUMBER.set(name, i + 1);
  });
}
MONTH_NUMBER.set("sept", 9);

// English short names count only next to a day number.
const SHORT_MONTH = new Map<string, number>([
  ["jan", 1],
  ["feb", 2],
  ["mar", 3],
  ["apr", 4],
  ["jun", 6],
  ["jul", 7],
  ["aug", 8],
  ["sep", 9],
  ["sept", 9],
  ["oct", 10],
  ["nov", 11],
  ["dec", 12],
]);

// Names that are also first names or common words. They need a preposition
// or a day number.
const AMBIGUOUS = new Set(["may", "march", "april", "june", "august", "marco"]);
const PREPOSITIONS = new Set([
  "in",
  "during",
  "of",
  "from",
  "until",
  "till",
  "since",
  "by",
  "before",
  "after",
  "em",
  "en",
  "im",
  "nel",
  "durante",
]);
// "marco" also means milestone (PT) and frame (ES): fewer prepositions.
const MARCO_PREPOSITIONS = new Set(["em", "en", "nel", "in"]);

// ---------------------------------------------------------------------------
// Relative words
// ---------------------------------------------------------------------------

type Relative =
  | "today"
  | "yesterday"
  | "this_week"
  | "last_week"
  | "this_month"
  | "last_month";

// Latin-script phrases, matched as whole words after folding.
const RELATIVE_WORDS: [Relative, string[]][] = [
  [
    "last_week",
    [
      "last week",
      "previous week",
      "semana passada",
      "semana pasada",
      "letzte woche",
      "letzter woche",
      "vergangene woche",
      "vergangenen woche",
      "la semaine derniere",
      "semaine derniere",
      "semaine passee",
      "settimana scorsa",
      "la settimana scorsa",
    ],
  ],
  [
    "last_month",
    [
      "last month",
      "previous month",
      "mes passado",
      "mes pasado",
      "letzten monat",
      "letzter monat",
      "vergangenen monat",
      "le mois dernier",
      "mois dernier",
      "mese scorso",
      "il mese scorso",
    ],
  ],
  [
    "this_week",
    [
      "this week",
      "esta semana",
      "essa semana",
      "nesta semana",
      "diese woche",
      "dieser woche",
      "cette semaine",
      "questa settimana",
    ],
  ],
  [
    "this_month",
    [
      "this month",
      "este mes",
      "esse mes",
      "neste mes",
      "diesen monat",
      "dieses monat",
      "ce mois",
      "ce mois ci",
      "questo mese",
    ],
  ],
  ["yesterday", ["yesterday", "ontem", "gestern", "ayer", "ieri"]],
  ["today", ["today", "hoje", "heute", "hoy", "aujourd hui", "oggi"]],
];
// Japanese has no spaces: plain substring match.
const RELATIVE_JA: [Relative, string][] = [
  ["last_week", "先週"],
  ["last_month", "先月"],
  ["this_week", "今週"],
  ["this_month", "今月"],
  ["yesterday", "昨日"],
  ["today", "今日"],
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const RELATIVE_RE: [Relative, RegExp][] = RELATIVE_WORDS.map(([rel, words]) => [
  rel,
  new RegExp(`(?:^|\\s)(?:${words.map(escapeRe).join("|")})(?=\\s|$)`),
]);

// "last 7 days", "ultimos 30 dias", "letzten 3 tage"
const LAST_DAYS_RE =
  /(?:^|\s)(?:last|past|ultimos|ultimas|letzten|derniers|ultimi)\s+(\d{1,3})\s+(?:days?|dias|tage|jours|giorni)(?=\s|$)/;

// ---------------------------------------------------------------------------
// Folding
// ---------------------------------------------------------------------------

/** Lower case, no accents, punctuation to spaces (digits and "." kept), single spaces. */
function fold(text: string): string {
  return text
    .slice(0, MAX_TEXT)
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/['’`]/g, " ")
    .replace(/[^\p{L}\p{N}.\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Absolute dates
// ---------------------------------------------------------------------------

const MONTH_ALT = [...MONTH_NUMBER.keys()]
  .sort((a, b) => b.length - a.length)
  .join("|");
const SHORT_ALT = [...SHORT_MONTH.keys()]
  .sort((a, b) => b.length - a.length)
  .join("|");
const DAY_NUM = "(\\d{1,2})(?:st|nd|rd|th|o|\\.)?";
const FILLER = "(?:\\s+(?:of|de|del|di|d|the|dia|day|el|le|il|am|im|am))*";
const YEAR_TAIL = "(?:\\s*,?\\s*(?:de|del|of)?\\s*((?:19|20)\\d{2}))?";

// "12 of september", "dia 15 de setembro", "15. september", "3 de mayo 2025"
const DAY_FIRST_RE = new RegExp(
  `(?:^|\\s)${DAY_NUM}${FILLER}\\s+(${MONTH_ALT}|${SHORT_ALT})\\.?${YEAR_TAIL}(?=\\s|$|\\.)`,
  "g",
);
// "september 12", "sept 12th, 2025", "september the 12th"
const MONTH_FIRST_RE = new RegExp(
  `(?:^|\\s)(${MONTH_ALT}|${SHORT_ALT})\\.?(?:\\s+(?:the|dia|day|el))?\\s+(\\d{1,2})(?:st|nd|rd|th|o)?(?![\\d:])${YEAR_TAIL}(?=\\s|$|\\.)`,
  "g",
);
// a month name alone, with an optional year
const MONTH_ONLY_RE = new RegExp(
  `(?:^|\\s)(${MONTH_ALT})(?:\\s*,?\\s*(?:de|del|of)?\\s*((?:19|20)\\d{2}))?(?=\\s|$|\\.)`,
  "g",
);
const ISO_RE = /(?:^|\s)((?:19|20)\d{2})-(\d{2})-(\d{2})(?=\s|$)/g;
const JA_DAY_RE = /(\d{1,2})月\s*(\d{1,2})日/g;
const JA_MONTH_RE = /(\d{1,2})月/g;

interface Parts {
  y: number | null;
  m: number;
  d: number | null;
}

function monthNumber(word: string): number | undefined {
  return MONTH_NUMBER.get(word) ?? SHORT_MONTH.get(word);
}

function absoluteParts(text: string): Parts[] {
  const out: Parts[] = [];
  const claimed: [number, number][] = [];
  const overlaps = (a: number, b: number) =>
    claimed.some(([s, e]) => a < e && b > s);
  const claim = (a: number, b: number) => claimed.push([a, b]);

  for (const m of text.matchAll(ISO_RE)) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    claim(m.index, m.index + m[0].length);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo)) {
      out.push({ y, m: mo, d });
    }
  }
  const pushDay = (
    start: number,
    len: number,
    monthWord: string,
    day: string,
    year: string | undefined,
  ) => {
    if (overlaps(start, start + len)) return;
    const mo = monthNumber(monthWord);
    if (!mo) return;
    const d = Number(day);
    if (d < 1 || d > 31) return;
    claim(start, start + len);
    out.push({ y: year ? Number(year) : null, m: mo, d });
  };
  for (const m of text.matchAll(DAY_FIRST_RE)) {
    pushDay(m.index, m[0].length, m[2] as string, m[1] as string, m[3]);
  }
  for (const m of text.matchAll(MONTH_FIRST_RE)) {
    const word = m[1] as string;
    // A month followed by a number is a day only when the number fits a day.
    pushDay(m.index, m[0].length, word, m[2] as string, m[3]);
  }
  for (const m of text.matchAll(JA_DAY_RE)) {
    const mo = Number(m[1]);
    const d = Number(m[2]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      claim(m.index, m.index + m[0].length);
      out.push({ y: null, m: mo, d });
    }
  }
  for (const m of text.matchAll(MONTH_ONLY_RE)) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    const word = m[1] as string;
    if (AMBIGUOUS.has(word)) {
      // The word before the month name.
      const before = text
        .slice(0, m.index + m[0].indexOf(word))
        .trimEnd()
        .split(" ")
        .pop();
      const ok =
        before !== undefined &&
        (word === "marco" ? MARCO_PREPOSITIONS : PREPOSITIONS).has(before);
      if (!ok) continue;
    }
    out.push({
      y: m[2] ? Number(m[2]) : null,
      m: monthNumber(word) as number,
      d: null,
    });
  }
  for (const m of text.matchAll(JA_MONTH_RE)) {
    const mo = Number(m[1]);
    if (mo < 1 || mo > 12) continue;
    if (overlaps(m.index, m.index + m[0].length)) continue;
    out.push({ y: null, m: mo, d: null });
  }
  return out;
}

/**
 * The range of a part, with the year rule applied. A day that does not exist
 * in the month (30 February) gives the whole month.
 */
function rangeOfPart(p: Parts, todayMs: number): [number, number] {
  const build = (y: number): [number, number] => {
    if (p.d === null || p.d > daysIn(y, p.m)) {
      return [Date.UTC(y, p.m - 1, 1), Date.UTC(y, p.m - 1, daysIn(y, p.m))];
    }
    const day = Date.UTC(y, p.m - 1, p.d);
    return [day, day];
  };
  const year = p.y ?? new Date(todayMs).getUTCFullYear();
  const range = build(year);
  // YEAR RULE: with no explicit year, a range that starts after today
  // belongs to the year before.
  return p.y === null && range[0] > todayMs ? build(year - 1) : range;
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/**
 * The date range that a question names, or nulls. `dateFrom` and `dateTo` are
 * ISO dates (yyyy-mm-dd), both included.
 */
export function parseDates(
  text: string,
  todayMs: number,
  utcOffsetMinutes = 0,
): DateRange {
  if (typeof text !== "string" || !Number.isFinite(todayMs)) return NONE;
  const shifted = todayMs + utcOffsetMinutes * 60_000;
  const t = new Date(shifted);
  // The start of the UTC day of "today".
  const today = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  const y = t.getUTCFullYear();
  const mo = t.getUTCMonth() + 1;
  const folded = fold(text);
  if (folded === "") return NONE;

  // 1. Absolute dates. Two or more give the range from the first to the last.
  const parts = absoluteParts(folded);
  if (parts.length > 0) {
    const ranges = parts.map((p) => rangeOfPart(p, today));
    const from = Math.min(...ranges.map((r) => r[0]));
    const to = Math.max(...ranges.map((r) => r[1]));
    return { dateFrom: iso(from), dateTo: iso(to) };
  }

  // 2. "last N days".
  const days = LAST_DAYS_RE.exec(folded);
  if (days) {
    const n = Math.min(Math.max(Number(days[1]), 1), 366);
    return { dateFrom: iso(today - (n - 1) * DAY_MS), dateTo: iso(today) };
  }

  // 3. Relative words.
  let rel: Relative | null = null;
  for (const [r, re] of RELATIVE_RE) {
    if (re.test(folded)) {
      rel = r;
      break;
    }
  }
  if (!rel) {
    for (const [r, word] of RELATIVE_JA) {
      if (text.includes(word)) {
        rel = r;
        break;
      }
    }
  }
  if (!rel) return NONE;

  const monday = today - ((new Date(today).getUTCDay() + 6) % 7) * DAY_MS;
  switch (rel) {
    case "today":
      return { dateFrom: iso(today), dateTo: iso(today) };
    case "yesterday":
      return { dateFrom: iso(today - DAY_MS), dateTo: iso(today - DAY_MS) };
    case "this_week":
      return { dateFrom: iso(monday), dateTo: iso(today) };
    case "last_week":
      return {
        dateFrom: iso(monday - 7 * DAY_MS),
        dateTo: iso(monday - DAY_MS),
      };
    case "this_month":
      return { dateFrom: iso(Date.UTC(y, mo - 1, 1)), dateTo: iso(today) };
    case "last_month": {
      const py = mo === 1 ? y - 1 : y;
      const pm = mo === 1 ? 12 : mo - 1;
      return {
        dateFrom: iso(Date.UTC(py, pm - 1, 1)),
        dateTo: iso(Date.UTC(py, pm - 1, daysIn(py, pm))),
      };
    }
  }
}

/**
 * The epoch range of two ISO dates. UTC day boundaries. `toMs` is exclusive
 * (the start of the day after `dateTo`), like the `dateRange` of `retrieve()`.
 * An open end is 0 or MAX_SAFE_INTEGER. Both null gives null. A text that is
 * not a real calendar date gives null.
 */
export function isoToRange(
  dateFrom: string | null | undefined,
  dateTo: string | null | undefined,
): { fromMs: number; toMs: number } | null {
  const from = dateFrom ? isoDayMs(dateFrom) : null;
  const to = dateTo ? isoDayMs(dateTo) : null;
  if (dateFrom && from === null) return null;
  if (dateTo && to === null) return null;
  if (from === null && to === null) return null;
  return {
    fromMs: from ?? 0,
    toMs: to === null ? Number.MAX_SAFE_INTEGER : to + DAY_MS,
  };
}

/** The UTC start of an ISO day, or null when it is not a real date. */
function isoDayMs(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return null;
  return Date.UTC(y, mo - 1, d);
}
