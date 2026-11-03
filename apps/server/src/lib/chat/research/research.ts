import type { ChatBlock, ChatMessage } from "@openstyle/validations";
import { z } from "zod";
import { followUpQuery, isDependentFollowUp } from "../plan.js";
import {
  REFLECT_MAX_TOKENS,
  REFLECT_SCHEMA,
  REFLECT_SYSTEM,
  type ReflectNext,
  reflectUser,
} from "../prompts.js";
import { scopeMeetingIds } from "../tools.js";
import { type Call, HARD_CAP_CALLS, type Turn } from "../turn.js";
import type { Source } from "../types.js";
import { asksReason } from "./trigger.js";

// The research loop (specs/meeting-chat-agent.md 11.9.5 and 11.9.6). The model
// makes two small choices: `next` (one word of a closed list) and a search
// text of at most 120 characters. Code builds every tool call, owns every
// stop rule, and never repeats a call.

export const MAX_ITER = { local: 4, cloud: 6 } as const;
export const MAX_LEADS = { local: 3, cloud: 5 } as const;
/** "Why are these open?": one worker for each of the top items (11.9.16). */
export const FAN_ITEMS = { local: 4, cloud: 5 } as const;
/** Meetings that "who pushed for it?" reads, one worker for each (11.9.16). */
export const FAN_MEETINGS = { local: 6, cloud: 8 } as const;
/** The open-items list shows at most this many items (11.9.16). Actions first, then questions. */
export const LIST_SHOWN = {
  actions: 8,
  questions: 4,
  questionsOnly: 12,
} as const;
/** One lead gets at most this many `act` steps. */
export const PER_LEAD_ACTS = 3;
/** A new loop turn needs time for the answer: it starts before this share of the deadline. */
export const SOFT_DEADLINE_SHARE = 0.5;
/** Summaries that one `act` reads (at most 3 tool calls for each loop turn, 11.9.10). */
export const SUMMARIES_PER_ACT = 3;
/** The answer attempts that must stay possible under the call cap. */
export const ANSWER_RESERVE = 3;

export const leadSchema = z.object({
  id: z.string(),
  text: z.string(),
  status: z.enum(["open", "done", "dropped"]),
  acts: z.number(),
  origin: z.enum(["question", "prior_answer", "plan", "reflect"]),
  /** The meeting of the list item that made this lead, else null. */
  meetingId: z.string().nullable(),
  /** The lead asks for the open items: a list answers it. */
  list: z.boolean(),
});
export type Lead = z.infer<typeof leadSchema>;

export const evidenceSchema = z.object({
  label: z.string(),
  kind: z.string(),
  meetingId: z.string(),
  title: z.string().nullable(),
  startedAt: z.number().nullable(),
  startMs: z.number().nullable(),
  endMs: z.number().nullable(),
  itemId: z.string().nullable(),
  text: z.string(),
  tool: z.string(),
  leadId: z.string(),
  score: z.number().nullable(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

export const stepSchema = z.object({
  tool: z.string(),
  argsKey: z.string(),
  rows: z.number(),
  topScore: z.number().nullable(),
  newLabels: z.array(z.string()),
  leadId: z.string(),
});
export type Step = z.infer<typeof stepSchema>;

export const DONE = [
  "enough",
  "max_iter",
  "stalled",
  "call_cap",
  "deadline",
  "no_leads",
  "error",
] as const;
export type Done = (typeof DONE)[number];

export type Strategy =
  | "list_open"
  | "search"
  | "rephrase"
  | "other_meetings"
  | "summary"
  | "window";

const fold = (q: string): string =>
  q
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();

/** "open items", "still open" in the 7 UI languages: a list answers the first question. */
const OPEN_ITEMS_RE = new RegExp(
  [
    "\\b(?:open|outstanding|pending) (?:items?|issues?|questions?|actions?|points?|tasks?)\\b",
    "\\b(?:still|what(?:'s| is| are)) (?:still )?open\\b",
    "\\bitens? em aberto\\b",
    "\\bem aberto\\b",
    "\\bpendentes?\\b",
    "\\b(?:abiert[oa]s?|pendientes?)\\b",
    "\\b(?:offen(?:e|en)?|ausstehend)\\b",
    "\\b(?:ouverts?|en suspens|en attente)\\b",
    "\\b(?:apert[oaie]|in sospeso)\\b",
  ].join("|"),
  "u",
);
/** "unresolved" in the 7 UI languages (accents are folded). */
const UNRESOLVED_RE =
  /\b(?:unresolved|outstanding|nao resolvid[oa]s?|sem resolver|sin resolver|irresuelt[oa]s?|ungeloest|non resolu[es]?|irrisolt[oaie])\b/u;
const ITEM_WORDS_RE =
  /\b(?:items?|actions?|tasks?|todos?|acoes|acao|tarefas?|itens|aufgaben?|taches?|tache|compiti|compito|tareas?)\b/u;
const QUESTION_WORDS_RE =
  /\b(?:questions?|perguntas?|preguntas?|fragen?|domande|domanda)\b/u;

/** True when the question asks for the open items or the unresolved points: the list tools answer it. */
export function asksOpenPoints(question: string): boolean {
  const q = fold(question);
  return OPEN_ITEMS_RE.test(q) || UNRESOLVED_RE.test(q);
}

/** The tools of the list strategy: action items and open questions, or the open questions alone. */
export function listCalls(text: string, showAll = false): Call[] {
  const q = fold(text);
  const questionsOnly = QUESTION_WORDS_RE.test(q) && !ITEM_WORDS_RE.test(q);
  // A capped list is ranked in the tool (raised often, then recent). "Show all" is not capped.
  const cap = (n: number) =>
    showAll ? {} : { limit: n, rank: true as const, topic: text.slice(0, 300) };
  return questionsOnly
    ? [
        {
          tool: "list_decisions_questions",
          args: { kind: "open_question", ...cap(LIST_SHOWN.questionsOnly) },
        },
      ]
    : [
        {
          tool: "list_action_items",
          args: { status: "open", ...cap(LIST_SHOWN.actions) },
        },
        {
          tool: "list_decisions_questions",
          args: { kind: "open_question", ...cap(LIST_SHOWN.questions) },
        },
      ];
}

/** The words of a query, for the repeat test. */
const wordsOf = (q: string): Set<string> =>
  new Set(
    fold(q)
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let both = 0;
  for (const w of a) if (b.has(w)) both += 1;
  return both / (a.size + b.size - both);
}

/** What the loop remembers between its steps. Not graph state: it is rebuilt from the steps. */
export class ResearchRun {
  readonly used = new Map<string, Set<Strategy>>();
  readonly keys = new Set<string>();
  readonly queries: Set<string>[] = [];
  /** The strategy that `reflect` asked for, for the next `act`. */
  requested: { next: ReflectNext; query: string } | null = null;

  usedBy(leadId: string): Set<Strategy> {
    let s = this.used.get(leadId);
    if (!s) {
      s = new Set();
      this.used.set(leadId, s);
    }
    return s;
  }

  /** True when the call repeats an earlier one: same key, or a search of nearly the same words. */
  isRepeat(call: Call): boolean {
    const key = argsKey(call);
    if (this.keys.has(key)) return true;
    if (call.tool === "search_chunks") {
      const a = call.args as { query?: string; meeting_ids?: string[] };
      // A search over other meetings is a different search, whatever its words.
      if (a.meeting_ids) return false;
      const w = wordsOf(a.query ?? "");
      if (this.queries.some((q) => jaccard(q, w) >= 0.8)) return true;
    }
    return false;
  }

  remember(call: Call): void {
    this.keys.add(argsKey(call));
    if (call.tool === "search_chunks") {
      const a = call.args as { query?: string; meeting_ids?: string[] };
      if (!a.meeting_ids) this.queries.push(wordsOf(a.query ?? ""));
    }
  }
}

/** The tool name plus the arguments, with the query in lower case and single spaces. */
export function argsKey(call: Call): string {
  const args = { ...(call.args as Record<string, unknown>) };
  if (typeof args.query === "string") {
    args.query = args.query.toLowerCase().replace(/\s+/g, " ").trim();
  }
  const sorted = Object.keys(args)
    .sort()
    .map((k) => [k, args[k]]);
  return `${call.tool}:${JSON.stringify(sorted)}`;
}

// ---- Leads (node `plan`) ----

/**
 * The items of the list blocks of the last answer (11.9.5, node `plan` point
 * 1). A list at Everything holds the items of every project: the items whose
 * text or meeting title shares words with the thread's questions come first.
 */
function priorItems(
  history: readonly ChatMessage[],
  topic: string,
): { text: string; meetingId: string | null }[] {
  const last = history.findLast((m) => m.role === "assistant");
  if (!last) return [];
  const items: {
    text: string;
    meetingId: string | null;
    score: number;
    raised: number;
  }[] = [];
  const words = [...wordsOf(topic)].filter((w) => w.length >= 4);
  for (const b of last.blocks as ChatBlock[]) {
    if (b.kind !== "list") continue;
    for (const it of b.items) {
      const text = it.text.trim();
      if (text === "" || items.some((x) => x.text === text)) continue;
      const hay = wordsOf(`${text} ${it.meeting_title ?? ""}`);
      items.push({
        text,
        meetingId: it.meeting_id,
        score: words.filter((w) => hay.has(w)).length,
        raised: it.raised ?? 1,
      });
    }
  }
  // A stable sort: items with the same score keep the order of the list.
  return items
    .map((x, i) => ({ x, i }))
    .sort(
      (a, b) => b.x.score - a.x.score || b.x.raised - a.x.raised || a.i - b.i,
    )
    .map(({ x }) => ({ text: x.text, meetingId: x.meetingId }));
}

/** Code seeds the leads. No model call. */
export function seedLeads(t: Turn): Lead[] {
  const { question, history } = t.input;
  const fan = t.input.llm.isLocal ? FAN_ITEMS.local : FAN_ITEMS.cloud;
  // Only a question with an earlier turn can lean on it ("this project" is not a follow-up).
  // "Show all" asks the earlier list question again: it stands alone.
  const dependent =
    t.input.showAll !== true &&
    t.turns.length > 0 &&
    isDependentFollowUp(question);
  if (dependent && asksReason(question)) {
    const items = priorItems(
      history,
      [...t.priorQuestions, question].join(" "),
    ).slice(0, fan);
    if (items.length > 0) {
      return items.map((it, i) => ({
        id: `L${i + 1}`,
        text: it.text.slice(0, 200),
        status: "open" as const,
        acts: 0,
        origin: "prior_answer" as const,
        meetingId: it.meetingId,
        list: false,
      }));
    }
  }
  const text = (
    dependent ? followUpQuery(question, t.priorTurns) : question
  ).slice(0, 200);
  return [
    {
      id: "L1",
      text,
      status: "open",
      acts: 0,
      origin: "question",
      meetingId: null,
      // The first question that asks for the open items: a list answers it.
      list:
        !dependent &&
        !asksReason(question) &&
        OPEN_ITEMS_RE.test(fold(question)),
    },
  ];
}

// ---- Strategies (node `act`) ----

function order(t: Turn, lead: Lead, evidence: readonly Evidence[]): Strategy[] {
  if (lead.list) return ["list_open", "search", "other_meetings", "summary"];
  // "Is anything still unresolved about X?": the open questions of the scope
  // are evidence too. At Everything they would drown the answer.
  const openish =
    lead.origin === "question" &&
    t.turnScope.kind !== "all" &&
    (OPEN_ITEMS_RE.test(fold(t.input.question)) ||
      UNRESOLVED_RE.test(fold(t.input.question)));
  if (t.turnScope.kind === "meeting") {
    return openish
      ? ["search", "list_open", "summary", "window"]
      : ["search", "summary", "window"];
  }
  if (openish) return ["search", "list_open", "other_meetings", "summary"];
  // A search that found nothing (a question with no topic word scores under
  // the floor): the summaries of the meetings come before the wider search.
  if (!evidence.some((e) => e.leadId === lead.id)) {
    return ["search", "summary", "other_meetings", "window"];
  }
  return ["search", "other_meetings", "summary", "window"];
}

const REQUESTED: Record<ReflectNext, Strategy | null> = {
  rephrase: "rephrase",
  other_meetings: "other_meetings",
  read_summaries: "summary",
  next_lead: null,
  stop: null,
};

export interface Pick {
  strategy: Strategy;
  calls: Call[];
}

/**
 * The next call for a lead. The `next` word of `reflect` picks the strategy
 * when it has not run for this lead; else the first strategy that has not run
 * and is not a repeat. Returns null when every strategy ran.
 */
export function chooseCalls(
  t: Turn,
  run: ResearchRun,
  lead: Lead,
  evidence: readonly Evidence[],
): Pick | null {
  const used = run.usedBy(lead.id);
  // The model's word picks the strategy only when the lead has evidence to
  // judge (or it gives better search words). With none, the code order runs.
  const hasEvidence = evidence.some((e) => e.leadId === lead.id);
  const request = run.requested;
  const asked =
    request && (hasEvidence || request.next === "rephrase")
      ? REQUESTED[request.next]
      : null;
  const candidates: Strategy[] = [
    ...(asked && !used.has(asked) ? [asked] : []),
    ...order(t, lead, evidence),
  ];
  for (const strategy of candidates) {
    if (used.has(strategy)) continue;
    const calls = buildCalls(t, run, lead, strategy, evidence);
    if (calls === null) {
      used.add(strategy);
      continue;
    }
    const fresh = calls.filter((c) => !run.isRepeat(c));
    if (fresh.length === 0) {
      used.add(strategy);
      continue;
    }
    used.add(strategy);
    return { strategy, calls: fresh };
  }
  return null;
}

function leadQuery(lead: Lead): string {
  return lead.text.slice(0, 200);
}

function buildCalls(
  t: Turn,
  run: ResearchRun,
  lead: Lead,
  strategy: Strategy,
  evidence: readonly Evidence[],
): Call[] | null {
  switch (strategy) {
    case "list_open":
      return listCalls(t.input.question, t.input.showAll === true);
    case "search":
      return [{ tool: "search_chunks", args: { query: leadQuery(lead) } }];
    case "rephrase": {
      const q = run.requested?.query.trim() ?? "";
      return q === "" ? null : [{ tool: "search_chunks", args: { query: q } }];
    }
    case "other_meetings": {
      const read = new Set(evidence.map((e) => e.meetingId));
      const unread = scopeMeetingIds(t.input.db, t.turnScope).filter(
        (id) => !read.has(id),
      );
      if (unread.length === 0) return null;
      return [
        {
          tool: "search_chunks",
          args: {
            query: leadQuery(lead),
            meeting_ids: unread.slice(0, 200),
            k: 4,
          },
        },
      ];
    }
    case "summary": {
      const read = new Set(
        t.toolCalls
          .filter((c) => c.tool === "get_meeting_summary")
          .map((c) => (c.args as { meeting_id?: string }).meeting_id),
      );
      // The meeting of the scope or of the lead, the meetings of the best
      // hits, then the first and the last meeting of the scope (a question
      // with no topic word, such as "what changed between the first and the
      // last meeting", is answered by those summaries).
      const inScope = scopeMeetingIds(t.input.db, t.turnScope);
      const candidates = [
        ...(t.turnScope.kind === "meeting" && t.turnScope.id
          ? [t.turnScope.id]
          : []),
        ...(lead.meetingId ? [lead.meetingId] : []),
        ...evidence.map((e) => e.meetingId),
        ...(inScope.length > 0 ? [inScope[0], inScope.at(-1)] : []),
        ...inScope,
      ];
      const ids = [
        ...new Set(candidates.filter((m): m is string => !!m && !read.has(m))),
      ].slice(0, SUMMARIES_PER_ACT);
      return ids.length > 0
        ? ids.map((id) => ({
            tool: "get_meeting_summary",
            args: { meeting_id: id },
          }))
        : null;
    }
    case "window": {
      const best = evidence.find(
        (e) => e.kind === "transcript" && e.startMs !== null,
      );
      if (!best || best.startMs === null) return null;
      return [
        {
          tool: "get_transcript_window",
          args: {
            meeting_id: best.meetingId,
            from_ms: Math.max(0, best.startMs - 15_000),
            to_ms: best.startMs + 45_000,
          },
        },
      ];
    }
  }
}

// ---- Observe ----

export function toEvidence(
  s: Source,
  tool: string,
  lead: string,
  score: number | null,
): Evidence {
  return {
    label: s.label,
    kind: s.kind,
    meetingId: s.meetingId,
    title: s.title,
    startedAt: s.startedAt,
    startMs: s.startMs,
    endMs: s.endMs,
    itemId: s.itemId,
    text: s.text.slice(0, 640),
    tool,
    leadId: lead,
    score,
  };
}

// ---- Reflect ----

const SNIPPET_CHARS = 160;
const SNIPPETS_MAX = 12;

export function reflectSources(evidence: readonly Evidence[]): string {
  return evidence
    .slice(-SNIPPETS_MAX)
    .map((e) => {
      const day =
        e.startedAt === null
          ? ""
          : ` (${new Date(e.startedAt).toISOString().slice(0, 10)})`;
      const text = e.text.replace(/\s+/g, " ").slice(0, SNIPPET_CHARS);
      return `[${e.label}] ${e.title ?? "meeting"}${day}: ${text}`;
    })
    .join("\n");
}

/**
 * One narrow LLM call. An invalid output, a gateway error or an empty `next` is
 * not retried: the caller treats it as `stop` (11.9.5, "node reflect").
 */
export async function reflectCall(
  t: Turn,
  lead: Lead,
  evidence: readonly Evidence[],
  doneStrategies: readonly string[],
): Promise<{ next: ReflectNext; query: string } | null> {
  const { question, llm, signal } = t.input;
  try {
    const r = await llm.structured({
      step: "chatReflect",
      unitKey: "reflect",
      schema: REFLECT_SCHEMA,
      system: REFLECT_SYSTEM,
      messages: [
        {
          role: "user",
          content: reflectUser({
            question: question.slice(0, 300),
            lead: lead.text,
            sources: reflectSources(evidence),
            done: doneStrategies.join(", ") || "nothing",
          }),
        },
      ],
      maxOutputTokens: REFLECT_MAX_TOKENS,
    });
    return { next: r.object.next, query: r.object.query.trim() };
  } catch (e) {
    // A client abort and the deadline end the turn; any other error means `stop`.
    if (signal.aborted) throw e;
    return null;
  }
}

// ---- Stop rules (11.9.6) ----

export interface RuleInput {
  t: Turn;
  iteration: number;
  maxIter: number;
  leads: readonly Lead[];
  steps: readonly Step[];
  evidenceCount: number;
}

/**
 * Rules 1 to 6, in order. The first that fires gives `done`. Rule 7 (`reflect`
 * said stop) is applied by the caller after the reflect call. Returns null to go on.
 */
export function stopRule(a: RuleInput): Done | null {
  const { t } = a;
  const { llm, settings } = t.input;
  // 1. A client abort throws (as today). The turn deadline passed: stop.
  if (t.stopReason() === "deadline") return "deadline";
  // 2. The call cap, with the answer attempts kept free.
  if (llm.calls() >= HARD_CAP_CALLS - ANSWER_RESERVE) return "call_cap";
  // 3. No lead is open.
  if (!a.leads.some((l) => l.status === "open")) return "no_leads";
  // 4. The loop turns.
  if (a.iteration >= a.maxIter) return "max_iter";
  // 5. The soft deadline: a new loop turn needs time for the answer call.
  if (Date.now() - t.t0 > SOFT_DEADLINE_SHARE * settings.deadlineMs) {
    return "deadline";
  }
  // 6. Stalled: the last 2 observe steps added no new label.
  const last = a.steps.slice(-2);
  if (last.length === 2 && last.every((s) => s.newLabels.length === 0)) {
    return "stalled";
  }
  return null;
}
