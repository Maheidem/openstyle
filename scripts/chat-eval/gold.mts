// gold.mts: the gold set (spec 8.3, 8.8). 190 questions with fixed answer
// keys, plus the retrieval queries. Every key is computed from the same facts
// that made the transcripts, so no LLM decides a result. Pure and seeded.

import { FOLDER_BANKS, type L } from "./bank.mts";
import {
  dateToken,
  fmtAmount,
  fmtDate,
  l,
  type MD,
  OWNER_ID,
  rng,
} from "./corpus.mts";
import { normalize } from "./keys.mts";
import type {
  AnswerKey,
  Corpus,
  Fact,
  GoldSet,
  Intent,
  Lang,
  Meeting,
  Person,
  Question,
  QuestionType,
  RetrievalQuery,
  RetrievalSlice,
  Scope,
  Turn,
} from "./types.mts";

const MONTH_EN = [
  "",
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const MONTH_PT = [
  "",
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];
const DAY = 86_400_000;

type Vendor = { name: string; asr: string };
type Sub = { s: L };

export function buildGold(c: Corpus): GoldSet {
  const r = rng(c.seed ^ 0x9e3779b9);
  const people = new Map(c.people.map((p) => [p.id, p]));
  const meetingById = new Map(c.meetings.map((m) => [m.id, m]));
  const folderName = (id: string | null) =>
    c.folders.find((f) => f.id === id)?.name ?? "";
  const factsOf = (family: string, version: 0 | 1 = 0) =>
    c.facts.filter((f) => f.family === family && f.version === version);
  const updated = new Set(
    c.facts
      .filter((f) => f.version === 1)
      .map((f) => `${f.family}|${f.subject}`),
  );
  const stable = (f: Fact) => !updated.has(`${f.family}|${f.subject}`);
  const mtg = (f: Fact) => meetingById.get(f.meetingId) as Meeting;
  const scopeOf = (kind: Scope["kind"], f: Fact): Scope =>
    kind === "meeting"
      ? { kind, id: f.meetingId }
      : kind === "folder"
        ? { kind, id: mtg(f).folderId }
        : { kind: "all", id: null };
  /** The scopes that contain a fact (unfiled meetings have no folder scope). */
  const scopesFor = (f: Fact, i: number): Scope => {
    const order: Scope["kind"][] = ["meeting", "folder", "all"];
    let k = order[i % 3] as Scope["kind"];
    if (k === "folder" && mtg(f).folderId === null) k = "meeting";
    return scopeOf(k, f);
  };

  let n = 0;
  const questions: Question[] = [];
  const langAt = (i: number): Lang => (i % 2 === 0 ? "en" : "pt");
  const add = (q: Omit<Question, "id">) => {
    questions.push({ ...q, id: `q${String(++n).padStart(3, "0")}` });
  };

  // ---- phrasing -----------------------------------------------------------

  const person = (id: string): Person => people.get(id) as Person;
  const surname = (p: Person) => p.full.split(" ").pop() as string;
  const asrSurname = (p: Person) => p.asr.split(" ").pop() as string;
  /** A text key that names one person. */
  const personKey = (id: string): AnswerKey => {
    const p = person(id);
    const same = c.people.filter((o) => o.first === p.first && o.id !== p.id);
    return {
      kind: "text",
      must: [[surname(p), asrSurname(p)]],
      mustNot: same.flatMap((o) => [surname(o), asrSurname(o)]),
    };
  };
  const dateWords = (d: MD, lang: Lang) => fmtDate(d, lang);
  const sub = (f: Fact) => (f.slots.sub ?? f.slots.m) as { s?: L; m?: L };
  const subjPair = (f: Fact): L => {
    const o = (f.slots.sub ??
      f.slots.m ??
      f.slots.d ??
      f.slots.a ??
      f.slots.role ??
      f.slots.task ??
      f.slots.x) as { s?: L; m?: L; topic?: L } | L;
    if (Array.isArray(o)) return o as L;
    const p = o as { s?: L; m?: L; topic?: L };
    return (p.s ?? p.m ?? p.topic) as L;
  };
  /** Tokens (> 3 letters) of the subject, in the language of the question. */
  const queryAny = (f: Fact, lang: Lang): string[] =>
    normalize(l(subjPair(f), lang))
      .split(" ")
      .filter(
        (w) =>
          w.length > 3 && !["that", "this", "with", "para", "como"].includes(w),
      );

  /** The question text per family (lookup form). */
  const ask = (f: Fact, lang: Lang, current = false): string => {
    const s = l(subjPair(f), lang);
    switch (f.family) {
      case "quote":
        return lang === "en"
          ? current
            ? `What is the current quote for ${s}?`
            : `How much is the quote for ${s}?`
          : current
            ? `Qual é a cotação atual para ${s}?`
            : `Quanto ficou a cotação para ${s}?`;
      case "date":
        return lang === "en"
          ? current
            ? `What is the current date for ${s}?`
            : `When is ${s}?`
          : current
            ? `Qual é a data atual para ${s}?`
            : `Quando é ${s}?`;
      case "metric":
        return lang === "en"
          ? current
            ? `What is the current number for ${s}?`
            : `What number did we give for ${s}?`
          : current
            ? `Qual é o número atual para ${s}?`
            : `Qual número demos para ${s}?`;
      case "decision":
        return lang === "en"
          ? `What did we decide on ${s}?`
          : `O que decidimos sobre ${s}?`;
      case "assign":
        return lang === "en" ? `Who will ${s}?` : `Quem vai ${s}?`;
      case "approve":
        return lang === "en" ? `Who signed off on ${s}?` : `Quem aprovou ${s}?`;
      case "propose":
        return lang === "en" ? `Who proposed ${s}?` : `Quem propôs ${s}?`;
      case "org": {
        const v = f.slots.vendor as Vendor;
        return lang === "en"
          ? `When did ${v.name} confirm delivery of ${s}?`
          : `Para quando a ${v.name} confirmou a entrega de ${s}?`;
      }
      default:
        return s;
    }
  };

  const valueKey = (f: Fact, withNot = true): AnswerKey => {
    switch (f.family) {
      case "quote":
      case "metric": {
        const others = c.facts
          .filter(
            (o) =>
              o.family === f.family &&
              o.id !== f.id &&
              o.meetingId !== f.meetingId,
          )
          .map((o) => Number(o.value));
        const near = withNot
          ? others
              .sort(
                (a, b) =>
                  Math.abs(a - Number(f.value)) - Math.abs(b - Number(f.value)),
              )
              .slice(0, 1)
          : [];
        return { kind: "text", must: [[f.value]], mustNot: near.map(String) };
      }
      case "date":
      case "org":
        return { kind: "text", must: [[f.value]], mustNot: [] };
      case "decision": {
        const d = f.slots.d as { choice: L };
        return {
          kind: "text",
          must: [[d.choice[0], d.choice[1]]],
          mustNot: [],
        };
      }
      case "assign":
      case "approve":
      case "propose":
        return personKey(f.value);
      default:
        return { kind: "text", must: [[f.value]], mustNot: [] };
    }
  };

  /** A short gold answer text (shown as the earlier answer in a thread). */
  const answerText = (f: Fact, lang: Lang): string => {
    switch (f.family) {
      case "quote":
        return lang === "en"
          ? `${fmtAmount(Number(f.value), "en")} dollars`
          : `${fmtAmount(Number(f.value), "pt")} reais`;
      case "metric": {
        const m = f.slots.m as { unit: L };
        return `${f.value} ${l(m.unit, lang)}`;
      }
      case "date":
        return fmtDate(f.slots.date as MD, lang);
      case "org":
        return fmtDate(f.slots.date as MD, lang);
      case "decision":
        return l((f.slots.d as { choice: L }).choice, lang);
      default:
        return person(f.value).full;
    }
  };

  const goldOf = (...fs: Fact[]) =>
    fs.map((f) => ({ meetingId: f.meetingId, segmentIdx: f.segmentIdx }));
  const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  const planTools: Record<string, string[]> = {
    lookup: ["search_chunks", "get_meeting_summary"],
    who_said: ["search_chunks", "get_transcript_window", "list_people"],
    aggregate: ["list_people", "list_action_items"],
    list_meetings: ["list_meetings", "get_meeting_summary"],
    review: ["list_decisions_questions"],
    status: ["folder_status"],
  };
  const base = (
    type: QuestionType,
    lang: Lang,
    scope: Scope,
    text: string,
    intent: Intent,
    tools: string[],
    key: AnswerKey,
    gold: Question["gold"],
    args: Question["args"] = {},
    history: Turn[] = [],
  ): Omit<Question, "id"> => ({
    type,
    lang,
    scope,
    text,
    history,
    intent,
    tools,
    args,
    key,
    gold,
  });

  // ---- lookup (25) ----------------------------------------------------------
  {
    const pool: Fact[] = [
      ...factsOf("quote").filter(stable).slice(0, 6),
      ...factsOf("date")
        .filter(stable)
        .filter((_f, i) => i % 3 === 0)
        .slice(0, 4),
      ...factsOf("metric").filter(stable).slice(0, 4),
      ...factsOf("decision")
        .filter((_f, i) => i % 3 === 0)
        .slice(0, 5),
      ...factsOf("assign")
        .filter((_f, i) => i % 6 === 0)
        .slice(0, 3),
      ...factsOf("org").slice(0, 3),
    ];
    pool.slice(0, 25).forEach((f, i) => {
      const lang = langAt(i);
      add(
        base(
          "lookup",
          lang,
          scopesFor(f, i),
          ask(f, lang),
          "lookup",
          planTools.lookup as string[],
          valueKey(f),
          goldOf(f),
          { query_any: queryAny(f, lang) },
        ),
      );
    });
  }

  // ---- who said (20) ---------------------------------------------------------
  {
    const pool = [...factsOf("propose"), ...factsOf("approve").slice(0, 6)];
    pool.slice(0, 20).forEach((f, i) => {
      const lang = langAt(i);
      add(
        base(
          "who_said",
          lang,
          scopesFor(f, i),
          ask(f, lang),
          "who_said",
          planTools.who_said as string[],
          personKey(f.value),
          goldOf(f),
          { query_any: queryAny(f, lang) },
        ),
      );
    });
  }

  // ---- aggregation (20): 8 aggregate, 6 review, 6 status ----------------------
  const itemsOf = (m: Meeting) => m.actionItems;
  const folderMeetings = (fid: string) =>
    c.meetings.filter((m) => m.folderId === fid);
  const openItems = (ms: Meeting[], pid?: string) =>
    ms
      .flatMap(itemsOf)
      .filter((a) => !a.done && (pid === undefined || a.ownerPersonId === pid));
  {
    // aggregate: (person, folder) pairs with at least one open item.
    const pairs: { pid: string; fid: string }[] = [];
    for (const f of c.folders) {
      for (const pid of f.teamPersonIds) {
        if (openItems(folderMeetings(f.id), pid).length > 0)
          pairs.push({ pid, fid: f.id });
      }
    }
    let k = 0;
    for (const p of pairs.slice(0, 6)) {
      const lang = langAt(k++);
      const ids = openItems(folderMeetings(p.fid), p.pid).map((a) => a.id);
      const name = person(p.pid).full;
      const fname = folderName(p.fid);
      add(
        base(
          "aggregation",
          lang,
          { kind: "folder", id: p.fid },
          lang === "en"
            ? `List the open action items for ${name} in ${fname}.`
            : `Liste os itens de ação em aberto de ${name} em ${fname}.`,
          "aggregate",
          planTools.aggregate as string[],
          { kind: "set", ids },
          [],
          { person_id: p.pid, status: "open" },
        ),
      );
    }
    // Two across all folders for a person who works in two folders.
    const multi = c.people
      .filter(
        (p) =>
          c.folders.filter((f) => f.teamPersonIds.includes(p.id)).length >= 2,
      )
      .map((p) => ({
        pid: p.id,
        n: openItems(
          c.meetings.filter((m) => m.folderId !== null),
          p.id,
        ).length,
      }))
      .filter((x) => x.n >= 2)
      .sort((a, b) => b.n - a.n || a.pid.localeCompare(b.pid))
      .slice(0, 2);
    for (const { pid } of multi) {
      const lang = langAt(k++);
      const ids = openItems(
        c.meetings.filter((m) => m.folderId !== null),
        pid,
      ).map((a) => a.id);
      const name = person(pid).full;
      add(
        base(
          "aggregation",
          lang,
          { kind: "all", id: null },
          lang === "en"
            ? `List all open action items for ${name}.`
            : `Liste todos os itens de ação em aberto de ${name}.`,
          "aggregate",
          planTools.aggregate as string[],
          { kind: "set", ids },
          [],
          { person_id: pid, status: "open" },
        ),
      );
    }
    // review: decisions (3) and open questions (3) per folder.
    const fl = c.folders;
    [0, 1, 2].forEach((i) => {
      const f = fl[i] as (typeof fl)[number];
      const lang = langAt(k++);
      const ids = folderMeetings(f.id).flatMap((m) =>
        m.decisions.map((d) => d.id),
      );
      add(
        base(
          "aggregation",
          lang,
          { kind: "folder", id: f.id },
          lang === "en"
            ? `Show all decisions in ${f.name}.`
            : `Mostre todas as decisões de ${f.name}.`,
          "review",
          planTools.review as string[],
          { kind: "set", ids },
          [],
          { kind: "decision" },
        ),
      );
    });
    [1, 2, 3].forEach((i) => {
      const f = fl[i] as (typeof fl)[number];
      const lang = langAt(k++);
      const ids = folderMeetings(f.id).flatMap((m) =>
        m.openQuestions.map((d) => d.id),
      );
      add(
        base(
          "aggregation",
          lang,
          { kind: "folder", id: f.id },
          lang === "en"
            ? `Which questions are still open in ${f.name}?`
            : `Quais perguntas ainda estão em aberto em ${f.name}?`,
          "review",
          planTools.review as string[],
          { kind: "set", ids },
          [],
          { kind: "open_question" },
        ),
      );
    });
    // status: where do we stand (open action items of the folder).
    [0, 1, 2, 3, 0, 2].forEach((i) => {
      const f = fl[i] as (typeof fl)[number];
      const lang = langAt(k++);
      const ids = openItems(folderMeetings(f.id)).map((a) => a.id);
      add(
        base(
          "aggregation",
          lang,
          { kind: "folder", id: f.id },
          lang === "en"
            ? `Where do we stand on ${f.name}?`
            : `Em que pé estamos com ${f.name}?`,
          "status",
          planTools.status as string[],
          { kind: "set", ids },
          [],
          {},
        ),
      );
    });
  }

  // ---- count (10) --------------------------------------------------------------
  {
    let k = 0;
    for (const f of c.folders) {
      const lang = langAt(k++);
      add(
        base(
          "count",
          lang,
          { kind: "folder", id: f.id },
          lang === "en"
            ? `How many meetings do we have in ${f.name}?`
            : `Quantas reuniões temos em ${f.name}?`,
          "aggregate",
          ["list_meetings"],
          { kind: "count", n: folderMeetings(f.id).length },
          [],
          {},
        ),
      );
    }
    // Vendor named by its exact spelling in at least two meetings.
    const vendors: Vendor[] = Object.values(FOLDER_BANKS).flatMap(
      (b) => b.vendors,
    );
    const exact = vendors
      .map((v) => ({
        v,
        n: c.meetings.filter((m) =>
          m.segments.some((s) => s.text.includes(v.name)),
        ).length,
      }))
      .filter((x) => x.n >= 2)
      .slice(0, 3);
    for (const x of exact) {
      const lang = langAt(k++);
      add(
        base(
          "count",
          lang,
          { kind: "all", id: null },
          lang === "en"
            ? `In how many meetings was ${x.v.name} named?`
            : `Em quantas reuniões a ${x.v.name} foi citada?`,
          "aggregate",
          ["search_chunks", "list_meetings"],
          { kind: "count", n: x.n },
          [],
          { query_any: [normalize(x.v.name).split(" ")[0] as string] },
        ),
      );
    }
    for (const mo of [8, 9, 10].slice(
      0,
      10 - questions.filter((q) => q.type === "count").length,
    )) {
      const lang = langAt(k++);
      const nn = c.meetings.filter(
        (m) => new Date(m.startedAt).getUTCMonth() + 1 === mo,
      ).length;
      add(
        base(
          "count",
          lang,
          { kind: "all", id: null },
          lang === "en"
            ? `How many meetings did we have in ${MONTH_EN[mo]}?`
            : `Quantas reuniões tivemos em ${MONTH_PT[mo]}?`,
          "aggregate",
          ["list_meetings"],
          { kind: "count", n: nn },
          [],
          {
            date_from: `2026-${String(mo).padStart(2, "0")}-01`,
            date_to: isoDay(Date.UTC(2026, mo, 0)),
          },
        ),
      );
    }
  }

  // ---- temporal (20) ------------------------------------------------------------
  {
    const monthOf = (m: Meeting) => new Date(m.startedAt).getUTCMonth() + 1;
    const idsIn = (ms: Meeting[], from: number, to: number) =>
      ms
        .filter((m) => m.startedAt >= from && m.startedAt < to)
        .map((m) => m.id);
    const wkStart =
      c.todayMs - 7 * DAY - ((new Date(c.todayMs).getUTCDay() + 6) % 7) * DAY;
    const lastWeek = [Date.UTC(2026, 9, 19), Date.UTC(2026, 9, 26)] as const;
    void wkStart;
    const tmp = (
      lang: Lang,
      scope: Scope,
      text: string,
      ids: string[],
      from: string,
      to: string,
    ) =>
      add(
        base(
          "temporal",
          lang,
          scope,
          text,
          "temporal",
          planTools.list_meetings as string[],
          { kind: "set", ids },
          [],
          { date_from: from, date_to: to },
        ),
      );
    let k = 0;
    let lang = langAt(k++);
    tmp(
      lang,
      { kind: "all", id: null },
      lang === "en"
        ? "Which meetings did we have last week?"
        : "Quais reuniões tivemos semana passada?",
      idsIn(c.meetings, lastWeek[0], lastWeek[1]),
      "2026-10-19",
      "2026-10-25",
    );
    for (const fk of ["fld-atlas", "fld-harbor"]) {
      lang = langAt(k++);
      tmp(
        lang,
        { kind: "folder", id: fk },
        lang === "en"
          ? `Which ${folderName(fk)} meetings did we have last week?`
          : `Quais reuniões de ${folderName(fk)} tivemos semana passada?`,
        idsIn(folderMeetings(fk), lastWeek[0], lastWeek[1]),
        "2026-10-19",
        "2026-10-25",
      );
    }
    lang = langAt(k++);
    tmp(
      lang,
      { kind: "all", id: null },
      lang === "en"
        ? "Which meetings did we have last month?"
        : "Quais reuniões tivemos no mês passado?",
      idsIn(c.meetings, Date.UTC(2026, 8, 1), Date.UTC(2026, 9, 1)),
      "2026-09-01",
      "2026-09-30",
    );
    lang = langAt(k++);
    tmp(
      lang,
      { kind: "all", id: null },
      lang === "en"
        ? "Which meetings did we have this month?"
        : "Quais reuniões tivemos neste mês?",
      idsIn(c.meetings, Date.UTC(2026, 9, 1), c.todayMs + DAY),
      "2026-10-01",
      "2026-10-26",
    );
    // Folder x month sets.
    const fm: [string, number][] = [
      ["fld-atlas", 9],
      ["fld-harbor", 9],
      ["fld-mobile", 10],
      ["fld-audit", 8],
      ["fld-mobile", 9],
    ];
    for (const [fid, mo] of fm) {
      lang = langAt(k++);
      const ids = folderMeetings(fid)
        .filter((m) => monthOf(m) === mo)
        .map((m) => m.id);
      tmp(
        lang,
        { kind: "folder", id: fid },
        lang === "en"
          ? `Which ${folderName(fid)} meetings were in ${MONTH_EN[mo]}?`
          : `Quais reuniões de ${folderName(fid)} foram em ${MONTH_PT[mo]}?`,
        ids,
        `2026-${String(mo).padStart(2, "0")}-01`,
        isoDay(Date.UTC(2026, mo, 0)),
      );
    }
    // Decisions of a dated meeting (5) and numbers of a dated meeting (5).
    const dayWords = (m: Meeting, lg: Lang) => {
      const d = new Date(m.startedAt);
      return fmtDate({ m: d.getUTCMonth() + 1, d: d.getUTCDate() }, lg);
    };
    const decs = factsOf("decision")
      .filter((f) => mtg(f).folderId !== null)
      .filter((_f, i) => i % 3 === 1)
      .slice(0, 5);
    for (const f of decs) {
      lang = langAt(k++);
      const m = mtg(f);
      const s = l(subjPair(f), lang);
      add(
        base(
          "temporal",
          lang,
          { kind: "folder", id: m.folderId },
          lang === "en"
            ? `What did we decide on ${s} in the meeting on ${dayWords(m, "en")}?`
            : `O que decidimos sobre ${s} na reunião de ${dayWords(m, "pt")}?`,
          "temporal",
          planTools.list_meetings as string[],
          valueKey(f),
          goldOf(f),
          { date_from: isoDay(m.startedAt), date_to: isoDay(m.startedAt) },
        ),
      );
    }
    const mets = [
      ...factsOf("metric", 0).filter((f) => !stable(f)),
      ...factsOf("metric", 1),
      ...factsOf("metric", 0).filter(stable),
    ].slice(0, 5);
    for (const f of mets) {
      lang = langAt(k++);
      const m = mtg(f);
      const s = l(subjPair(f), lang);
      add(
        base(
          "temporal",
          lang,
          { kind: "folder", id: m.folderId },
          lang === "en"
            ? `What number did we give for ${s} in the meeting on ${dayWords(m, "en")}?`
            : `Qual número demos para ${s} na reunião de ${dayWords(m, "pt")}?`,
          "temporal",
          planTools.list_meetings as string[],
          valueKey(f, false),
          goldOf(f),
          { date_from: isoDay(m.startedAt), date_to: isoDay(m.startedAt) },
        ),
      );
    }
  }

  // ---- knowledge update (10) ------------------------------------------------------
  {
    const newer = c.facts.filter((f) => f.version === 1);
    newer.slice(0, 10).forEach((f, i) => {
      const lang = langAt(i);
      const old = c.facts.find(
        (o) =>
          o.version === 0 && o.family === f.family && o.subject === f.subject,
      ) as Fact;
      add(
        base(
          "knowledge_update",
          lang,
          scopesFor(f, i === 0 ? 2 : i),
          ask(f, lang, true),
          "lookup",
          planTools.lookup as string[],
          { kind: "text", must: [[f.value]], mustNot: [] },
          goldOf(f),
          { query_any: queryAny(f, lang) },
        ),
      );
      void old;
    });
  }

  // ---- not answerable (30) ---------------------------------------------------------
  {
    const T = (en: string, pt: string): L => [en, pt];
    const na: { q: L; absent: string[] }[] = [
      {
        q: T(
          "How much was the quote for the penetration test?",
          "Quanto ficou a cotação para o teste de intrusão?",
        ),
        absent: ["penetration", "intrusão"],
      },
      {
        q: T(
          "How much was the quote for the marketing video?",
          "Quanto ficou a cotação para o vídeo de marketing?",
        ),
        absent: ["marketing video", "vídeo de marketing"],
      },
      {
        q: T(
          "How much was the quote for the parking permits?",
          "Quanto ficou a cotação para as vagas de estacionamento?",
        ),
        absent: ["parking", "estacionamento"],
      },
      {
        q: T(
          "How much was the quote for the legal retainer?",
          "Quanto ficou a cotação para o contrato de advogados?",
        ),
        absent: ["retainer", "advogados"],
      },
      {
        q: T(
          "How much was the quote for the stage lighting?",
          "Quanto ficou a cotação para a iluminação do palco?",
        ),
        absent: ["lighting", "iluminação"],
      },
      {
        q: T(
          "How much was the quote for the translation work?",
          "Quanto ficou a cotação para o trabalho de tradução?",
        ),
        absent: ["translation", "tradução"],
      },
      {
        q: T(
          "When is the audit kickoff dinner?",
          "Quando é o jantar de abertura da auditoria?",
        ),
        absent: ["dinner", "jantar"],
      },
      {
        q: T("When is the board offsite?", "Quando é o retiro da diretoria?"),
        absent: ["board offsite", "retiro"],
      },
      {
        q: T("When is the tax filing?", "Quando é a declaração de impostos?"),
        absent: ["tax filing", "declaração de impostos"],
      },
      {
        q: T(
          "When is the stakeholder demo?",
          "Quando é a demonstração para os investidores?",
        ),
        absent: ["stakeholder demo", "investidores"],
      },
      {
        q: T(
          "When is the customer summit?",
          "Quando é o encontro de clientes?",
        ),
        absent: ["customer summit", "encontro de clientes"],
      },
      {
        q: T(
          "What number did we give for the NPS score?",
          "Qual número demos para a nota de NPS?",
        ),
        absent: ["nps"],
      },
      {
        q: T(
          "What number did we give for the server uptime last week?",
          "Qual número demos para a disponibilidade do servidor?",
        ),
        absent: ["uptime", "disponibilidade"],
      },
      {
        q: T(
          "What number did we give for the headcount?",
          "Qual número demos para o total de funcionários?",
        ),
        absent: ["headcount", "funcionários"],
      },
      {
        q: T(
          "What number did we give for the refund rate?",
          "Qual número demos para a taxa de reembolso?",
        ),
        absent: ["refund", "reembolso"],
      },
      {
        q: T(
          "What did we decide on the logo color?",
          "O que decidimos sobre a cor do logotipo?",
        ),
        absent: ["logo", "logotipo"],
      },
      {
        q: T(
          "What did we decide on the office plants?",
          "O que decidimos sobre as plantas do escritório?",
        ),
        absent: ["plants", "plantas"],
      },
      {
        q: T(
          "What did we decide on the holiday gift?",
          "O que decidimos sobre o presente de fim de ano?",
        ),
        absent: ["gift", "presente"],
      },
      {
        q: T(
          "What did we decide on the data retention period?",
          "O que decidimos sobre o prazo de retenção de dados?",
        ),
        absent: ["retention", "retenção"],
      },
      {
        q: T(
          "Who signed off on the vendor contract?",
          "Quem aprovou o contrato com o fornecedor?",
        ),
        absent: ["vendor contract", "contrato com o fornecedor"],
      },
      {
        q: T(
          "Who signed off on the insurance policy?",
          "Quem aprovou a apólice de seguro?",
        ),
        absent: ["insurance", "seguro"],
      },
      {
        q: T("Who proposed the hackathon?", "Quem propôs o hackathon?"),
        absent: ["hackathon"],
      },
      {
        q: T(
          "Who proposed the open source release?",
          "Quem propôs o lançamento em código aberto?",
        ),
        absent: ["open source", "código aberto"],
      },
      {
        q: T("Who will book the flights?", "Quem vai reservar as passagens?"),
        absent: ["flights", "passagens"],
      },
      {
        q: T(
          "Who will pay for the monitoring licenses?",
          "Quem vai pagar as licenças de monitoramento?",
        ),
        absent: ["pay for", "vai pagar"],
      },
      {
        q: T(
          "How many people attended the cutover?",
          "Quantas pessoas participaram da virada para a nuvem?",
        ),
        absent: ["attended", "participaram"],
      },
      {
        q: T("What color is the new icon?", "Qual é a cor do novo ícone?"),
        absent: ["color", "cor do"],
      },
      {
        q: T(
          "Which airline did the team choose?",
          "Qual companhia aérea o time escolheu?",
        ),
        absent: ["airline", "aérea"],
      },
      {
        q: T(
          "What is the name of the new intern?",
          "Qual é o nome do novo estagiário?",
        ),
        absent: ["intern", "estagiário"],
      },
      {
        q: T(
          "What was the final score of the football match?",
          "Qual foi o placar final da partida de futebol?",
        ),
        absent: ["football", "futebol"],
      },
    ];
    const text = (m: Meeting) =>
      [
        ...m.segments.map((s) => s.text),
        m.overview,
        ...m.keyPoints,
        ...m.decisions.map((d) => d.text),
        ...m.openQuestions.map((x) => x.text),
        ...m.actionItems.map((a) => a.task),
      ]
        .join(" ")
        .toLowerCase();
    const all = c.meetings.map(text).join(" ");
    na.forEach((x, i) => {
      for (const a of x.absent) {
        if (
          new RegExp(
            `(?<![\\p{L}])${a.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`,
            "u",
          ).test(all)
        )
          throw new Error(`not-answerable token "${a}" is in the corpus`);
      }
      const lang = langAt(i);
      const kinds: Scope[] = [
        { kind: "all", id: null },
        { kind: "folder", id: c.folders[i % 4]?.id ?? null },
        {
          kind: "meeting",
          id: c.meetings[(i * 7) % c.meetings.length]?.id ?? null,
        },
      ];
      add(
        base(
          "not_answerable",
          lang,
          kinds[i % 3] as Scope,
          l(x.q, lang),
          "lookup",
          planTools.lookup as string[],
          { kind: "not_found" },
          [],
          {},
        ),
      );
    });
  }

  // ---- scope trap (10) ---------------------------------------------------------------
  {
    const pool = [
      ...factsOf("quote").filter(stable).slice(6, 9),
      ...factsOf("date").filter(stable).slice(4, 7),
      ...factsOf("decision").slice(5, 9),
    ].filter((f) => mtg(f).folderId !== null);
    pool.slice(0, 10).forEach((f, i) => {
      const lang = langAt(i);
      const m = mtg(f);
      let scope: Scope;
      if (i % 2 === 0) {
        const other = c.meetings.find(
          (o) => o.folderId === m.folderId && o.id !== m.id,
        ) as Meeting;
        scope = { kind: "meeting", id: other.id };
      } else {
        const other = c.folders.find(
          (o) => o.id !== m.folderId,
        ) as (typeof c.folders)[number];
        scope = { kind: "folder", id: other.id };
      }
      add(
        base(
          "scope_trap",
          lang,
          scope,
          ask(f, lang),
          "lookup",
          planTools.lookup as string[],
          { kind: "not_found" },
          [],
          { query_any: queryAny(f, lang) },
        ),
      );
    });
  }

  // ---- follow-up (10) ------------------------------------------------------------------
  {
    const assigns = factsOf("assign")
      .filter((f) => mtg(f).folderId !== null)
      .filter((_f, i) => i % 4 === 0)
      .slice(0, 5);
    const orgs = factsOf("org").slice(0, 5);
    assigns.forEach((f, i) => {
      const lang = langAt(i);
      const due = f.slots.due as MD;
      const hist: Turn[] = [{ q: ask(f, lang), a: person(f.value).full }];
      add(
        base(
          "follow_up",
          lang,
          scopesFor(f, 1),
          lang === "en" ? "And when is that due?" : "E para quando isso é?",
          "lookup",
          planTools.lookup as string[],
          { kind: "text", must: [[dateToken(due)]], mustNot: [] },
          goldOf(f),
          { query_any: queryAny(f, lang) },
          hist,
        ),
      );
    });
    orgs.forEach((f, i) => {
      const lang = langAt(i + 1);
      const v = f.slots.vendor as Vendor;
      const hist: Turn[] = [{ q: ask(f, lang), a: answerText(f, lang) }];
      add(
        base(
          "follow_up",
          lang,
          scopesFor(f, 2),
          lang === "en"
            ? "And which company confirmed that?"
            : "E qual empresa confirmou isso?",
          "lookup",
          planTools.lookup as string[],
          {
            kind: "text",
            must: [
              [
                normalize(v.name).split(" ")[0] as string,
                normalize(v.asr).split(" ")[0] as string,
              ],
            ],
            mustNot: [],
          },
          goldOf(f),
          { query_any: queryAny(f, lang) },
          hist,
        ),
      );
    });
  }

  // ---- long thread (10) ------------------------------------------------------------------
  {
    const assigns = factsOf("assign").filter((f) => mtg(f).folderId !== null);
    const fillers = [
      ...factsOf("quote").filter(stable),
      ...factsOf("metric").filter(stable),
      ...factsOf("decision"),
    ];
    for (let i = 0; i < 10; i++) {
      const lang = langAt(i);
      const f = assigns[(i * 2) % assigns.length] as Fact;
      const turns = 5 + (i % 6); // 5..10 turns in all
      const scope: Scope =
        i % 2 === 0 ? scopeOf("folder", f) : { kind: "all", id: null };
      const hist: Turn[] = [{ q: ask(f, lang), a: person(f.value).full }];
      // The middle turns are other lookups that stay inside the scope.
      const inScope = (g: Fact) =>
        scope.kind === "all" || mtg(g).folderId === scope.id;
      const mids = fillers
        .filter(inScope)
        .filter((g) => g.meetingId !== f.meetingId);
      for (let t = 1; t < turns - 1; t++) {
        const g = mids[(i * 3 + t) % mids.length] as Fact;
        hist.push({ q: ask(g, lang), a: answerText(g, lang) });
      }
      const due = f.slots.due as MD;
      const last =
        i < 7
          ? lang === "en"
            ? "Back to my first question: when is that task due?"
            : "Voltando à minha primeira pergunta: para quando é essa tarefa?"
          : lang === "en"
            ? "Back to my first question: what did that task cost?"
            : "Voltando à minha primeira pergunta: quanto custou essa tarefa?";
      const key: AnswerKey =
        i < 7
          ? { kind: "text", must: [[dateToken(due)]], mustNot: [] }
          : { kind: "not_found" };
      add(
        base(
          "long_thread",
          lang,
          scope,
          last,
          "lookup",
          planTools.lookup as string[],
          key,
          i < 7 ? goldOf(f) : [],
          { query_any: queryAny(f, lang) },
          hist,
        ),
      );
    }
  }

  // ---- write (25) ---------------------------------------------------------------------------
  {
    const allItems = c.meetings.flatMap((m) =>
      m.actionItems.map((a) => ({ a, m })),
    );
    const folderItems = allItems.filter((x) => x.m.folderId !== null);
    const open = folderItems.filter((x) => !x.a.done);
    const done = folderItems.filter((x) => x.a.done);
    // Pick open items from distinct folders first.
    const byFolder = c.folders.map((f) =>
      open.filter((x) => x.m.folderId === f.id),
    );
    const chosen: typeof open = [];
    for (let i = 0; chosen.length < 8; i++) {
      const bucket = byFolder[i % 4] as typeof open;
      const x = bucket[Math.floor(i / 4)];
      if (x) chosen.push(x);
      if (i > 60) break;
    }
    let k = 0;
    for (const x of chosen) {
      const lang = langAt(k++);
      add(
        base(
          "write",
          lang,
          { kind: "folder", id: x.m.folderId },
          lang === "en"
            ? `Mark "${x.a.task}" as done.`
            : `Marque "${x.a.task}" como concluída.`,
          "write",
          ["list_action_items", "propose_action_item_change"],
          { kind: "write", change: "action_item", ids: [x.a.id], arg: true },
          [],
          { item: x.a.id },
        ),
      );
    }
    for (const x of done.slice(0, 2)) {
      const lang = langAt(k++);
      add(
        base(
          "write",
          lang,
          { kind: "folder", id: x.m.folderId },
          lang === "en" ? `Reopen "${x.a.task}".` : `Reabra "${x.a.task}".`,
          "write",
          ["list_action_items", "propose_action_item_change"],
          { kind: "write", change: "action_item", ids: [x.a.id], arg: false },
          [],
          { item: x.a.id },
        ),
      );
    }
    // retag (6)
    const tagJobs: {
      scope: Scope;
      ids: string[];
      tag: string;
      en: string;
      pt: string;
      from: string;
      to: string;
    }[] = [];
    const sept = (fid: string) =>
      folderMeetings(fid).filter(
        (m) => new Date(m.startedAt).getUTCMonth() === 8,
      );
    for (const [fid, tag] of [
      ["fld-atlas", "q3-review"],
      ["fld-harbor", "pricing-check"],
      ["fld-audit", "supplier-risk"],
    ] as const) {
      const ms =
        fid === "fld-audit"
          ? folderMeetings(fid).filter(
              (m) => new Date(m.startedAt).getUTCMonth() === 8,
            )
          : sept(fid);
      tagJobs.push({
        scope: { kind: "folder", id: fid },
        ids: ms.map((m) => m.id),
        tag,
        en: `Tag the ${folderName(fid)} meetings from September with ${tag}.`,
        pt: `Marque as reuniões de ${folderName(fid)} de setembro com ${tag}.`,
        from: "2026-09-01",
        to: "2026-09-30",
      });
    }
    const lw = c.meetings
      .filter(
        (m) =>
          m.startedAt >= Date.UTC(2026, 9, 19) &&
          m.startedAt < Date.UTC(2026, 9, 26),
      )
      .map((m) => m.id);
    tagJobs.push({
      scope: { kind: "all", id: null },
      ids: lw,
      tag: "reviewed",
      en: "Tag every meeting from last week with reviewed.",
      pt: "Marque todas as reuniões da semana passada com reviewed.",
      from: "2026-10-19",
      to: "2026-10-25",
    });
    const first = c.meetings.filter(
      (m) => m.folderId === "fld-mobile",
    )[0] as Meeting;
    tagJobs.push({
      scope: { kind: "folder", id: "fld-mobile" },
      ids: [first.id],
      tag: "kickoff-notes",
      en: `Tag the first ${folderName("fld-mobile")} meeting with kickoff-notes.`,
      pt: `Marque a primeira reunião de ${folderName("fld-mobile")} com kickoff-notes.`,
      from: "",
      to: "",
    });
    const hs = folderMeetings("fld-harbor")
      .filter((m) => new Date(m.startedAt).getUTCMonth() === 9)
      .map((m) => m.id);
    tagJobs.push({
      scope: { kind: "folder", id: "fld-harbor" },
      ids: hs,
      tag: "october",
      en: `Tag the ${folderName("fld-harbor")} meetings from October with october.`,
      pt: `Marque as reuniões de ${folderName("fld-harbor")} de outubro com october.`,
      from: "2026-10-01",
      to: "2026-10-31",
    });
    for (const j of tagJobs.slice(0, 6)) {
      const lang = langAt(k++);
      add(
        base(
          "write",
          lang,
          j.scope,
          lang === "en" ? j.en : j.pt,
          "write",
          ["list_meetings", "propose_retag"],
          { kind: "write", change: "retag", ids: j.ids, arg: [j.tag] },
          [],
          { tag: j.tag, date_from: j.from || null, date_to: j.to || null },
        ),
      );
    }
    // move (5)
    const moves: { m: Meeting; to: string }[] = [
      {
        m: c.meetings.find((m) => m.id === "mtg-ops-1") as Meeting,
        to: "fld-atlas",
      },
      {
        m: c.meetings.find((m) => m.id === "mtg-ops-2") as Meeting,
        to: "fld-harbor",
      },
      {
        m: c.meetings.find((m) => m.id === "mtg-ops-3") as Meeting,
        to: "fld-mobile",
      },
      {
        m: c.meetings.find((m) => m.id === "mtg-audit-2") as Meeting,
        to: "fld-atlas",
      },
      {
        m: c.meetings.find((m) => m.id === "mtg-mobile-3") as Meeting,
        to: "fld-audit",
      },
    ];
    for (const x of moves) {
      const lang = langAt(k++);
      const d = new Date(x.m.startedAt);
      const dw = fmtDate({ m: d.getUTCMonth() + 1, d: d.getUTCDate() }, lang);
      const where = x.m.folderId
        ? folderName(x.m.folderId)
        : lang === "en"
          ? "unfiled"
          : "sem pasta";
      add(
        base(
          "write",
          lang,
          { kind: "all", id: null },
          lang === "en"
            ? `Move the ${where} meeting of ${dw} to ${folderName(x.to)}.`
            : `Mova a reunião (${where}) de ${dw} para ${folderName(x.to)}.`,
          "write",
          ["list_meetings", "propose_move"],
          { kind: "write", change: "move", ids: [x.m.id], arg: x.to },
          [],
          { meeting: x.m.id, folder: x.to },
        ),
      );
    }
    // merge people (4)
    const merges: [string, string, string][] = [
      ["p01", "Ana S.", "Anna Silvestri"],
      ["p06", "Tomek", "Tomash Vyechorek"],
      ["p10", "Rafa", "Rafael Quintanilha"],
      ["p03", "Carlos Medeiros", "Carlos Medeyros"],
    ];
    for (const [pid, a, b] of merges) {
      const lang = langAt(k++);
      add(
        base(
          "write",
          lang,
          { kind: "all", id: null },
          lang === "en"
            ? `Merge ${a} and ${b} into one person.`
            : `Una ${a} e ${b} em uma só pessoa.`,
          "write",
          ["list_people", "propose_merge_people"],
          { kind: "write", change: "merge_people", ids: [pid], arg: null },
          [],
          { cluster: pid },
        ),
      );
    }
  }

  // ---- retrieval queries (spec 8.8) --------------------------------------------------------------
  const retrieval: RetrievalQuery[] = [];
  const addR = (
    slice: RetrievalSlice,
    lang: Lang,
    text: string,
    gold: Question["gold"],
    from: string | null = null,
    to: string | null = null,
  ) => {
    retrieval.push({
      id: `r${String(retrieval.length + 1).padStart(3, "0")}`,
      slice,
      lang,
      text,
      scope: { kind: "all", id: null },
      dateFrom: from,
      dateTo: to,
      gold,
    });
  };
  const sameSubject = (f: Fact) =>
    c.facts.filter((o) => o.family === f.family && o.subject === f.subject);
  {
    // names (40): vendor name with the word quote, first names with a due date.
    let k = 0;
    const names: { text: (lg: Lang) => string; gold: Fact[] }[] = [];
    for (const f of factsOf("quote")) {
      const v = f.slots.vendor as Vendor;
      names.push({
        text: (lg) =>
          lg === "en" ? `${v.name} quote` : `cotação da ${v.name}`,
        gold: sameSubject(f),
      });
    }
    const firstUnique = (f: Fact) => {
      const p = person(f.value);
      const due = f.slots.due as MD;
      const same = factsOf("assign").filter(
        (o) =>
          person(o.value).first === p.first &&
          dateToken(o.slots.due as MD) === dateToken(due),
      );
      return same.length === 1;
    };
    for (const f of factsOf("assign").filter(firstUnique)) {
      const p = person(f.value);
      const due = f.slots.due as MD;
      names.push({
        text: (lg) =>
          lg === "en"
            ? `What does ${p.first} have to do by ${dateWords(due, "en")}?`
            : `O que ${p.first} tem que fazer até ${dateWords(due, "pt")}?`,
        gold: [f],
      });
    }
    // Interleave quotes and assigns so both kinds are in the 40.
    const qn = names.filter((_x, i) => i < factsOf("quote").length);
    const an = names.filter((_x, i) => i >= factsOf("quote").length);
    const mixed: typeof names = [];
    for (
      let i = 0;
      mixed.length < 40 && (i < qn.length || i < an.length);
      i++
    ) {
      if (qn[i]) mixed.push(qn[i] as (typeof names)[number]);
      if (an[i] && mixed.length < 40)
        mixed.push(an[i] as (typeof names)[number]);
    }
    for (const x of mixed.slice(0, 40)) {
      const lg = langAt(k++);
      addR("names", lg, x.text(lg), goldOf(...x.gold));
    }
  }
  {
    // numbers (40): amounts, metrics, decisions with a number.
    let k = 0;
    const nums: { text: (lg: Lang) => string; gold: Fact[] }[] = [];
    for (const f of [...factsOf("quote"), ...factsOf("quote", 1)]) {
      const a = Number(f.value);
      nums.push({
        text: (lg) =>
          lg === "en"
            ? `${fmtAmount(a, "en")} dollars`
            : `${fmtAmount(a, "pt")} reais`,
        gold: [f],
      });
    }
    for (const f of [...factsOf("metric"), ...factsOf("metric", 1)]) {
      const m = f.slots.m as { unit: L };
      nums.push({ text: (lg) => `${f.value} ${l(m.unit, lg)}`, gold: [f] });
    }
    for (const f of factsOf("decision")) {
      const d = f.slots.d as { choice: L };
      if (
        /\b(fourteen|thirty|ten percent|twenty|three|five)\b/i.test(d.choice[0])
      ) {
        nums.push({ text: (lg) => l(d.choice, lg), gold: [f] });
      }
    }
    for (const x of nums.slice(0, 40)) {
      const lg = langAt(k++);
      addR("numbers", lg, x.text(lg), goldOf(...x.gold));
    }
  }
  {
    // concept (30): a paraphrase with none of the words of the line.
    const items: { f: Fact; gist: L }[] = [];
    for (const f of factsOf("decision"))
      items.push({ f, gist: (f.slots.d as { gist: L }).gist });
    for (const f of factsOf("date")) {
      const g = (f.slots.sub as { gist?: L }).gist;
      if (g) items.push({ f, gist: g });
    }
    const spread = items
      .filter((_x, i) => i % Math.max(1, Math.floor(items.length / 30)) === 0)
      .slice(0, 30);
    spread.forEach((x, i) => {
      const lg = langAt(i);
      const text =
        x.f.family === "decision"
          ? lg === "en"
            ? `What did we decide about ${l(x.gist, "en")}?`
            : `O que decidimos sobre ${l(x.gist, "pt")}?`
          : lg === "en"
            ? `When is ${l(x.gist, "en")}?`
            : `Quando é ${l(x.gist, "pt")}?`;
      addR("concept", lg, text, goldOf(x.f));
    });
  }
  {
    // ASR-error names (20): the line has the ASR spelling, the query the right one.
    const items: { text: (lg: Lang) => string; f: Fact }[] = [];
    for (const f of c.facts.filter((x) => x.asrNameLine)) {
      if (f.family === "approve") {
        const p = person(f.value);
        items.push({
          f,
          text: (lg) =>
            lg === "en"
              ? `What did ${p.full} sign off on?`
              : `O que ${p.full} aprovou?`,
        });
      } else {
        const v = f.slots.vendor as Vendor;
        const role = f.slots.role as L;
        items.push({
          f,
          text: (lg) =>
            lg === "en"
              ? `When did ${v.name} confirm delivery of ${l(role, "en")}?`
              : `Para quando a ${v.name} confirmou a entrega de ${l(role, "pt")}?`,
        });
      }
    }
    items.slice(0, 20).forEach((x, i) => {
      const lg = langAt(i);
      addR("asr_names", lg, x.text(lg), goldOf(x.f));
    });
  }
  {
    // date-bounded (20): both versions of the 10 updated subjects, each in its own week.
    let k = 0;
    for (const f1 of c.facts.filter((f) => f.version === 1)) {
      for (const f of sameSubject(f1)) {
        const lg = langAt(k++);
        const m = mtg(f);
        const monday =
          m.startedAt - ((new Date(m.startedAt).getUTCDay() + 6) % 7) * DAY;
        const s = l(subjPair(f), lg);
        const text =
          f.family === "quote"
            ? lg === "en"
              ? `quote for ${s}`
              : `cotação para ${s}`
            : f.family === "date"
              ? lg === "en"
                ? `when is ${s}`
                : `quando é ${s}`
              : lg === "en"
                ? `number for ${s}`
                : `número para ${s}`;
        addR(
          "date",
          lg,
          text,
          goldOf(f),
          isoDay(monday),
          isoDay(monday + 6 * DAY),
        );
      }
    }
  }
  void OWNER_ID;
  return { questions, retrieval };
}
