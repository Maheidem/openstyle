// Code stage S4 (specs/dictation-pipeline.md 4.2): spoken numbers become
// digits (owner rule 2026-10-26: numbers are always digits). Dates, times,
// money, percent, phone numbers and plain counts. Own number tables for en,
// es and zh. Other languages pass through.
//
// Kept as words on purpose:
// - the number one alone ("one", "un", "una", "uno", 一): "no one", "one of
//   them", 一下, 一起. Inside a larger number, a time, money or a date it is a
//   digit.
// - ordinals outside a date ("the second item", 第二).
// - es "mil" alone ("mil gracias").
// - zh numbers without a unit: a zh number becomes digits only before a
//   measure word, in a date or time, or with money or percent (十分 = "very",
//   三明治 = "sandwich").

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

type EsState = "none" | "unit" | "tens" | "y" | "hund" | "big";

function parseEs(words: readonly string[], k: number): NumParse | null {
  let total = 0;
  let cur = 0;
  let used = 0;
  let last: EsState = "none";
  for (let i = k; i < words.length; i++) {
    const w = fold(words[i] ?? "");
    if (w === "y" && last === "tens") {
      const nx = fold(words[i + 1] ?? "");
      if (nx in ES_UNITS && (ES_UNITS[nx] as number) < 10) {
        used++;
        last = "y";
        continue;
      }
      break;
    }
    if (w in ES_UNITS) {
      const v = ES_UNITS[w] as number;
      if (last === "unit" || last === "tens") break;
      if (last === "y" && v >= 10) break;
      cur += v;
      used++;
      last = "unit";
      continue;
    }
    if (w in ES_TENS) {
      if (last === "unit" || last === "tens" || last === "y") break;
      cur += ES_TENS[w] as number;
      used++;
      last = "tens";
      continue;
    }
    if (w in ES_HUNDREDS) {
      if (last !== "none" && last !== "big") break;
      cur += ES_HUNDREDS[w] as number;
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
    if ((w === "millon" || w === "millones") && last !== "none") {
      total += (cur || 1) * 1_000_000;
      cur = 0;
      used++;
      last = "big";
      continue;
    }
    break;
  }
  if (used === 0) return null;
  return { value: total + cur, n: used, ordinal: false };
}

/** en: 3,500 and 12,000; years (1900 to 2099) have no comma. */
function fmtEn(n: number): string {
  if (n >= 1900 && n <= 2099) return String(n);
  return n >= 1000 ? n.toLocaleString("en-US") : String(n);
}

/** es: 3500 (four digits, no point), 12.000. */
function fmtEs(n: number): string {
  return n >= 10000 ? n.toLocaleString("es-ES") : String(n);
}

function ordSuffix(n: number): string {
  const t = n % 100;
  if (t >= 11 && t <= 13) return "th";
  return (
    ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"
  );
}

function phoneFormat(d: string, lang: "en" | "es"): string {
  if (lang === "es" && d.length === 9) {
    return `${d.slice(0, 3)} ${d.slice(3, 5)} ${d.slice(5, 7)} ${d.slice(7)}`;
  }
  if (d.length === 7) return `${d.slice(0, 3)}-${d.slice(3)}`;
  if (d.length === 10) {
    return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  }
  return d;
}

/** A word that stays a word when it is the whole number. */
function keepsWord(lang: "en" | "es", n: NumParse, first: string): boolean {
  if (n.ordinal) return true;
  if (n.n !== 1) return false;
  if (n.value === 1) return true;
  return lang === "es" && first === "mil";
}

/**
 * One rule pass over the word tokens. At each word the rules run in order and
 * the first match wins; then the pass starts again on the new tokens.
 */
function latinNumbers(text: string, lang: "en" | "es"): string {
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
          : esRuleAt(k, W, words, replace);
    }
    if (!hit) break;
  }
  return toks.map((t) => t.t).join("");
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
      replace(k, run.end, phoneFormat(run.digits, "en"));
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
  if (keepsWord("en", n, w)) return false;
  replace(k, after - 1, fmtEn(n.value));
  return true;
}

function esRuleAt(
  k: number,
  W: (k: number) => string,
  words: readonly string[],
  replace: Replace,
): boolean {
  const w = W(k);
  if (w in ES_DIGIT) {
    const run = digitRun(k, W, ES_DIGIT);
    if (run) {
      replace(k, run.end, phoneFormat(run.digits, "es"));
      return true;
    }
  }
  // Date: N de mes [de año].
  const day =
    w === "primero" ? { value: 1, n: 1, ordinal: false } : parseEs(words, k);
  if (
    day &&
    day.value >= 1 &&
    day.value <= 31 &&
    W(k + day.n) === "de" &&
    ES_MONTHS.includes(W(k + day.n + 1))
  ) {
    let end = k + day.n + 1;
    let s = `${day.value} de ${W(end)}`;
    if (W(end + 1) === "de") {
      const y = parseEs(words, end + 2);
      if (y && y.value >= 1900 && y.value <= 2100) {
        s += ` de ${y.value}`;
        end += 1 + y.n;
      }
    }
    replace(k, end, s);
    return true;
  }
  // Clock time: a las H [y media | y cuarto | menos cuarto | y MM].
  if ((w === "las" || w === "la") && /^(a|son|desde|hasta)$/.test(W(k - 1))) {
    const h = parseEs(words, k + 1);
    if (h && h.value >= 1 && h.value <= 24) {
      let end = k + 1 + h.n;
      let mm: number | null = null;
      let hh = h.value;
      if (W(end) === "y" && W(end + 1) === "media") {
        mm = 30;
        end += 2;
      } else if (W(end) === "y" && W(end + 1) === "cuarto") {
        mm = 15;
        end += 2;
      } else if (W(end) === "menos" && W(end + 1) === "cuarto") {
        mm = 45;
        hh = hh === 1 ? 12 : hh - 1;
        end += 2;
      } else if (W(end) === "y") {
        const m = parseEs(words, end + 1);
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
  const n = parseEs(words, k);
  if (!n) return false;
  const after = k + n.n;
  if (ES_CURRENCY.test(W(after)) && !(n.value === 1 && n.n === 1)) {
    replace(k, after - 1, fmtEs(n.value));
    return true;
  }
  if (W(after) === "por" && W(after + 1) === "ciento") {
    replace(k, after + 1, `${n.value} %`);
    return true;
  }
  if (W(after) === "coma") {
    let j = after + 1;
    let ds = "";
    while (W(j) in ES_DIGIT) {
      ds += ES_DIGIT[W(j)];
      j++;
    }
    if (ds) {
      replace(k, j - 1, `${n.value},${ds}`);
      return true;
    }
  }
  if (keepsWord("es", n, w)) return false;
  replace(k, after - 1, fmtEs(n.value));
  return true;
}

// --- Chinese -----------------------------------------------------------------

const ZH_DIGIT: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  幺: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};
const ZH_NUM = "[零〇一二两三四五六七八九十百千万幺]";
const ZH_PERIOD = "上午|下午|早上|晚上|中午|凌晨|傍晚";
/** Measure words after a count: 三个 -> 3个. Long words first. */
const ZH_MEASURE =
  "个月|小时|分钟|秒钟|公里|个|位|名|次|件|本|张|台|条|份|只|天|周|年|岁|秒|人|页|号|米|斤|箱|瓶|杯|家|种|项|篇|封|遍|趟|倍|层|楼|辆|支|套|间|句|段|章|节|场|届|批|组|双";

/** A zh digit string ("二零二七") or a zh number with units ("三千五百"). */
function zhValue(s: string, allowDigitString: boolean): number | null {
  if (!s) return null;
  if (!/[十百千万]/.test(s)) {
    if (s.length === 1) return ZH_DIGIT[s] ?? null;
    if (!allowDigitString) return null;
    return Number([...s].map((c) => ZH_DIGIT[c] ?? "x").join(""));
  }
  let total = 0;
  let section = 0;
  let num = 0;
  for (const c of s) {
    if (c in ZH_DIGIT) num = ZH_DIGIT[c] as number;
    else if (c === "十") {
      section += (num || 1) * 10;
      num = 0;
    } else if (c === "百") {
      section += num * 100;
      num = 0;
    } else if (c === "千") {
      section += num * 1000;
      num = 0;
    } else if (c === "万") {
      total += (section + num) * 10000;
      section = 0;
      num = 0;
    } else return null;
  }
  const v = total + section + num;
  return Number.isFinite(v) ? v : null;
}

function zhNumbers(text: string): string {
  let out = text;
  // Phone numbers and other digit runs.
  out = out.replace(/[零〇一二三四五六七八九幺]{7,}/g, (m) =>
    [...m].map((c) => ZH_DIGIT[c]).join(""),
  );
  // Years: 二零二七年.
  out = out.replace(/([零〇一二三四五六七八九]{4})年/g, (m, y: string) => {
    const v = zhValue(y, true);
    return v !== null ? `${v}年` : m;
  });
  // Month + day: 三月十五号.
  out = out.replace(
    /([一二三四五六七八九十]{1,3})月([一二三四五六七八九十]{1,3})([号日])/g,
    (m, a: string, b: string, c: string) => {
      const mo = zhValue(a, false);
      const d = zhValue(b, false);
      return mo && d && mo <= 12 && d <= 31 ? `${mo}月${d}${c}` : m;
    },
  );
  // Counts before a measure word: 两个 -> 2个, 十分钟 -> 10分钟.
  out = out.replace(
    new RegExp(
      `(?<![第${ZH_NUM.slice(1, -1)}])(${ZH_NUM}+)(${ZH_MEASURE})`,
      "g",
    ),
    (m, n: string, unit: string) => {
      const v = zhValue(n, false);
      return v !== null && v >= 2 ? `${v}${unit}` : m;
    },
  );
  // Clock time: [下午]三点[半|十五分|钟]. 一点 without a period word or a
  // suffix is "a little" (好一点), so it stays.
  out = out.replace(
    new RegExp(
      `(?<!周|期|拜)(?<!(?<![周期拜])[第零〇一二两三四五六七八九十百千万])(${ZH_PERIOD})?([一二两三四五六七八九十]{1,3})点(半|钟|([零一二三四五六七八九十]{1,3})分)?(?![零〇一二两三四五六七八九十])`,
      "g",
    ),
    (
      m,
      period: string | undefined,
      h: string,
      rest: string | undefined,
      mi: string | undefined,
    ) => {
      const hh = zhValue(h, false);
      if (hh === null || hh > 24) return m;
      if (hh === 1 && !period && !rest) return m;
      const p = period ?? "";
      if (rest === "半") return `${p}${hh}点半`;
      if (rest === "钟") return `${p}${hh}点钟`;
      if (mi) {
        const v = zhValue(mi, false);
        return v !== null && v < 60
          ? `${p}${hh}:${String(v).padStart(2, "0")}`
          : m;
      }
      return `${p}${hh}点`;
    },
  );
  // Money.
  out = out.replace(
    new RegExp(`(?<!第)(${ZH_NUM}+)(块钱|块|元|美元|欧元|英镑)`, "g"),
    (m, n: string, cur: string) => {
      const v = zhValue(n, false);
      return v !== null && v > 0 ? `${v}${cur}` : m;
    },
  );
  // Percent.
  out = out.replace(new RegExp(`百分之(${ZH_NUM}+)`, "g"), (m, n: string) => {
    const v = zhValue(n, false);
    return v !== null ? `${v}%` : m;
  });
  return out;
}

/** S4: write spoken numbers as digits. No rules for the language: no change. */
export function spokenNumbers(
  text: string,
  lang: DictationLang | null,
): string {
  if (lang === "en" || lang === "es") return latinNumbers(text, lang);
  if (lang === "zh") return zhNumbers(text);
  return text;
}
