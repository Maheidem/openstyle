import type { DatabaseSync } from "node:sqlite";
import type {
  ChatBlock,
  ChatCite,
  ChatMessage,
  ChatScope,
  ChatTrace,
  ChatTraceStep,
} from "@openstyle/validations";
import { estimatePromptTokens } from "../llm/token-budget.js";
import { rerankPairs } from "../mlx-rerank/client.js";
import {
  buildChoices,
  type Choices,
  nativeToolDefs,
  validateNativeCall,
  visibleToolNames,
} from "./choices.js";
import {
  assignMissingCites,
  checkAnswer,
  citeFromSentences,
  failureNote,
  pickCiteTimes,
  refineCiteTimes,
  repeatedEarlierAnswer,
  stripCiteMarkers,
  tidyCites,
} from "./cites.js";
import {
  assembleAnswerInput,
  compactHistory,
  type HistoryTurn,
  halveBudget,
  renderHistory,
} from "./context.js";
import type { ChatLlm } from "./llm.js";
import {
  asksForCount,
  asksOverview,
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
} from "./prompts.js";
import { proposalFor } from "./proposals.js";
import type { ChatSettings } from "./settings.js";
import { countMentions, runTool } from "./tools.js";
import {
  type Intent,
  SourceMap,
  type ToolContext,
  type ToolResult,
  type TurnResult,
  type TurnScope,
} from "./types.js";

// The turn pipeline of the meeting chat agent (specs/meeting-chat-agent.md
// 2.2). Stages 0, 2, 3 and 5 are code. Stages 1, 2b and 4 are LLM calls.
// Router design (owner decision 2026-10-31): MIXED. A native tool call gives
// the tool and its arguments. Code validates the call. An invalid or missing
// call falls back to the structured router (stage 1) and the slot call (2b).
// Dates always come from the code date parser.

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

export interface ChatTurnInput {
  db: DatabaseSync;
  scope: ChatScope;
  question: string;
  /** The stored messages of the thread before this question. */
  history: ChatMessage[];
  settings: ChatSettings;
  llm: ChatLlm;
  signal: AbortSignal;
  /** The clock of the turn. The eval sets it. */
  now?: number;
  /** Eval only: a write question gives a proposal. Nothing is applied in any case. */
  allowProposals?: boolean;
  /** Override of `SCORE_FLOOR` (the eval measures it). */
  scoreFloor?: number;
}

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

interface Call {
  tool: string;
  args: unknown;
}

function isTimeout(signal: AbortSignal): boolean {
  const r = signal.reason as { name?: string } | undefined;
  return signal.aborted && r?.name === "TimeoutError";
}

function gatewayKind(e: unknown): string {
  const k = (e as { kind?: unknown })?.kind;
  return typeof k === "string" ? k : "";
}

export async function runChatTurn(input: ChatTurnInput): Promise<TurnResult> {
  const { db, scope, question, llm, signal, settings } = input;
  const t0 = Date.now();
  const todayMs = input.now ?? t0;
  const turnScope: TurnScope = { kind: scope.kind, id: scope.id };
  const sources = new SourceMap();
  const steps: ChatTraceStep[] = [];
  const toolCalls: TurnResult["toolCalls"] = [];
  const ctx: ToolContext = {
    db,
    scope: turnScope,
    sources,
    todayMs,
    k: settings.k,
    rerank: true,
    ...(signal ? { signal } : {}),
  };
  const turns: HistoryTurn[] = compactHistory(
    input.history.map((m) => ({
      role: m.role,
      content: m.content,
      blocks: m.blocks,
      cites: m.cites,
    })),
  );
  const priorQuestions = turns.map((t) => t.question);
  const priorTurns = turns.map((t) => ({
    question: t.question,
    answer: t.answer,
  }));
  let router: ChatTrace["router"] = "skipped";
  let intent: Intent | null = null;
  let proposal: TurnResult["proposal"] = null;
  let sourcesDropped: string[] = [];
  let historyDropped = 0;
  let sourceTokens = 0;

  const step = (
    stage: ChatTraceStep["stage"],
    name: string,
    started: number,
    rows: number | null = null,
    note: string | null = null,
  ) => {
    steps.push({ stage, name, rows, ms: Date.now() - started, note });
  };

  const finish = (
    blocks: ChatBlock[],
    cites: ChatCite[],
    content: string,
  ): TurnResult => ({
    blocks,
    content,
    cites,
    trace: {
      intent,
      router,
      steps,
      calls: llm.calls(),
      sources_dropped: sourcesDropped,
      history_turns_dropped: historyDropped,
      source_tokens: sourceTokens,
    },
    proposal,
    toolCalls,
    modelId: llm.modelId,
    provider: llm.provider,
    runId: llm.runId,
    ms: Date.now() - t0,
  });

  const nearest = (): ChatCite[] =>
    sources
      .all()
      .filter((s) => s.kind !== "item" && s.kind !== "folder")
      .slice(0, NEAREST)
      .map((s) => sources.toCite(s.label))
      .filter((c): c is ChatCite => c !== null);

  const notFound = (
    reason: Extract<ChatBlock, { kind: "not_found" }>["reason"],
  ): TurnResult =>
    finish([{ kind: "not_found", scope, reason, nearest: nearest() }], [], "");

  /** Deadline and call cap end the turn with a block. A client abort throws. */
  const stopReason = ():
    | Extract<ChatBlock, { kind: "not_found" }>["reason"]
    | null => {
    if (signal.aborted) {
      if (isTimeout(signal)) return "deadline";
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException("The turn was cancelled.", "AbortError");
    }
    if (llm.calls() >= HARD_CAP_CALLS) return "call_cap";
    return null;
  };

  // Stage 0b: prefetch. The closed choices are built by code (spec 2.3).
  const choices: Choices = buildChoices(
    db,
    turnScope,
    question,
    priorQuestions,
    todayMs,
  );
  const historyText = renderHistory(turns.slice(-2));
  const scopeLine =
    scope.kind === "meeting"
      ? "one meeting"
      : scope.kind === "folder"
        ? "one project folder"
        : "all meetings";

  // ---- Stage 1+2: the first tool call (native), or the fallback router. ----
  const write = looksLikeWrite(question);
  const plain =
    !write &&
    !asksForList(question) &&
    !asksForCount(question) &&
    !asksForStatus(question);
  let first: Call | null = null;
  // A plain follow-up ("and when is that due?") gets no tool call from the
  // native turn: all 10 follow-ups of the eval and 13 of 20 follow-ups and
  // long-thread turns on E4B and E2B returned text, after 650 to 850 ms on
  // the Mac. Code makes the search call, with the earlier turn in the query.
  const skipNative = plain && turns.length > 0 && isDependentFollowUp(question);
  // "What was this meeting about?" reads the summary (P1.2). Code makes the
  // call: a search for it found chunks of one fact and the model repeated the
  // earlier answer.
  if (
    !write &&
    turnScope.kind === "meeting" &&
    turnScope.id &&
    asksOverview(question)
  ) {
    const started = Date.now();
    router = "default";
    intent = "lookup";
    first = {
      tool: "get_meeting_summary",
      args: { meeting_id: turnScope.id },
    };
    step("route", "rules:overview", started);
  }
  if (settings.nativeTools && !skipNative && !first) {
    const started = Date.now();
    const names = visibleToolNames(turnScope.kind, write);
    try {
      const r = await llm.nativeCall({
        system: nativeSystem({
          todayMs,
          scopeLine,
          lists: choiceLists(choices, write),
          history: historyText,
          write,
        }),
        messages: [{ role: "user", content: question }],
        tools: nativeToolDefs(choices, names),
        maxOutputTokens: NATIVE_MAX_TOKENS,
        unitKey: "route/native",
      });
      if (r.kind === "call") {
        const v = validateNativeCall(r, {
          choices,
          scope: turnScope,
          allowed: names,
          question,
          todayMs,
        });
        if (v.ok) {
          first = { tool: v.args.tool, args: v.args.args };
          router = "native";
          step("route", `native:${v.args.tool}`, started);
        } else {
          step("route", "native:invalid", started, null, v.reason);
        }
      } else {
        step("route", "native:none", started, null, "no tool call");
      }
    } catch (e) {
      if (signal.aborted) {
        const why = stopReason();
        if (why) return notFound(why);
      }
      // A provider error here is not final: the structured router may work.
      step("route", "native:error", started, null, gatewayKind(e) || "error");
    }
  }
  {
    const why = stopReason();
    if (why) return notFound(why);
  }

  let fallbackCalls: Call[] = [];
  if (!first && plain) {
    // The cheap route (P1.1): a question that asks for no list, no count, no
    // status and no change reads text. Code makes the search call. No router
    // call and no slot call run (two model calls less on the slow path).
    const started = Date.now();
    router = "default";
    intent = "lookup";
    first = {
      tool: "search_chunks",
      args: { query: question.slice(0, 200) },
    };
    step("route", "rules:lookup", started);
  }
  if (!first) {
    const started = Date.now();
    router = "structured";
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
      step("route", `intent:${r.object.intent}`, started);
    } catch (e) {
      if (signal.aborted) {
        const why = stopReason();
        if (why) return notFound(why);
      }
      router = "default";
      step("route", "intent:default", started, null, gatewayKind(e) || "error");
    }
    intent = routed;
    // Dates: a temporal question with no date range reads text, like a lookup.
    const slotsStarted = Date.now();
    let slots = defaultSlots(question, [], routed);
    const zod = slotZod(routed, choices);
    if (zod && !(await stopOrNull())) {
      try {
        const r = await llm.structured({
          step: "chatSlots",
          unitKey: "route/slots",
          schema: { name: "chat_slots", version: 1, zod },
          system: slotSystem(routed, choices, isoDay(todayMs)),
          messages: [
            {
              role: "user",
              content: `${historyText ? `Earlier: ${historyText}\n` : ""}Question: ${question}`,
            },
          ],
          maxOutputTokens: SLOT_MAX_TOKENS,
        });
        slots = { ...slots, ...(r.object as object) };
        step("slots", routed, slotsStarted);
      } catch (e) {
        step("slots", "default", slotsStarted, null, gatewayKind(e) || "error");
      }
    } else {
      step("slots", "default", slotsStarted);
    }
    fallbackCalls = plannedCalls(
      routed,
      turnScope,
      slots,
      choices,
      question,
      todayMs,
      1,
    );
    first = fallbackCalls[0] ?? {
      tool: "search_chunks",
      args: { query: question },
    };
  }

  async function stopOrNull() {
    try {
      return stopReason();
    } catch {
      return "cancelled";
    }
  }
  intent ??= TOOL_INTENT[first.tool] ?? "lookup";

  // A list tool needs a question that asks for a list or a count. A question
  // about one topic reads text (P1 eval, lookup and long-thread questions).
  const LIST_TOOLS = ["list_action_items", "list_decisions_questions"];
  if (
    LIST_TOOLS.includes(first.tool) &&
    !asksForList(question) &&
    !asksForCount(question)
  ) {
    first = { tool: "search_chunks", args: { query: question.slice(0, 200) } };
    fallbackCalls = [];
    intent = "lookup";
    steps.push({
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
    const widen = (c: Call): Call => {
      if (c.tool !== "search_chunks") return c;
      const a = c.args as { query?: string };
      return {
        ...c,
        args: { ...a, query: followUpQuery(question, priorTurns, a.query) },
      };
    };
    first = widen(first);
    fallbackCalls = fallbackCalls.map(widen);
  }

  // ---- Write questions: read only in P1. The eval may read the proposal. ----
  if (intent === "write" || first.tool.startsWith("propose_")) {
    intent = "write";
    if (input.allowProposals) {
      proposal = proposalFor(db, turnScope, first.tool, first.args);
    }
    return finish([{ kind: "read_only" }], [], "");
  }

  // ---- Count of meetings that name something: a code count (P1.1). ----
  if (!write) {
    const phrase = mentionPhrase(question);
    if (phrase) {
      const started = Date.now();
      const r = countMentions(ctx, phrase);
      toolCalls.push({
        tool: "count_mentions",
        args: { query: phrase },
        rows: r.rows,
      });
      step("tool", "count_mentions", started, r.rows);
      const cites = r.labels
        .map((l) => sources.toCite(l))
        .filter((c): c is ChatCite => c !== null);
      return finish(r.blocks, cites, "");
    }
  }

  // ---- Stage 3: tools, in rounds. ----
  const results: ToolResult[] = [];
  const run = async (call: Call): Promise<ToolResult | null> => {
    const started = Date.now();
    try {
      const r = await runTool(ctx, call.tool as never, call.args);
      toolCalls.push({ tool: call.tool, args: call.args, rows: r.rows });
      step(
        "tool",
        call.tool,
        started,
        r.rows,
        r.degraded ??
          (r.topScore !== null ? `top=${r.topScore.toFixed(3)}` : null),
      );
      results.push(r);
      return r;
    } catch (e) {
      toolCalls.push({ tool: call.tool, args: call.args, rows: 0 });
      step("tool", call.tool, started, 0, (e as Error).message.slice(0, 120));
      return null;
    }
  };

  const textMaterial = () =>
    sources.all().some((s) => s.kind !== "item" && s.kind !== "folder");
  const blockResult = () =>
    results.find((r) => BLOCK_TOOLS.has(r.tool) && r.blocks.length > 0) ?? null;

  let wide = false;
  for (let round = 1; round <= settings.rounds; round++) {
    const why = stopReason();
    if (why) return notFound(why);
    // Round 1 runs the first call (and the other steps of the fallback plan).
    // Later rounds widen the search (spec 2.3 fallback chain).
    const calls: Call[] =
      round === 1
        ? [first, ...fallbackCalls.slice(1)]
        : plannedCalls(
            intent,
            turnScope,
            defaultSlots(question, priorTurns, intent),
            choices,
            question,
            todayMs,
            round,
          ).slice(0, 1);
    if (round > 1) wide = true;
    for (const call of calls) {
      const r = await run(call);
      // A search that found little in a meeting also reads its summary.
      if (
        r &&
        call.tool === "search_chunks" &&
        r.rows < THIN_ROWS &&
        turnScope.kind === "meeting" &&
        turnScope.id &&
        !calls.some((c) => c.tool === "get_meeting_summary")
      ) {
        await run({
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
        await run({
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
          await run({
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
    if (blockResult() || textMaterial()) break;
    if (!planFor(intent, turnScope.kind).includes("search_chunks")) break;
  }
  void wide;

  // ---- Block answers: list, count, status. No model text (spec 2.2). ----
  const block = blockResult();
  if (block && (BLOCK_TOOLS.has(first.tool) || !textMaterial())) {
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
      .map((l) => sources.toCite(l))
      .filter((c): c is ChatCite => c !== null);
    return finish(blocks, cites, "");
  }

  // ---- The not-found floor: the best hit is too weak for an answer. ----
  const floor = input.scoreFloor ?? SCORE_FLOOR;
  let searched = results.find((r) => r.tool === "search_chunks");

  // Cross-language step (P1.1): a weak first search may come from a question
  // in another language than the meetings. One model call writes the search
  // words in the language of the weak hit. A better second search replaces
  // the first one. Else the floor below ends the turn as before.
  if (
    floor > 0 &&
    searched &&
    searched.topScore !== null &&
    searched.topScore < floor &&
    !(await stopOrNull())
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
        step("tool", "query rewrite", started, null, query.slice(0, 80));
        if (query !== "") {
          const before = searched;
          const second = await run({
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
        step("tool", "query rewrite", started, null, gatewayKind(e) || "error");
      }
    }
  }
  if (
    floor > 0 &&
    searched &&
    searched.topScore !== null &&
    searched.topScore < floor
  ) {
    return notFound("no_sources");
  }

  // ---- Stage 4: the answer from the numbered sources. ----
  const ranked = sources
    .all()
    .filter((s) => s.kind !== "folder" || block === null);
  if (ranked.length === 0) return notFound("no_sources");

  const allowed = new Set(
    turnScope.kind === "meeting" && turnScope.id
      ? [turnScope.id]
      : ranked.map((s) => s.meetingId),
  );
  const knownNames = [
    ...choices.people.map((p) => p.name),
    ...choices.meetings.map((m) =>
      m.text.replace(/\s*\(\d{4}-\d{2}-\d{2}\)$/, ""),
    ),
  ];

  let budget = settings.sourceBudget;
  let repair: string | null = null;
  const window = llm.contextWindow;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const why = stopReason();
    if (why) return notFound(why);
    const assembled = assembleAnswerInput({
      system: ANSWER_SYSTEM,
      question,
      history: turns,
      sources: ranked,
      budgetTokens: budget,
      windowTokens: window,
      maxOutputTokens: ANSWER_MAX_TOKENS,
      fixedTokens: estimatePromptTokens(ANSWER_SYSTEM),
    });
    sourcesDropped = assembled.droppedLabels;
    historyDropped = assembled.historyTurnsDropped;
    sourceTokens = assembled.parts.sources;
    const started = Date.now();
    let parsed: { sentences: { text: string; cites: string[] }[] };
    try {
      const r = await llm.structured({
        step: "chatAnswer",
        unitKey: attempt === 1 ? "answer" : `answer/retry${attempt - 1}`,
        schema: ANSWER_SCHEMA,
        system: ANSWER_SYSTEM,
        messages: [
          {
            role: "user",
            content: answerUser({
              history: assembled.historyText,
              sources: assembled.sourcesText,
              question,
              repair,
            }),
          },
        ],
        maxOutputTokens: ANSWER_MAX_TOKENS,
      });
      parsed = r.object;
      step("answer", `attempt ${attempt}`, started);
    } catch (e) {
      const kind = gatewayKind(e);
      step("answer", `attempt ${attempt}`, started, null, kind || "error");
      if (signal.aborted) {
        const why = stopReason();
        if (why) return notFound(why);
      }
      // A cut answer or an overflow: one retry with a smaller source budget (spec 2.5b).
      if ((kind === "length" || kind === "context_exceeded") && attempt < 3) {
        budget = halveBudget(budget);
        continue;
      }
      if (kind === "length" || kind === "context_exceeded") {
        return notFound("model_error");
      }
      throw e;
    }
    if (parsed.sentences.length === 0) {
      return notFound("no_sources");
    }
    const started5 = Date.now();
    for (const sentence of parsed.sentences) {
      sentence.text = stripCiteMarkers(sentence.text);
    }
    assignMissingCites(parsed.sentences, sources);
    const check = checkAnswer({
      sentences: parsed.sentences,
      sources,
      question,
      allowedMeetingIds: turnScope.kind === "all" ? "all" : allowed,
      knownNames,
    });
    step(
      "cite_check",
      check.ok ? "pass" : "fail",
      started5,
      check.sentences.length,
      check.ok ? null : failureNote(check),
    );
    if (check.ok) {
      // A new question gets a new answer. The same text as an earlier answer to
      // another question is a repeat (P1.2): one retry, then not found.
      const repeated = repeatedEarlierAnswer(
        question,
        check.sentences.map((s) => s.text).join(" "),
        turns,
      );
      if (repeated !== null) {
        step(
          "answer",
          attempt === 1 ? "repeat: retry" : "repeat: not found",
          started5,
        );
        if (attempt >= 2) return notFound("no_sources");
        repair =
          "Your answer repeats an earlier answer, but this question is new. Answer only the new question. If no source shows it, return an empty sentences list.";
        continue;
      }
      tidyCites(check.sentences, sources);
      refineCiteTimes(check.sentences, sources);
      try {
        await pickCiteTimes(
          check.sentences,
          sources,
          followUpQuery(question, priorTurns),
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
          const why = stopReason();
          if (why) return notFound(why);
        }
        throw e;
      }
      const cites = citeFromSentences(check.sentences, sources);
      const blocks: ChatBlock[] = check.sentences.map((s) => ({
        kind: "text",
        text: s.text,
        cites: s.cites,
      }));
      return finish(
        blocks,
        cites,
        check.sentences.map((s) => s.text).join(" "),
      );
    }
    repair = failureNote(check);
    if (attempt >= 2) break;
  }
  return notFound("cite_check");
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
