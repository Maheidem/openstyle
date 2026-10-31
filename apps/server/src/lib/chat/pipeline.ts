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
import {
  buildChoices,
  type Choices,
  nativeToolDefs,
  validateNativeCall,
  visibleToolNames,
} from "./choices.js";
import { checkAnswer, citeFromSentences, failureNote } from "./cites.js";
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
  defaultSlots,
  planFor,
  plannedCalls,
  slotSystem,
  slotZod,
} from "./plan.js";
import {
  ANSWER_MAX_TOKENS,
  ANSWER_SCHEMA,
  ANSWER_SYSTEM,
  answerUser,
  asksWho,
  isoDay,
  looksLikeWrite,
  NATIVE_MAX_TOKENS,
  nativeSystem,
  ROUTER_MAX_TOKENS,
  ROUTER_SCHEMA,
  ROUTER_SYSTEM,
  SLOT_MAX_TOKENS,
} from "./prompts.js";
import { proposalFor } from "./proposals.js";
import type { ChatSettings } from "./settings.js";
import { runTool } from "./tools.js";
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
/** Nearest sources shown in a not_found block. */
const NEAREST = 3;
/** Cites kept for a block answer (list, count, status). */
const BLOCK_CITES = 12;

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
  let first: Call | null = null;
  if (settings.nativeTools) {
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
      routed = r.object.intent === "other" ? "lookup" : r.object.intent;
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
    let slots = defaultSlots(question);
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

  // ---- Write questions: read only in P1. The eval may read the proposal. ----
  if (intent === "write" || first.tool.startsWith("propose_")) {
    intent = "write";
    if (input.allowProposals) {
      proposal = proposalFor(db, turnScope, first.tool, first.args);
    }
    return finish([{ kind: "read_only" }], [], "");
  }

  // ---- Stage 3: tools, in rounds. ----
  const results: ToolResult[] = [];
  const run = async (call: Call): Promise<ToolResult | null> => {
    const started = Date.now();
    try {
      const r = await runTool(ctx, call.tool as never, call.args);
      toolCalls.push({ tool: call.tool, args: call.args, rows: r.rows });
      step("tool", call.tool, started, r.rows, r.degraded);
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
            defaultSlots(question),
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
    let parsed: {
      found: boolean;
      sentences: { text: string; cites: string[] }[];
    };
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
    if (!parsed.found || parsed.sentences.length === 0) {
      return notFound("no_sources");
    }
    const started5 = Date.now();
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
