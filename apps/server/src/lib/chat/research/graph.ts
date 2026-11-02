import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { END, START, StateGraph } from "@langchain/langgraph";
import type { ChatBlock, ChatProgress } from "@openstyle/validations";
import { NodeSqliteSaver } from "../../llm/workflow/checkpoint-saver.js";
import type { AnswerSentence } from "../cites.js";
import type { ReflectNext } from "../prompts.js";
import {
  type AnswerJob,
  type AnswerRun,
  type Exit,
  SCORE_FLOOR,
  type Turn,
} from "../turn.js";
import type { TurnResult } from "../types.js";
import {
  chooseCalls,
  type Done,
  type Evidence,
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

  const plan = async (s: ResearchStateType): Promise<Update> => {
    if (s.mode === "research") {
      t.beginResearch();
      return { leads: seedLeads(t), path: "research", go: "act" };
    }
    const r = await t.route();
    if (r.kind === "exit") {
      return r.exit.kind === "result"
        ? { result: r.exit, go: "end" }
        : { notFoundReason: r.exit.reason, go: "not_found" };
    }
    return { path: r.kind === "broad" ? "broad" : "tools", go: "act" };
  };

  // ---- act ----

  const actResearch = async (
    s: ResearchStateType,
    config: LangGraphRunnableConfig,
  ): Promise<Update> => {
    g.last = null;
    const leads = s.leads;
    // The first open lead that still has a call to make.
    for (const [i, lead] of leads.entries()) {
      if (lead.status !== "open") continue;
      if (lead.acts >= PER_LEAD_ACTS) {
        return { leads: [{ ...lead, status: "dropped" }], go: "observe" };
      }
      const pick = chooseCalls(t, g.loop, lead, s.evidence);
      if (!pick) {
        // Every strategy of this lead ran: the lead closes.
        return { leads: [{ ...lead, status: "dropped" }], go: "observe" };
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
        leads: [{ ...lead, acts: lead.acts + 1 }],
        iteration: s.iteration + 1,
        go: "observe",
      };
    }
    return { go: "observe" };
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
    if (g.last?.strategy === "list_open" && t.blockResult()) {
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

    const lead = leads.find((l) => l.status === "open") as Lead;
    let decision: { next: ReflectNext; query: string } | null = null;
    // No call ran in this turn (a lead closed): nothing new to judge.
    if (reflectOn && g.last) {
      const idx = leads.indexOf(lead) + 1;
      emit(config, {
        iteration: s.iteration,
        max_iter: maxIter,
        lead_index: idx,
        leads: leads.length,
      });
      const started = Date.now();
      const r = await reflectCall(t, lead, s.evidence, [
        ...g.loop.usedBy(lead.id),
      ]);
      t.step("research", `reflect:${r?.next ?? "stop"}`, started, null, null);
      decision = r;
    }
    // Rule 7: reflect said stop (or failed: an error means `stop`) and the
    // evidence is not empty.
    if (
      reflectOn &&
      g.last &&
      (decision === null || decision.next === "stop")
    ) {
      if (hasEvidence) return endLoop(s, "enough", leads, "synthesize");
    }
    // A lead with no evidence does not close because the model says so: its
    // other strategies still run (code owns the loop).
    if (
      decision?.next === "next_lead" &&
      !s.evidence.some((e) => e.leadId === lead.id)
    ) {
      decision = null;
    }
    let nextLeads = leads;
    if (decision?.next === "next_lead") {
      nextLeads = leads.map((l) =>
        l.id === lead.id ? ({ ...l, status: "done" } as Lead) : l,
      );
    }
    g.loop.requested = decision;
    return { leads: nextLeads, next: decision?.next ?? null, go: "act" };
  };

  const reflect = async (
    s: ResearchStateType,
    config: LangGraphRunnableConfig,
  ): Promise<Update> => {
    if (s.path === "research") return reflectResearch(s, config);
    if (s.path === "broad") return { go: "synthesize" };
    if (!t.loopDone(s.iteration)) return { go: "act" };
    if (t.blockKind()) return { go: "blocks" };
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

  return new StateGraph(ResearchState)
    .addNode("scope", scope)
    .addNode("plan", plan)
    .addNode("act", act)
    .addNode("observe", observe)
    .addNode("reflect", reflect)
    .addNode("blocks", blocks)
    .addNode("synthesize", synthesize)
    .addNode("cite_check", citeCheck)
    .addNode("not_found", notFound)
    .addEdge(START, "scope")
    .addConditionalEdges("scope", route, { plan: "plan", end: END })
    .addConditionalEdges("plan", route, {
      act: "act",
      not_found: "not_found",
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
    .addConditionalEdges("reflect", route, {
      act: "act",
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
