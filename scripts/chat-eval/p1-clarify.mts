// p1-clarify.mts: the `clarify` part of the chat eval (D20, spec 11.8).
// Two features are measured. Keys are code; no LLM judge decides.
//   (1) The clarify block. Code finds the ambiguity and no model is called.
//       Items either should ask (scope, intent, person) or should not ask.
//       Keys: block kind, `why`, and for chips: every option.ask, sent as the
//       next question of the thread, must not return clarify again, and for an
//       answerable item must not be not_found. Metrics: precision, recall and
//       the false-clarify rate. The false-clarify rate is also counted over
//       the existing 190 gold questions, the broad turns and the thread turns
//       with the detector alone (code only, no model time).
//   (2) Map-reduce on the folder "Long Program" (72 meetings). Key: the answer
//       names must-mention facts of early AND late meetings, shows no invalid
//       cite, and the trace has a `map_reduce` step.

import type { ChatBlock, ChatMessage } from "@openstyle/validations";
import {
  type ClarifyAddon,
  HARBOR_MOBILE_ID,
  HARBOR_WEB_ID,
  LONG_PROGRAM_ID,
  type LongFact,
} from "./clarify-corpus.mts";
import { mean } from "./keys.mts";
import { buildBroad, coverage } from "./p1-broad.mts";
import { checkCites } from "./p1-score.mts";
import type { Scope, ThreadQ, Turn } from "./types.mts";

export type ClarifyWhy = "scope" | "intent" | "person";

/** The block fields the keys read. A real ChatBlock fits this shape. */
export interface BlockLike {
  kind: string;
  why?: string;
  options?: { label: string; key?: string | null; ask: string }[];
}

export interface ClarifyItem {
  id: string;
  /** "ask": the detector must return a clarify block. "no_ask": it must not. */
  expect: "ask" | "no_ask";
  /** The expected `why` of an "ask" item. */
  why: ClarifyWhy | null;
  scope: Scope;
  question: string;
  history: Turn[];
  /**
   * Chips of an "ask" item. "all": every chip must be answerable (not_found
   * fails). "none": a chip only has to not return clarify.
   */
  chips: "all" | "none";
}

// ---------------------------------------------------------------------------
// The items
// ---------------------------------------------------------------------------

const ALL: Scope = { kind: "all", id: null };

export function buildClarifyItems(addon: ClarifyAddon): ClarifyItem[] {
  const meetingOf = (folderId: string) =>
    addon.meetings.find((m) => m.folderId === folderId)?.id ?? "";
  const mobileMeeting: Scope = {
    kind: "meeting",
    id: meetingOf(HARBOR_MOBILE_ID),
  };
  const prior: Turn[] = [
    {
      q: "What is the rollout plan for Harbor Web?",
      a: "The web rollout starts with 20 percent of users in the first week.",
    },
  ];
  const ask = (
    id: string,
    why: ClarifyWhy,
    question: string,
    chips: ClarifyItem["chips"],
  ): ClarifyItem => ({
    id,
    expect: "ask",
    why,
    scope: ALL,
    question,
    history: [],
    chips,
  });
  const no = (
    id: string,
    scope: Scope,
    question: string,
    history: Turn[] = [],
  ): ClarifyItem => ({
    id,
    expect: "no_ask",
    why: null,
    scope,
    question,
    history,
    chips: "none",
  });
  return [
    // Should ask: the scope is ambiguous ("Harbor" names three folders).
    ask("cl01", "scope", "What is the latest on Harbor?", "all"),
    ask("cl02", "scope", "Any news on Harbor?", "all"),
    ask("cl03", "scope", "How is Harbor going?", "all"),
    ask("cl04", "scope", "Como está o Harbor?", "all"),
    // Should ask: no topic and no intent, no earlier question in the thread.
    ask("cl05", "intent", "status?", "all"),
    ask("cl06", "intent", "what about it?", "all"),
    ask("cl07", "intent", "tell me more", "all"),
    // Should ask: a first name that two people share, no full name.
    ask("cl08", "person", "What did Marta say about the rollout?", "all"),
    ask("cl09", "person", "What did Ana say about pricing?", "none"),
    ask("cl10", "person", "What did Carlos say about the audit?", "none"),
    // Should NOT ask: the question names a folder in full.
    no("nc01", ALL, "What is the latest on Harbor Mobile?"),
    no("nc02", ALL, "What is the latest on Harbor Web?"),
    no("nc03", ALL, "What was decided about discounts in Harbor Pricing?"),
    // Should NOT ask: the question names a person in full.
    no("nc04", ALL, "What did Marta Reis say about the rollout?"),
    no("nc05", ALL, "What did Marta Lacerda say about the rollout?"),
    // Should NOT ask: the page fixes the scope and only one person fits.
    no(
      "nc06",
      { kind: "folder", id: HARBOR_MOBILE_ID },
      "What did Marta say about the rollout?",
    ),
    no(
      "nc07",
      { kind: "folder", id: HARBOR_WEB_ID },
      "What did Marta say about the rollout?",
    ),
    no("nc08", mobileMeeting, "What did Marta say about the beta?"),
    // Should NOT ask: a vague question at a fixed scope is answerable.
    no("nc09", { kind: "folder", id: HARBOR_WEB_ID }, "status?"),
    no("nc10", mobileMeeting, "what about it?"),
    // Should NOT ask: the thread has an earlier question.
    no("nc11", ALL, "status?", prior),
    no("nc12", ALL, "tell me more", prior),
    // Should NOT ask: a specific question.
    no("nc13", ALL, "What is the rollout plan for Harbor Web?"),
    no("nc14", ALL, "What was decided about the Atlas cloud migration budget?"),
    no("nc15", ALL, "When did the Vendor Audit review the suppliers?"),
    no(
      "nc16",
      { kind: "folder", id: LONG_PROGRAM_ID },
      "Give me the story of Long Program.",
    ),
    // Never two clarify blocks in a row: the last assistant block is a clarify.
    {
      id: "nc17",
      expect: "no_ask",
      why: null,
      scope: ALL,
      question: "Harbor",
      history: [{ q: "What is the latest on Harbor?", a: "__clarify__" }],
      chips: "none",
    },
  ];
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export interface ClarifyScore {
  predicted: boolean;
  /** The item expected a clarify block. */
  expected: boolean;
  tp: boolean;
  fp: boolean;
  fn: boolean;
  tn: boolean;
  /** For a true positive: the `why` matches the key. Else null. */
  whyOk: boolean | null;
}

/** The key of the first turn: the first block is a clarify block of the expected kind. */
export function scoreClarify(
  item: Pick<ClarifyItem, "expect" | "why">,
  blocks: readonly BlockLike[],
): ClarifyScore {
  const first = blocks[0];
  const predicted = first?.kind === "clarify";
  const expected = item.expect === "ask";
  const tp = predicted && expected;
  return {
    predicted,
    expected,
    tp,
    fp: predicted && !expected,
    fn: !predicted && expected,
    tn: !predicted && !expected,
    whyOk: tp ? first?.why === item.why : null,
  };
}

export interface ChipScore {
  ok: boolean;
  reason: "ok" | "clarify_again" | "not_found" | "error";
}

/** The key of a chip: its question is asked as the next turn. */
export function scoreChip(
  chips: ClarifyItem["chips"],
  follow: { blocks: readonly BlockLike[]; err?: string | null },
): ChipScore {
  if (follow.err) return { ok: false, reason: "error" };
  if (follow.blocks[0]?.kind === "clarify")
    return { ok: false, reason: "clarify_again" };
  if (chips === "all" && follow.blocks.some((b) => b.kind === "not_found"))
    return { ok: false, reason: "not_found" };
  return { ok: true, reason: "ok" };
}

export interface ClarifyRow {
  id: string;
  expect: ClarifyItem["expect"];
  why: string | null;
  got: string;
  score: ClarifyScore;
  options: number;
  chips: { label: string; ok: boolean; reason: ChipScore["reason"] }[];
  err: string | null;
}

export function summarizeClarify(rows: ClarifyRow[]): Record<string, number> {
  const m: Record<string, number> = {};
  const count = (f: (r: ClarifyRow) => boolean) => rows.filter(f).length;
  const tp = count((r) => r.score.tp);
  const fp = count((r) => r.score.fp);
  const fn = count((r) => r.score.fn);
  const tn = count((r) => r.score.tn);
  m.items = rows.length;
  m.errors = count((r) => r.err !== null);
  m.tp = tp;
  m.fp = fp;
  m.fn = fn;
  m.tn = tn;
  m.precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  m.recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  m.false_clarify_rate = fp + tn === 0 ? 0 : fp / (fp + tn);
  const tps = rows.filter((r) => r.score.tp);
  m.why_acc =
    tps.length === 0 ? 0 : mean(tps.map((r) => (r.score.whyOk ? 1 : 0)));
  const chips = tps.flatMap((r) => r.chips);
  m.chips = chips.length;
  m.chips_ok = chips.length === 0 ? 0 : mean(chips.map((c) => (c.ok ? 1 : 0)));
  for (const w of ["scope", "intent", "person"] as const) {
    const rs = rows.filter((r) => r.expect === "ask" && r.why === w);
    if (rs.length > 0)
      m[`recall.${w}`] = mean(rs.map((r) => (r.score.tp ? 1 : 0)));
  }
  return m;
}

// ---------------------------------------------------------------------------
// False-clarify rate on the existing questions (code only)
// ---------------------------------------------------------------------------

export interface DetectCall {
  scope: Scope;
  question: string;
  /** Turns before this one, as (question, answer text) pairs. */
  history: Turn[];
}

/** Calls of the detector for the questions of a set, as the pipeline sees them. */
export function callsFromQuestions(
  qs: { scope: Scope; text: string; history: Turn[] }[],
): DetectCall[] {
  return qs.map((q) => ({
    scope: q.scope,
    question: q.text,
    history: q.history,
  }));
}

/** Calls of every turn of the threads: the earlier turns are the history. */
export function callsFromThreads(
  ts: { scope: Scope; turns: { text: string }[] }[] | ThreadQ[],
): DetectCall[] {
  const out: DetectCall[] = [];
  for (const t of ts)
    t.turns.forEach((turn, i) => {
      out.push({
        scope: t.scope,
        question: turn.text,
        history: t.turns.slice(0, i).map((x) => ({ q: x.text, a: "answer" })),
      });
    });
  return out;
}

/** The broad turns are threads too. */
export function callsFromBroad(
  corpus: Parameters<typeof buildBroad>[0],
): DetectCall[] {
  return callsFromThreads(buildBroad(corpus));
}

export interface FalseClarify {
  n: number;
  clarify: number;
  rate: number;
  /** Up to 10 questions that got a clarify block: `scope|why|text`. */
  samples: string[];
}

/** `detect` is `detectClarify` of the server with the db bound. */
export function falseClarifyRate(
  calls: DetectCall[],
  detect: (c: DetectCall) => BlockLike | null,
): FalseClarify {
  const hits = calls.flatMap((c) => {
    const b = detect(c);
    return b ? [`${c.scope.kind}|${b.why}|${c.question.slice(0, 60)}`] : [];
  });
  return {
    n: calls.length,
    clarify: hits.length,
    rate: calls.length === 0 ? 0 : hits.length / calls.length,
    samples: hits.slice(0, 10),
  };
}

/** The arguments of `detectClarify` for one call, as the pipeline builds them. */
export function detectArgs(c: DetectCall) {
  const last = historyMessages("detect", c.history).findLast(
    (m) => m.role === "assistant",
  );
  return {
    scope: c.scope,
    question: c.question,
    lastAssistantBlocks: last?.blocks ?? [],
    hasEarlierQuestion: c.history.length > 0,
  };
}

/** The stored messages of a history, as the app sends them to `runChatTurn`. */
export function historyMessages(
  id: string,
  history: Turn[],
  extra: {
    blocks: ChatBlock[];
    content: string;
    question: string;
  } | null = null,
): ChatMessage[] {
  const out: ChatMessage[] = [];
  let n = 1;
  const base = {
    thread_id: `eval-${id}`,
    cites: [],
    trace: null,
    model_id: null,
    provider: null,
    ms: null,
    created_at: 0,
  };
  const pair = (q: string, blocks: ChatBlock[], content: string) => {
    out.push({ ...base, id: n++, role: "user", content: q, blocks: [] });
    out.push({ ...base, id: n++, role: "assistant", content, blocks });
  };
  for (const t of history) {
    if (t.a === "__clarify__") {
      pair(t.q, [CLARIFY_STUB], "");
    } else pair(t.q, [{ kind: "text", text: t.a, cites: [] }], t.a);
  }
  if (extra) pair(extra.question, extra.blocks, extra.content);
  return out;
}

/** A clarify block as an earlier assistant message holds it (history of nc17). */
const CLARIFY_STUB: ChatBlock = {
  kind: "clarify",
  why: "scope",
  subject: "Harbor",
  options: [
    {
      label: "Harbor Mobile",
      key: null,
      ask: 'What is the latest on Harbor? (in the folder "Harbor Mobile")',
    },
  ],
};

// ---------------------------------------------------------------------------
// Map-reduce on the Long Program folder
// ---------------------------------------------------------------------------

export interface MapItem {
  id: string;
  question: string;
  scope: Scope;
}

export function buildMapItems(): MapItem[] {
  const scope: Scope = { kind: "folder", id: LONG_PROGRAM_ID };
  return [
    { id: "mr1", question: "Give me the story of Long Program.", scope },
    {
      id: "mr2",
      question: "Give me the history of the program with the key decisions.",
      scope,
    },
    {
      id: "mr3",
      question: "Catch me up on the whole program from the first review.",
      scope,
    },
  ];
}

export interface MapRow {
  id: string;
  pass: boolean;
  notFound: boolean;
  err: string | null;
  mapStep: boolean;
  /** Share of the must-mention facts named: all, early third, late third. */
  cov: number;
  covEarly: number;
  covLate: number;
  hitEarly: number;
  hitLate: number;
  invalidCites: number;
  uncited: number;
  sourcesDropped: number;
  note: string;
  chars: number;
  ms: number;
}

const share = (c: { hit: number; of: number }) =>
  c.of === 0 ? 1 : c.hit / c.of;

/**
 * The key of a map-reduce item. A pass needs a `map_reduce` step in the trace,
 * no invalid cite, no text block without a cite, at least one fact of an early
 * and one of a late meeting. `cites` is the result of `checkCites`.
 */
export function scoreMapReduce(
  facts: readonly LongFact[],
  r: {
    text: string;
    blocks: readonly BlockLike[];
    stepNames: readonly string[];
    cites: ReturnType<typeof checkCites>;
    uncited: number;
    sourcesDropped: number;
  },
): Omit<MapRow, "id" | "err" | "note" | "chars" | "ms"> {
  const groups = (p?: LongFact["period"]) =>
    facts.filter((f) => !p || f.period === p).map((f) => f.group);
  const all = coverage(r.text, groups());
  const early = coverage(r.text, groups("early"));
  const late = coverage(r.text, groups("late"));
  const notFound = r.blocks.some((b) => b.kind === "not_found");
  const mapStep = r.stepNames.includes("map_reduce");
  const pass =
    !notFound &&
    mapStep &&
    r.cites.invalid.length === 0 &&
    r.uncited === 0 &&
    early.hit >= 1 &&
    late.hit >= 1;
  return {
    pass,
    notFound,
    mapStep,
    cov: share(all),
    covEarly: share(early),
    covLate: share(late),
    hitEarly: early.hit,
    hitLate: late.hit,
    invalidCites: r.cites.invalid.length,
    uncited: r.uncited,
    sourcesDropped: r.sourcesDropped,
  };
}

export function summarizeMap(rows: MapRow[]): Record<string, number> {
  const m: Record<string, number> = {};
  m.items = rows.length;
  m.errors = rows.filter((r) => r.err).length;
  m.pass = mean(rows.map((r) => (r.pass ? 1 : 0)));
  m.map_step = mean(rows.map((r) => (r.mapStep ? 1 : 0)));
  m.cov = mean(rows.map((r) => r.cov));
  m.cov_early = mean(rows.map((r) => r.covEarly));
  m.cov_late = mean(rows.map((r) => r.covLate));
  m.invalid_cites = rows.reduce((a, r) => a + r.invalidCites + r.uncited, 0);
  m.not_found = mean(rows.map((r) => (r.notFound ? 1 : 0)));
  m.sources_dropped = mean(rows.map((r) => r.sourcesDropped));
  return m;
}

// ---------------------------------------------------------------------------
// Runners (the real pipeline; used by the part in p1-run.mts)
// ---------------------------------------------------------------------------

export interface ClarifyEnv {
  corpus: { todayMs: number };
  stack: { db: import("node:sqlite").DatabaseSync };
  mods: {
    pipeline: typeof import("../../apps/server/src/lib/chat/pipeline.ts");
    llm: typeof import("../../apps/server/src/lib/chat/llm.ts");
    settings: typeof import("../../apps/server/src/lib/chat/settings.ts");
  };
  detect: (i: {
    scope: Scope;
    question: string;
    lastAssistantBlocks: readonly ChatBlock[];
    hasEarlierQuestion: boolean;
  }) => BlockLike | null;
  known: Parameters<typeof checkCites>[1];
}

async function turn(
  env: ClarifyEnv,
  id: string,
  scope: Scope,
  question: string,
  history: ChatMessage[],
) {
  const signal = AbortSignal.timeout(180_000);
  const llm = await env.mods.llm.createChatLlm(env.stack.db, {
    threadId: `eval-${id}`,
    signal,
  });
  try {
    const res = await env.mods.pipeline.runChatTurn({
      db: env.stack.db,
      scope: { kind: scope.kind, id: scope.id } as never,
      question,
      history,
      settings: env.mods.settings.readChatSettings(),
      llm,
      signal,
      now: env.corpus.todayMs,
      allowProposals: false,
    });
    llm.finish("succeeded");
    return res;
  } catch (e) {
    llm.finish("failed", { errorDetail: String(e).slice(0, 200) });
    throw e;
  }
}

/**
 * One clarify item. The detector decides the first turn by code (the pipeline
 * runs the same function at stage 0a and returns before any model call). When
 * it fires, the real pipeline is run too to prove the block comes out of
 * `runChatTurn`. Each chip is then asked as the next turn, with the clarify
 * block in the history, like the app does.
 */
export async function runClarifyItem(
  env: ClarifyEnv,
  item: ClarifyItem,
): Promise<ClarifyRow> {
  const base = { id: item.id, expect: item.expect, why: item.why };
  try {
    const history = historyMessages(item.id, item.history);
    const hit = env.detect(
      detectArgs({
        scope: item.scope,
        question: item.question,
        history: item.history,
      }),
    );
    let blocks: BlockLike[] = [];
    let raw: ChatBlock[] = [];
    if (hit) {
      const res = await turn(env, item.id, item.scope, item.question, history);
      raw = res.blocks;
      blocks = res.blocks;
    }
    const score = scoreClarify(item, blocks);
    const chips: ClarifyRow["chips"] = [];
    const first = blocks[0];
    if (score.tp && first?.options) {
      const clar = raw[0] as ChatBlock;
      for (const opt of first.options) {
        const follow = historyMessages(item.id, item.history, {
          question: item.question,
          blocks: [clar],
          content: "",
        });
        let got: { blocks: readonly BlockLike[]; err?: string };
        try {
          const r = await turn(env, item.id, item.scope, opt.ask, follow);
          got = { blocks: r.blocks };
        } catch (e) {
          got = { blocks: [], err: String(e).slice(0, 200) };
        }
        const s = scoreChip(item.chips, got);
        chips.push({ label: opt.label, ok: s.ok, reason: s.reason });
      }
    }
    return {
      ...base,
      got: first?.kind === "clarify" ? `clarify:${first.why}` : "no_clarify",
      score,
      options: first?.options?.length ?? 0,
      chips,
      err: null,
    };
  } catch (e) {
    return {
      ...base,
      got: "error",
      score: scoreClarify(item, []),
      options: 0,
      chips: [],
      err: String(e).slice(0, 200),
    };
  }
}

export async function runMapItem(
  env: ClarifyEnv,
  item: MapItem,
  facts: readonly LongFact[],
): Promise<MapRow> {
  const t0 = Date.now();
  try {
    const res = await turn(env, item.id, item.scope, item.question, []);
    const textBlocks = res.blocks.filter((b) => b.kind === "text");
    const uncited = textBlocks.filter(
      (b) => b.kind === "text" && b.cites.length === 0,
    ).length;
    const steps = res.trace.steps;
    const k = scoreMapReduce(facts, {
      text: res.content,
      blocks: res.blocks,
      stepNames: steps.map((s) => s.name),
      cites: checkCites(res, env.known),
      uncited,
      sourcesDropped: res.trace.sources_dropped.length,
    });
    return {
      id: item.id,
      ...k,
      err: null,
      note: steps.find((s) => s.name === "map_reduce")?.note ?? "",
      chars: res.content.length,
      ms: Date.now() - t0,
    };
  } catch (e) {
    return {
      id: item.id,
      ...scoreMapReduce(facts, {
        text: "",
        blocks: [],
        stepNames: [],
        cites: { shown: 0, invalid: [] },
        uncited: 0,
        sourcesDropped: 0,
      }),
      pass: false,
      err: String(e).slice(0, 200),
      note: "",
      chars: 0,
      ms: Date.now() - t0,
    };
  }
}
