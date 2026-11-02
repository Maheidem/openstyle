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
export const ANSWER_MAX_TOKENS = 500;
/** A lead paragraph plus up to 6 bullets with cites needs more room: E4B writes indented JSON and hit 900 tokens (synthesis, 2026-11-01). */
export const SYNTH_MAX_TOKENS = 1500;

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

const sentenceSchema = z.object({
  text: z.string().max(280),
  cites: z.array(z.string().max(6)).max(3),
});

/**
 * Stage 4: the answer. Sentences with their own cites (the cite check works
 * per sentence). `bullets` is optional: a lookup that finds several facts may
 * list them (owner decision 2026-11-01).
 */
export const ANSWER_SCHEMA: StepSchema<{
  sentences: { text: string; cites: string[] }[];
  bullets?: { text: string; cites: string[] }[];
}> = {
  name: "chat_answer",
  version: 3,
  zod: z.object({
    sentences: z.array(sentenceSchema).max(6),
    bullets: z.array(sentenceSchema).max(5).optional(),
  }),
};

/** Stage 4 for a broad question: a lead paragraph (1 to 3 sentences) plus 2 to 6 bullets. */
export const SYNTH_SCHEMA: StepSchema<{
  lead: { text: string; cites: string[] }[];
  bullets: { text: string; cites: string[] }[];
}> = {
  name: "chat_synthesis",
  version: 1,
  zod: z.object({
    lead: z.array(sentenceSchema).min(1).max(3),
    bullets: z.array(sentenceSchema).min(2).max(6),
  }),
};

export const ANSWER_SYSTEM = `You answer a question about meeting notes. Use ONLY the numbered sources.
Write 1 to 3 short sentences in the language of the question. State the answer first.
One sentence states one fact. Put the labels of the sources that show the fact in "cites", for example ["S2"].
When the sources show several separate facts that answer the question, put them in "bullets", one fact for each bullet, with their own "cites". Else leave "bullets" empty.
Copy names, numbers and dates exactly as the sources write them. Write the full name of a person (first and last name) when the sources have it.
Never write a source label such as [S1] inside a sentence. The labels go in "cites" only.
Answer the new question. Earlier questions give context only: do not copy an earlier answer.
Return an empty "sentences" list ONLY when no source speaks about the topic of the question.
Never use knowledge from outside the sources.`;

/**
 * The system text for a broad question (overview, details, history, story,
 * onboarding, "tell me more"). Lead paragraph, then bullets; every sentence
 * and every bullet has its own cites.
 */
export const SYNTH_SYSTEM = `You explain a project or a meeting from meeting notes. Use ONLY the numbered sources.
Write the answer in the language of the QUESTION, even when the sources use another language.
"lead" holds 1 to 3 short sentences: the main point first.
"bullets" holds 3 to 6 bullets. One bullet states one fact, such as a decision, a number, a date, a person, an open question or a next step. Keep each bullet under 30 words.
Put the labels of the sources that show the sentence or bullet in "cites", for example ["S2"]. Every sentence and every bullet needs at least one label.
Copy names, numbers and dates exactly as the sources write them. Write the full name of a person when the sources have it.
Never write a source label such as [S1] inside the text. The labels go in "cites" only.
Cover different sources: do not say the same fact twice.
When the sources are listed by date, tell the story in date order.
When a block ALREADY TOLD is given, do NOT repeat its facts. Give other facts from the sources.
Never use knowledge from outside the sources.`;

/** The user text of the answer call. */
export function answerUser(args: {
  history: string;
  sources: string;
  question: string;
  repair: string | null;
  /** Facts the thread already gave (a broad question asked again). */
  told?: string;
}): string {
  return [
    args.history ? `EARLIER QUESTIONS:\n${args.history}\n` : "",
    args.told ? `ALREADY TOLD (do not repeat):\n${args.told}\n` : "",
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
      : "Use search_chunks for a question about one fact, one topic, one person or one date, and when you are not sure. Use a list tool ONLY when the user asks for a whole list or a count. A `query` is the topic of the question with its names and numbers, in the language of the meeting. For a follow-up, the query holds the topic of the earlier question. Use the lists for ids.",
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

/**
 * Words that ask for a whole list or a number, in the 7 UI languages. A list
 * tool is allowed only for such a question: in the P1 eval the model chose a
 * list tool for "What did we decide on X?" and a question about one topic
 * needs search (code decides, as the router rule of spec 2.1 point 5).
 */
const LIST_RE =
  /\b(list|lists|show|display|all|every|each|which|how many|number of|liste|listar|lista|mostre|mostrar|todas?|todos|quais|quantas?|quantos|cu[aá]ntas?|cu[aá]ntos|muestra|muestre|alle|zeige|welche|wie viele|tous|toutes|montre|quels|quelles|combien|tutti|tutte|mostra|quali|quanti|elenca)\b|一覧|すべて|全部|何件|何回/iu;

export function asksForList(question: string): boolean {
  return LIST_RE.test(question);
}

/** Words that ask where a project stands, in the 7 UI languages. */
const STATUS_RE =
  /\b(where do we stand|where are we|status of|how is .* going|em que p[eé] estamos|como est[aá]|como anda|d[oó]nde estamos|c[oó]mo va|wo stehen wir|wie steht|o[uù] en sommes|o[uù] en est|a che punto|come procede)\b|どうなって|状況|進捗/iu;

export function asksForStatus(question: string): boolean {
  return STATUS_RE.test(question);
}

/** The query rewrite (cross-language step): English search words for a question in another language. */
export const QUERY_SCHEMA: StepSchema<{ query: string }> = {
  name: "chat_query",
  version: 1,
  zod: z.object({ query: z.string().max(120) }),
};

export const QUERY_SYSTEM =
  "You turn a question about meeting notes into English search words. Always write English words, even when the question is in another language. Write 3 to 8 words. Keep names and numbers as they are. Do not answer the question.";

/** The user text of the rewrite call. A bare question made the model repeat it. */
export const queryUser = (question: string): string =>
  `Question: ${question}\nEnglish search words:`;
