import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { END, Send, START, StateGraph } from "@langchain/langgraph";
import type { ChatBlock, ChatProgress } from "@openstyle/validations";
import { NodeSqliteSaver } from "../../llm/workflow/checkpoint-saver.js";
import type { AnswerSentence } from "../cites.js";
import type { ReflectNext } from "../prompts.js";
import { scopeMeetingIds } from "../tools.js";
import {
  type AnswerJob,
  type AnswerRun,
  type Exit,
  SCORE_FLOOR,
  type Turn,
} from "../turn.js";
import type { TurnResult } from "../types.js";
import {
  asksOpenPoints,
  chooseCalls,
  type Done,
  type Evidence,
  FAN_MEETINGS,
  type Lead,
  MAX_ITER,
  PER_LEAD_ACTS,
  ResearchRun,
  reflectCall,
  type Step,
  seedLeads,
  stopRule,
  toEvidence,
} from "./research.js";
import { type Go, ResearchState, type ResearchStateType } from "./state.js";
import { researchTrigger } from "./trigger.js";
import {
  composeReasons,
  itemWorker,
  langOf,
  meetingWorker,
  type WorkerRecord,
} from "./workers.js";

// The Ask turn as a LangGraph graph (specs/meeting-chat-agent.md 11.9.3). The
// nodes call the stage methods of `Turn` and the research functions. Code owns
// every edge: a node returns the key of the next node in `go`, and the
// conditional edge reads it. This module imports LangGraph statically;
// `run.ts` loads it with a dynamic `import()`, after the tracing variables
// are removed, as the Enhance graph does.

type Update = Partial<ResearchStateType>;

/** The not_found reason of a loop that ended with no evidence. */
const REASON_OF: Partial<Record<Done, string>> = {
  deadline: "deadline",
  call_cap: "call_cap",
};

/** The call of the last `act`, for `observe`. */
interface LastRun {
  strategy: string;
  calls: { tool: string }[];
  results: { rows: number; topScore: number | null; labels: string[] }[];
  before: Set<string>;
  leadId: string;
  started: number;
  argsKey: string;
}

/** A saver that reports the time of each write (the eval measures bar D17). */
class TimedSaver extends NodeSqliteSaver {
  constructor(
    db: ConstructorParameters<typeof NodeSqliteSaver>[0],
    private readonly report: (ms: number) => void,
  ) {
    super(db);
  }

  override async put(...a: Parameters<NodeSqliteSaver["put"]>) {
    const started = performance.now();
    try {
      return await super.put(...a);
    } finally {
      this.report(performance.now() - started);
    }
  }

  override async putWrites(...a: Parameters<NodeSqliteSaver["putWrites"]>) {
    const started = performance.now();
    try {
      return await super.putWrites(...a);
    } finally {
      this.report(performance.now() - started);
    }
  }
}

export function buildResearchGraph(t: Turn, checkpoint: boolean) {
  // The parts of a turn that are not graph state: the answer jobs and the
  // draft. They hold source objects, which the state never holds.
  const g = {
    jobs: null as AnswerJob[] | null,
    merge: false,
    partials: [] as TurnResult[],
    run: null as AnswerRun | null,
    draft: null as AnswerSentence[] | null,
    statusBlocks: null as ChatBlock[] | null,
    // the workers
    sends: [] as Send[],
    // research
    loop: new ResearchRun(),
    last: null as LastRun | null,
  };

  const maxIter = t.input.llm.isLocal ? MAX_ITER.local : MAX_ITER.cloud;
  const reflectOn = t.input.researchReflect !== false;

  const emit = (config: LangGraphRunnableConfig, p: Partial<ChatProgress>) => {
    config.writer?.({ stage: "researching", count: null, ...p });
  };

  /** A status turn keeps its counts as the last block, whatever the text did. */
  const settle = (exit: Exit): Exit =>
    g.statusBlocks
      ? {
          kind: "result",
          result: t.statusResult(t.resolve(exit), g.statusBlocks),
        }
      : exit;

  /** Where an exit goes: `not_found` builds the block; a result is passed to the end. */
  const leave = (exit: Exit, from: Go): Update =>
    exit.kind === "not_found"
      ? { notFoundReason: exit.reason, go: "not_found" }
      : {
          result: settle(exit),
          go: from === "cite_check" ? "end" : "cite_check",
        };

  /** The end of one answer job. A map-reduce has several jobs: the slices. */
  const jobEnd = (exit: Exit, s: ResearchStateType, from: Go): Update => {
    const jobs = g.jobs as AnswerJob[];
    if (!g.merge) return leave(exit, from);
    g.partials.push(t.resolve(exit));
    if (s.jobIndex < jobs.length - 1) {
      const between = t.betweenSlices(g.partials);
      if (between === null) {
        g.run = null;
        return { jobIndex: s.jobIndex + 1, attempts: 0, go: "synthesize" };
      }
      if (between !== "break") return leave(between, from);
    }
    return leave(t.mergeSlices(g.partials), from);
  };

  const scope = (): Update => {
    t.begin();
    const gate = t.clarify();
    if (gate) return { result: gate, go: "end" };
    const research = researchTrigger({
      question: t.input.question,
      history: t.input.history,
      enabled: t.input.settings.research,
    });
    t.mode = research ? "research" : "fast";
    return {
      mode: t.mode,
      maxIter: research ? maxIter : t.input.settings.rounds,
      go: "plan",
    };
  };

  /** The research start: leads from code, then the workers or the loop. */
  const planResearch = (): Update => {
    t.beginResearch();
    const leads = seedLeads(t);
    // Orchestrator-worker (11.9.17): "why are these open?" sends one worker
    // for each item; any other digging question scouts the meetings first and
    // sends one worker for each meeting. The open-points questions keep the loop.
    if (leads.length > 0 && leads.every((l) => l.origin === "prior_answer")) {
      g.sends = leads.map(
        (lead) => new Send("worker", { kind: "item" as const, lead }),
      );
      return { leads, path: "research", fan: "items", go: "fanout" };
    }
    const first = leads[0];
    if (
      first &&
      first.origin === "question" &&
      !first.list &&
      !asksOpenPoints(t.input.question)
    ) {
      return { leads, path: "research", fan: "meetings", go: "scout" };
    }
    return { leads, path: "research", go: "act" };
  };

  const plan = async (s: ResearchStateType): Promise<Update> => {
    if (s.mode === "research") return planResearch();
    const r = await t.route();
    if (r.kind === "dig") {
      // The model asked to dig (11.9.17): the same graph, research mode.
      t.mode = "research";
      return { mode: "research", maxIter, ...planResearch() };
    }
    if (r.kind === "exit") {
      return r.exit.kind === "result"
        ? { result: r.exit, go: "end" }
        : { notFoundReason: r.exit.reason, go: "not_found" };
    }
    return { path: r.kind === "broad" ? "broad" : "tools", go: "act" };
  };

  // ---- scout, worker, join (11.9.16) ----

  /** `scout`: one search over the scope; the meetings of the best hits get one worker each. */
  const scout = async (s: ResearchStateType): Promise<Update> => {
    const lead = s.leads[0] as Lead;
    const floor = t.input.scoreFloor ?? SCORE_FLOOR;
    const find = async (query: string) => {
      const r = await t.run({
        tool: "search_chunks",
        args: { query: query.slice(0, 200), k: 16 },
      });
      return r && (floor <= 0 || r.topScore === null || r.topScore >= floor)
        ? r.labels
            .map((l) => t.sources.get(l))
            .filter(
              (x): x is NonNullable<typeof x> => !!x && x.kind !== "folder",
            )
        : [];
    };
    let hits = await find(lead.text);
    // A follow-up ("who pushed for it?") may build a weak query: the topic of the
    // earlier turn (its question and the start of its answer) finds the meetings.
    const prior = t.priorTurns.at(-1);
    if (hits.length === 0 && prior) {
      hits = await find(`${prior.question} ${prior.answer.slice(0, 120)}`);
    }
    const max = t.input.llm.isLocal ? FAN_MEETINGS.local : FAN_MEETINGS.cloud;
    const seen = new Map<string, { title: string | null; at: number | null }>();
    for (const h of hits) {
      if (!seen.has(h.meetingId)) {
        seen.set(h.meetingId, { title: h.title, at: h.startedAt });
      }
      if (seen.size >= max) break;
    }
    // A reason can sit in a meeting that the first search ranked low (a
    // different wording): the rest of a small scope is read too, oldest and
    // newest first, so the story has both ends. Only when something was found.
    if (seen.size > 0) {
      const inScope = scopeMeetingIds(t.input.db, t.turnScope);
      const order = [inScope[0], inScope.at(-1), ...inScope];
      for (const id of order) {
        if (seen.size >= max) break;
        if (id && !seen.has(id)) seen.set(id, { title: null, at: null });
      }
    }
    if (seen.size === 0) return { go: "act" };
    g.sends = [...seen].map(
      ([meetingId, m]) =>
        new Send("worker", {
          kind: "meeting" as const,
          meetingId,
          title: m.title ?? meetingId,
          lead,
        }),
    );
    return { go: "fanout" };
  };

  type WorkerInput =
    | { kind: "item"; lead: Lead }
    | { kind: "meeting"; meetingId: string; title: string; lead: Lead };

  /** `worker`: one record. A failed worker gives an empty record, never an error. */
  const worker = async (
    w: WorkerInput,
    config: LangGraphRunnableConfig,
  ): Promise<Update> => {
    // The status line of the client: "Looking for ..." with the worker count.
    emit(config, {
      iteration: 1,
      max_iter: maxIter,
      lead_index: w.kind === "item" ? Number(w.lead.id.slice(1)) : 1,
      leads: g.sends.length,
    });
    const rec: WorkerRecord =
      w.kind === "item"
        ? await itemWorker(t, w.lead)
        : await meetingWorker(
            t,
            `M:${w.meetingId}`,
            w.meetingId,
            w.title,
            t.input.question,
            w.lead.text,
          );
    return { records: [rec] };
  };

  /** `join`: the records are in. Compose the bullets (items), or give the verified sources to the answer call (meetings). */
  const join = (s: ResearchStateType): Update => {
    const started = Date.now();
    const lead = s.leads[0] as Lead;
    const trail = (done: Done, meetings: number) => {
      t.trail = {
        iterations: 1,
        max_iter: maxIter,
        meetings,
        searches: s.records.length,
        done,
        open_leads: [],
      };
    };
    if (s.fan === "items") {
      const order = new Map(s.leads.map((l, i) => [l.id, i]));
      const recs = [...s.records].sort(
        (a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0),
      );
      const lang = langOf(
        `${t.input.question} ${recs.map((r) => r.subject).join(" ")}`,
      );
      const { blocks, cites } = composeReasons(t, recs, lang);
      t.step(
        "research",
        "join:items",
        started,
        recs.filter((r) => r.why !== "").length,
        `${recs.length} items`,
      );
      if (blocks.length === 0) return { go: "act" };
      trail("enough", new Set(recs.map((r) => r.meetingId)).size);
      return { result: t.codeResult(blocks, cites), go: "end" };
    }
    // meetings: the verified excerpts are the only sources of the answer
    const recs = s.records
      .filter((r) => r.source !== "")
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    t.step("research", "join:meetings", started, recs.length, null);
    if (recs.length === 0) return { go: "act" };
    const keep = new Set(recs.map((r) => r.source));
    t.sources.remove(
      t.sources
        .all()
        .filter((x) => !keep.has(x.label))
        .map((x) => x.label),
    );
    const ranked = t.sources.all().filter((x) => x.kind !== "folder");
    const day = (r: WorkerRecord) =>
      r.startedAt === null
        ? ""
        : new Date(r.startedAt).toISOString().slice(0, 10);
    const notes = recs
      .map(
        (r) =>
          `${day(r)} [${r.source}]: ${[r.who && `who: ${r.who}`, r.what && `what: ${r.what}`, r.why && `why: ${r.why}`].filter(Boolean).join("; ")}`,
      )
      .join(" | ");
    g.jobs = [
      {
        ranked,
        synth: true,
        focus: `answer the question from these findings, meeting by meeting, with the date. Name the person and the reason when a finding has them. Findings: ${notes}`,
      },
    ];
    g.merge = false;
    trail("enough", new Set(recs.map((r) => r.meetingId)).size);
    return { go: "synthesize", leads: [{ ...lead, status: "done" as const }] };
  };

  // ---- act ----

  const actResearch = async (
    s: ResearchStateType,
    config: LangGraphRunnableConfig,
  ): Promise<Update> => {
    g.last = null;
    const leads = s.leads;
    // Leads that close in this step (no call left, or the cap of acts): they
    // cost no loop turn, so the next lead runs in the same `act`.
    const closed: Lead[] = [];
    // The first open lead that still has a call to make.
    for (const [i, lead] of leads.entries()) {
      if (lead.status !== "open") continue;
      const pick =
        lead.acts >= PER_LEAD_ACTS
          ? null
          : chooseCalls(t, g.loop, lead, s.evidence);
      if (!pick) {
        closed.push({ ...lead, status: "dropped" });
        continue;
      }
      emit(config, {
        iteration: s.iteration + 1,
        max_iter: maxIter,
        lead_index: i + 1,
        leads: leads.length,
      });
      const started = Date.now();
      const before = new Set(t.sources.all().map((x) => x.label));
      const results: LastRun["results"] = [];
      for (const call of pick.calls) {
        const r = await t.run(call);
        g.loop.remember(call);
        if (r) {
          results.push({
            rows: r.rows,
            topScore: r.topScore,
            labels: r.labels,
          });
        }
      }
      g.last = {
        strategy: pick.strategy,
        calls: pick.calls,
        results,
        before,
        leadId: lead.id,
        started,
        argsKey: pick.calls.map((c) => `${c.tool}`).join("+"),
      };
      g.loop.requested = null;
      return {
        leads: [...closed, { ...lead, acts: lead.acts + 1 }],
        iteration: s.iteration + 1,
        go: "observe",
      };
    }
    return { leads: closed, go: "observe" };
  };

  const act = async (
    s: ResearchStateType,
    config: LangGraphRunnableConfig,
  ): Promise<Update> => {
    if (s.path === "research") return actResearch(s, config);
    if (s.path === "broad") {
      await t.broadGather();
      return { go: "observe" };
    }
    const stop = await t.actRound(s.iteration + 1);
    if (stop?.kind === "not_found") {
      return { notFoundReason: stop.reason, go: "not_found" };
    }
    return { iteration: s.iteration + 1, go: "observe" };
  };

  // ---- observe ----

  const observeResearch = (
    s: ResearchStateType,
    config: LangGraphRunnableConfig,
  ): Update => {
    const last = g.last;
    if (!last) return { go: "reflect" };
    const floor = t.input.scoreFloor ?? SCORE_FLOOR;
    // A search whose best hit is under the floor adds no evidence (11.9.7 point 6).
    for (const r of last.results) {
      if (floor > 0 && r.topScore !== null && r.topScore < floor) {
        t.sources.remove(r.labels.filter((l) => !last.before.has(l)));
      }
    }
    const added = t.sources
      .all()
      .filter((x) => !last.before.has(x.label) && x.kind !== "folder");
    const tool = last.calls[0]?.tool ?? "";
    const scores = last.results
      .map((r) => r.topScore)
      .filter((x): x is number => x !== null);
    const topScore = scores.length > 0 ? Math.max(...scores) : null;
    const rows = last.results.reduce((n, r) => n + r.rows, 0);
    const evidence: Evidence[] = added.map((x) =>
      toEvidence(x, tool, last.leadId, topScore),
    );
    const step: Step = {
      tool,
      argsKey: last.argsKey,
      rows,
      topScore,
      newLabels: added.map((x) => x.label),
      leadId: last.leadId,
    };
    const leadIndex = s.leads.findIndex((l) => l.id === last.leadId) + 1;
    t.step(
      "research",
      last.strategy,
      last.started,
      rows,
      `lead ${leadIndex}; ${added.length} new`,
    );
    emit(config, {
      iteration: s.iteration,
      max_iter: maxIter,
      lead_index: leadIndex,
      leads: s.leads.length,
    });
    return { evidence, steps: [step], go: "reflect" };
  };

  const observe = (
    s: ResearchStateType,
    config: LangGraphRunnableConfig,
  ): Update => {
    if (s.path === "research") return observeResearch(s, config);
    if (s.path === "broad") {
      const stop = t.broadObserve();
      if (stop?.kind === "not_found") {
        return { notFoundReason: stop.reason, go: "not_found" };
      }
    }
    return { go: "reflect" };
  };

  // ---- reflect ----

  /** The leads that stayed open, or closed with no evidence: what was not found. */
  const unfound = (leads: Lead[], evidence: Evidence[]): string[] =>
    leads
      .filter(
        (l) =>
          l.status === "open" ||
          (l.status === "dropped" && !evidence.some((e) => e.leadId === l.id)),
      )
      .map((l) => l.text);

  const endLoop = (
    s: ResearchStateType,
    done: Done,
    leads: Lead[],
    to: Go,
  ): Update => {
    const meetings = new Set(s.evidence.map((e) => e.meetingId)).size;
    t.trail = {
      iterations: s.iteration,
      max_iter: maxIter,
      meetings,
      searches: s.steps.length,
      done,
      open_leads: done === "enough" ? [] : unfound(leads, s.evidence),
    };
    if (to === "synthesize") {
      const ranked = t.sources.all().filter((x) => x.kind !== "folder");
      g.jobs = [
        {
          ranked,
          synth: true,
          focus: researchFocus(leads),
        },
      ];
      g.merge = false;
    }
    const reason = REASON_OF[done] ?? "no_sources";
    return to === "not_found"
      ? { leads, done, notFoundReason: reason, go: "not_found" }
      : { leads, done, go: to };
  };

  /** What the answer call is told to cover (11.9.5, node `synthesize`). */
  const researchFocus = (leads: Lead[]): string => {
    const parts = leads.filter((l) => l.origin === "prior_answer");
    const base =
      "answer with the reasons, changes or facts that the sources show; one bullet for each, from every meeting that tells one, with the date of the meeting";
    return parts.length > 1
      ? `${base}. The question has ${parts.length} parts: ${parts.map((p, i) => `${i + 1}) ${p.text}`).join("; ")}`
      : base;
  };

  const reflectResearch = async (
    s: ResearchStateType,
    config: LangGraphRunnableConfig,
  ): Promise<Update> => {
    // The first question asked for the open items: a list answers it.
    const last = g.last;
    if (
      last?.strategy === "list_open" &&
      s.leads.find((l) => l.id === last.leadId)?.list &&
      t.blockResult()
    ) {
      return endLoop(s, "enough", s.leads, "blocks");
    }
    // A lead at its cap of acts closes.
    const leads = s.leads.map((l) =>
      l.status === "open" && l.acts >= PER_LEAD_ACTS
        ? ({ ...l, status: "dropped" } as Lead)
        : l,
    );
    const hasEvidence = s.evidence.length > 0;
    const stop = stopRule({
      t,
      iteration: s.iteration,
      maxIter,
      leads,
      steps: s.steps,
      evidenceCount: s.evidence.length,
    });
    if (stop)
      return endLoop(s, stop, leads, hasEvidence ? "synthesize" : "not_found");

    // The lead that the last `act` worked on, else the first open lead.
    const lead = (leads.find(
      (l) => l.id === g.last?.leadId && l.status === "open",
    ) ?? leads.find((l) => l.status === "open")) as Lead;
    let decision: { next: ReflectNext; query: string } | null = null;
    // No call ran in this turn (a lead closed): nothing new to judge.
    if (reflectOn && g.last) {
      emit(config, {
        iteration: s.iteration,
        max_iter: maxIter,
        lead_index: leads.indexOf(lead) + 1,
        leads: leads.length,
      });
      const started = Date.now();
      const r = await reflectCall(t, lead, s.evidence, [
        ...g.loop.usedBy(lead.id),
      ]);
      t.step("research", `reflect:${r?.next ?? "stop"}`, started, null, null);
      decision = r;
    }
    // Rule 7: reflect said stop (or failed: an error means `stop`). A lead with
    // no evidence does not close because the model says so: its other
    // strategies still run (code owns the loop). With evidence, `stop` ends
    // the loop when no other open lead lacks evidence; else it closes this lead
    // and the next lead runs.
    const stopSaid =
      reflectOn && g.last && (decision === null || decision.next === "stop");
    const leadHasEvidence = s.evidence.some((e) => e.leadId === lead.id);
    let closeLead = decision?.next === "next_lead";
    if (stopSaid && leadHasEvidence) {
      const waiting = leads.some(
        (l) =>
          l.status === "open" &&
          l.id !== lead.id &&
          !s.evidence.some((e) => e.leadId === l.id),
      );
      if (!waiting) return endLoop(s, "enough", leads, "synthesize");
      closeLead = true;
    }
    if (!leadHasEvidence) {
      closeLead = false;
      if (decision?.next === "next_lead" || stopSaid) decision = null;
    }
    const nextLeads = closeLead
      ? leads.map((l) =>
          l.id === lead.id ? ({ ...l, status: "done" } as Lead) : l,
        )
      : leads;
    g.loop.requested = closeLead ? null : decision;
    return {
      leads: nextLeads,
      next: closeLead ? "next_lead" : (decision?.next ?? null),
      go: "act",
    };
  };

  const reflect = async (
    s: ResearchStateType,
    config: LangGraphRunnableConfig,
  ): Promise<Update> => {
    if (s.path === "research") return reflectResearch(s, config);
    if (s.path === "broad") return { go: "synthesize" };
    if (!t.loopDone(s.iteration)) return { go: "act" };
    if (t.blockKind()) return { go: "blocks" };
    // The evidence spans several meetings: a story, not a fact (11.9.17).
    if (t.spreadEscalation()) {
      t.mode = "research";
      return { mode: "research", maxIter, ...planResearch() };
    }
    const floor = await t.floorStage();
    if (floor.kind === "exit") return leave(floor.exit, "reflect");
    g.jobs = [floor.job];
    g.merge = false;
    return { go: "synthesize" };
  };

  // ---- blocks, synthesize, cite_check, not_found ----

  const blocks = (s: ResearchStateType): Update => {
    if (s.path === "research") {
      return { result: t.researchBlocks(), go: "end" };
    }
    if (t.blockKind() === "status_text") {
      // The summaries answer; the counts stay as the last block.
      g.statusBlocks = t.statusBlocks();
      t.beginBroad();
      return { path: "broad", go: "act" };
    }
    return { result: t.blocksResult(), go: "end" };
  };

  const synthesize = async (s: ResearchStateType): Promise<Update> => {
    if (!g.jobs) {
      const planned = await t.broadJobs();
      if (planned.kind === "exit") {
        return leave(planned.exit, "synthesize");
      }
      g.jobs = planned.jobs;
      g.merge = planned.merge;
    }
    const job = g.jobs[s.jobIndex] as AnswerJob;
    g.run ??= t.newRun();
    const a = await t.answerAttempt(job, g.run);
    if (a.kind === "draft") {
      g.draft = a.parsed;
      return { attempts: g.run.attempt, go: "cite_check" };
    }
    if (a.kind === "retry") {
      return { attempts: g.run.attempt, go: "synthesize" };
    }
    return jobEnd(a.exit, s, "synthesize");
  };

  /** The last node before the end (11.9.7 point 3). No edge skips it. */
  const citeCheck = async (s: ResearchStateType): Promise<Update> => {
    // A map-reduce that ended in `synthesize` comes here with its result.
    if (s.result) return { go: "end" };
    const jobs = g.jobs as AnswerJob[];
    const c = await t.checkAttempt(
      jobs[s.jobIndex] as AnswerJob,
      g.run as AnswerRun,
      g.draft as AnswerSentence[],
    );
    if (c.kind === "retry") return { go: "synthesize" };
    return jobEnd(c.exit, s, "cite_check");
  };

  const notFound = (s: ResearchStateType): Update => {
    const reason = s.notFoundReason as Parameters<Turn["notFound"]>[0];
    return {
      result: settle({ kind: "result", result: t.notFound(reason) }),
      go: "end",
    };
  };

  const route = (s: ResearchStateType): string => s.go;
  /** Edges that can fan out: the workers are Send objects, one for each item or meeting. */
  const routeOrFan = (s: ResearchStateType): string | Send[] =>
    s.go === "fanout" ? g.sends : s.go;

  return new StateGraph(ResearchState)
    .addNode("scope", scope)
    .addNode("plan", plan)
    .addNode("scout", scout)
    .addNode("worker", worker)
    .addNode("join", join)
    .addNode("act", act)
    .addNode("observe", observe)
    .addNode("reflect", reflect)
    .addNode("blocks", blocks)
    .addNode("synthesize", synthesize)
    .addNode("cite_check", citeCheck)
    .addNode("not_found", notFound)
    .addEdge(START, "scope")
    .addConditionalEdges("scope", route, { plan: "plan", end: END })
    .addConditionalEdges("plan", routeOrFan, {
      act: "act",
      scout: "scout",
      worker: "worker",
      not_found: "not_found",
      end: END,
    })
    .addConditionalEdges("scout", routeOrFan, { act: "act", worker: "worker" })
    .addEdge("worker", "join")
    .addConditionalEdges("join", route, {
      act: "act",
      synthesize: "synthesize",
      end: END,
    })
    .addConditionalEdges("act", route, {
      observe: "observe",
      not_found: "not_found",
    })
    .addConditionalEdges("observe", route, {
      reflect: "reflect",
      not_found: "not_found",
    })
    .addConditionalEdges("reflect", routeOrFan, {
      act: "act",
      scout: "scout",
      worker: "worker",
      blocks: "blocks",
      synthesize: "synthesize",
      cite_check: "cite_check",
      not_found: "not_found",
    })
    .addConditionalEdges("blocks", route, { act: "act", end: END })
    .addConditionalEdges("synthesize", route, {
      cite_check: "cite_check",
      synthesize: "synthesize",
      not_found: "not_found",
    })
    .addConditionalEdges("cite_check", route, {
      synthesize: "synthesize",
      not_found: "not_found",
      end: END,
    })
    .addEdge("not_found", END)
    .compile(
      checkpoint
        ? {
            checkpointer: t.input.onCheckpointMs
              ? new TimedSaver(t.input.db, t.input.onCheckpointMs)
              : new NodeSqliteSaver(t.input.db),
          }
        : {},
    );
}

export type CompiledResearch = ReturnType<typeof buildResearchGraph>;
