// p1-broad.mts: the "broad" part of the chat eval (Ask synthesis, branch
// fix/ask-synthesis). Broad questions ask for an overview, details, the story,
// the history or an onboarding of a meeting, a folder or everything. A lookup
// key has one fact; here a key lists the facts that the summaries and the
// transcripts hold, made by code from the fictional corpus (no judge):
//   (a) coverage: the share of the must-mention facts that the answer names,
//   (b) cite validity: no cite shown that the data does not support, and no
//       sentence shown with no cite,
//   (c) no repeated answer in a thread (whole text and sentences),
//   (d) answer length in range (2 to 9 text blocks, 100 to 1800 characters).
// An elaboration turn ("gimme details", "tell me more", "how did it start?")
// must add at least one fact that the earlier turns of the thread did not name.

import type { ChatMessage } from "@openstyle/validations";
import { mean, normalize } from "./keys.mts";
import { checkCites } from "./p1-score.mts";
import type { Corpus, Fact, Lang, Meeting, Scope } from "./types.mts";

export type BroadKind = "overview" | "details" | "story" | "onboarding";

export interface BroadTurn {
  kind: BroadKind;
  /** A later turn that asks for more. It must add a fact. */
  elaboration: boolean;
  text: string;
  /** The facts of the summaries. Each group is a list of alternatives. */
  groups: string[][];
  /** All facts of the scope (summaries and transcripts). */
  universe: string[][];
  /** Share of `groups` that a first answer must name. */
  minCov: number;
}
export interface BroadQ {
  id: string;
  lang: Lang;
  scope: Scope;
  turns: BroadTurn[];
}

export interface BroadRow {
  id: string;
  turn: number;
  scope: Scope["kind"];
  lang: Lang;
  kind: BroadKind;
  elaboration: boolean;
  question: string;
  pass: boolean;
  notFound: boolean;
  err: string | null;
  cov: number;
  /** Facts of the universe named now and not named in the earlier turns. */
  fresh: number;
  citesShown: number;
  invalidCites: number;
  uncited: number;
  repeat: boolean;
  lenOk: boolean;
  blocks: number;
  bullets: number;
  chars: number;
  tool: string | null;
  ms: number;
  answer: string;
  /** The steps of the turn, one line (debug). */
  trace: string;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** One anchor of a sentence: its first date or number, else a full name. */
export function anchorOf(text: string): string[] | null {
  const n = normalize(text);
  const m = n.match(/d:\d{2}-\d{2}|\b\d{2,}\b/);
  if (m) return [m[0]];
  const name = text.match(/\p{Lu}[\p{L}]+(?: \p{Lu}[\p{L}]+)+/u);
  return name ? [name[0]] : null;
}

const uniqGroups = (gs: (string[] | null)[]): string[][] => {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const g of gs) {
    if (!g) continue;
    const k = g.map(normalize).join("|");
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(g);
  }
  return out;
};

const choiceOf = (f: Fact | undefined): string[] | null => {
  const d = f?.slots?.d as { choice?: string[] } | undefined;
  return d?.choice ?? null;
};

/** Facts a transcript holds: dates, amounts, choices. People ids are not text. */
function factGroup(f: Fact): string[] | null {
  if (f.family === "decision") return choiceOf(f);
  if (/^p\d+$/.test(f.value)) return null;
  return [f.value];
}

function meetingGroups(
  c: Corpus,
  m: Meeting,
): { groups: string[][]; universe: string[][] } {
  const byId = new Map(c.facts.map((f) => [f.id, f]));
  const groups = uniqGroups([
    ...m.keyPoints.map(anchorOf),
    ...m.decisions.map((d) => choiceOf(byId.get(d.factId))),
  ]);
  const universe = uniqGroups([
    ...groups,
    ...c.facts.filter((f) => f.meetingId === m.id).map(factGroup),
  ]);
  return { groups, universe };
}

function folderGroups(
  c: Corpus,
  folderId: string,
): { groups: string[][]; universe: string[][] } {
  const ms = c.meetings.filter((m) => m.folderId === folderId);
  const groups = uniqGroups(
    ms.map((m) => (m.keyPoints[0] ? anchorOf(m.keyPoints[0]) : null)),
  );
  const universe = uniqGroups([
    ...groups,
    ...ms.flatMap((m) => meetingGroups(c, m).universe),
  ]);
  return { groups, universe };
}

// ---------------------------------------------------------------------------
// The set (about 30 turns, EN and PT, three scopes)
// ---------------------------------------------------------------------------

const MEETING_FIRST: Record<Lang, string[]> = {
  en: [
    "Give me an overview of this meeting.",
    "I need more details about this meeting.",
    "Tell me everything that happened in this meeting.",
    "Can you summarize this meeting for me?",
  ],
  pt: [
    "Me dá uma visão geral dessa reunião.",
    "Quero mais detalhes dessa reunião.",
    "Me conta tudo que aconteceu nessa reunião.",
    "Faça um resumo dessa reunião.",
  ],
};
const FOLDER_FIRST: Record<Lang, string[]> = {
  en: [
    "Tell me the story of this project so far. A good and complete onboarding.",
    "What is this project about? Give me the big picture.",
    "Catch me up on this project.",
    "How did this project begin? What is the history?",
  ],
  pt: [
    "Me conta a história desse projeto até agora.",
    "Quero um onboarding completo desse projeto.",
    "Me dá uma visão geral do projeto.",
    "O que já aconteceu nesse projeto?",
  ],
};
const ALL_FIRST = (lang: Lang, folder: string): string =>
  lang === "en"
    ? `Tell me the story of the ${folder} project so far.`
    : `Me conta a história do projeto ${folder}.`;
const ALL_FIRST2 = (lang: Lang, folder: string): string =>
  lang === "en"
    ? `Give me an overview of the ${folder} project.`
    : `Quero uma visão geral do projeto ${folder}.`;
const MORE: Record<Lang, string[]> = {
  en: [
    "gimme details",
    "Tell me more.",
    "I need more details about the whole project.",
    "How did it start?",
    "Can you elaborate?",
  ],
  pt: [
    "me dá mais detalhes",
    "Conte mais.",
    "Como isso começou?",
    "Quero mais detalhes.",
  ],
};

export function buildBroad(c: Corpus): BroadQ[] {
  const out: BroadQ[] = [];
  const langs: Lang[] = ["en", "pt"];
  const turn = (
    kind: BroadKind,
    text: string,
    g: { groups: string[][]; universe: string[][] },
    minCov: number,
    elaboration = false,
  ): BroadTurn => ({ kind, elaboration, text, ...g, minCov });
  const folders = c.folders;
  const inFolder = (id: string) => c.meetings.filter((m) => m.folderId === id);
  let n = 0;
  const id = () => `b${String(++n).padStart(2, "0")}`;

  // Meeting scope, one turn: 4 EN and 4 PT, one meeting of each folder.
  let k = 0;
  for (const lang of langs) {
    MEETING_FIRST[lang].forEach((text, i) => {
      const f = folders[(i + (lang === "pt" ? 2 : 0)) % folders.length];
      const ms = inFolder(f.id);
      const m = ms[(i + k) % ms.length];
      out.push({
        id: id(),
        lang,
        scope: { kind: "meeting", id: m.id },
        turns: [
          turn(
            i % 2 === 0 ? "overview" : "details",
            text,
            meetingGroups(c, m),
            0.5,
          ),
        ],
      });
      k++;
    });
  }
  // Folder scope, one turn: 4 EN, 4 PT.
  for (const lang of langs) {
    FOLDER_FIRST[lang].forEach((text, i) => {
      const f = folders[(i + (lang === "pt" ? 1 : 0)) % folders.length];
      out.push({
        id: id(),
        lang,
        scope: { kind: "folder", id: f.id },
        turns: [
          turn(
            i % 2 === 0 ? "story" : "onboarding",
            text,
            folderGroups(c, f.id),
            0.4,
          ),
        ],
      });
    });
  }
  // Everything scope, one turn: 2 EN, 2 PT, each names a project.
  for (const [i, lang] of (["en", "pt", "en", "pt"] as Lang[]).entries()) {
    const f = folders[i % folders.length];
    out.push({
      id: id(),
      lang,
      scope: { kind: "all", id: null },
      turns: [
        turn(
          i < 2 ? "story" : "overview",
          i < 2 ? ALL_FIRST(lang, f.name) : ALL_FIRST2(lang, f.name),
          folderGroups(c, f.id),
          0.4,
        ),
      ],
    });
  }
  // Threads with an elaboration follow-up (2 or 3 turns).
  const thread = (
    lang: Lang,
    scope: Scope,
    first: BroadTurn,
    mores: string[],
  ) => {
    const g = { groups: first.groups, universe: first.universe };
    out.push({
      id: id(),
      lang,
      scope,
      turns: [first, ...mores.map((t) => turn("details", t, g, 0, true))],
    });
  };
  for (const [i, lang] of (["en", "pt", "en", "pt"] as Lang[]).entries()) {
    const f = folders[i % folders.length];
    const m = inFolder(f.id)[i % inFolder(f.id).length];
    thread(
      lang,
      { kind: "meeting", id: m.id },
      turn("overview", MEETING_FIRST[lang][0], meetingGroups(c, m), 0.5),
      i < 2 ? [MORE[lang][0], MORE[lang][1]] : [MORE[lang][i === 2 ? 4 : 3]],
    );
  }
  for (const [i, lang] of (["en", "pt", "en", "pt"] as Lang[]).entries()) {
    const f = folders[(i + 1) % folders.length];
    thread(
      lang,
      { kind: "folder", id: f.id },
      turn("story", FOLDER_FIRST[lang][0], folderGroups(c, f.id), 0.4),
      i < 2 ? [MORE[lang][i === 0 ? 3 : 2], MORE[lang][1]] : [MORE[lang][0]],
    );
  }
  const fa = folders[0];
  thread(
    "en",
    { kind: "all", id: null },
    turn("story", ALL_FIRST("en", fa.name), folderGroups(c, fa.id), 0.4),
    [MORE.en[1]],
  );
  return out;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const has = (norm: string, g: string[]): boolean =>
  g.some((alt) => {
    const a = normalize(alt);
    return a !== "" && ` ${norm} `.includes(` ${a} `);
  });

export function coverage(
  answer: string,
  groups: string[][],
): { hit: number; of: number } {
  const norm = normalize(answer);
  return { hit: groups.filter((g) => has(norm, g)).length, of: groups.length };
}

const toks = (s: string): Set<string> =>
  new Set(
    normalize(s)
      .split(" ")
      .filter((w) => w.length > 2),
  );
const jac = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / (a.size + b.size - n);
};

/** The answer repeats an earlier answer: the whole text, or most sentences. */
export function isRepeat(answer: string, earlier: readonly string[]): boolean {
  if (earlier.length === 0 || answer.trim() === "") return false;
  const whole = toks(answer);
  if (earlier.some((e) => jac(whole, toks(e)) >= 0.8)) return true;
  const sents = answer
    .split(/\n+|(?<=[.!?])\s+/u)
    .map((x) => x.trim())
    .filter((x) => toks(x).size >= 3);
  if (sents.length === 0) return false;
  const old = earlier.flatMap((e) => e.split(/\n+|(?<=[.!?])\s+/u)).map(toks);
  const dup = sents.filter((s) =>
    old.some((o) => jac(toks(s), o) >= 0.6),
  ).length;
  return dup / sents.length > 0.5;
}

export interface BroadEnv {
  corpus: Corpus;
  stack: { db: import("node:sqlite").DatabaseSync };
  mods: {
    pipeline: typeof import("../../apps/server/src/lib/chat/pipeline.ts");
    llm: typeof import("../../apps/server/src/lib/chat/llm.ts");
    settings: typeof import("../../apps/server/src/lib/chat/settings.ts");
  };
  known: Parameters<typeof checkCites>[1];
}

export async function runBroad(env: BroadEnv, q: BroadQ): Promise<BroadRow[]> {
  const { mods, stack, corpus } = env;
  const history: ChatMessage[] = [];
  const earlier: string[] = [];
  const named = new Set<string>();
  const rows: BroadRow[] = [];
  let mid = 1;
  for (const [i, t] of q.turns.entries()) {
    const signal = AbortSignal.timeout(180_000);
    const t0 = Date.now();
    const base = {
      id: q.id,
      turn: i + 1,
      scope: q.scope.kind,
      lang: q.lang,
      kind: t.kind,
      elaboration: t.elaboration,
      question: t.text,
    };
    let llm: Awaited<ReturnType<typeof mods.llm.createChatLlm>> | null = null;
    try {
      llm = await mods.llm.createChatLlm(stack.db, {
        threadId: `eval-${q.id}`,
        signal,
      });
      const res = await mods.pipeline.runChatTurn({
        db: stack.db,
        scope: { kind: q.scope.kind, id: q.scope.id } as never,
        question: t.text,
        history: [...history],
        settings: mods.settings.readChatSettings(),
        llm,
        signal,
        now: corpus.todayMs,
        allowProposals: false,
      });
      llm.finish("succeeded");
      const nf = res.blocks.find((b) => b.kind === "not_found");
      const notFound = nf !== undefined;
      // After the second answer the sources may hold nothing new. Saying so is
      // the right answer then, never on the first elaboration.
      const nothingNew =
        nf?.kind === "not_found" && nf.reason === "nothing_new";
      const textBlocks = res.blocks.filter((b) => b.kind === "text");
      const text = res.content;
      const uni = t.universe.filter((g) => has(normalize(text), g));
      const fresh = uni.filter((g) => !named.has(g.join("|"))).length;
      const cov = coverage(text, t.groups);
      const covShare = cov.of === 0 ? 1 : cov.hit / cov.of;
      const chk = checkCites(res, env.known);
      const uncited = textBlocks.filter(
        (b) => b.kind === "text" && b.cites.length === 0,
      ).length;
      const repeat = !notFound && isRepeat(text, earlier);
      const bullets = textBlocks.filter(
        (b) => b.kind === "text" && b.bullet,
      ).length;
      // A first answer: lead plus bullets. An elaboration may be shorter (only new facts).
      const lenOk = t.elaboration
        ? textBlocks.length >= 1 &&
          textBlocks.length <= 9 &&
          text.length >= 40 &&
          text.length <= 1800
        : textBlocks.length >= 2 &&
          textBlocks.length <= 9 &&
          text.length >= 100 &&
          text.length <= 1800;
      const honestEnd = t.elaboration && nothingNew && i >= 2;
      const factOk = t.elaboration ? !notFound : covShare >= t.minCov;
      const pass =
        honestEnd ||
        (!notFound &&
          factOk &&
          chk.invalid.length === 0 &&
          uncited === 0 &&
          !repeat &&
          lenOk);
      rows.push({
        ...base,
        pass,
        notFound,
        err: null,
        cov: covShare,
        fresh,
        citesShown: chk.shown,
        invalidCites: chk.invalid.length,
        uncited,
        repeat,
        lenOk,
        blocks: textBlocks.length,
        bullets,
        chars: text.length,
        tool: res.toolCalls[0]?.tool ?? null,
        ms: Date.now() - t0,
        answer: text,
        trace: res.trace.steps
          .map((x) => `${x.stage}:${x.name}${x.note ? `(${x.note})` : ""}`)
          .join(" > "),
      });
      for (const g of uni) named.add(g.join("|"));
      earlier.push(text);
      const mk = {
        thread_id: `eval-${q.id}`,
        trace: null,
        model_id: null,
        provider: null,
        ms: null,
        created_at: 0,
      };
      history.push(
        {
          ...mk,
          id: mid++,
          role: "user",
          content: t.text,
          blocks: [],
          cites: [],
        },
        {
          ...mk,
          id: mid++,
          role: "assistant",
          content: res.content,
          blocks: res.blocks,
          cites: res.cites,
        },
      );
    } catch (e) {
      llm?.finish("failed", { errorDetail: String(e).slice(0, 200) });
      rows.push({
        ...base,
        pass: false,
        notFound: false,
        err: String(e).slice(0, 200),
        cov: 0,
        fresh: 0,
        citesShown: 0,
        invalidCites: 0,
        uncited: 0,
        repeat: false,
        lenOk: false,
        blocks: 0,
        bullets: 0,
        chars: 0,
        tool: null,
        ms: Date.now() - t0,
        answer: "",
        trace: "",
      });
      break;
    }
  }
  return rows;
}

export function summarizeBroad(rows: BroadRow[]): Record<string, number> {
  const m: Record<string, number> = {};
  const first = rows.filter((r) => !r.elaboration);
  const elab = rows.filter((r) => r.elaboration);
  m.turns = rows.length;
  m.errors = rows.filter((r) => r.err).length;
  m.pass = mean(rows.map((r) => (r.pass ? 1 : 0)));
  m.cov = mean(first.map((r) => r.cov));
  m.cov_pass = mean(first.map((r) => (r.cov >= 0.4 ? 1 : 0)));
  m.fresh_rate = mean(elab.map((r) => (r.pass && !r.notFound ? 1 : 0)));
  m.not_found = mean(rows.map((r) => (r.notFound ? 1 : 0)));
  m.invalid_cites = rows.reduce((a, r) => a + r.invalidCites + r.uncited, 0);
  m.cite_valid =
    rows.reduce((a, r) => a + r.citesShown, 0) === 0
      ? 0
      : 1 -
        m.invalid_cites /
          Math.max(
            1,
            rows.reduce((a, r) => a + r.citesShown, 0),
          );
  m.repeats = rows.filter((r) => r.repeat).length;
  m.len_ok = mean(rows.map((r) => (r.lenOk ? 1 : 0)));
  m.bullets_mean = mean(rows.map((r) => r.bullets));
  m.blocks_mean = mean(rows.map((r) => r.blocks));
  for (const s of ["meeting", "folder", "all"] as const) {
    const rs = rows.filter((r) => r.scope === s);
    if (rs.length) m[`pass.${s}`] = mean(rs.map((r) => (r.pass ? 1 : 0)));
    m[`n.${s}`] = rs.length;
  }
  for (const l of ["en", "pt"] as const) {
    const rs = rows.filter((r) => r.lang === l);
    if (rs.length) m[`pass.${l}`] = mean(rs.map((r) => (r.pass ? 1 : 0)));
  }
  return m;
}
