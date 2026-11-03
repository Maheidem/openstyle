// The Ask tool loop (specs/meeting-chat-agent.md 11.10.5, decision D22). The
// model owns the next tool call. Code owns the scope, the first call of a
// small model, the step cap, the size of a result, the answer call and the
// cite check by id. The loop is driven step by step through `llm.nativeCall`,
// so every model call stays in the cost log and in the trace of the gateway.
// Engine `loop` of the setting `chat_engine`. The pipeline is `runGraph`.

import type { ModelMessage } from "ai";
import { z } from "zod";
import { estimatePromptTokens } from "../../llm/token-budget.js";
import type { AnswerSentence } from "../cites.js";
import { assembleAnswerInput } from "../context.js";
import { parseDates } from "../dates.js";
import type { ChatTurnInput } from "../pipeline.js";
import { answerUser } from "../prompts.js";
import { Turn } from "../turn.js";
import type { TurnResult } from "../types.js";
import { TOOL_LINE, TOOLS, type ToolName } from "./definitions.js";
import { kickLedgerBackfill } from "./ledger.js";
import { type LoopProfile, loopProfile } from "./profile.js";
import { createLoopTools } from "./tools.js";

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const cut = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

/** The most bullets of an answer. Code sets it by model size (spec 11.10.6 point 2). */
const BULLETS = 12;

const sentence = z.object({
  text: z.string().max(300),
  cites: z.array(z.string().max(6)).max(4),
});
const ANSWER_SCHEMA = {
  name: "chat_loop_answer",
  version: 2,
  zod: z.object({
    lead: z.array(sentence).max(3),
    bullets: z.array(sentence).max(BULLETS),
  }),
};

const answerSystem = `You answer a question about meeting notes. Use ONLY the numbered sources.
Write the answer in the language of the QUESTION, even when the sources use another language.
"lead" holds 1 to 3 short sentences: the answer first.
"bullets" holds one bullet for each separate fact, reason, item or change that the sources show. Put them in date order when the question is about change over time. Write as many bullets as the sources need, at most ${BULLETS}. Write no bullet when the lead answers the question.
One bullet states one fact in at most 30 words. Name the date of the meeting when the sources give one.
Put the labels of the sources that show the sentence or bullet in "cites", for example ["S2"]. When a sentence uses facts of more than one source, put every one of those labels in "cites". Never write a label inside the text.
Copy names, numbers and dates exactly as the sources write them. Write the full name of a person when the sources have it.
When a source shows an item with its history, say its status now and why.
Answer the new question. Earlier questions give context only.
If the sources hold no answer, return empty lists. Never use knowledge from outside the sources.`;

/** Eval only: overrides of the model profile, so a run can measure a first call. */
export type LoopOverride = Partial<
  Pick<LoopProfile, "first" | "stepCap" | "ledger">
>;

export async function runLoop(
  raw: ChatTurnInput,
  override?: LoopOverride,
): Promise<TurnResult> {
  const input = raw;
  const llm = input.llm;
  const profile: LoopProfile = {
    ...loopProfile({ modelId: llm.modelId, isLocal: llm.isLocal }),
    ...override,
  };
  const t = new Turn(input);
  const { question } = input;
  // Hit text is 1500 characters in the loop (spec 11.10.4, `search`).
  Object.assign(t.ctx, { hitChars: 1500 });
  t.prepare();
  // D20: the clarify block runs as today. It ends the turn.
  const clarified = t.clarify();
  if (clarified) return t.resolve(clarified);
  t.begin();
  // A cloud model has an item ledger. A meeting with no pass is written in the background.
  if (profile.ledger) kickLedgerBackfill();

  const tools = createLoopTools(t, profile, question);
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
  let idle = 0;
  for (let i = 0; i < profile.stepCap; i++) {
    if (t.stopReason()) break;
    t.progress({
      stage: "researching",
      count: null,
      iteration: i + 1,
      max_iter: profile.stepCap,
    });
    const forced = profile.first === "auto" ? null : profile.first;
    const active =
      i === 0 && forced
        ? TOOLS.filter((x) => x.function.name === forced)
        : TOOLS;
    const before = t.sources.size;
    const started = Date.now();
    let res: Awaited<ReturnType<typeof llm.nativeCall>>;
    try {
      res = await llm.nativeCall({
        system: systemFor(active.map((x) => x.function.name)),
        // The record and the window check see the flat text of the thread.
        messages: [
          { role: "user", content: JSON.stringify(messages).slice(-60_000) },
        ],
        modelMessages: messages,
        tools: active as never,
        // The worker takes auto, required or none. One tool is active, so required forces it.
        ...(i === 0 && forced ? { toolChoice: "required" as const } : {}),
        maxOutputTokens: profile.stepTokens,
        unitKey: `loop/${i}`,
      });
    } catch (e) {
      const kind = (e as { kind?: string }).kind;
      t.step("route", `loop:${i}`, started, null, kind ?? "error");
      if (input.signal.aborted) break;
      // A cut reply ends the loop; the answer step uses what was found.
      if (kind === "length" || kind === "context_exceeded") break;
      throw e;
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

  // ---- The answer: one structured call, tools off (the worker rejects both). ----
  // Only what a tool showed to the model can be cited.
  t.sources.remove(
    t.sources
      .all()
      .filter((s) => !tools.shown.has(s.label))
      .map((s) => s.label),
  );
  const ranked = t.sources
    .all()
    .sort((a, b) => Number(a.label.slice(1)) - Number(b.label.slice(1)));
  if (ranked.length === 0) return t.notFound("no_sources");
  // The answer step sees who spoke. The cite chip keeps the real text.
  for (const s of ranked) {
    const who = tools.speakersOf(s).trim();
    if (who) {
      s.citeText = s.citeText ?? s.text;
      s.text = `(${who}) ${s.text}`;
    }
  }
  t.progress({ stage: "answering", count: null });
  const run = t.newRun();
  run.budget = profile.answerBudget;
  const job = { ranked, synth: true, focus: null };
  while (run.attempt < 3) {
    const attempt = ++run.attempt;
    const why = t.stopReason();
    if (why) return t.notFound(why);
    const assembled = assembleAnswerInput({
      system: answerSystem,
      question,
      history: t.turns,
      sources: ranked,
      budgetTokens: run.budget,
      windowTokens: llm.contextWindow,
      maxOutputTokens: profile.answerTokens,
      fixedTokens: estimatePromptTokens(answerSystem),
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
        system: answerSystem,
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
        ...r.object.lead.map((x) => ({ ...x })),
        ...r.object.bullets.map((x) => ({ ...x, bullet: true })),
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
      if (kind === "length" || kind === "context_exceeded")
        return t.notFound("model_error");
      throw e;
    }
    parsed = parsed.filter((x) => x.text.trim() !== "");
    if (parsed.length === 0) return t.notFound("no_sources");
    const c = await t.checkAttempt(job, run, parsed);
    if (c.kind === "exit") return t.resolve(c.exit);
  }
  return t.notFound("cite_check");
}
