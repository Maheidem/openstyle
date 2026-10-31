import type { ChatBlock, ChatCite } from "@openstyle/validations";
import { estimatePromptTokens } from "../llm/token-budget.js";
import type { Source } from "./types.js";

// The context window rules of the answer call (specs/meeting-chat-agent.md
// 2.8), as pure functions. Code decides what the model sees. The order is
// fixed: SOURCES, HISTORY, QUESTION. History never pushes a source out. A
// source drops whole and is never cut.

export const HISTORY_TOKENS_MAX = 600;
export const HISTORY_ANSWER_CHARS = 200;
const HISTORY_QUESTION_CHARS = 200;
const HISTORY_CITES_MAX = 3;

const H_SOURCES = "SOURCES:\n";
const H_HISTORY = "HISTORY:\n";
const H_QUESTION = "QUESTION:\n";

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");
const mmss = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
};

/** `[S3] <title>, <yyyy-mm-dd> <mm:ss>: <text>`. A missing part is left out. */
export function renderSource(s: Source): string {
  const when = [
    s.startedAt === null
      ? ""
      : new Date(s.startedAt).toISOString().slice(0, 10),
    s.startMs === null ? "" : mmss(s.startMs),
  ]
    .filter(Boolean)
    .join(" ");
  const head = [s.title ?? "", when].filter(Boolean).join(", ");
  const text = s.text.replace(/\s+/g, " ").trim();
  return `[${s.label}] ${head ? `${head}: ` : ""}${text}`;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface HistoryTurn {
  question: string;
  /** Short answer: the first sentence of the stored answer, or a fixed description. */
  answer: string;
  /**
   * Where the answer came from, as `title, yyyy-mm-dd`. Labels S1.. of an old
   * turn would clash with the labels of the new turn, so they are not used.
   */
  cites: string[];
}

const cutChars = (s: string, n: number) =>
  s.length <= n ? s : `${s.slice(0, Math.max(0, n - 3)).trimEnd()}...`;

function firstSentence(text: string): string {
  const t = text
    .replace(/\[S\d+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const m = t.match(/^.*?[.!?。](?=\s|$)/su);
  return (m ? m[0] : t).trim();
}

const words = (s: string) => s.replace(/_/g, " ");

function describeBlock(b: ChatBlock): string {
  switch (b.kind) {
    case "text":
      return firstSentence(b.text);
    case "list":
      return `listed ${b.total} ${words(b.list)}`;
    case "count":
      return `counted ${b.n} ${words(b.what)}`;
    case "status":
      return `showed the status: ${b.open_actions} open action items, ${b.open_questions} open questions`;
    case "read_only":
      return "said that the chat does not change data";
    case "not_found":
      return "found nothing";
  }
}

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
  blocks?: ChatBlock[];
  cites: Pick<ChatCite, "title" | "started_at">[];
}

/**
 * Past turns in compact form (spec 2.8 point 3): the question, a short
 * answer (at most 200 characters) and where it came from. A question with no
 * answer yet is left out.
 */
export function compactHistory(
  messages: readonly HistoryMessage[],
): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  for (let i = 0; i < messages.length; i++) {
    const q = messages[i];
    const a = messages[i + 1];
    if (!q || q.role !== "user" || !a || a.role !== "assistant") continue;
    i++;
    const fromText = firstSentence(a.content);
    const answer =
      fromText ||
      (a.blocks ?? []).map(describeBlock).filter(Boolean).join("; ") ||
      "gave no answer";
    const cites = [
      ...new Set(
        a.cites.map((c) =>
          [
            c.title ?? "",
            c.started_at === null
              ? ""
              : new Date(c.started_at).toISOString().slice(0, 10),
          ]
            .filter(Boolean)
            .join(", "),
        ),
      ),
    ]
      .filter(Boolean)
      .slice(0, HISTORY_CITES_MAX);
    turns.push({
      question: cutChars(
        q.content.replace(/\s+/g, " ").trim(),
        HISTORY_QUESTION_CHARS,
      ),
      answer: cutChars(answer, HISTORY_ANSWER_CHARS),
      cites,
    });
  }
  return turns;
}

/** The text of the history turns. */
export function renderHistory(turns: readonly HistoryTurn[]): string {
  return turns
    .map(
      (t) =>
        `Q: ${t.question}\nA: ${t.answer}${t.cites.length ? ` (from: ${t.cites.join("; ")})` : ""}`,
    )
    .join("\n");
}

// ---------------------------------------------------------------------------
// Assemble
// ---------------------------------------------------------------------------

export interface AssembleInput {
  system: string;
  question: string;
  /** Oldest first. */
  history: readonly HistoryTurn[];
  /** Best first. */
  sources: readonly Source[];
  /** Estimated tokens for system, sources, history and question together. */
  budgetTokens: number;
  /** The window of the model, or null when it is not known. */
  windowTokens: number | null;
  maxOutputTokens: number;
  /** Tokens that code adds outside these parts (call overhead, schema). */
  fixedTokens: number;
}

export interface Assembled {
  user: string;
  /** The SOURCES lines and the HISTORY lines alone, for a caller with its own template. */
  sourcesText: string;
  historyText: string;
  includedLabels: string[];
  droppedLabels: string[];
  historyTurnsDropped: number;
  parts: { system: number; question: number; history: number; sources: number };
  /** system + user, estimated. `fixedTokens` is not in it. */
  total: number;
}

const tokens = (s: string) => estimatePromptTokens(s);

/**
 * Fit the parts of the answer call (spec 2.8). The budget is capped by the
 * window. The question stays whole. Sources have the first claim on the
 * space: the last-ranked source drops first, whole. History gets what is left
 * (at most 600 tokens) and its oldest turns drop first.
 */
export function assembleAnswerInput(input: AssembleInput): Assembled {
  const cap =
    input.windowTokens === null
      ? input.budgetTokens
      : Math.min(
          input.budgetTokens,
          input.windowTokens - input.maxOutputTokens - input.fixedTokens,
        );
  const systemTok = tokens(input.system);
  const questionTok = tokens(input.question);
  const headings = tokens(H_SOURCES + H_HISTORY + H_QUESTION) + 4;
  const avail = Math.max(0, cap - systemTok - questionTok - headings);

  // Sources: a prefix of the ranked list. Never cut in the middle.
  const included: Source[] = [];
  let srcTok = 0;
  for (const s of input.sources) {
    const t = tokens(renderSource(s)) + 1;
    if (srcTok + t > avail) break;
    srcTok += t;
    included.push(s);
  }
  const droppedLabels = input.sources
    .slice(included.length)
    .map((s) => s.label);

  // History: the newest turns that fit in what is left.
  const histBudget = Math.min(HISTORY_TOKENS_MAX, avail - srcTok);
  let start = 0;
  while (
    start < input.history.length &&
    tokens(renderHistory(input.history.slice(start))) > histBudget
  ) {
    start++;
  }
  const kept = input.history.slice(start);
  const historyText = renderHistory(kept);

  const sourcesText = included.map(renderSource).join("\n");
  const user = [
    `${H_SOURCES}${sourcesText}`,
    ...(historyText ? [`${H_HISTORY}${historyText}`] : []),
    `${H_QUESTION}${input.question}`,
  ].join("\n\n");

  const parts = {
    system: systemTok,
    question: questionTok,
    history: tokens(historyText),
    sources: tokens(sourcesText),
  };
  return {
    user,
    sourcesText,
    historyText,
    includedLabels: included.map((s) => s.label),
    droppedLabels,
    historyTurnsDropped: start,
    parts,
    total: systemTok + tokens(user),
  };
}

// ---------------------------------------------------------------------------
// Retry after an overflow (spec 2.5b)
// ---------------------------------------------------------------------------

/** The budget for the retry after a `length` finish. */
export function halveBudget(budget: number): number {
  return Math.floor(budget / 2);
}

/**
 * The budget for the retry after `context_length_exceeded`. The error has the
 * prompt tokens and the window (`overflowNumbers`). The budget drops by the
 * overshoot times 1.5 (our estimate counts more than the worker) plus 3% of
 * the window. Without numbers, or when the result is not smaller, it halves.
 */
export function trimToErrorNumbers(input: {
  budgetTokens: number;
  maxOutputTokens: number;
  promptTokens: number | null;
  contextTokens: number | null;
}): number {
  const { promptTokens, contextTokens } = input;
  if (promptTokens === null || contextTokens === null) {
    return halveBudget(input.budgetTokens);
  }
  const overshoot = promptTokens + input.maxOutputTokens - contextTokens;
  const next =
    input.budgetTokens -
    Math.ceil(overshoot * 1.5) -
    Math.ceil(contextTokens * 0.03);
  return overshoot > 0 && next > 0 && next < input.budgetTokens
    ? next
    : halveBudget(input.budgetTokens);
}
