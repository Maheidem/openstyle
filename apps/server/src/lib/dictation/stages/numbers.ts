// Code stage S4 (specs/dictation-pipeline.md 4.2): spoken numbers become
// digits (owner rule 2026-10-26: numbers are always digits). Dates, times,
// money, percent, phone numbers and plain counts. Own number tables for en,
// es and pt (owner decision 2026-10-27). Other languages pass through.
//
// Kept as words on purpose (owner confirmed 2026-10-27):
// - the number one alone ("one", "un", "una", "uno", "um", "uma"): "no one",
//   "one of them". Inside a larger number, a time, money or a date it is a
//   digit. In a run of counts it is a digit too ("one cable two adapters" ->
//   "1 cable 2 adapters").
// - ordinals outside a date ("the second item").
// - "mil" alone ("mil gracias", "mil vezes").
//
// Number style: en 3,500 (years 1900-2099 have no comma); es 3500 and 12.000
// (es-ES: no point in a number of 4 digits, as the RAE says); pt 3.500 and
// 12.000 (pt-BR); es percent "12 %" (RAE), pt percent "12%".

import type { DictationLang } from "../language.js";

const fold = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const EN_UNITS: Record<string, number> = {
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
};
const EN_TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const EN_ORD: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  nineteenth: 19,
  twentieth: 20,
  thirtieth: 30,
};
const ES_UNITS: Record<string, number> = {
  cero: 0,
  un: 1,
  uno: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
  trece: 13,
  catorce: 14,
  quince: 15,
  dieciseis: 16,
  diecisiete: 17,
  dieciocho: 18,
  diecinueve: 19,
  veinte: 20,
  veintiun: 21,
  veintiuno: 21,
  veintiuna: 21,
  veintidos: 22,
  veintitres: 23,
  veinticuatro: 24,
  veinticinco: 25,
  veintiseis: 26,
  veintisiete: 27,
  veintiocho: 28,
  veintinueve: 29,
};
const ES_TENS: Record<string, number> = {
  treinta: 30,
  cuarenta: 40,
  cincuenta: 50,
  sesenta: 60,
  setenta: 70,
  ochenta: 80,
  noventa: 90,
};
const ES_HUNDREDS: Record<string, number> = {
  cien: 100,
  ciento: 100,
  doscientos: 200,
  doscientas: 200,
  trescientos: 300,
  trescientas: 300,
  cuatrocientos: 400,
  cuatrocientas: 400,
  quinientos: 500,
  quinientas: 500,
  seiscientos: 600,
  seiscientas: 600,
  setecientos: 700,
  setecientas: 700,
  ochocientos: 800,
  ochocientas: 800,
  novecientos: 900,
  novecientas: 900,
};
const EN_MONTHS = [
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
];
const ES_MONTHS = [
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
];
const EN_DIGIT: Record<string, string> = {
  zero: "0",
  oh: "0",
  o: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};
const ES_DIGIT: Record<string, string> = {
  cero: "0",
  uno: "1",
  dos: "2",
  tres: "3",
  cuatro: "4",
  cinco: "5",
  seis: "6",
  siete: "7",
  ocho: "8",
  nueve: "9",
};
const EN_CURRENCY = /^(dollars?|bucks|euros?|pounds?|cents?|yen)$/;
const ES_CURRENCY = /^(dolares|dolar|euros?|pesos?|centavos?|libras?)$/;
/** Words before a clock time: "at three thirty" -> "at 3:30". */
const EN_TIME_PREP = new Set([
  "at",
  "by",
  "until",
  "till",
  "from",
  "around",
  "before",
  "after",
]);

interface Tok {
  t: string;
  /** Word-like (letters or digits). */
  w: boolean;
}

function tokenize(text: string): Tok[] {
  const parts = text.match(/[\p{L}\p{M}'’]+|\d+(?:[.,:]\d+)*|\s+|./gsu) ?? [];
  return parts.map((t) => ({ t, w: /[\p{L}\d]/u.test(t) }));
}

interface NumParse {
  value: number;
  /** Word tokens used. */
  n: number;
  ordinal: boolean;
}

type EnState = "none" | "unit" | "teen" | "tens" | "hund" | "big";

/** An English cardinal or ordinal at words[k]. "a hundred" counts as 100. */
function parseEn(words: readonly string[], k: number): NumParse | null {
  let total = 0;
  let cur = 0;
  let used = 0;
  let last: EnState = "none";
  let ordinal = false;
  for (let i = k; i < words.length; i++) {
    const w = fold(words[i] ?? "");
    if (
      w === "a" &&
      last === "none" &&
      /^(hundred|thousand|million)$/.test(fold(words[i + 1] ?? ""))
    ) {
      cur = 1;
      used++;
      last = "unit";
      continue;
    }
    if (w === "and" && last === "hund") {
      const nx = fold(words[i + 1] ?? "");
      if (nx in EN_UNITS || nx in EN_TENS) {
        used++;
        continue;
      }
      break;
    }
    if (w in EN_ORD) {
      const v = EN_ORD[w] as number;
      const after =
        v < 10
          ? last === "tens" || last === "hund" || last === "big"
          : last === "hund" || last === "big";
      if (last === "none" || after) {
        cur += v;
        used++;
        ordinal = true;
      }
      break;
    }
    if (w in EN_UNITS) {
      const v = EN_UNITS[w] as number;
      if (last === "unit" || last === "teen") break;
      if (v >= 10 && last === "tens") break;
      cur += v;
      used++;
      last = v < 10 ? "unit" : "teen";
      continue;
    }
    if (w in EN_TENS) {
      if (last === "unit" || last === "teen" || last === "tens") break;
      cur += EN_TENS[w] as number;
      used++;
      last = "tens";
      continue;
    }
    if (w === "hundred" && (last === "unit" || last === "teen")) {
      cur *= 100;
      used++;
      last = "hund";
      continue;
    }
    if (
      (w === "thousand" || w === "million") &&
      last !== "none" &&
      last !== "big"
    ) {
      total += cur * (w === "thousand" ? 1000 : 1_000_000);
      cur = 0;
      used++;
      last = "big";
      continue;
    }
    break;
  }
  if (used === 0) return null;
  return { value: total + cur, n: used, ordinal };
}

/** "twenty twenty seven", "nineteen ninety", "twenty oh five", "two thousand twenty". */
function parseEnYear(words: readonly string[], k: number): NumParse | null {
  const a = parseEn(words, k);
  if (!a || a.ordinal) return null;
  if (a.value >= 1900 && a.value <= 2100 && a.n >= 2) return a;
  if (a.n === 1 && (a.value === 19 || a.value === 20)) {
    if (fold(words[k + 1] ?? "") === "oh") {
      const u = parseEn(words, k + 2);
      if (u && !u.ordinal && u.n === 1 && u.value >= 1 && u.value <= 9) {
        return { value: a.value * 100 + u.value, n: 3, ordinal: false };
      }
      return null;
    }
    const b = parseEn(words, k + 1);
    if (b && !b.ordinal && b.value >= 10 && b.value < 100) {
      return { value: a.value * 100 + b.value, n: 1 + b.n, ordinal: false };
    }
  }
  return null;
}

/** en: 3,500 and 12,000; years (1900 to 2099) have no comma. */
function fmtEn(n: number): string {
  if (n >= 1900 && n <= 2099) return String(n);
  return n >= 1000 ? n.toLocaleString("en-US") : String(n);
}

function ordSuffix(n: number): string {
  const t = n % 100;
  if (t >= 11 && t <= 13) return "th";
  return (
    ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"
  );
}

type Replace = (k0: number, k1: number, s: string) => void;

function digitRun(
  k: number,
  W: (k: number) => string,
  map: Record<string, string>,
): { digits: string; end: number } | null {
  let j = k;
  let ds = "";
  while (W(j) in map) {
    ds += map[W(j)];
    j++;
  }
  return ds.length >= 7 ? { digits: ds, end: j - 1 } : null;
}

function enRuleAt(
  k: number,
  W: (k: number) => string,
  words: readonly string[],
  replace: Replace,
): boolean {
  const w = W(k);
  // Phone numbers and other digit runs: 7 or more digit words.
  if (w in EN_DIGIT && w !== "o" && w !== "oh") {
    const run = digitRun(k, W, EN_DIGIT);
    if (run) {
      const d = run.digits;
      replace(
        k,
        run.end,
        d.length === 7
          ? `${d.slice(0, 3)}-${d.slice(3)}`
          : d.length === 10
            ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`
            : d,
      );
      return true;
    }
  }
  // Date: Month + day [+ year]. "may" is also a verb: no rule.
  const mi = EN_MONTHS.indexOf(w);
  if (mi >= 0 && w !== "may") {
    const d = parseEn(words, k + 1);
    if (d && d.value >= 1 && d.value <= 31) {
      let end = k + d.n;
      const month = EN_MONTHS[mi] as string;
      let s = `${month[0]?.toUpperCase()}${month.slice(1)} ${d.value}${d.ordinal ? ordSuffix(d.value) : ""}`;
      const y = parseEnYear(words, end + 1);
      if (y) {
        s += `, ${y.value}`;
        end += y.n;
      }
      replace(k, end, s);
      return true;
    }
  }
  const year = parseEnYear(words, k);
  if (year && year.n >= 2 && parseEn(words, k)?.n !== year.n) {
    replace(k, k + year.n - 1, String(year.value));
    return true;
  }
  const n = parseEn(words, k);
  if (!n) return false;
  const after = k + n.n;
  if (!n.ordinal && n.value >= 1 && n.value <= 12) {
    // Clock time: H [MM] am/pm, H o'clock, "at H MM".
    let mm: number | null = null;
    let used = n.n;
    const oh = W(after) === "oh";
    const m2 = parseEn(words, oh ? after + 1 : after);
    const m2End = m2 ? (oh ? after + 1 : after) + m2.n : after;
    const minuteOk =
      m2 &&
      !m2.ordinal &&
      (oh ? m2.value >= 1 && m2.value <= 9 : m2.value >= 10 && m2.value <= 59);
    if (minuteOk && /^(am|pm)$/.test(W(m2End))) {
      mm = m2.value;
      used = m2End - k;
    }
    const ap = W(k + used);
    if (ap === "am" || ap === "pm") {
      replace(
        k,
        k + used,
        `${n.value}${mm !== null ? `:${String(mm).padStart(2, "0")}` : ""} ${ap.toUpperCase()}`,
      );
      return true;
    }
    if (W(after) === "o'clock" || W(after) === "o’clock") {
      replace(k, after, `${n.value} o'clock`);
      return true;
    }
    if (minuteOk && n.n === 1 && EN_TIME_PREP.has(W(k - 1))) {
      replace(k, m2End - 1, `${n.value}:${String(m2.value).padStart(2, "0")}`);
      return true;
    }
  }
  if (n.ordinal) return false;
  if (EN_CURRENCY.test(W(after))) {
    replace(k, after - 1, fmtEn(n.value));
    return true;
  }
  if (
    W(after) === "percent" ||
    (W(after) === "per" && W(after + 1) === "cent")
  ) {
    replace(k, after + (W(after) === "per" ? 1 : 0), `${n.value}%`);
    return true;
  }
  if (W(after) === "point") {
    let j = after + 1;
    let ds = "";
    while (W(j) in EN_DIGIT && W(j) !== "o") {
      ds += EN_DIGIT[W(j)];
      j++;
    }
    if (ds) {
      replace(k, j - 1, `${n.value}.${ds}`);
      return true;
    }
  }
  if (keepsWord(n, w, words, k, parseEn)) return false;
  replace(k, after - 1, fmtEn(n.value));
  return true;
}

/** Words after a lone "one" that make it a pronoun or an article, not a count. */
const ONE_NOT_COUNT = new Set(
  "of the a an de del la el los las o os do da dos das que".split(" "),
);
/** Words before a lone "one" that make it a pronoun: "no one", "this one". */
const ONE_AFTER_PRONOUN = new Set(
  "no any every some each this that the which another".split(" "),
);

/**
 * A word that stays a word when it is the whole number: an ordinal, a lone
 * "one" (unless a count of 2 or more follows within 3 words: "one cable two
 * adapters"), and a lone "mil".
 */
function keepsWord(
  n: NumParse,
  first: string,
  words: readonly string[],
  k: number,
  parse: (words: readonly string[], k: number) => NumParse | null,
): boolean {
  if (n.ordinal) return true;
  if (n.n !== 1) return false;
  if (first === "mil") return true;
  if (n.value !== 1) return false;
  if (ONE_NOT_COUNT.has(fold(words[k + 1] ?? ""))) return true;
  if (ONE_AFTER_PRONOUN.has(fold(words[k - 1] ?? ""))) return true;
  for (let j = k + 2; j <= k + 4 && j < words.length; j++) {
    // "por ciento" / "por cento" / "per cent" is not a count.
    if (/^(por|per)$/.test(fold(words[j - 1] ?? ""))) continue;
    const m = parse(words, j);
    const loneMil = m?.n === 1 && fold(words[j] ?? "") === "mil";
    if (m && !m.ordinal && m.value >= 2 && !loneMil) return false;
  }
  return true;
}

// --- es and pt -----------------------------------------------------------------

interface RomanceTable {
  lang: "es" | "pt";
  units: Record<string, number>;
  tens: Record<string, number>;
  hundreds: Record<string, number>;
  /** "y" (es), "e" (pt). */
  and: string;
  /** pt also joins after a hundred and after "mil": "cento e vinte", "dois mil e quinhentos". */
  andAfterHundreds: boolean;
  million: RegExp;
  months: string[];
  digits: Record<string, string>;
  /** Digit words that only count inside a run ("meia" = 6 in pt phone numbers). */
  runOnlyDigits: Record<string, string>;
  currency: RegExp;
  percent: [string, string];
  decimal: string;
  /** Words before the hour article. */
  timePrep: RegExp;
  /** The hour article ("las"/"la" in es; pt "às" is one word). */
  hourWord: (w: string, raw: string, prev: string) => boolean;
  /** Day 1 in a date ("1" in es, "1º" in pt-BR). */
  firstDay: string;
  fmt: (n: number) => string;
  phone: (d: string) => string;
  percentFmt: (n: number) => string;
  /** The words of half and quarter hours. */
  half: [string, string];
  quarter: [string, string];
}

const ES: RomanceTable = {
  lang: "es",
  units: ES_UNITS,
  tens: ES_TENS,
  hundreds: ES_HUNDREDS,
  and: "y",
  andAfterHundreds: false,
  million: /^(millon|millones)$/,
  months: ES_MONTHS,
  digits: ES_DIGIT,
  runOnlyDigits: {},
  currency: ES_CURRENCY,
  percent: ["por", "ciento"],
  decimal: "coma",
  timePrep: /^(a|son|desde|hasta)$/,
  hourWord: (w, _raw, prev) =>
    (w === "las" || w === "la") && /^(a|son|desde|hasta)$/.test(prev),
  firstDay: "1",
  fmt: (n) => (n >= 10000 ? n.toLocaleString("es-ES") : String(n)),
  phone: (d) =>
    d.length === 9
      ? `${d.slice(0, 3)} ${d.slice(3, 5)} ${d.slice(5, 7)} ${d.slice(7)}`
      : d,
  percentFmt: (n) => `${n} %`,
  half: ["y", "media"],
  quarter: ["y", "cuarto"],
};

const PT_UNITS: Record<string, number> = {
  zero: 0,
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
const PT_TENS: Record<string, number> = {
  vinte: 20,
  trinta: 30,
  quarenta: 40,
  cinquenta: 50,
  sessenta: 60,
  setenta: 70,
  oitenta: 80,
  noventa: 90,
};
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

const PT: RomanceTable = {
  lang: "pt",
  units: PT_UNITS,
  tens: PT_TENS,
  hundreds: PT_HUNDREDS,
  and: "e",
  andAfterHundreds: true,
  million: /^(milhao|milhoes)$/,
  months:
    "janeiro fevereiro marco abril maio junho julho agosto setembro outubro novembro dezembro".split(
      " ",
    ),
  digits: {
    zero: "0",
    um: "1",
    dois: "2",
    tres: "3",
    quatro: "4",
    cinco: "5",
    seis: "6",
    sete: "7",
    oito: "8",
    nove: "9",
  },
  runOnlyDigits: { meia: "6" },
  currency: /^(reais|real|dolares|dolar|euros?|centavos?|libras?)$/,
  percent: ["por", "cento"],
  decimal: "virgula",
  timePrep: /^$/,
  // pt "às" carries the article; "as" without the accent is "the" (no rule).
  hourWord: (_w, raw) => raw.toLowerCase() === "às",
  firstDay: "1º",
  fmt: (n) => (n >= 1000 ? n.toLocaleString("pt-BR") : String(n)),
  phone: (d) =>
    d.length === 11
      ? `${d.slice(0, 2)} ${d.slice(2, 7)}-${d.slice(7)}`
      : d.length === 10
        ? `${d.slice(0, 2)} ${d.slice(2, 6)}-${d.slice(6)}`
        : d.length === 9
          ? `${d.slice(0, 5)}-${d.slice(5)}`
          : d.length === 8
            ? `${d.slice(0, 4)}-${d.slice(4)}`
            : d,
  percentFmt: (n) => `${n}%`,
  half: ["e", "meia"],
  quarter: ["e", "quinze"],
};

type RomanceState = "none" | "unit" | "tens" | "and" | "hund" | "big";

/** An es or pt cardinal at words[k]. */
function parseRomance(
  words: readonly string[],
  k: number,
  T: RomanceTable,
): NumParse | null {
  let total = 0;
  let cur = 0;
  let used = 0;
  let last: RomanceState = "none";
  for (let i = k; i < words.length; i++) {
    const w = fold(words[i] ?? "");
    if (
      w === T.and &&
      (last === "tens" ||
        (T.andAfterHundreds && (last === "hund" || last === "big")))
    ) {
      const nx = fold(words[i + 1] ?? "");
      const ok =
        last === "tens"
          ? nx in T.units && (T.units[nx] as number) < 10
          : nx in T.units || nx in T.tens || nx in T.hundreds;
      if (ok) {
        used++;
        last = "and";
        continue;
      }
      break;
    }
    if (w in T.units) {
      if (last === "unit" || last === "tens") break;
      cur += T.units[w] as number;
      used++;
      last = "unit";
      continue;
    }
    if (w in T.tens) {
      if (last === "unit" || last === "tens") break;
      cur += T.tens[w] as number;
      used++;
      last = "tens";
      continue;
    }
    if (w in T.hundreds) {
      if (last !== "none" && last !== "big" && last !== "and") break;
      cur += T.hundreds[w] as number;
      used++;
      last = "hund";
      continue;
    }
    if (w === "mil" && last !== "big") {
      total += (cur || 1) * 1000;
      cur = 0;
      used++;
      last = "big";
      continue;
    }
    if (T.million.test(w) && last !== "none") {
      total += (cur || 1) * 1_000_000;
      cur = 0;
      used++;
      last = "big";
      continue;
    }
    break;
  }
  // A trailing joiner is not part of the number.
  if (last === "and") used--;
  if (used <= 0) return null;
  return { value: total + cur, n: used, ordinal: false };
}

function romanceRuleAt(
  k: number,
  W: (k: number) => string,
  words: readonly string[],
  replace: Replace,
  T: RomanceTable,
): boolean {
  const parse = (ws: readonly string[], j: number) => parseRomance(ws, j, T);
  const w = W(k);
  if (w in T.digits) {
    let j = k;
    let ds = "";
    while (W(j) in T.digits || (j > k && W(j) in T.runOnlyDigits)) {
      ds += T.digits[W(j)] ?? T.runOnlyDigits[W(j)];
      j++;
    }
    if (ds.length >= 7) {
      replace(k, j - 1, T.phone(ds));
      return true;
    }
  }
  // Date: N de mes [de año].
  const day = w === "primero" || w === "primeiro" ? null : parse(words, k);
  const dayValue = day
    ? day.value
    : w === "primero" || w === "primeiro"
      ? 1
      : 0;
  const dayLen = day ? day.n : 1;
  if (
    dayValue >= 1 &&
    dayValue <= 31 &&
    W(k + dayLen) === "de" &&
    T.months.includes(W(k + dayLen + 1))
  ) {
    let end = k + dayLen + 1;
    let s = `${dayValue === 1 ? T.firstDay : dayValue} de ${(words[end] ?? "").toLowerCase()}`;
    if (W(end + 1) === "de") {
      const y = parse(words, end + 2);
      if (y && y.value >= 1900 && y.value <= 2100) {
        s += ` de ${y.value}`;
        end += 1 + y.n;
      }
    }
    replace(k, end, s);
    return true;
  }
  // Clock time: a las H / às H [y media | e meia | y cuarto | y MM].
  if (T.hourWord(w, words[k] ?? "", W(k - 1))) {
    const h = parse(words, k + 1);
    if (h && h.value >= 1 && h.value <= 24) {
      let end = k + 1 + h.n;
      let mm: number | null = null;
      let hh = h.value;
      if (W(end) === T.half[0] && W(end + 1) === T.half[1]) {
        mm = 30;
        end += 2;
      } else if (W(end) === T.quarter[0] && W(end + 1) === T.quarter[1]) {
        mm = 15;
        end += 2;
      } else if (W(end) === "menos" && W(end + 1) === "cuarto") {
        mm = 45;
        hh = hh === 1 ? 12 : hh - 1;
        end += 2;
      } else if (W(end) === T.and) {
        const m = parse(words, end + 1);
        if (m && m.value > 0 && m.value < 60) {
          mm = m.value;
          end += 1 + m.n;
        }
      }
      replace(
        k + 1,
        end - 1,
        `${hh}${mm !== null ? `:${String(mm).padStart(2, "0")}` : ""}`,
      );
      return true;
    }
  }
  const n = parse(words, k);
  if (!n) return false;
  const after = k + n.n;
  if (T.currency.test(W(after)) && !(n.value === 1 && n.n === 1)) {
    replace(k, after - 1, T.fmt(n.value));
    return true;
  }
  if (W(after) === T.percent[0] && W(after + 1) === T.percent[1]) {
    replace(k, after + 1, T.percentFmt(n.value));
    return true;
  }
  if (W(after) === T.decimal) {
    let j = after + 1;
    let ds = "";
    while (W(j) in T.digits) {
      ds += T.digits[W(j)];
      j++;
    }
    if (ds) {
      replace(k, j - 1, `${n.value},${ds}`);
      return true;
    }
  }
  if (keepsWord(n, w, words, k, parse)) return false;
  replace(k, after - 1, T.fmt(n.value));
  return true;
}

/**
 * One rule pass over the word tokens. At each word the rules run in order and
 * the first match wins; then the pass starts again on the new tokens.
 */
function latinNumbers(text: string, lang: DictationLang): string {
  const toks = tokenize(text.replace(/\b([ap])\.\s?m\./gi, "$1m"));
  for (let guard = 0; guard < 500; guard++) {
    const wi = toks.flatMap((t, i) => (t.w ? [i] : []));
    const words = wi.map((i) => (toks[i] as Tok).t);
    const W = (k: number) => fold(words[k] ?? "");
    const replace = (k0: number, k1: number, s: string) => {
      const a = wi[k0] as number;
      const b = wi[k1] as number;
      toks.splice(a, b - a + 1, { t: s, w: true });
    };
    let hit = false;
    for (let k = 0; k < words.length && !hit; k++) {
      hit =
        lang === "en"
          ? enRuleAt(k, W, words, replace)
          : romanceRuleAt(k, W, words, replace, lang === "es" ? ES : PT);
    }
    if (!hit) break;
  }
  return toks.map((t) => t.t).join("");
}

/** S4: write spoken numbers as digits. No rules for the language: no change. */
export function spokenNumbers(
  text: string,
  lang: DictationLang | null,
): string {
  return lang ? latinNumbers(text, lang) : text;
}
