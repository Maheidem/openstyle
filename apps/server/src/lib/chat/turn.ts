import type {
  ChatBlock,
  ChatCite,
  ChatProgress,
  ChatResearch,
  ChatTrace,
  ChatTraceStep,
} from "@openstyle/validations";
import { estimatePromptTokens } from "../llm/token-budget.js";
import { rerankPairs } from "../mlx-rerank/client.js";
import {
  buildChoices,
  type Choices,
  DIG_TOOL_NAME,
  digToolDef,
  nativeToolDefs,
  validateNativeCall,
  visibleToolNames,
} from "./choices.js";
import {
  type AnswerSentence,
  assignMissingCites,
  checkAnswer,
  citeFromSentences,
  dropToldSentences,
  failureNote,
  pickCiteTimes,
  refineCiteTimes,
  repeatedEarlierAnswer,
  sentencesOf,
  stripCiteMarkers,
  tidyCites,
  withoutTold,
} from "./cites.js";
import { detectClarify, isGlobalQuestion } from "./clarify.js";
import {
  assembleAnswerInput,
  compactHistory,
  type HistoryTurn,
  halveBudget,
  renderHistory,
  renderSource,
} from "./context.js";
import { mapNotes } from "./mapreduce.js";
import type { ChatTurnInput } from "./pipeline.js";
import {
  asksDecisions,
  asksElaboration,
  asksForCount,
  asksNextSteps,
  asksOverview,
  asksSynthesis,
  defaultSlots,
  followUpQuery,
  isDependentFollowUp,
  mentionPhrase,
  planFor,
  plannedCalls,
  refineIntent,
  slotSystem,
  slotZod,
} from "./plan.js";
import {
  ANSWER_MAX_TOKENS,
  ANSWER_SCHEMA,
  ANSWER_SYSTEM,
  answerUser,
  asksForList,
  asksForStatus,
  asksWho,
  isoDay,
  looksLikeWrite,
  NATIVE_MAX_TOKENS,
  nativeSystem,
  QUERY_SCHEMA,
  QUERY_SYSTEM,
  queryUser,
  ROUTER_MAX_TOKENS,
  ROUTER_SCHEMA,
  ROUTER_SYSTEM,
  SLOT_MAX_TOKENS,
  SYNTH_MAX_TOKENS,
  SYNTH_SCHEMA,
  SYNTH_SYSTEM,
} from "./prompts.js";
import { proposalFor } from "./proposals.js";
import { countScopeMeetings, nextWider } from "./store.js";
import { countMentions, runTool, summaryDigest } from "./tools.js";
import {
  type Intent,
  type Source,
  SourceMap,
  type ToolContext,
  type ToolResult,
  type TurnResult,
  type TurnScope,
} from "./types.js";

// The stages of one Ask turn (specs/meeting-chat-agent.md 2.2 and 11.9.11,
// step M1). `Turn` holds the state of one turn; each method is one stage and
// returns what the next stage needs, or an `Exit`. The graph nodes of
// `research/` call these methods (11.9.5). The code of every stage is the code
// of the former `runChatTurn`, in the same order, with the same model calls.

/** A runaway guard: no turn makes more LLM calls than this (spec 2.2). */
export const HARD_CAP_CALLS = 16;
/** The thin-hit rule: fewer search rows than this adds the summary. */
const THIN_ROWS = 3;
/**
 * The not-found floor (spec 6.3 point 1): when the reranker gives the best hit
 * a score below this, the question has no source. The number comes from the
 * P1 eval: the best hit of 33 not-found questions scored 0.00 to 0.31 (two
 * 0.92 and 0.98), the best hit of 76 answerable questions scored 0.55 to 1.00
 * (one 0.13). 0.5 sits in the gap. 0 turns the floor off.
 */
export const SCORE_FLOOR = 0.5;
/**
 * A rewritten search replaces a weak first search only when its best hit
 * scores at least this. A small model writes loose words, and a hit just over
 * the floor (0.55 in the E2B eval) is another topic. A true cross-language
 * hit scored 0.98 (P1.1).
 */
export const REWRITE_SCORE = 0.8;
/** Nearest sources shown in a not_found block. */
const NEAREST = 3;
/** Cites kept for a block answer (list, count, status). */
const BLOCK_CITES = 50;

/** Tool name to the intent it stands for (trace and answer mode). */
const TOOL_INTENT: Record<string, Intent> = {
  search_chunks: "lookup",
  get_meeting_summary: "lookup",
  get_transcript_window: "who_said",
  list_action_items: "aggregate",
  list_people: "aggregate",
  list_meetings: "temporal",
  list_decisions_questions: "review",
  folder_status: "status",
  propose_action_item_change: "write",
  propose_retag: "write",
  propose_move: "write",
  propose_merge_people: "write",
};

/** Tools whose result is a block and not source text. */
const BLOCK_TOOLS = new Set([
  "list_action_items",
  "list_decisions_questions",
  "list_meetings",
  "folder_status",
]);

export interface Call {
  tool: string;
  args: unknown;
}

export type NotFoundReason = Extract<
  ChatBlock,
  { kind: "not_found" }
>["reason"];

/** How a stage ends the turn: a finished result, or a not_found reason. */
export type Exit =
  | { kind: "result"; result: TurnResult }
  | { kind: "not_found"; reason: NotFoundReason };

const done = (result: TurnResult): Exit => ({ kind: "result", result });
const miss = (reason: NotFoundReason): Exit => ({ kind: "not_found", reason });

/** One answer call and its cite check. `ranked` are the sources it may use. */
export interface AnswerJob {
  ranked: Source[];
  synth: boolean;
  focus: string | null;
}

/** The state of the attempts of one `AnswerJob`. */
export interface AnswerRun {
  attempt: number;
  budget: number;
  repair: string | null;
}

export type AttemptOut =
  | { kind: "draft"; parsed: AnswerSentence[] }
  | { kind: "retry" }
  | { kind: "exit"; exit: Exit };

export type CheckOut = { kind: "retry" } | { kind: "exit"; exit: Exit };

/** The jobs of a broad answer. `merge` is true for the date slices of a map-reduce. */
export interface BroadJobs {
  jobs: AnswerJob[];
  merge: boolean;
}

function isTimeout(signal: AbortSignal): boolean {
  const r = signal.reason as { name?: string } | undefined;
  return signal.aborted && r?.name === "TimeoutError";
}

function gatewayKind(e: unknown): string {
  const k = (e as { kind?: unknown })?.kind;
  return typeof k === "string" ? k : "";
}

export const wordsIn = (q: string): number =>
  q
    .trim()
    .split(/[\s,;:.?!]+/u)
    .filter(Boolean).length;

/** The plain text of an answer: the lead sentences, then one line for each bullet. */
export function answerContent(sentences: readonly AnswerSentence[]): string {
  const lead = sentences.filter((x) => !x.bullet).map((x) => x.text);
  const bullets = sentences.filter((x) => x.bullet).map((x) => `- ${x.text}`);
  return [lead.join(" "), ...bullets].filter(Boolean).join("\n");
}

/** The closed-choice lists for the native system text. */
function choiceLists(ch: Choices, write: boolean): string[] {
  const lines: string[] = [];
  if (ch.people.length)
    lines.push(
      `people: ${ch.people.map((p) => `${p.id}=${p.name}`).join("; ")}`,
    );
  if (ch.meetings.length)
    lines.push(
      `meetings: ${ch.meetings.map((m) => `${m.label}=${m.text}`).join("; ")}`,
    );
  if (write) {
    if (ch.items.length)
      lines.push(
        `items: ${ch.items.map((i) => `${i.label}="${i.text}"`).join("; ")}`,
      );
    if (ch.folders.length)
      lines.push(
        `folders: ${ch.folders.map((f) => `${f.id}=${f.name}`).join("; ")}`,
      );
  }
  return lines;
}

export class Turn {
  readonly input: ChatTurnInput;
  readonly t0 = Date.now();
  readonly todayMs: number;
  readonly turnScope: TurnScope;
  readonly sources = new SourceMap();
  readonly steps: ChatTraceStep[] = [];
  readonly toolCalls: TurnResult["toolCalls"] = [];
  readonly ctx: ToolContext;
  readonly turns: HistoryTurn[];
  readonly priorQuestions: string[];
  readonly priorTurns: { question: string; answer: string }[];
  readonly scopeMeetings: number;
  readonly historyText: string;
  readonly scopeLine: string;
  toldPrompt: string;
  told: string[];
  excludeTold: boolean;
  private readonly toldTexts: string[];
  readonly write: boolean;
  readonly plain: boolean;
  readonly skipNative: boolean;
  readonly summaryKind: "overview" | "decisions" | "steps" | null;
  readonly synthesis: boolean;

  /** Research mode (D21): set by the `scope` node. */
  mode: "fast" | "research" = "fast";
  /** What the research loop did, for the trail line. Set when the loop ends. */
  trail: ChatResearch | null = null;

  router: ChatTrace["router"] = "skipped";
  intent: Intent | null = null;
  proposal: TurnResult["proposal"] = null;
  sourcesDropped: string[] = [];
  historyDropped = 0;
  sourceTokens = 0;

  choices!: Choices;
  first: Call | null = null;
  fallbackCalls: Call[] = [];
  /** The tool results of the round loop. */
  readonly results: ToolResult[] = [];
  /** The sources of a broad answer, in the order of the prompt. */
  ranked: Source[] = [];
  /** The weak search that the rewrite step and the floor look at. */
  searched: ToolResult | undefined;

  // Broad answers (11.7, 11.8 B).
  private seen = new Set<string>();
  private seenMeetings = new Set<string>();
  private digestIds: string[] | undefined;
  private digestLabels: string[] = [];
  private mapped: { from: string; to: string; n: number } | null = null;
  private mappedLabels = new Set<string>();

  constructor(input: ChatTurnInput) {
    this.input = input;
    const { db, scope, question, settings } = input;
    this.todayMs = input.now ?? this.t0;
    this.turnScope = {
      kind: scope.kind,
      id: scope.kind === "all" ? null : scope.id,
    };
    this.ctx = {
      db,
      scope: this.turnScope,
      sources: this.sources,
      todayMs: this.todayMs,
      k: settings.k,
      rerank: true,
      ...(input.signal ? { signal: input.signal } : {}),
    };
    this.turns = compactHistory(
      input.history.map((m) => ({
        role: m.role,
        content: m.content,
        blocks: m.blocks,
        cites: m.cites,
      })),
    );
    this.priorQuestions = this.turns.map((t) => t.question);
    this.priorTurns = this.turns.map((t) => ({
      question: t.question,
      answer: t.answer,
    }));
    this.scopeMeetings = countScopeMeetings(db, this.turnScope);
    this.historyText = renderHistory(this.turns.slice(-2));
    this.scopeLine =
      scope.kind === "meeting"
        ? "one meeting"
        : scope.kind === "folder"
          ? "one project folder"
          : "all meetings";

    // Stage 4 inputs: the facts the thread told already.
    const toldTexts = input.history
      .filter((m) => m.role === "assistant" && m.content.trim() !== "")
      .slice(-3)
      .map((m) => m.content);
    this.toldTexts = toldTexts;
    const prevQuestion = this.turns.at(-1)?.question ?? null;
    // A broad question after a broad answer, or "more details": the thread
    // already told some facts. They are not told again (owner report 2026-11-01).
    this.excludeTold =
      toldTexts.length > 0 &&
      (asksElaboration(question) ||
        (prevQuestion !== null && asksSynthesis(prevQuestion)));
    this.told = this.excludeTold ? toldTexts.flatMap(sentencesOf) : [];
    this.toldPrompt = this.excludeTold
      ? toldTexts
          .slice(-2)
          .map((t) => (t.length > 600 ? `${t.slice(0, 600)}...` : t))
          .join("\n")
      : "";

    this.write = looksLikeWrite(question);
    this.plain =
      !this.write &&
      !asksForList(question) &&
      !asksForCount(question) &&
      !asksForStatus(question);
    // A plain follow-up ("and when is that due?") gets no tool call from the
    // native turn: all 10 follow-ups of the eval and 13 of 20 follow-ups and
    // long-thread turns on E4B and E2B returned text, after 650 to 850 ms on
    // the Mac. Code makes the search call, with the earlier turn in the query.
    this.skipNative =
      this.plain && this.turns.length > 0 && isDependentFollowUp(question);
    // "What was this meeting about?", "What has been decided?" and "What are the
    // next steps?" read the summary (P1.2). Code makes the call: a search for
    // them found chunks of one fact, or nothing. A meeting with no summary falls
    // back to the search (the rounds below).
    this.summaryKind =
      !this.write && this.turnScope.kind === "meeting" && this.turnScope.id
        ? asksOverview(question)
          ? "overview"
          : asksNextSteps(question)
            ? "steps"
            : asksDecisions(question)
              ? "decisions"
              : null
        : null;
    // Broad questions: overview, details, history, story, onboarding. Code
    // decides (owner decision 2026-11-01).
    const lastMessage = input.history.at(-1);
    const prevNotFound =
      lastMessage?.role === "assistant" &&
      lastMessage.blocks.some((b) => b.kind === "not_found");
    this.synthesis =
      !this.write &&
      (asksSynthesis(question) ||
        asksOverview(question) ||
        // "Really?", "Nothing?" after a not found: the user wants what the sources do say.
        (prevNotFound &&
          isDependentFollowUp(question) &&
          wordsIn(question) <= 3));
  }

  // ---- Helpers shared by all stages. ----

  step(
    stage: ChatTraceStep["stage"],
    name: string,
    started: number,
    rows: number | null = null,
    note: string | null = null,
  ): void {
    this.steps.push({ stage, name, rows, ms: Date.now() - started, note });
  }

  finish(blocks: ChatBlock[], cites: ChatCite[], content: string): TurnResult {
    const { llm, scope } = this.input;
    return {
      blocks,
      content,
      cites,
      trace: {
        scope,
        intent: this.intent,
        router: this.router,
        steps: this.steps,
        calls: llm.calls(),
        sources_dropped: this.sourcesDropped,
        history_turns_dropped: this.historyDropped,
        source_tokens: this.sourceTokens,
        ...(this.trail ? { research: this.trail } : {}),
      },
      proposal: this.proposal,
      toolCalls: this.toolCalls,
      modelId: llm.modelId,
      provider: llm.provider,
      runId: llm.runId,
      ms: Date.now() - this.t0,
    };
  }

  progress(p: ChatProgress): void {
    this.input.onProgress?.(p);
  }

  nearest(): ChatCite[] {
    return this.sources
      .all()
      .filter((s) => s.kind !== "item" && s.kind !== "folder")
      .slice(0, NEAREST)
      .map((s) => this.sources.toCite(s.label))
      .filter((c): c is ChatCite => c !== null);
  }

  notFound(reason: NotFoundReason): TurnResult {
    const { db, scope, settings } = this.input;
    return this.finish(
      [
        {
          kind: "not_found",
          scope,
          reason,
          nearest: this.nearest(),
          searched: this.scopeMeetings,
          wider:
            reason === "nothing_new"
              ? null
              : nextWider(db, scope, settings.searchWider),
        },
      ],
      [],
      "",
    );
  }

  /** The turn result of an exit. */
  resolve(exit: Exit): TurnResult {
    return exit.kind === "result" ? exit.result : this.notFound(exit.reason);
  }

  /** Deadline and call cap end the turn with a block. A client abort throws. */
  stopReason = (): NotFoundReason | null => {
    const { signal, llm } = this.input;
    if (signal.aborted) {
      if (isTimeout(signal)) return "deadline";
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException("The turn was cancelled.", "AbortError");
    }
    if (llm.calls() >= HARD_CAP_CALLS) return "call_cap";
    return null;
  };

  private stopOrNull(): NotFoundReason | "cancelled" | null {
    try {
      return this.stopReason();
    } catch {
      return "cancelled";
    }
  }

  // ---- Stage 0a: a clarifying question (D20). Code only, no LLM call. ----

  begin(): void {
    this.progress({ stage: "searching", count: this.scopeMeetings });
  }

  clarify(): Exit | null {
    const { settings, db, question, history } = this.input;
    if (settings.clarify && !this.input.noClarify) {
      const started = Date.now();
      const lastAssistant = history.findLast((m) => m.role === "assistant");
      const block = detectClarify({
        db,
        scope: this.turnScope,
        question,
        lastAssistantBlocks: lastAssistant?.blocks ?? [],
        hasEarlierQuestion: history.some((m) => m.role === "user"),
      });
      if (block) {
        this.step(
          "gate",
          `clarify:${block.why}`,
          started,
          block.options.length,
        );
        return done(this.finish([block], [], ""));
      }
    }
    return null;
  }

  /** Stage 0b: prefetch. The closed choices are built by code (spec 2.3). */
  prepare(): void {
    this.choices = buildChoices(
      this.input.db,
      this.turnScope,
      this.input.question,
      this.priorQuestions,
      this.todayMs,
    );
  }

  // ---- Stage 1+2: the route. ----

  /**
   * Stage 0b and the route. Returns an exit (a write question, a count, a
   * deadline), `broad` (the synthesis path) or `tools` (the round loop).
   */
  async route(): Promise<
    | { kind: "exit"; exit: Exit }
    | { kind: "broad" }
    | { kind: "tools" }
    | { kind: "dig" }
  > {
    const { db, question, llm, signal, settings } = this.input;
    const { turnScope, todayMs, turns } = this;
    this.prepare();
    const choices = this.choices;
    if (this.synthesis) {
      this.beginBroad();
      return { kind: "broad" };
    }

    const { write, plain, summaryKind } = this;
    if (summaryKind && turnScope.id) {
      const started = Date.now();
      this.router = "default";
      this.intent = "lookup";
      this.first = {
        tool: "get_meeting_summary",
        args: { meeting_id: turnScope.id },
      };
      this.step("route", `rules:${summaryKind}`, started);
    }
    if (settings.nativeTools && !this.skipNative && !this.first) {
      const started = Date.now();
      const names = visibleToolNames(turnScope.kind, write);
      // The research tool (11.9.17): offered when research mode is on.
      const offerDig = settings.research && !write;
      try {
        const r = await llm.nativeCall({
          system: nativeSystem({
            todayMs,
            scopeLine: this.scopeLine,
            lists: choiceLists(choices, write),
            history: this.historyText,
            write,
            dig: offerDig,
          }),
          messages: [{ role: "user", content: question }],
          tools: [
            ...nativeToolDefs(choices, names),
            ...(offerDig ? [digToolDef()] : []),
          ],
          maxOutputTokens: NATIVE_MAX_TOKENS,
          unitKey: "route/native",
        });
        if (r.kind === "call" && r.name === DIG_TOOL_NAME && offerDig) {
          // The model says the question needs digging: the graph switches to research.
          this.step("route", "native:dig_deeper", started);
          return { kind: "dig" };
        }
        if (r.kind === "call") {
          const v = validateNativeCall(r, {
            choices,
            scope: turnScope,
            allowed: names,
            question,
            todayMs,
          });
          if (v.ok) {
            this.first = { tool: v.args.tool, args: v.args.args };
            this.router = "native";
            this.step("route", `native:${v.args.tool}`, started);
          } else {
            this.step("route", "native:invalid", started, null, v.reason);
          }
        } else {
          this.step("route", "native:none", started, null, "no tool call");
        }
      } catch (e) {
        if (signal.aborted) {
          const why = this.stopReason();
          if (why) return { kind: "exit", exit: miss(why) };
        }
        // A provider error here is not final: the structured router may work.
        this.step(
          "route",
          "native:error",
          started,
          null,
          gatewayKind(e) || "error",
        );
      }
    }
    {
      const why = this.stopReason();
      if (why) return { kind: "exit", exit: miss(why) };
    }

    if (!this.first && plain) {
      // The cheap route (P1.1): a question that asks for no list, no count, no
      // status and no change reads text. Code makes the search call. No router
      // call and no slot call run (two model calls less on the slow path).
      const started = Date.now();
      this.router = "default";
      this.intent = "lookup";
      this.first = {
        tool: "search_chunks",
        args: { query: question.slice(0, 200) },
      };
      this.step("route", "rules:lookup", started);
    }
    if (!this.first) {
      const started = Date.now();
      this.router = "structured";
      let routed: Intent = "lookup";
      try {
        const prev = turns.at(-1)?.question ?? null;
        const r = await llm.structured({
          step: "chatRoute",
          unitKey: "route/intent",
          schema: ROUTER_SCHEMA,
          system: ROUTER_SYSTEM,
          messages: [
            {
              role: "user",
              content: prev
                ? `Previous question: ${prev}\nQuestion: ${question}`
                : `Question: ${question}`,
            },
          ],
          maxOutputTokens: ROUTER_MAX_TOKENS,
        });
        routed = refineIntent(
          question,
          r.object.intent === "other" ? "lookup" : r.object.intent,
          todayMs,
        );
        this.step("route", `intent:${r.object.intent}`, started);
      } catch (e) {
        if (signal.aborted) {
          const why = this.stopReason();
          if (why) return { kind: "exit", exit: miss(why) };
        }
        this.router = "default";
        this.step(
          "route",
          "intent:default",
          started,
          null,
          gatewayKind(e) || "error",
        );
      }
      this.intent = routed;
      // Dates: a temporal question with no date range reads text, like a lookup.
      const slotsStarted = Date.now();
      let slots = defaultSlots(question, [], routed);
      const zod = slotZod(routed, choices);
      if (zod && !this.stopOrNull()) {
        try {
          const r = await llm.structured({
            step: "chatSlots",
            unitKey: "route/slots",
            schema: { name: "chat_slots", version: 1, zod },
            system: slotSystem(routed, choices, isoDay(todayMs)),
            messages: [
              {
                role: "user",
                content: `${this.historyText ? `Earlier: ${this.historyText}\n` : ""}Question: ${question}`,
              },
            ],
            maxOutputTokens: SLOT_MAX_TOKENS,
          });
          slots = { ...slots, ...(r.object as object) };
          this.step("slots", routed, slotsStarted);
        } catch (e) {
          this.step(
            "slots",
            "default",
            slotsStarted,
            null,
            gatewayKind(e) || "error",
          );
        }
      } else {
        this.step("slots", "default", slotsStarted);
      }
      this.fallbackCalls = plannedCalls(
        routed,
        turnScope,
        slots,
        choices,
        question,
        todayMs,
        1,
      );
      this.first = this.fallbackCalls[0] ?? {
        tool: "search_chunks",
        args: { query: question },
      };
    }

    this.intent ??= TOOL_INTENT[this.first.tool] ?? "lookup";

    // A list tool needs a question that asks for a list or a count. A question
    // about one topic reads text (P1 eval, lookup and long-thread questions).
    const LIST_TOOLS = ["list_action_items", "list_decisions_questions"];
    if (
      LIST_TOOLS.includes(this.first.tool) &&
      !asksForList(question) &&
      !asksForCount(question)
    ) {
      this.first = {
        tool: "search_chunks",
        args: { query: question.slice(0, 200) },
      };
      this.fallbackCalls = [];
      this.intent = "lookup";
      this.steps.push({
        stage: "plan",
        name: "list tool replaced by search_chunks",
        rows: null,
        ms: 0,
        note: null,
      });
    }

    // A follow-up has no topic of its own ("and when is that due?"). The search
    // query holds the first and the last earlier question too (spec 2.8 point 4;
    // in P1 code does the rewrite, the eval measures it on the follow-up slice).
    if (turns.length > 0) {
      const priorTurns = this.priorTurns;
      const widen = (c: Call): Call => {
        if (c.tool !== "search_chunks") return c;
        const a = c.args as { query?: string };
        return {
          ...c,
          args: { ...a, query: followUpQuery(question, priorTurns, a.query) },
        };
      };
      this.first = widen(this.first);
      this.fallbackCalls = this.fallbackCalls.map(widen);
    }

    // Write questions: read only in P1. The eval may read the proposal.
    if (this.intent === "write" || this.first.tool.startsWith("propose_")) {
      this.intent = "write";
      if (this.input.allowProposals) {
        this.proposal = proposalFor(
          db,
          turnScope,
          this.first.tool,
          this.first.args,
        );
      }
      return {
        kind: "exit",
        exit: done(this.finish([{ kind: "read_only" }], [], "")),
      };
    }

    // Count of meetings that name something: a code count (P1.1).
    if (!write) {
      const phrase = mentionPhrase(question);
      if (phrase) {
        const started = Date.now();
        const r = countMentions(this.ctx, phrase);
        this.toolCalls.push({
          tool: "count_mentions",
          args: { query: phrase },
          rows: r.rows,
        });
        this.step("tool", "count_mentions", started, r.rows);
        const cites = r.labels
          .map((l) => this.sources.toCite(l))
          .filter((c): c is ChatCite => c !== null);
        return {
          kind: "exit",
          exit: done(this.finish(r.blocks, cites, "")),
        };
      }
    }
    return { kind: "tools" };
  }

  // ---- Stage 3: tools, in rounds. ----

  async run(call: Call): Promise<ToolResult | null> {
    const started = Date.now();
    try {
      const r = await runTool(this.ctx, call.tool as never, call.args);
      this.toolCalls.push({ tool: call.tool, args: call.args, rows: r.rows });
      this.step(
        "tool",
        call.tool,
        started,
        r.rows,
        r.degraded ??
          (r.topScore !== null ? `top=${r.topScore.toFixed(3)}` : null),
      );
      this.results.push(r);
      return r;
    } catch (e) {
      this.toolCalls.push({ tool: call.tool, args: call.args, rows: 0 });
      this.step(
        "tool",
        call.tool,
        started,
        0,
        (e as Error).message.slice(0, 120),
      );
      return null;
    }
  }

  textMaterial(): boolean {
    return this.sources
      .all()
      .some((s) => s.kind !== "item" && s.kind !== "folder");
  }

  blockResult(): ToolResult | null {
    return (
      this.results.find(
        (r) => BLOCK_TOOLS.has(r.tool) && r.blocks.length > 0,
      ) ?? null
    );
  }

  /** `act`: the calls of one round. Returns an exit on the deadline or the call cap. */
  async actRound(round: number): Promise<Exit | null> {
    const { question } = this.input;
    const { turnScope, summaryKind } = this;
    const why = this.stopReason();
    if (why) return miss(why);
    const intent = this.intent as Intent;
    const first = this.first as Call;
    // Round 1 runs the first call (and the other steps of the fallback plan).
    // Later rounds widen the search (spec 2.3 fallback chain).
    const calls: Call[] =
      round === 1
        ? [first, ...this.fallbackCalls.slice(1)]
        : plannedCalls(
            intent,
            turnScope,
            defaultSlots(question, this.priorTurns, intent),
            this.choices,
            question,
            this.todayMs,
            round,
          ).slice(0, 1);
    const { sources, results } = this;
    for (const call of calls) {
      const r = await this.run(call);
      // Decisions and next steps: a search with the words of those lines gives
      // transcript lines, so a cite can open the spoken segment (P1.2).
      if (
        r &&
        r.rows > 0 &&
        call.tool === "get_meeting_summary" &&
        (summaryKind === "decisions" || summaryKind === "steps")
      ) {
        const prefix =
          summaryKind === "decisions" ? "Decision: " : "Action item: ";
        const words = sources
          .all()
          .filter((x) => x.text.startsWith(prefix))
          .map((x) => x.text.slice(prefix.length).replace(/\s*\(.*\)$/, ""))
          .join(" ")
          .slice(0, 200)
          .trim();
        if (words)
          await this.run({ tool: "search_chunks", args: { query: words } });
      }
      // A search that found little in a meeting also reads its summary.
      if (
        r &&
        call.tool === "search_chunks" &&
        r.rows < THIN_ROWS &&
        turnScope.kind === "meeting" &&
        turnScope.id &&
        !calls.some((c) => c.tool === "get_meeting_summary")
      ) {
        await this.run({
          tool: "get_meeting_summary",
          args: { meeting_id: turnScope.id },
        });
      }
      // Search off or failed in a meeting: the summary still answers (spec 2.5a).
      if (
        r?.degraded &&
        turnScope.kind === "meeting" &&
        turnScope.id &&
        !results.some((x) => x.tool === "get_meeting_summary")
      ) {
        await this.run({
          tool: "get_meeting_summary",
          args: { meeting_id: turnScope.id },
        });
      }
      // Who said it: the window around the best hit has the speaker names.
      if (
        r &&
        call.tool === "search_chunks" &&
        r.rows > 0 &&
        (intent === "who_said" || asksWho(question)) &&
        !results.some((x) => x.tool === "get_transcript_window")
      ) {
        const best = sources
          .all()
          .find((s) => s.kind === "transcript" && s.startMs !== null);
        if (best?.startMs != null) {
          await this.run({
            tool: "get_transcript_window",
            args: {
              meeting_id: best.meetingId,
              from_ms: Math.max(0, best.startMs - 15_000),
              to_ms: best.startMs + 45_000,
            },
          });
        }
      }
    }
    return null;
  }

  /** `reflect`, fast mode (code): stay in the loop or leave it (11.9.6, "Fast mode"). */
  loopDone(round: number): boolean {
    if (this.blockResult() || this.textMaterial()) return true;
    if (
      !planFor(this.intent as Intent, this.turnScope.kind).includes(
        "search_chunks",
      )
    )
      return true;
    return round >= this.input.settings.rounds;
  }

  /** What the block answer of the loop is: counts only, or a block list. */
  blockKind(): "status_text" | "blocks" | null {
    const block = this.blockResult();
    const first = this.first as Call;
    // A status without saved text has no bullets (owner report 2026-11-01). The
    // summaries of the folder answer instead; the counts stay as the last block.
    if (
      block &&
      block.tool === "folder_status" &&
      block.blocks.every((b) => b.kind === "status" && b.bullets.length === 0)
    ) {
      return "status_text";
    }
    if (block && (BLOCK_TOOLS.has(first.tool) || !this.textMaterial())) {
      return "blocks";
    }
    return null;
  }

  /** The start of the research path: no route call, the leads come from code (11.9.5). */
  beginResearch(): void {
    const started = Date.now();
    // A follow-up that digs ("what blocked it?") answers the new question: the
    // facts of the earlier answer are told already and stay out of this one.
    if (
      this.toldTexts.length > 0 &&
      !this.excludeTold &&
      isDependentFollowUp(this.input.question)
    ) {
      this.excludeTold = true;
      this.told = this.toldTexts.flatMap(sentencesOf);
      this.toldPrompt = this.toldTexts
        .slice(-2)
        .map((t) => (t.length > 600 ? `${t.slice(0, 600)}...` : t))
        .join("\n");
    }
    this.router = "default";
    this.intent = "lookup";
    this.prepare();
    this.step("route", "rules:research", started);
  }

  /** `blocks` of the research mode: the lists of all list calls, in one answer. */
  researchBlocks(): Exit {
    const lists = this.results.filter(
      (r) => BLOCK_TOOLS.has(r.tool) && r.blocks.length > 0,
    );
    const blocks = lists.flatMap((r) => r.blocks);
    const labels = new Set<string>();
    for (const b of blocks) {
      if (b.kind === "list") {
        for (const it of b.items) if (it.label) labels.add(it.label);
      }
    }
    for (const r of lists) for (const l of r.labels) labels.add(l);
    const cites = [...labels]
      .slice(0, BLOCK_CITES)
      .map((l) => this.sources.toCite(l))
      .filter((c): c is ChatCite => c !== null);
    return done(this.finish(blocks, cites, ""));
  }

  /** A result that code composed (the workers' bullets, 11.9.16). */
  codeResult(blocks: ChatBlock[], cites: ChatCite[]): Exit {
    const content = answerContent(
      blocks.flatMap((b) =>
        b.kind === "text"
          ? [
              {
                text: b.text,
                cites: b.cites,
                ...(b.bullet ? { bullet: true } : {}),
              },
            ]
          : [],
      ),
    );
    return done(this.finish(blocks, cites, content));
  }

  /** `status_text`: the status blocks that stay as the last block of the answer. */
  statusBlocks(): ChatBlock[] {
    return this.blockResult()?.blocks ?? [];
  }

  /** `blocks`: the list, count or status answer. No model text (spec 2.2). */
  blocksResult(): Exit {
    const { question } = this.input;
    const block = this.blockResult() as ToolResult;
    let blocks = block.blocks;
    if (asksForCount(question)) {
      blocks = blocks.map((b) =>
        b.kind === "list" ? { kind: "count", n: b.total, what: b.list } : b,
      );
    }
    const labels = new Set<string>();
    for (const b of block.blocks) {
      if (b.kind === "list") {
        for (const it of b.items) if (it.label) labels.add(it.label);
      }
    }
    for (const l of block.labels) labels.add(l);
    const cites = [...labels]
      .slice(0, BLOCK_CITES)
      .map((l) => this.sources.toCite(l))
      .filter((c): c is ChatCite => c !== null);
    return done(this.finish(blocks, cites, ""));
  }

  /** The text that a status turn gets, or its counts alone when the text fails. */
  statusResult(res: TurnResult, blocks: ChatBlock[]): TurnResult {
    if (res.blocks.some((b) => b.kind === "text")) {
      return { ...res, blocks: [...res.blocks, ...blocks] };
    }
    return this.finish(blocks, [], "");
  }

  /**
   * The not-found floor and the cross-language rewrite (P1.1). Returns an
   * exit, or the job of the answer.
   */
  async floorStage(): Promise<
    { kind: "exit"; exit: Exit } | { kind: "answer"; job: AnswerJob }
  > {
    const { question, llm } = this.input;
    const { sources, summaryKind, toolCalls } = this;
    const block = this.blockResult();
    const floor = this.input.scoreFloor ?? SCORE_FLOOR;
    // The summary answered a decisions or next steps question: the extra search
    // only maps cites to the transcript. A weak score there is no reason to stop.
    const summaryHit =
      summaryKind !== null &&
      this.results.some((r) => r.tool === "get_meeting_summary" && r.rows > 0);
    let searched = summaryHit
      ? undefined
      : this.results.find((r) => r.tool === "search_chunks");

    // Cross-language step (P1.1): a weak first search may come from a question
    // in another language than the meetings. One model call writes the search
    // words in the language of the weak hit. A better second search replaces
    // the first one. Else the floor below ends the turn as before.
    if (
      floor > 0 &&
      searched &&
      searched.topScore !== null &&
      searched.topScore < floor &&
      !this.stopOrNull()
    ) {
      const firstSearch = toolCalls.find((c) => c.tool === "search_chunks");
      if (firstSearch) {
        const started = Date.now();
        try {
          const r = await llm.structured({
            step: "chatSlots",
            unitKey: "route/query",
            schema: QUERY_SCHEMA,
            system: QUERY_SYSTEM,
            messages: [{ role: "user", content: queryUser(question) }],
            maxOutputTokens: SLOT_MAX_TOKENS,
          });
          const query = r.object.query.trim();
          this.step("tool", "query rewrite", started, null, query.slice(0, 80));
          if (query !== "") {
            const before = searched;
            const second = await this.run({
              tool: "search_chunks",
              args: { ...(firstSearch.args as object), query },
            });
            if (
              second &&
              second.topScore !== null &&
              second.topScore >= REWRITE_SCORE &&
              second.topScore > (before.topScore ?? 0)
            ) {
              const keep = new Set(second.labels);
              sources.remove(before.labels.filter((l) => !keep.has(l)));
              searched = second;
            } else if (second) {
              const keep = new Set(before.labels);
              sources.remove(second.labels.filter((l) => !keep.has(l)));
            }
          }
        } catch (e) {
          this.step(
            "tool",
            "query rewrite",
            started,
            null,
            gatewayKind(e) || "error",
          );
        }
      }
    }
    if (
      floor > 0 &&
      searched &&
      searched.topScore !== null &&
      searched.topScore < floor
    ) {
      return { kind: "exit", exit: miss("no_sources") };
    }

    // Stage 4: the answer from the numbered sources.
    const ranked = sources
      .all()
      .filter((s) => s.kind !== "folder" || block === null);
    if (ranked.length === 0) return { kind: "exit", exit: miss("no_sources") };
    return {
      kind: "answer",
      job: {
        ranked,
        synth: summaryKind !== null,
        focus:
          summaryKind === "decisions"
            ? "the decisions of the meeting: one bullet for each decision"
            : summaryKind === "steps"
              ? "the next steps of the meeting: one bullet for each action item, with its owner and due date"
              : null,
      },
    };
  }

  // ---- Broad questions (11.7, 11.8 B). ----

  /** The start of the synthesis path. */
  beginBroad(): void {
    const { history } = this.input;
    const started = Date.now();
    this.router = "default";
    this.intent = "lookup";
    this.step("route", "rules:synthesis", started);
    for (const m of history) {
      if (m.role !== "assistant") continue;
      for (const c of m.cites) {
        this.seen.add(
          this.seenKey(c.meeting_id, c.kind, c.item_id, c.start_ms, c.text),
        );
        this.seenMeetings.add(c.meeting_id);
      }
    }
  }

  private seenKey(
    meetingId: string,
    kind: string,
    itemId: string | null,
    startMs: number | null,
    text: string,
  ): string {
    return `${meetingId}|${kind}|${itemId ?? ""}|${startMs ?? ""}|${text.slice(0, 60)}`;
  }

  private async runCall(call: Call): Promise<ToolResult | null> {
    const t = Date.now();
    try {
      const r = await runTool(this.ctx, call.tool as never, call.args);
      this.toolCalls.push({ tool: call.tool, args: call.args, rows: r.rows });
      this.step("tool", call.tool, t, r.rows, r.degraded);
      return r;
    } catch (e) {
      this.toolCalls.push({ tool: call.tool, args: call.args, rows: 0 });
      this.step("tool", call.tool, t, 0, (e as Error).message.slice(0, 120));
      return null;
    }
  }

  private digest(ids?: string[], budgetTokens?: number, quiet = false): void {
    const t = Date.now();
    this.digestIds = ids;
    const r = summaryDigest(this.ctx, {
      ...(ids ? { meetingIds: ids } : {}),
      budgetTokens:
        budgetTokens ?? Math.floor(this.input.settings.sourceBudget * 0.6),
      ...(this.excludeTold ? { told: this.seenMeetings } : {}),
    });
    this.digestLabels = r.labels;
    if (quiet) return;
    this.toolCalls.push({
      tool: r.tool,
      args: { meetings: ids?.length ?? "scope" },
      rows: r.rows,
    });
    this.step("tool", r.tool, t, r.rows);
  }

  /** `act` of the synthesis path: the summaries and the top chunks. */
  async broadGather(): Promise<void> {
    const { question } = this.input;
    const { turnScope, turns, priorTurns, excludeTold: more } = this;
    const query =
      more || isDependentFollowUp(question)
        ? followUpQuery(question, priorTurns)
        : question.slice(0, 200);
    if (turnScope.kind === "meeting" && turnScope.id) {
      await this.runCall({
        tool: "get_meeting_summary",
        args: { meeting_id: turnScope.id },
      });
      await this.runCall({
        tool: "search_chunks",
        args: { query, k: more ? 14 : 8 },
      });
    } else if (turnScope.kind === "folder") {
      this.digest();
      await this.runCall({
        tool: "search_chunks",
        args: { query, k: more ? 8 : 4 },
      });
    } else {
      await this.runCall({
        tool: "search_chunks",
        args: { query, k: more ? 12 : 8 },
      });
      const ids = [
        ...new Set(
          this.sources
            .all()
            .map((x) => x.meetingId)
            .filter(Boolean),
        ),
      ].slice(0, 6);
      // A question with no topic ("an overview of everything") reads every
      // meeting: the map-reduce below shortens what does not fit (D20).
      // Only a first question: a follow-up ("tell me more") stays on the topic of the thread.
      if (turns.length === 0 && isGlobalQuestion(question)) this.digest();
      else if (ids.length > 0) this.digest(ids);
    }
  }

  private isSeen(x: Source): boolean {
    return this.seen.has(
      this.seenKey(x.meetingId, x.kind, x.itemId, x.startMs, x.text),
    );
  }

  private rankSources(): Source[] {
    const spoken = (x: Source) =>
      x.kind === "transcript" || x.kind === "window";
    const now = this.sources.all().filter((x) => x.kind !== "folder");
    return [
      ...now.filter((x) => !this.isSeen(x) && !spoken(x)),
      ...now.filter((x) => !this.isSeen(x) && spoken(x)),
      ...now.filter((x) => this.isSeen(x) && !spoken(x)),
      ...now.filter((x) => this.isSeen(x) && spoken(x)),
    ];
  }

  /** `observe` of the synthesis path: the told facts leave, the sources are ranked. */
  broadObserve(): Exit | null {
    const why = this.stopReason();
    if (why) return miss(why);
    // "More details": the facts the thread told stay out of the sources (the
    // model cannot tell new from told on its own).
    if (this.excludeTold && this.told.length > 0) {
      const drop: string[] = [];
      for (const x of this.sources.all()) {
        const t = withoutTold(x.text, this.told);
        if (t === "") drop.push(x.label);
        else x.text = t;
      }
      this.sources.remove(drop);
    }
    const all = this.sources.all().filter((x) => x.kind !== "folder");
    if (all.length === 0) return miss("no_sources");
    this.ranked = this.rankSources();
    return null;
  }

  /**
   * The map step and the slices of a broad answer. Returns an exit, or the
   * jobs of the answer calls. A folder or Everything digest that does not fit
   * the window is shortened in groups (map), then each date slice is one job.
   */
  async broadJobs(): Promise<
    { kind: "exit"; exit: Exit } | ({ kind: "jobs" } & BroadJobs)
  > {
    const { question, llm, signal, settings } = this.input;
    const { turnScope, sources } = this;
    let ranked = this.ranked;
    // Map-reduce (D20): the digest of a folder or of Everything does not fit
    // the window, so the oldest meetings would drop. Map: shorten the full
    // summaries in groups, each note keeps its label. Reduce: the synthesis
    // answer below reads the notes.
    if (turnScope.kind !== "meeting" && this.digestLabels.length >= 6) {
      // The digest shrinks every meeting to one line when the budget is
      // short, and that loses the facts. Map-reduce runs when the FULL
      // summaries do not fit the digest budget.
      const digestBudget = Math.floor(settings.sourceBudget * 0.6);
      // Measure the full digest on a scratch source map: the labels of the
      // real map stay as they are when nothing needs to be shortened.
      const scratch = new SourceMap();
      summaryDigest(
        { ...this.ctx, sources: scratch },
        {
          ...(this.digestIds ? { meetingIds: this.digestIds } : {}),
          budgetTokens: 1_000_000,
        },
      );
      const fullTokens = scratch
        .all()
        .reduce((n, x) => n + estimatePromptTokens(renderSource(x)) + 1, 0);
      if (fullTokens > digestBudget) {
        sources.remove(this.digestLabels);
        this.digest(this.digestIds, 1_000_000, true);
        const full = this.digestLabels
          .map((l) => sources.get(l))
          .filter((x): x is Source => x !== undefined);

        this.progress({ stage: "reading", count: full.length });
        const t = Date.now();
        const cap = settings.sourceBudget;
        const win = llm.contextWindow;
        const groupTokens = Math.max(
          1000,
          Math.min(
            Math.floor(cap * 0.7),
            win === null ? Number.POSITIVE_INFINITY : win - 2400,
          ),
        );
        // The notes together fill about 60% of the source budget.
        // Each source also costs its title and date (about 28 tokens).
        const noteChars = Math.max(
          80,
          Math.min(
            420,
            Math.floor(((cap * 0.6) / Math.max(1, full.length) - 28) * 4),
          ),
        );
        const m = await mapNotes({
          sources: full,
          question,
          llm,
          signal,
          groupTokens,
          noteChars,
          stop: this.stopReason,
        });
        this.step(
          "tool",
          "map_reduce",
          t,
          m.sources,
          `Reading ${m.sources} meetings in ${m.groups} groups; ${m.calls} calls; ${m.fallback} code cuts (error ${m.why.error}, missing ${m.why.missing}, unsafe ${m.why.unsafe})${m.firstError ? `; ${m.firstError}` : ""}`,
        );
        if (m.stopped) return { kind: "exit", exit: miss(m.stopped as never) };
        const days = full
          .map((x) => x.startedAt)
          .filter((x): x is number => x !== null)
          .sort((a, b) => a - b);
        const day = (ms: number | undefined) =>
          ms === undefined ? "" : new Date(ms).toISOString().slice(0, 10);
        this.mapped = {
          from: day(days[0]),
          to: day(days.at(-1)),
          n: full.length,
        };
        this.mappedLabels = new Set(full.map((x) => x.label));
      }
      ranked = this.rankSources();
      this.ranked = ranked;
    }
    if (this.mapped) {
      // Reduce in date slices (D20): one answer for each third of the period,
      // so the late meetings get bullets too (a model that reads 72 notes
      // writes about the first ones). Each slice has its own cite check.
      // Only the shortened digest sources, in date order (a "more details"
      // turn ranks unseen sources first, which mixes the order).
      const mappedLabels = this.mappedLabels;
      const summaries = ranked
        .filter((x) => x.kind === "summary" && mappedLabels.has(x.label))
        .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
      // At most 4 slices; each one fits the source budget when it can.
      const total = summaries.reduce(
        (n, x) => n + estimatePromptTokens(renderSource(x)) + 1,
        0,
      );
      const parts = Math.min(
        4,
        Math.max(
          1,
          Math.ceil(summaries.length / 24),
          Math.ceil(total / Math.max(1, settings.sourceBudget - 800)),
        ),
      );
      const size = Math.ceil(summaries.length / parts);
      const slices = Array.from({ length: parts }, (_, i) =>
        summaries.slice(i * size, (i + 1) * size),
      ).filter((x) => x.length > 0);
      const day = (x: Source | undefined) =>
        x?.startedAt == null
          ? ""
          : new Date(x.startedAt).toISOString().slice(0, 10);
      return {
        kind: "jobs",
        merge: true,
        jobs: slices.map((slice, i) => ({
          ranked: slice,
          synth: true,
          focus: `these are ${slice.length} meetings from ${day(slice[0])} to ${day(slice.at(-1))}, part ${i + 1} of ${slices.length} of a longer story; ${i === 0 ? "the lead says what the whole folder is about in one sentence; " : "write only bullets; "}one bullet for each important fact, in date order, with its date`,
        })),
      };
    }
    return {
      kind: "jobs",
      merge: false,
      jobs: [
        {
          ranked,
          synth: true,
          focus:
            turnScope.kind === "meeting"
              ? null
              : "tell it in date order; write one bullet for each of the most important meetings, with its date",
        },
      ],
    };
  }

  /**
   * The slices of a map-reduce: after each slice (but the last) the deadline
   * and the call cap are checked. Returns "stop" with the exit to give when no
   * slice answered, or "break" to keep the good slices.
   */
  betweenSlices(results: TurnResult[]): Exit | "break" | null {
    const stop = this.stopReason();
    if (!stop) return null;
    if (!results.some((x) => !x.blocks.some((b) => b.kind === "not_found")))
      return miss(stop);
    return "break";
  }

  /** The merge of the date slices into one answer. */
  mergeSlices(results: TurnResult[]): Exit {
    const good = results.filter(
      (r) => !r.blocks.some((b) => b.kind === "not_found"),
    );
    if (good.length === 0) {
      const last = results.at(-1);
      return last ? done(last) : miss("no_sources");
    }
    const blocks: ChatBlock[] = [];
    const cites = new Map<string, ChatCite>();
    for (const [i, r] of good.entries()) {
      for (const b of r.blocks) {
        blocks.push(i > 0 && b.kind === "text" ? { ...b, bullet: true } : b);
      }
      for (const c of r.cites) cites.set(c.label, c);
    }
    const content = answerContent(
      blocks.flatMap((b) =>
        b.kind === "text"
          ? [
              {
                text: b.text,
                cites: b.cites,
                ...(b.bullet ? { bullet: true } : {}),
              },
            ]
          : [],
      ),
    );
    return done(this.finish(blocks, [...cites.values()], content));
  }

  // ---- Stage 4 and 5: the answer, one attempt at a time. ----

  newRun(): AnswerRun {
    return {
      attempt: 0,
      budget: this.input.settings.sourceBudget,
      repair: null,
    };
  }

  /** `synthesize`: one answer call. */
  async answerAttempt(job: AnswerJob, run: AnswerRun): Promise<AttemptOut> {
    const { question, llm, signal } = this.input;
    const { ranked, synth } = job;
    const attempt = ++run.attempt;
    const why = this.stopReason();
    if (why) return { kind: "exit", exit: miss(why) };
    const system = synth ? SYNTH_SYSTEM : ANSWER_SYSTEM;
    const maxOut = synth ? SYNTH_MAX_TOKENS : ANSWER_MAX_TOKENS;
    const assembled = assembleAnswerInput({
      system,
      question,
      history: this.turns,
      sources: ranked,
      budgetTokens: run.budget,
      windowTokens: llm.contextWindow,
      maxOutputTokens: maxOut,
      fixedTokens:
        estimatePromptTokens(system) + estimatePromptTokens(this.toldPrompt),
    });
    this.sourcesDropped = assembled.droppedLabels;
    this.historyDropped = assembled.historyTurnsDropped;
    this.sourceTokens = assembled.parts.sources;
    const started = Date.now();
    this.progress({ stage: "answering", count: null });
    let parsed: AnswerSentence[];
    try {
      const user = answerUser({
        history: assembled.historyText,
        sources: assembled.sourcesText,
        question: job.focus ? `${question}\nFOCUS: ${job.focus}` : question,
        repair: run.repair,
        told: this.toldPrompt,
      });
      const messages = [{ role: "user" as const, content: user }];
      if (synth) {
        const r = await llm.structured({
          step: "chatAnswer",
          unitKey: attempt === 1 ? "answer" : `answer/retry${attempt - 1}`,
          schema: SYNTH_SCHEMA,
          system,
          messages,
          maxOutputTokens: maxOut,
        });
        parsed = [
          ...r.object.lead.map((x) => ({ ...x })),
          ...r.object.bullets.map((x) => ({ ...x, bullet: true })),
        ];
      } else {
        const r = await llm.structured({
          step: "chatAnswer",
          unitKey: attempt === 1 ? "answer" : `answer/retry${attempt - 1}`,
          schema: ANSWER_SCHEMA,
          system,
          messages,
          maxOutputTokens: maxOut,
        });
        parsed = [
          ...r.object.sentences.map((x) => ({ ...x })),
          ...(r.object.bullets ?? []).map((x) => ({ ...x, bullet: true })),
        ];
      }
      this.step("answer", `attempt ${attempt}`, started);
    } catch (e) {
      const kind = gatewayKind(e);
      this.step("answer", `attempt ${attempt}`, started, null, kind || "error");
      if (signal.aborted) {
        const why = this.stopReason();
        if (why) return { kind: "exit", exit: miss(why) };
      }
      // A cut answer or an overflow: one retry with a smaller source budget (spec 2.5b).
      if ((kind === "length" || kind === "context_exceeded") && attempt < 3) {
        run.budget = halveBudget(run.budget);
        return { kind: "retry" };
      }
      if (kind === "length" || kind === "context_exceeded") {
        return { kind: "exit", exit: miss("model_error") };
      }
      throw e;
    }
    parsed = parsed.filter((x) => x.text.trim() !== "");
    if (parsed.length === 0) {
      return {
        kind: "exit",
        exit: miss(this.excludeTold && synth ? "nothing_new" : "no_sources"),
      };
    }
    return { kind: "draft", parsed };
  }

  /** `cite_check`: the guards on a draft. */
  async checkAttempt(
    job: AnswerJob,
    run: AnswerRun,
    parsed: AnswerSentence[],
  ): Promise<CheckOut> {
    const { question, signal } = this.input;
    const { ranked, synth } = job;
    const attempt = run.attempt;
    const { sources, turnScope, told } = this;
    const allowed = new Set(
      turnScope.kind === "meeting" && turnScope.id
        ? [turnScope.id]
        : ranked.map((s) => s.meetingId),
    );
    const knownNames = [
      ...this.choices.people.map((p) => p.name),
      ...this.choices.meetings.map((m) =>
        m.text.replace(/\s*\(\d{4}-\d{2}-\d{2}\)$/, ""),
      ),
    ];
    const started5 = Date.now();
    for (const sentence of parsed) {
      sentence.text = stripCiteMarkers(sentence.text);
    }
    assignMissingCites(parsed, sources);
    const check = checkAnswer({
      sentences: parsed,
      sources,
      question,
      allowedMeetingIds: turnScope.kind === "all" ? "all" : allowed,
      knownNames,
      // A broad answer drops a sentence with a fact that no source holds
      // (last attempt); a lookup answer is retried and then not found.
      dropUnsupported: synth && attempt >= 2,
    });
    this.step(
      "cite_check",
      check.ok ? "pass" : "fail",
      started5,
      check.sentences.length,
      check.ok ? null : failureNote(check),
    );
    if (check.ok) {
      // Facts the thread told already stay out (a follow-up asks for more).
      if (told.length > 0) {
        const fresh = dropToldSentences(check.sentences, told);
        if (fresh.length < check.sentences.length) {
          this.step(
            "answer",
            `told facts removed: ${check.sentences.length - fresh.length}`,
            started5,
          );
        }
        check.sentences = fresh;
        if (fresh.length === 0) {
          if (attempt >= 2) return { kind: "exit", exit: miss("nothing_new") };
          run.repair =
            "Your answer repeats facts that the thread told already. Give other facts from the sources. If the sources hold no other fact, return empty lists.";
          return { kind: "retry" };
        }
      }
      // A new question gets a new answer. The same text as an earlier answer to
      // another question is a repeat (P1.2): one retry, then not found.
      const repeated = repeatedEarlierAnswer(
        question,
        check.sentences.map((s) => s.text).join(" "),
        this.turns,
      );
      if (repeated !== null) {
        this.step(
          "answer",
          attempt === 1 ? "repeat: retry" : "repeat: not found",
          started5,
        );
        if (attempt >= 2)
          return {
            kind: "exit",
            exit: miss(this.excludeTold ? "nothing_new" : "no_sources"),
          };
        run.repair =
          "Your answer repeats an earlier answer, but this question is new. Answer only the new question. If no source shows it, return an empty sentences list.";
        return { kind: "retry" };
      }
      tidyCites(check.sentences, sources);
      refineCiteTimes(check.sentences, sources);
      try {
        await pickCiteTimes(
          check.sentences,
          sources,
          followUpQuery(question, this.priorTurns),
          async (q, texts) => {
            try {
              return await rerankPairs(q, texts, signal);
            } catch (e) {
              if (signal.aborted) throw e;
              return null;
            }
          },
        );
      } catch (e) {
        // A client abort or the deadline during the pick ends the turn as before.
        if (signal.aborted) {
          const why = this.stopReason();
          if (why) return { kind: "exit", exit: miss(why) };
        }
        throw e;
      }
      const cites = citeFromSentences(check.sentences, sources);
      const blocks: ChatBlock[] = check.sentences.map((s) => ({
        kind: "text",
        text: s.text,
        cites: s.cites,
        ...(s.bullet ? { bullet: true } : {}),
      }));
      return {
        kind: "exit",
        exit: done(this.finish(blocks, cites, answerContent(check.sentences))),
      };
    }
    run.repair = failureNote(check);
    if (attempt >= 2) return { kind: "exit", exit: miss("cite_check") };
    return { kind: "retry" };
  }

  /** One answer job: up to 3 attempts. */
  async answerStage(job: AnswerJob): Promise<Exit> {
    const run = this.newRun();
    while (run.attempt < 3) {
      const a = await this.answerAttempt(job, run);
      if (a.kind === "exit") return a.exit;
      if (a.kind === "retry") continue;
      const c = await this.checkAttempt(job, run, a.parsed);
      if (c.kind === "exit") return c.exit;
    }
    return miss("cite_check");
  }
}
