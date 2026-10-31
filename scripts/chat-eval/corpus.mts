// corpus.mts: the fictional corpus builder (spec 8.2). Seeded and pure: the
// same seed gives the same bytes. 30 meetings (4 folders of 6 to 7, plus 4
// unfiled), 12 people, EN, PT and mixed. Facts are planted at known
// segments; distractors (similar numbers, shared first names, the same
// vendor in two folders) sit around them. Nothing here is real data.

import {
  FOLDER_BANKS,
  GENERIC_CLOSE,
  GENERIC_MID,
  GENERIC_OPEN,
  type FolderBank,
  type L,
  type Vendor,
} from "./bank.mts";
import type {
  ActionItem,
  Corpus,
  Fact,
  Folder,
  Lang,
  Meeting,
  MeetingLang,
  Person,
  Segment,
  SummaryItem,
} from "./types.mts";

export const OWNER_ID = "p00";
export const OWNER_NAME = "Helena Duarte";
/** The clock of the corpus: Monday 2026-10-26, 12:00 UTC. */
export const TODAY_MS = Date.UTC(2026, 9, 26, 12, 0, 0);
const START = Date.UTC(2026, 7, 3, 10, 0, 0); // Monday 2026-08-03
const DAY = 86_400_000;

export const PEOPLE: Person[] = [
  { id: "p01", first: "Ana", full: "Ana Silvestre", variants: ["Ana S.", "Aninha"], asr: "Anna Silvestri" },
  { id: "p02", first: "Ana", full: "Ana Brandt", variants: ["Ana B."], asr: "Anna Brant" },
  { id: "p03", first: "Carlos", full: "Carlos Medeiros", variants: ["Carlão", "Carlos M."], asr: "Carlos Medeyros" },
  { id: "p04", first: "Carlos", full: "Carlos Okafor", variants: ["Carlos O."], asr: "Carlos Okafour" },
  { id: "p05", first: "Priya", full: "Priya Nandakumar", variants: ["Priya N."], asr: "Pria Nandacumar" },
  { id: "p06", first: "Tomasz", full: "Tomasz Wieczorek", variants: ["Tomek"], asr: "Tomash Vyechorek" },
  { id: "p07", first: "Lucia", full: "Lucia Ferraro", variants: ["Lu"], asr: "Lúcia Ferrero" },
  { id: "p08", first: "Jonas", full: "Jonas Eklund", variants: ["Jonas E."], asr: "Yonas Ecklund" },
  { id: "p09", first: "Mei", full: "Mei Halvorsen", variants: ["Mei H."], asr: "May Halvorson" },
  { id: "p10", first: "Rafael", full: "Rafael Quintanilha", variants: ["Rafa"], asr: "Rafael Quintanília" },
  { id: "p11", first: "Sofia", full: "Sofia Almeida", variants: ["Sô"], asr: "Sofia Almeda" },
  { id: OWNER_ID, first: "Helena", full: OWNER_NAME, variants: [], asr: "Elena Duarte" },
];
const person = (id: string) => PEOPLE.find((p) => p.id === id) as Person;

export const FOLDERS: (Folder & { key: string })[] = [
  { key: "atlas", id: "fld-atlas", name: "Atlas Migration", description: "Moving the billing and reporting stack to the new cloud.", teamPersonIds: ["p01", "p03", "p05", "p06"] },
  { key: "harbor", id: "fld-harbor", name: "Harbor Pricing", description: "New price plans and discounts for next year.", teamPersonIds: ["p02", "p04", "p07", "p08"] },
  { key: "mobile", id: "fld-mobile", name: "Mobile Relaunch", description: "The new version of the phone app.", teamPersonIds: ["p09", "p10", "p11", "p01"] },
  { key: "audit", id: "fld-audit", name: "Vendor Audit", description: "The yearly check of our main suppliers.", teamPersonIds: ["p03", "p07", "p06", "p02"] },
];

// --- Seeded random numbers ------------------------------------------------

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rng = () => number;
const pick = <T,>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
function shuffle<T>(r: Rng, xs: readonly T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

// --- Plan -----------------------------------------------------------------

type Step =
  | "quote" | "metric" | "date" | "decision" | "assign" | "openq" | "approve"
  | "propose" | "org" | "upd:quote" | "upd:date" | "upd:metric";

const RECIPES: Step[][] = [
  ["quote", "date", "decision", "assign", "org"],
  ["metric", "date", "openq", "assign", "approve"],
  ["quote", "decision", "assign", "propose", "upd:quote"],
  ["metric", "date", "openq", "assign", "org"],
  ["quote", "decision", "approve", "upd:date", "propose"],
  ["metric", "date", "assign", "propose", "openq"],
  ["quote", "decision", "date", "approve", "upd:metric"],
];
const OPS_RECIPES: Step[][] = [
  ["quote", "date", "decision", "assign", "org"],
  ["metric", "date", "openq", "assign", "approve"],
  ["quote", "decision", "assign", "propose", "approve"],
  ["metric", "date", "openq", "assign", "propose"],
];

interface MeetingPlan {
  key: string; // bank key
  folderId: string | null;
  index: number;
  week: number;
  dow: number;
  lang: MeetingLang;
  recipe: Step[];
  team: string[];
}
const PLANS: MeetingPlan[] = [];
(function buildPlans() {
  const cal: Record<string, { weeks: number[]; dow: number; langs: MeetingLang[] }> = {
    atlas: { weeks: [0, 2, 3, 5, 7, 9, 11], dow: 1, langs: ["en", "en", "pt", "en", "mixed", "en", "en"] },
    harbor: { weeks: [0, 1, 3, 4, 6, 8, 11], dow: 2, langs: ["en", "en", "en", "pt", "en", "mixed", "en"] },
    mobile: { weeks: [1, 2, 4, 6, 8, 10], dow: 3, langs: ["en", "pt", "en", "mixed", "en", "en"] },
    audit: { weeks: [1, 3, 5, 7, 9, 10], dow: 4, langs: ["en", "en", "pt", "en", "mixed", "en"] },
    ops: { weeks: [0, 4, 8, 11], dow: 0, langs: ["pt", "en", "pt", "en"] },
  };
  for (const [key, c] of Object.entries(cal)) {
    const f = FOLDERS.find((x) => x.key === key);
    c.weeks.forEach((week, index) => {
      PLANS.push({
        key,
        folderId: f?.id ?? null,
        index,
        week,
        dow: c.dow,
        lang: c.langs[index] as MeetingLang,
        recipe: (key === "ops" ? OPS_RECIPES : RECIPES)[index] as Step[],
        team: f?.teamPersonIds ?? ["p01", "p05", "p07", "p10"],
      });
    });
  }
})();

// --- Formatting -----------------------------------------------------------

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const MONTH_EN = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTH_PT = ["", "janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
export interface MD { m: number; d: number }
export const fmtDate = (x: MD, lang: Lang) =>
  lang === "en" ? `${MONTH_EN[x.m]} ${x.d}` : `${x.d} de ${MONTH_PT[x.m]}`;
export const fmtAmount = (n: number, lang: Lang) =>
  lang === "en" ? n.toLocaleString("en-US") : n.toLocaleString("pt-BR");
const two = (n: number) => String(n).padStart(2, "0");
export const dateToken = (x: MD) => `d:${two(x.m)}-${two(x.d)}`;

export function l(x: L, lang: Lang): string {
  return lang === "en" ? x[0] : x[1];
}

// --- Fact lines -----------------------------------------------------------

interface Built {
  fact: Omit<Fact, "id" | "meetingId" | "segmentIdx" | "speakerPersonId">;
  line: (lang: Lang) => string;
  /** Summary item. */
  sumKey?: (lang: Lang) => string;
  sumDecision?: (lang: Lang) => string;
  sumAction?: (lang: Lang) => ActionDraft;
  sumOpen?: (lang: Lang) => string;
  /** Persons that must not speak this line (named in it). */
  namedPersonId?: string | null;
}
interface ActionDraft { task: string; owner: string; ownerPersonId: string; due: string }

interface Pools {
  amounts: number[];
  metrics: number[];
  dates: MD[];
}
function makePools(r: Rng): Pools {
  const base = [];
  for (let i = 0; i < 70; i++) base.push(30_000 + i * 700 + (i % 2 === 0 ? 0 : 500));
  const amounts = shuffle(r, base);
  const metrics = shuffle(r, Array.from({ length: 200 }, (_, i) => 20 + i * 3 + (i % 5)));
  const dates: MD[] = [];
  for (let d = 2; d <= 30; d++) dates.push({ m: 11, d });
  for (let d = 1; d <= 22; d++) dates.push({ m: 12, d });
  // 51 dates for about 60 draws: a date may come twice, never twice in a row.
  return { amounts, metrics, dates: [...shuffle(r, dates), ...shuffle(r, dates)] };
}

interface FolderState {
  quote: number; date: number; metric: number; decision: number; assign: number;
  openq: number; approve: number; propose: number; org: number; vendor: number;
  first: Map<string, Fact>;
}

function buildFacts(
  r: Rng,
  bank: FolderBank,
  step: Step,
  st: FolderState,
  pools: Pools,
  team: string[],
  speaker: string | null,
  asrFlags: { approve: boolean; org: boolean },
): Built {
  const take = <T,>(xs: readonly T[], k: keyof FolderState): T => {
    const i = (st[k] as number)++;
    return xs[i % xs.length] as T;
  };
  const named = team.filter((p) => p !== speaker);
  switch (step) {
    case "quote": {
      const sub = take(bank.quote, "quote");
      const vendor = bank.vendors[(st.vendor++) % bank.vendors.length] as Vendor;
      const amount = pools.amounts.pop() as number;
      return {
        fact: { family: "quote", subject: sub.s[0], value: String(amount), lang: "en", asrNameLine: false, version: 0, slots: { sub, vendor, amount } },
        line: (lang) => lang === "en"
          ? `${vendor.name} quoted ${fmtAmount(amount, "en")} dollars for ${l(sub.s, "en")}.`
          : `${vendor.name} cotou ${fmtAmount(amount, "pt")} reais para ${l(sub.s, "pt")}.`,
        sumKey: (lang) => lang === "en"
          ? `${vendor.name} quoted ${fmtAmount(amount, "en")} dollars for ${l(sub.s, "en")}.`
          : `${vendor.name} cotou ${fmtAmount(amount, "pt")} reais para ${l(sub.s, "pt")}.`,
      };
    }
    case "date": {
      const sub = take(bank.date, "date");
      const date = pools.dates.pop() as MD;
      return {
        fact: { family: "date", subject: sub.s[0], value: dateToken(date), lang: "en", asrNameLine: false, version: 0, slots: { sub, date } },
        line: (lang) => lang === "en" ? `${cap(l(sub.s, "en"))} is set for ${fmtDate(date, "en")}.` : `${cap(l(sub.s, "pt"))} fica para ${fmtDate(date, "pt")}.`,
        sumKey: (lang) => lang === "en" ? `${cap(l(sub.s, "en"))} is set for ${fmtDate(date, "en")}.` : `${cap(l(sub.s, "pt"))} fica para ${fmtDate(date, "pt")}.`,
      };
    }
    case "metric": {
      const m = take(bank.metric, "metric");
      const v = pools.metrics.pop() as number;
      return {
        fact: { family: "metric", subject: m.m[0], value: String(v), lang: "en", asrNameLine: false, version: 0, slots: { m, v } },
        line: (lang) => `${cap(l(m.m, lang))}: ${lang === "en" ? "now" : "agora"} ${v} ${l(m.unit, lang)}.`,
        sumKey: (lang) => `${cap(l(m.m, lang))}: ${lang === "en" ? "now" : "agora"} ${v} ${l(m.unit, lang)}.`,
      };
    }
    case "decision": {
      const d = take(bank.decision, "decision");
      return {
        fact: { family: "decision", subject: d.topic[0], value: d.choice[0].toLowerCase(), lang: "en", asrNameLine: false, version: 0, slots: { d } },
        line: (lang) => lang === "en"
          ? `On ${l(d.topic, "en")}, we decided on ${l(d.choice, "en")}, not ${l(d.alt, "en")}.`
          : `Sobre ${l(d.topic, "pt")}, decidimos por ${l(d.choice, "pt")}, não ${l(d.alt, "pt")}.`,
        sumDecision: (lang) => lang === "en"
          ? `${cap(l(d.topic, "en"))}: ${l(d.choice, "en")}, not ${l(d.alt, "en")}.`
          : `${cap(l(d.topic, "pt"))}: ${l(d.choice, "pt")}, não ${l(d.alt, "pt")}.`,
      };
    }
    case "assign": {
      const task = take(bank.assign, "assign");
      const who = person(pick(r, named.filter((p) => p !== OWNER_ID)));
      const due = pools.dates.pop() as MD;
      return {
        fact: { family: "assign", subject: task[0], value: who.id, lang: "en", asrNameLine: false, version: 0, slots: { task, personId: who.id, due } },
        line: (lang) => lang === "en" ? `${who.first} will ${l(task, "en")} by ${fmtDate(due, "en")}.` : `${who.first} vai ${l(task, "pt")} até ${fmtDate(due, "pt")}.`,
        sumAction: (lang) => ({ task: cap(l(task, lang)), owner: who.full, ownerPersonId: who.id, due: fmtDate(due, lang) }),
        namedPersonId: who.id,
      };
    }
    case "openq": {
      const q = take(bank.openq, "openq");
      return {
        fact: { family: "openq", subject: q[0], value: "", lang: "en", asrNameLine: false, version: 0, slots: { q } },
        line: (lang) => lang === "en" ? `We still do not know ${l(q, "en")}.` : `Ainda não sabemos ${l(q, "pt")}.`,
        sumOpen: (lang) => lang === "en" ? `We do not know ${l(q, "en")}.` : `Não sabemos ${l(q, "pt")}.`,
      };
    }
    case "approve": {
      const a = take(bank.approve, "approve");
      const who = person(pick(r, named.filter((p) => p !== OWNER_ID)));
      const asr = asrFlags.approve;
      const nm = asr ? who.asr : who.full;
      return {
        fact: { family: "approve", subject: a[0], value: who.id, lang: "en", asrNameLine: asr, version: 0, slots: { a, personId: who.id } },
        line: (lang) => lang === "en" ? `${nm} signed off on ${l(a, "en")}.` : `${nm} aprovou ${l(a, "pt")}.`,
        sumKey: (lang) => lang === "en" ? `${who.full} signed off on ${l(a, "en")}.` : `${who.full} aprovou ${l(a, "pt")}.`,
        namedPersonId: who.id,
      };
    }
    case "propose": {
      const x = take(bank.propose, "propose");
      return {
        fact: { family: "propose", subject: x[0], value: speaker ?? OWNER_ID, lang: "en", asrNameLine: false, version: 0, slots: { x } },
        line: (lang) => lang === "en" ? `I propose ${l(x, "en")}.` : `Eu proponho ${l(x, "pt")}.`,
        sumKey: (lang) => lang === "en" ? `${person(speaker ?? OWNER_ID).full} proposed ${l(x, "en")}.` : `${person(speaker ?? OWNER_ID).full} propôs ${l(x, "pt")}.`,
      };
    }
    case "org": {
      const vendor = bank.vendors[(st.vendor++) % bank.vendors.length] as Vendor;
      const role = take(bank.vendorRole, "org");
      const date = pools.dates.pop() as MD;
      const asr = asrFlags.org;
      const nm = asr ? vendor.asr : vendor.name;
      return {
        fact: { family: "org", subject: role[0], value: dateToken(date), lang: "en", asrNameLine: asr, version: 0, slots: { vendor, role, date } },
        line: (lang) => lang === "en" ? `${nm} confirmed delivery of ${l(role, "en")} by ${fmtDate(date, "en")}.` : `${nm} confirmou a entrega de ${l(role, "pt")} até ${fmtDate(date, "pt")}.`,
        sumKey: (lang) => lang === "en" ? `${vendor.name} confirmed delivery of ${l(role, "en")} by ${fmtDate(date, "en")}.` : `${vendor.name} confirmou a entrega de ${l(role, "pt")} até ${fmtDate(date, "pt")}.`,
      };
    }
    case "upd:quote": {
      const old = st.first.get("quote") as Fact;
      const sub = old.slots.sub as { s: L };
      const vendor = old.slots.vendor as Vendor;
      const amount = pools.amounts.pop() as number;
      return {
        fact: { family: "quote", subject: old.subject, value: String(amount), lang: "en", asrNameLine: false, version: 1, slots: { sub, vendor, amount } },
        line: (lang) => lang === "en"
          ? `${vendor.name} revised the quote for ${l(sub.s, "en")} to ${fmtAmount(amount, "en")} dollars.`
          : `${vendor.name} revisou a cotação de ${l(sub.s, "pt")} para ${fmtAmount(amount, "pt")} reais.`,
        sumKey: (lang) => lang === "en"
          ? `${vendor.name} revised the quote for ${l(sub.s, "en")} to ${fmtAmount(amount, "en")} dollars.`
          : `${vendor.name} revisou a cotação de ${l(sub.s, "pt")} para ${fmtAmount(amount, "pt")} reais.`,
      };
    }
    case "upd:date": {
      const old = st.first.get("date") as Fact;
      const sub = old.slots.sub as { s: L };
      const oldDate = old.slots.date as MD;
      let date = pools.dates.pop() as MD;
      if (dateToken(date) === dateToken(oldDate)) date = pools.dates.pop() as MD;
      return {
        fact: { family: "date", subject: old.subject, value: dateToken(date), lang: "en", asrNameLine: false, version: 1, slots: { sub, date } },
        line: (lang) => lang === "en" ? `${cap(l(sub.s, "en"))} moved to ${fmtDate(date, "en")}.` : `${cap(l(sub.s, "pt"))} mudou para ${fmtDate(date, "pt")}.`,
        sumKey: (lang) => lang === "en" ? `${cap(l(sub.s, "en"))} moved to ${fmtDate(date, "en")}.` : `${cap(l(sub.s, "pt"))} mudou para ${fmtDate(date, "pt")}.`,
      };
    }
    case "upd:metric": {
      const old = st.first.get("metric") as Fact;
      const m = old.slots.m as { m: L; unit: L };
      const v = pools.metrics.pop() as number;
      return {
        fact: { family: "metric", subject: old.subject, value: String(v), lang: "en", asrNameLine: false, version: 1, slots: { m, v } },
        line: (lang) => lang === "en" ? `${cap(l(m.m, "en"))} moved to ${v} ${l(m.unit, "en")}.` : `${cap(l(m.m, "pt"))} mudou para ${v} ${l(m.unit, "pt")}.`,
        sumKey: (lang) => lang === "en" ? `${cap(l(m.m, "en"))} moved to ${v} ${l(m.unit, "en")}.` : `${cap(l(m.m, "pt"))} mudou para ${v} ${l(m.unit, "pt")}.`,
      };
    }
  }
}

// --- Build ----------------------------------------------------------------

const TITLE_EN = ["kickoff", "weekly sync", "vendor review", "weekly sync", "risk review", "weekly sync", "go/no-go"];
const TITLE_PT = ["abertura", "reunião semanal", "revisão de fornecedores", "reunião semanal", "revisão de riscos", "reunião semanal", "decisão final"];
const OPS_TITLES: L[] = [["Team sync", "Alinhamento do time"], ["Planning chat", "Conversa de planejamento"], ["Hiring check-in", "Conversa sobre contratação"], ["Office logistics", "Logística do escritório"]];
const TAGS = ["kickoff", "weekly", "vendors", "weekly", "risks", "weekly", "decision"];

/** Subject chatter: lines that name the subject but carry no value. */
const CHATTER: L[] = [
  ["Let's talk about {s} for a minute.", "Vamos falar de {s} por um minuto."],
  ["We need to look at {s} more closely.", "Precisamos olhar {s} com mais cuidado."],
  ["Someone asked me about {s} yesterday.", "Alguém me perguntou sobre {s} ontem."],
  ["I have mixed feelings about {s}.", "Tenho sentimentos mistos sobre {s}."],
];
const DISTRACTOR_NUM: L[] = [
  ["We are about {n} minutes in.", "Já estamos com uns {n} minutos de reunião."],
  ["There are {n} people on the call today.", "Hoje tem {n} pessoas na chamada."],
  ["Please open page {n} of the slides.", "Abram a página {n} dos slides."],
  ["I sent {n} emails about this last week.", "Mandei {n} e-mails sobre isso semana passada."],
];

function subjectForChatter(f: Fact, lang: Lang): string {
  const s = (f.slots.sub ?? f.slots.m ?? f.slots.d ?? f.slots.a ?? f.slots.role ?? f.slots.task) as
    | { s?: L; m?: L; topic?: L }
    | L
    | undefined;
  if (!s) return lang === "en" ? "this" : "isso";
  if (Array.isArray(s)) return l(s as L, lang);
  const o = s as { s?: L; m?: L; topic?: L };
  const pair = o.s ?? o.m ?? o.topic;
  return pair ? l(pair, lang) : lang === "en" ? "this" : "isso";
}

export function buildCorpus(seed = 20261031): Corpus {
  const r = rng(seed);
  const pools = makePools(r);
  const meetings: Meeting[] = [];
  const allFacts: Fact[] = [];
  const states = new Map<string, FolderState>();
  let asrApprove = 0;
  let asrOrg = 0;

  for (const plan of PLANS) {
    const bank = FOLDER_BANKS[plan.key] as FolderBank;
    const st =
      states.get(plan.key) ??
      ({ quote: 0, date: 0, metric: 0, decision: 0, assign: 0, openq: 0, approve: 0, propose: 0, org: 0, vendor: 0, first: new Map() } as FolderState);
    states.set(plan.key, st);
    const meetingId = `mtg-${plan.key}-${plan.index + 1}`;
    const startedAt = START + (plan.week * 7 + plan.dow) * DAY;
    const participants = shuffle(r, plan.team.filter((p) => p !== OWNER_ID)).slice(0, 3);
    const speakers = participants.map((pid, i) => ({
      label: String(i + 1),
      personId: pid,
      displayName: person(pid).full,
    }));
    const labelOf = (pid: string) => speakers.find((s) => s.personId === pid)?.label ?? null;
    const summaryLang: Lang = plan.lang === "pt" ? "pt" : "en";
    const langOf = (): Lang => (plan.lang === "mixed" ? (r() < 0.5 ? "en" : "pt") : plan.lang);

    // Facts of this meeting.
    const built: { b: Built; speaker: string | null }[] = [];
    for (const step of plan.recipe) {
      let speaker: string | null = r() < 0.2 ? null : pick(r, participants);
      if (step === "propose" && speaker === null) speaker = pick(r, participants);
      // approve/org: all org lines and the first 14 approve lines are ASR-spelled (21 in all, see tests).
      const asrFlags = { approve: asrApprove < 14, org: asrOrg < 9 };
      const b = buildFacts(r, bank, step, st, pools, [...participants], speaker, asrFlags);
      if (step === "approve" && asrFlags.approve) asrApprove++;
      if (step === "org" && asrFlags.org) asrOrg++;
      if (b.namedPersonId && speaker === b.namedPersonId) speaker = pick(r, participants.filter((p) => p !== b.namedPersonId));
      built.push({ b, speaker });
    }

    // Transcript.
    const segments: Segment[] = [];
    let t = 0;
    const pushLine = (text: string, lang: Lang, speaker: string | null, factId: string | null) => {
      const idx = segments.length;
      const words = text.split(/\s+/).length;
      const dur = Math.round((1.6 + words * 0.38) * 1000);
      segments.push({
        id: `${meetingId}-s${idx}`,
        idx,
        source: speaker === null ? "mic" : "system",
        speakerLabel: speaker === null ? null : labelOf(speaker),
        personId: speaker,
        startMs: t,
        endMs: t + dur,
        text,
        lang,
        factId,
      });
      t += dur + 300 + Math.round(r() * 900);
    };
    const anyone = (): string | null => (r() < 0.25 ? null : pick(r, participants));
    const filler = (): { text: string; lang: Lang } => {
      const lang = langOf();
      const roll = r();
      if (roll < 0.35) return { text: l(pick(r, bank.filler), lang), lang };
      return { text: l(pick(r, GENERIC_MID), lang), lang };
    };

    const open = pick(r, GENERIC_OPEN);
    pushLine(l(open, langOf()), langOf(), pick(r, participants), null);
    const facts: Fact[] = [];
    built.forEach(({ b, speaker }, i) => {
      const factId = `${meetingId}-f${i}`;
      for (let k = 0; k < 6; k++) {
        const f = filler();
        pushLine(f.text, f.lang, anyone(), null);
      }
      const prev = facts[facts.length - 1];
      // Chatter that names the subject (no value).
      const subjectLang = langOf();
      const probe: Fact = { ...b.fact, id: factId, meetingId, segmentIdx: -1, speakerPersonId: speaker };
      for (let k = 0; k < 2; k++) {
        const c = pick(r, CHATTER);
        pushLine(l(c, subjectLang).replace("{s}", subjectForChatter(probe, subjectLang)), subjectLang, anyone(), null);
      }
      if (r() < 0.6) {
        const d = pick(r, DISTRACTOR_NUM);
        const lg = langOf();
        pushLine(l(d, lg).replace("{n}", String(2 + Math.floor(r() * 58))), lg, anyone(), null);
      }
      for (let k = 0; k < 4; k++) {
        const f = filler();
        pushLine(f.text, f.lang, anyone(), null);
      }
      const lang = langOf();
      const idx = segments.length;
      pushLine(b.line(lang), lang, speaker, factId);
      const fact: Fact = { ...b.fact, id: factId, meetingId, segmentIdx: idx, speakerPersonId: speaker, lang };
      facts.push(fact);
      allFacts.push(fact);
      if (fact.version === 0 && !st.first.has(fact.family)) st.first.set(fact.family, fact);
      void prev;
      for (let k = 0; k < 3; k++) {
        const f = filler();
        pushLine(f.text, f.lang, anyone(), null);
      }
    });
    for (let k = 0; k < 5; k++) {
      const f = filler();
      pushLine(f.text, f.lang, anyone(), null);
    }
    pushLine(l(pick(r, GENERIC_CLOSE), langOf()), langOf(), pick(r, participants), null);

    // Summary.
    const keyPoints: string[] = [];
    const decisions: SummaryItem[] = [];
    const actionItems: ActionItem[] = [];
    const openQuestions: SummaryItem[] = [];
    built.forEach(({ b }, i) => {
      const fact = facts[i] as Fact;
      if (b.sumKey) keyPoints.push(b.sumKey(summaryLang));
      if (b.sumDecision) {
        decisions.push({ id: `${meetingId}#d${decisions.length}`, text: b.sumDecision(summaryLang), factId: fact.id });
      }
      if (b.sumAction) {
        const a = b.sumAction(summaryLang);
        actionItems.push({
          id: `${meetingId}#a${actionItems.length}`,
          task: a.task,
          owner: a.owner,
          ownerPersonId: a.ownerPersonId,
          due: a.due,
          done: false,
          factId: fact.id,
        });
      }
      if (b.sumOpen) {
        openQuestions.push({ id: `${meetingId}#q${openQuestions.length}`, text: b.sumOpen(summaryLang), factId: fact.id });
      }
    });
    for (const a of actionItems) a.done = plan.key !== "ops" && r() < 0.4;
    const title =
      plan.key === "ops"
        ? l(OPS_TITLES[plan.index] as L, summaryLang)
        : `${bank.short} - ${summaryLang === "en" ? TITLE_EN[plan.index] : TITLE_PT[plan.index]}`;
    const overview =
      summaryLang === "en"
        ? `The team met for ${bank.short.toLowerCase()}. ${keyPoints[0] ?? ""} ${keyPoints[1] ?? ""}`.trim()
        : `A equipe se reuniu para ${bank.short.toLowerCase()}. ${keyPoints[0] ?? ""} ${keyPoints[1] ?? ""}`.trim();

    meetings.push({
      id: meetingId,
      folderId: plan.folderId,
      title,
      startedAt,
      durationMs: t,
      lang: plan.lang,
      summaryLang,
      tags: plan.key === "ops" ? ["team"] : [TAGS[plan.index] as string],
      speakers,
      segments,
      overview,
      keyPoints,
      decisions,
      actionItems,
      openQuestions,
    });
  }

  return {
    seed,
    todayMs: TODAY_MS,
    ownerName: OWNER_NAME,
    people: PEOPLE,
    folders: FOLDERS.map(({ key: _k, ...f }) => f),
    meetings,
    facts: allFacts,
  };
}

/** Markdown of a summary, the same sections as renderSummaryMarkdown (summary-pure.ts:44). */
export function summaryMarkdown(m: Meeting): string {
  const list = (a: string[]) => (a.length ? a.map((t) => `- ${t}`).join("\n") : "None.");
  const act = m.actionItems.map(
    (a) => `- ${a.task} (Owner: ${a.owner}; Due: ${a.due})`,
  );
  return [
    `## Overview\n${m.overview}`,
    `## Key Points\n${list(m.keyPoints)}`,
    `## Decisions\n${list(m.decisions.map((d) => d.text))}`,
    `## Action Items\n${act.length ? act.join("\n") : "None."}`,
    `## Open Questions\n${list(m.openQuestions.map((q) => q.text))}`,
  ].join("\n\n");
}

/** The summary_json object the app stores (workflow/schemas.ts MeetingSummarySchema). */
export function summaryJson(m: Meeting) {
  return {
    overview: m.overview,
    keyPoints: m.keyPoints,
    decisions: m.decisions.map((d) => d.text),
    actionItems: m.actionItems.map((a) => ({ task: a.task, owner: a.owner, due: a.due })),
    openQuestions: m.openQuestions.map((q) => q.text),
  };
}
