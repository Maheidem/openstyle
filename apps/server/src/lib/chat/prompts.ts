import { z } from "zod";
import type { StepSchema } from "../llm/gateway.js";
import { INTENTS, type Intent } from "./types.js";

// The prompts and the stage schemas of the meeting chat agent
// (specs/meeting-chat-agent.md 2.3). Each prompt has ONE job (AGENTS.md, "LLM
// design ethos"). The router prompt is the v2 wording of the P0 eval, which was
// checked on a blind set of 224 questions in 7 languages (P0 report 4.2).

/** Output caps per stage in tokens (spec 2.2 budget table). */
export const ROUTER_MAX_TOKENS = 24;
export const SLOT_MAX_TOKENS = 150;
export const NATIVE_MAX_TOKENS = 200;
export const ANSWER_MAX_TOKENS = 400;

const INTENT_LINES = `lookup: asks for ONE specific fact: an amount, a number, a name, or what was decided about one topic. "What did we decide on the database?"
who_said: asks WHO said, proposed, approved or will do something. "Who proposed the pilot?" "Who will write the rollback plan?"
aggregate: asks for a list of items or a count. "List the open tasks of Ana." "How many meetings did we have?"
temporal: asks WHEN something is or happens, or WHICH meetings happened in a time range. "When is the launch?" "Which meetings did we have last week?"
review: asks to show ALL decisions or ALL open questions of a project. "Show all decisions."
status: asks where a project stands. "Where do we stand on Atlas?"
write: asks you to change data: mark done, reopen, tag, move, merge. "Mark the task as done."
other: a greeting, thanks, or not about the meetings. "Hello!"`;

/** Stage 1 (fallback router): one intent. */
export const ROUTER_SYSTEM = `You route a user question about meeting notes. Answer with exactly one intent. The question can be in any language.\n${INTENT_LINES}`;

export const ROUTER_SCHEMA: StepSchema<{ intent: Intent }> = {
  name: "chat_router",
  version: 1,
  zod: z.object({ intent: z.enum(INTENTS) }),
};

/** Stage 4: the answer. Sentences with their own cites (the cite check works per sentence). */
export const ANSWER_SCHEMA: StepSchema<{
  sentences: { text: string; cites: string[] }[];
}> = {
  name: "chat_answer",
  version: 2,
  zod: z.object({
    sentences: z
      .array(
        z.object({
          text: z.string().max(320),
          cites: z.array(z.string().max(6)).max(3),
        }),
      )
      .max(6),
  }),
};

export const ANSWER_SYSTEM = `You answer a question about meeting notes. Use ONLY the numbered sources.
Write 1 to 3 short sentences in the language of the question. State the answer first.
One sentence states one fact. Put the labels of the sources that show the fact in "cites", for example ["S2"].
Copy names, numbers and dates exactly as the sources write them.
Return an empty "sentences" list ONLY when no source speaks about the topic of the question.
Never use knowledge from outside the sources.`;

/** The user text of the answer call. */
export function answerUser(args: {
  history: string;
  sources: string;
  question: string;
  repair: string | null;
}): string {
  return [
    args.history ? `EARLIER QUESTIONS:\n${args.history}\n` : "",
    `SOURCES:\n${args.sources || "(none)"}\n`,
    args.repair ? `FIX THIS IN YOUR ANSWER: ${args.repair}\n` : "",
    `QUESTION: ${args.question}`,
  ]
    .filter(Boolean)
    .join("\n");
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function weekdayName(ms: number): string {
  return WEEKDAYS[new Date(ms).getUTCDay()] as string;
}

/** The system text of the native tool call. Short, with the closed choices as lists. */
export function nativeSystem(args: {
  todayMs: number;
  scopeLine: string;
  lists: string[];
  history: string;
  write: boolean;
}): string {
  const lines = [
    `You help with questions about meeting notes. Call exactly one tool. Today is ${isoDay(args.todayMs)} (${weekdayName(args.todayMs)}).`,
    `Scope: ${args.scopeLine}`,
    args.write
      ? "The user asks for a change. Call the matching propose tool."
      : "Use search_chunks when you are not sure. A `query` is a short standalone search text in the language of the question. Use the lists for ids.",
    ...args.lists,
  ];
  if (args.history) lines.push(`Earlier questions:\n${args.history}`);
  return lines.join("\n");
}

/** Write verbs in the 7 UI languages. Code decides to show the propose tools. */
const WRITE_RE =
  /\b(mark|tag|retag|move|merge|reopen|re-open|close|rename|marque|marcar|mova|mover|una|unir|reabra|reabrir|feche|fechar|etiquete|marca|mueve|fusiona|reabre|cierra|markiere|verschiebe|f[uü]hre .* zusammen|[oö]ffne .* erneut|d[eé]place|fusionne|rouvre|ferme|segna|sposta|unisci|riapri|chiudi)\b|完了にして|移動|統合|タグ/iu;

export function looksLikeWrite(question: string): boolean {
  return WRITE_RE.test(question);
}

/** "who" words in the 7 UI languages: the transcript window adds the speaker names. */
const WHO_RE = /\b(who|whom|quem|qui|wer|wen|qui[eé]n|chi)\b|誰|だれ/iu;

export function asksWho(question: string): boolean {
  return WHO_RE.test(question);
}
