import { END, START, StateGraph } from "@langchain/langgraph";
import type { ChatBlock } from "@openstyle/validations";
import { NodeSqliteSaver } from "../../llm/workflow/checkpoint-saver.js";
import type { AnswerSentence } from "../cites.js";
import type { AnswerJob, AnswerRun, Exit, Turn } from "../turn.js";
import type { TurnResult } from "../types.js";
import { type Next, ResearchState, type ResearchStateType } from "./state.js";

// The Ask turn as a LangGraph graph (specs/meeting-chat-agent.md 11.9.3). The
// nodes call the stage methods of `Turn`. Code owns every edge: a node returns
// the key of the next node in `next`, and the conditional edge reads it. This
// module imports LangGraph statically; `run.ts` loads it with a dynamic
// `import()`, after the tracing variables are removed, as the Enhance graph does.

type Update = Partial<ResearchStateType>;

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
  const leave = (exit: Exit, from: Next): Update =>
    exit.kind === "not_found"
      ? { notFoundReason: exit.reason, next: "not_found" }
      : {
          result: settle(exit),
          next: from === "cite_check" ? "end" : "cite_check",
        };

  /** The end of one answer job. A map-reduce has several jobs: the slices. */
  const jobEnd = (exit: Exit, s: ResearchStateType, from: Next): Update => {
    const jobs = g.jobs as AnswerJob[];
    if (!g.merge) return leave(exit, from);
    g.partials.push(t.resolve(exit));
    if (s.jobIndex < jobs.length - 1) {
      const between = t.betweenSlices(g.partials);
      if (between === null) {
        g.run = null;
        return { jobIndex: s.jobIndex + 1, attempts: 0, next: "synthesize" };
      }
      if (between !== "break") return leave(between, from);
    }
    return leave(t.mergeSlices(g.partials), from);
  };

  const scope = (): Update => {
    t.begin();
    const gate = t.clarify();
    return gate ? { result: gate, next: "end" } : { next: "plan" };
  };

  const plan = async (): Promise<Update> => {
    const r = await t.route();
    if (r.kind === "exit") {
      return r.exit.kind === "result"
        ? { result: r.exit, next: "end" }
        : { notFoundReason: r.exit.reason, next: "not_found" };
    }
    return { path: r.kind === "broad" ? "broad" : "tools", next: "act" };
  };

  const act = async (s: ResearchStateType): Promise<Update> => {
    if (s.path === "broad") {
      await t.broadGather();
      return { next: "observe" };
    }
    const stop = await t.actRound(s.iteration + 1);
    if (stop?.kind === "not_found") {
      return { notFoundReason: stop.reason, next: "not_found" };
    }
    return { iteration: s.iteration + 1, next: "observe" };
  };

  const observe = (s: ResearchStateType): Update => {
    if (s.path === "broad") {
      const stop = t.broadObserve();
      if (stop?.kind === "not_found") {
        return { notFoundReason: stop.reason, next: "not_found" };
      }
    }
    return { next: "reflect" };
  };

  /** Fast mode: code only (11.9.6). Stay in the loop, or leave it. */
  const reflect = async (s: ResearchStateType): Promise<Update> => {
    if (s.path === "broad") return { next: "synthesize" };
    if (!t.loopDone(s.iteration)) return { next: "act" };
    if (t.blockKind()) return { next: "blocks" };
    const floor = await t.floorStage();
    if (floor.kind === "exit") return leave(floor.exit, "reflect");
    g.jobs = [floor.job];
    g.merge = false;
    return { next: "synthesize" };
  };

  const blocks = (): Update => {
    if (t.blockKind() === "status_text") {
      // The summaries answer; the counts stay as the last block.
      g.statusBlocks = t.statusBlocks();
      t.beginBroad();
      return { path: "broad", next: "act" };
    }
    return { result: t.blocksResult(), next: "end" };
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
      return { attempts: g.run.attempt, next: "cite_check" };
    }
    if (a.kind === "retry") {
      return { attempts: g.run.attempt, next: "synthesize" };
    }
    return jobEnd(a.exit, s, "synthesize");
  };

  /** The last node before the end (11.9.7 point 3). No edge skips it. */
  const citeCheck = async (s: ResearchStateType): Promise<Update> => {
    // A map-reduce that ended in `synthesize` comes here with its result.
    if (s.result) return { next: "end" };
    const jobs = g.jobs as AnswerJob[];
    const c = await t.checkAttempt(
      jobs[s.jobIndex] as AnswerJob,
      g.run as AnswerRun,
      g.draft as AnswerSentence[],
    );
    if (c.kind === "retry") return { next: "synthesize" };
    return jobEnd(c.exit, s, "cite_check");
  };

  const notFound = (s: ResearchStateType): Update => {
    const reason = s.notFoundReason as Parameters<Turn["notFound"]>[0];
    return {
      result: settle({ kind: "result", result: t.notFound(reason) }),
      next: "end",
    };
  };

  const route = (s: ResearchStateType): string => s.next;

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
      checkpoint ? { checkpointer: new NodeSqliteSaver(t.input.db) } : {},
    );
}

export type CompiledResearch = ReturnType<typeof buildResearchGraph>;
