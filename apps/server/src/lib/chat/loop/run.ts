// The Ask tool loop (specs/meeting-chat-agent.md 11.10.5, decision D22). The
// model owns the next tool call. Code owns the scope, the first call of a
// small model, the step cap, the size of a result, the answer call and the
// cite check by id. The loop is driven step by step through `llm.nativeCall`,
// so every model call stays in the cost log and in the trace of the gateway.
// Engine `loop` of the setting `chat_engine`. The pipeline is `runGraph`.

import type { ModelMessage } from "ai";
import { z } from "zod";
import { estimatePromptTokens } from "../../llm/token-budget.js";
import { rerankPairs } from "../../mlx-rerank/client.js";
import type { AnswerSentence, Ranker } from "../cites.js";
import { assembleAnswerInput } from "../context.js";
import { parseDates } from "../dates.js";
import type { ChatTurnInput } from "../pipeline.js";
import { asksForCount } from "../plan.js";
import { answerUser, asksForList, asksForStatus } from "../prompts.js";
import { SCORE_FLOOR, Turn } from "../turn.js";
import type { TurnResult } from "../types.js";
import { type AttributeOptions, attributeCites } from "./attribute.js";
import { TOOL_LINE, TOOLS, type ToolName } from "./definitions.js";
import { kickLedgerBackfill } from "./ledger.js";
import { type LoopProfile, loopProfile } from "./profile.js";
import { tidySentences } from "./tidy.js";
import { createLoopTools } from "./tools.js";

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const cut = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

/** The most bullets of an answer. Code sets it by model size (spec 11.10.6 point 2). */
const BULLETS = 12;

// The answer step writes plain sentences. Code adds the cites (attribute.ts).
const sentence = z.object({
  text: z.string().max(300),
});
const ANSWER_SCHEMA = {
  name: "chat_loop_answer",
  version: 3,
  zod: z.object({
    lead: z.array(sentence).max(3),
    bullets: z.array(sentence).max(BULLETS),
  }),
};

const answerSystem = `You answer a question about meeting notes. Use ONLY the numbered sources.
Write the answer in the language of the QUESTION, even when the sources use another language.
"lead" holds 1 to 3 short sentences: the answer first.
"bullets" holds one bullet for each separate fact, reason, item or change that the sources show. Put them in date order when the question is about change over time. Write as many bullets as the sources need, at most ${BULLETS}. Write one bullet for each source label that adds a new fact. Write no bullet when the lead answers the question.
One bullet states one fact in at most 30 words. Name the date of the meeting when the sources give one.
Each sentence and each bullet states what one source shows. Write no source label and no cite marker: code adds the sources after your answer.
Copy names, numbers and dates exactly as the sources write them. Write the full name of a person when the sources have it.
When a source shows an item with its history, say its status now and why.
Answer the new question. Earlier questions give context only.
If the sources hold no answer, return empty lists. Never use knowledge from outside the sources.`;

/** Eval only: overrides of the model profile, so a run can measure a first call. */
export type LoopFix =
  | "listBlocks"
  | "segmentCites"
  | "labelledHits"
  | "emptyRetry"
  | "navSearch"
  | "bulletPerSource"
  | "argRetry"
  | "listGate"
  | "tidy";
export type LoopOverride = Partial<
  Pick<LoopProfile, "first" | "stepCap" | "ledger" | "hitChars">
> & {
  /** Eval only: switches a P3.1 fix off, to measure it. */
  off?: LoopFix[];
  /** Eval only: how code attributes the cites (see `AttributeOptions`). */
  cite?: AttributeOptions;
};

export async function runLoop(
  raw: ChatTurnInput,
  override?: LoopOverride,
  /** The pipeline of the same turn. The loop hands over the kinds that it does not answer (see below). */
  handOver?: () => Promise<TurnResult>,
): Promise<TurnResult> {
  const input = raw;
  const llm = input.llm;
  const profile: LoopProfile = {
    ...loopProfile({ modelId: llm.modelId, isLocal: llm.isLocal }),
    ...override,
  };
  const off = new Set<LoopFix>(override?.off ?? []);
  const t = new Turn(input);
  const { question } = input;
  // The hit text is longer than in the pipeline (640): spec 11.10.4, `search`.
  Object.assign(t.ctx, { hitChars: profile.hitChars });
  t.prepare();
  // D20: the clarify block runs as today. It ends the turn.
  const clarified = t.clarify();
  if (clarified) return t.resolve(clarified);
  // Three kinds of turn keep the code path of the pipeline, because the loop
  // has no tool for them (spec 11.10.4 rule 4, 11.10.6 point 5): a write
  // request (a proposal), a count of mentions, and a broad question that the
  // synthesis path answers from the summaries of every meeting. The gold,
  // broad and thread parts of chat-eval showed the loss without it. P4 removes
  // this bridge when the loop has tools for them.
  if (
    handOver &&
    (t.write ||
      t.synthesis ||
      asksForCount(question) ||
      asksForStatus(question) ||
      // "What was decided?", "What are the next steps?" in one meeting: the summary answers it.
      t.summaryKind !== null)
  )
    return handOver();
  t.begin();
  // A cloud model has an item ledger. A meeting with no pass is written in the background.
  if (profile.ledger) kickLedgerBackfill();

  const tools = createLoopTools(t, profile, question, off.has("labelledHits"));
  const { ids } = tools;
  const todayIso = day(t.todayMs);
  const named = parseDates(question, t.todayMs);
  const systemFor = (
    names: string[],
  ) => `You answer questions about the meetings of ${t.scopeLine}. Use the tools to find the facts. Never answer from memory.
Today is ${todayIso}. ${named.dateFrom ? `The question names the dates ${named.dateFrom} to ${named.dateTo}. ` : ""}There are ${ids.length} meetings, labeled M1 to M${ids.length}, oldest first. Passages and items you receive have labels S1, S2, and so on.
Tools: ${names.map((n) => TOOL_LINE[n as ToolName]).join(", ")}.
When you have the facts, stop calling tools and reply with one short line.`;

  const hist: ModelMessage[] = t.turns.slice(-3).flatMap((h) => [
    { role: "user" as const, content: h.question },
    { role: "assistant" as const, content: cut(h.answer, 700) },
  ]);
  const messages: ModelMessage[] = [
    ...hist,
    { role: "user", content: question },
  ];
  // ---- Weak evidence (spec 11.10.10, risk T8). ----
  // The score floor of the pipeline is a hint inside the loop, not an exit
  // (an exit failed simple facts that the reranker scored low). When every
  // search was weak and no read or item list gave a source, the answer step
  // gets a line that says so. A cloud model needs no such line.
  const floor = profile.cls === "cloud" ? 0 : (input.scoreFloor ?? SCORE_FLOOR);
  function weakEvidence(): boolean {
    const tops = t.results
      .filter((r) => r.tool === "search_chunks" && r.topScore !== null)
      .map((r) => r.topScore as number);
    const other = t.toolCalls.some(
      (c) =>
        c.tool === "get_meeting_summary" ||
        c.tool === "get_transcript_window" ||
        c.tool === "list_action_items" ||
        c.tool === "list_decisions_questions" ||
        (c.tool === "list_items" && c.rows > 0),
    );
    return floor > 0 && tops.length > 0 && Math.max(...tops) < floor && !other;
  }
  let idle = 0;
  /** The tools of the last step that ran. */
  let lastNames: string[] = [];
  for (let i = 0; i < profile.stepCap; i++) {
    if (t.stopReason()) break;
    t.progress({
      stage: "researching",
      count: null,
      iteration: i + 1,
      max_iter: profile.stepCap,
    });
    // A list of all meetings does not help a follow-up that leans on the thread:
    // when the thread has an earlier turn, code forces the search for it.
    const forced =
      profile.first === "auto"
        ? null
        : profile.first === "list_meetings" && t.turns.length > 0
          ? "search"
          : profile.first;
    const active =
      i === 0 && forced
        ? TOOLS.filter((x) => x.function.name === forced)
        : TOOLS;
    const before = t.sources.size;
    const started = Date.now();
    type NativeRes = Awaited<ReturnType<typeof llm.nativeCall>>;
    const callModel = async (
      extra: ModelMessage[],
      key: string,
    ): Promise<NativeRes | null> => {
      try {
        return await llm.nativeCall({
          system: systemFor(active.map((x) => x.function.name)),
          // The record and the window check see the flat text of the thread.
          messages: [
            {
              role: "user",
              content: JSON.stringify(messages).slice(-60_000),
            },
          ],
          modelMessages: [...messages, ...extra],
          tools: active as never,
          // The worker takes auto, required or none. One tool is active, so required forces it.
          ...(i === 0 && forced ? { toolChoice: "required" as const } : {}),
          maxOutputTokens: profile.stepTokens,
          unitKey: key,
        });
      } catch (e) {
        const kind = (e as { kind?: string }).kind;
        t.step("route", `loop:${i}`, started, null, kind ?? "error");
        if (input.signal.aborted) return null;
        // A cut reply ends the loop; the answer step uses what was found.
        if (kind === "length" || kind === "context_exceeded") return null;
        throw e;
      }
    };
    let res = await callModel([], `loop/${i}`);
    if (res === null) break;
    // A call that the model cut or wrote as broken JSON has no arguments. The
    // model gets one more try with a short hint; code does not guess its call.
    if (
      !off.has("argRetry") &&
      (res.calls ?? []).length > 0 &&
      (res.calls ?? []).every((c) => c.args === null)
    ) {
      t.step("route", `loop:${i}:bad_args`, started, null, null);
      const again = await callModel(
        [
          {
            role: "user",
            content:
              "Your last tool call was cut or was not valid JSON. Call one tool again. Keep the arguments short. Leave meeting_ids out to use all meetings.",
          },
        ],
        `loop/${i}/retry`,
      );
      if (again === null) break;
      res = again;
    }
    const names = new Set(active.map((x) => x.function.name as string));
    let calls = (res.calls ?? []).filter(
      (c) => c.args !== null && names.has(c.name),
    );
    // Code owns the first call of a small model. When the model does not make
    // it (it answers in text or picks another tool), code makes it. The
    // search tool widens a follow-up with the topic of the thread.
    if (i === 0 && forced && calls.length === 0) {
      calls = [
        {
          id: "forced-0",
          name: forced,
          args: forced === "search" ? { query: question } : {},
        },
      ];
      t.step(
        "route",
        "loop:forced",
        started,
        1,
        `model gave no valid first call: ${JSON.stringify(res.calls ?? []).slice(0, 160)}`,
      );
    }
    t.step(
      "route",
      `loop:${i}`,
      started,
      calls.length,
      calls.map((c) => c.name).join(","),
    );
    if (calls.length === 0) break;
    messages.push({
      role: "assistant",
      content: [
        ...(res.text ? [{ type: "text" as const, text: res.text }] : []),
        ...calls.map((c) => ({
          type: "tool-call" as const,
          toolCallId: c.id,
          toolName: c.name,
          input: c.args,
        })),
      ],
    });
    lastNames = calls.map((c) => c.name);
    const results: string[] = [];
    // Calls of one step run in order, so the labels do not change between runs.
    for (const c of calls)
      results.push(await tools.execute(c.name, c.args ?? {}));
    messages.push({
      role: "tool",
      content: calls.map((c, j) => ({
        type: "tool-result" as const,
        toolCallId: c.id,
        toolName: c.name,
        output: { type: "text" as const, value: results[j] as string },
      })),
    });
    // Guard (not a router): two steps in a row with no new source end the loop.
    idle = t.sources.size === before ? idle + 1 : 0;
    if (idle >= 2) break;
  }

  // ---- List answer (P3.1). ----
  // When the last step of the model asked for the lists of items, the lists
  // are the answer, in the blocks that the pipeline writes (grouped lists with
  // "Show all"). The model chose the list; code does not read the question.
  if (
    !off.has("listBlocks") &&
    // The model chose the lists in its last step. Retrieval stays with the
    // model. A list of the items of the whole scope is a list answer. A list of
    // one meeting is a lookup, and the answer step writes it. A step of meetings
    // only is a list answer when the question asks for a list (the pipeline
    // detector picks the form).
    (off.has("listGate")
      ? asksForList(question)
      : (lastNames.includes("list_items") && tools.wholeScopeList()) ||
        asksForList(question)) &&
    lastNames.length > 0 &&
    lastNames.every((n) => n === "list_items" || n === "list_meetings") &&
    t.results.some((r) => r.blocks.some((b) => b.kind === "list"))
  ) {
    // The lists of items answer. The list of meetings is the map to them.
    if (lastNames.includes("list_items")) {
      for (let i = t.results.length - 1; i >= 0; i--)
        if (t.results[i]?.tool === "list_meetings") t.results.splice(i, 1);
    }
    t.step("route", "loop:list_blocks", Date.now(), 0, null);
    return t.resolve(t.researchBlocks());
  }

  // ---- A map is not evidence (P3.1). ----
  // The model asked for the list of meetings and stopped. The titles and gists
  // are a map, so code makes the search with the question, as it does when the
  // model gives no valid first call. The model then has passages to cite.
  if (
    !off.has("navSearch") &&
    t.toolCalls.every((c) => c.tool === "list_meetings") &&
    !t.stopReason()
  ) {
    const started = Date.now();
    await tools.execute("search", { query: question });
    t.step("route", "loop:nav_search", started, 1, null);
  }

  // ---- Weak evidence (the function is defined before the loop). ----
  const weak = weakEvidence();
  const searchTops = t.results
    .filter((r) => r.tool === "search_chunks" && r.topScore !== null)
    .map((r) => r.topScore as number);
  if (weak) {
    t.step(
      "route",
      "loop:weak_evidence",
      Date.now(),
      0,
      `best score ${Math.max(...searchTops).toFixed(2)}`,
    );
  }
  if (weak && profile.weakExit) return t.notFound("no_sources");
  const answerBase = off.has("bulletPerSource")
    ? answerSystem.replace(
        "Write one bullet for each source label that adds a new fact. ",
        "",
      )
    : answerSystem;
  const answerSys = weak
    ? `${answerBase}\nThe search found only weak matches. Write a sentence only when a source states the answer in its own words. If no source states it, return empty lists.`
    : answerBase;

  // ---- The answer: one structured call, tools off (the worker rejects both). ----
  // Only what a tool showed to the model can be cited.
  t.sources.remove(
    t.sources
      .all()
      .filter((s) => !tools.shown.has(s.label))
      .map((s) => s.label),
  );
  // The list of meetings is a map, not evidence: when a passage, a summary or
  // an item gave a source, the map stays out of the cites.
  if (
    [...tools.shown].some((l) => !tools.navLabels.has(l)) &&
    tools.navLabels.size > 0
  )
    t.sources.remove([...tools.navLabels]);
  const ranked = t.sources
    .all()
    .sort((a, b) => Number(a.label.slice(1)) - Number(b.label.slice(1)));
  if (ranked.length === 0) return t.notFound("no_sources");
  // The answer step sees who spoke. The cite chip keeps the real text.
  for (const s of ranked) {
    const who = s.citeText === undefined ? tools.speakersOf(s).trim() : "";
    if (who) {
      s.citeText = s.citeText ?? s.text;
      s.text = `(${who}) ${s.text}`;
    }
  }
  t.progress({ stage: "answering", count: null });
  const run = t.newRun();
  run.budget = profile.answerBudget;
  const job = { ranked, synth: true, focus: null, codeCites: true };
  // The reranker scores a sentence against the blocks. When it fails once, the word share takes over.
  let rerankDown = false;
  const rankSentence: Ranker = async (q, texts) => {
    if (rerankDown) return null;
    try {
      return await rerankPairs(q, texts, input.signal);
    } catch (e) {
      if (input.signal.aborted) throw e;
      rerankDown = true;
      return null;
    }
  };
  while (run.attempt < 3) {
    const attempt = ++run.attempt;
    const why = t.stopReason();
    if (why) return t.notFound(why);
    const assembled = assembleAnswerInput({
      system: answerSys,
      question,
      history: t.turns,
      sources: ranked,
      budgetTokens: run.budget,
      windowTokens: llm.contextWindow,
      maxOutputTokens: profile.answerTokens,
      fixedTokens: estimatePromptTokens(answerSys),
    });
    t.sourcesDropped = assembled.droppedLabels;
    t.historyDropped = assembled.historyTurnsDropped;
    t.sourceTokens = assembled.parts.sources;
    const started = Date.now();
    let parsed: AnswerSentence[];
    try {
      const r = await llm.structured({
        step: "chatAnswer",
        unitKey: attempt === 1 ? "answer" : `answer/retry${attempt - 1}`,
        schema: ANSWER_SCHEMA,
        system: answerSys,
        messages: [
          {
            role: "user",
            content: answerUser({
              history: assembled.historyText,
              sources: assembled.sourcesText,
              question,
              repair: run.repair,
            }),
          },
        ],
        maxOutputTokens: profile.answerTokens,
      });
      t.step("answer", `attempt ${attempt}`, started);
      parsed = [
        ...r.object.lead.map((x) => ({ ...x, cites: [] as string[] })),
        ...r.object.bullets.map((x) => ({
          ...x,
          cites: [] as string[],
          bullet: true,
        })),
      ];
    } catch (e) {
      const kind = (e as { kind?: string }).kind ?? "";
      t.step("answer", `attempt ${attempt}`, started, null, kind || "error");
      if (input.signal.aborted) {
        const w = t.stopReason();
        if (w) return t.notFound(w);
      }
      if ((kind === "length" || kind === "context_exceeded") && attempt < 3) {
        run.budget = Math.floor(run.budget / 2);
        continue;
      }
      // The answer broke a limit of the schema (a long sentence, too many bullets). Ask once more.
      if (kind === "schema" && attempt < 3) {
        run.repair = `Your answer broke a limit. Write at most 3 lead sentences and at most ${BULLETS} bullets, each text under 300 characters.`;
        continue;
      }
      // Some local servers answer the structured call with a tool call. Ask once more.
      if (kind === "unexpected_tool_calls" && attempt < 3) {
        run.repair =
          "Reply with the JSON object only. Do not call a tool. Use only the sources.";
        continue;
      }
      if (kind === "length" || kind === "context_exceeded")
        return t.notFound("model_error");
      throw e;
    }
    parsed = off.has("tidy")
      ? parsed.filter((x) => x.text.trim() !== "")
      : tidySentences(parsed.filter((x) => x.text.trim() !== ""));
    // An empty answer with good evidence is one more try. Some models answer
    // with empty lists when a source states the fact only in other words.
    if (parsed.length === 0 && !weak && attempt < 2 && !off.has("emptyRetry")) {
      run.repair =
        "The sources hold facts about this question. Answer from them. Return empty lists only when no source mentions the topic.";
      continue;
    }
    if (parsed.length === 0) return t.notFound("no_sources");
    // Code owns the cites: each sentence gets the blocks of this turn that show it.
    const startedCites = Date.now();
    try {
      const stats = await attributeCites(
        parsed,
        ranked,
        t.sources,
        rankSentence,
        override?.cite,
      );
      t.step(
        "cite_check",
        "attribute",
        startedCites,
        stats.cited,
        `cited ${stats.cited}, uncited ${stats.uncited}, ${stats.reranked ? "reranker" : "word share"}, best ${stats.best.map((b) => b.toFixed(2)).join(" ")}`,
      );
    } catch (e) {
      if (input.signal.aborted) {
        const w = t.stopReason();
        if (w) return t.notFound(w);
      }
      throw e;
    }
    const c = await t.checkAttempt(job, run, parsed);
    if (c.kind === "exit") return t.resolve(c.exit);
  }
  return t.notFound("cite_check");
}
