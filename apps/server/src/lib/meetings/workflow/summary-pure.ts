import { overlapTokens } from "./chunking.js";
import {
  type MeetingSummary,
  type SummaryStageAnswer,
  valueOrNull,
  withoutDuplicates,
} from "./schemas.js";

// Pure functions of the summary (specs/meeting-enhance-agentic.md 4.5.3, 4.5.6).
// WP5a owns the full bodies, because the `save` test compares the stored
// Markdown with the real function and WP5a runs before WP6. No LangGraph, no
// database, no model.

/**
 * Hard ceiling on the LLM calls of one Summarize run (4.5.3). A part costs
 * SUMMARY_CALLS_PER_PART calls and the overview one more, so 40 calls hold 13
 * parts: at the default budget of 8000 tokens, about 100,000 transcript tokens.
 */
export const MAX_SUMMARIZE_CALLS = 40;
/** The extraction calls of one transcript part (decisions, action items, points). */
export const SUMMARY_CALLS_PER_PART = 3;

/** Replace line breaks with spaces, so one item stays one list line. */
export function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

/** Remove any line that starts with `#`, so a model string cannot add a heading. */
export function paragraphs(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .trim();
}

/** Code renders the object. The model does not write Markdown. */
export function renderSummaryMarkdown(s: MeetingSummary): string {
  const list = (a: string[]) =>
    a.length ? a.map((t) => `- ${oneLine(t)}`).join("\n") : "None.";
  const act = s.actionItems.map((a) => {
    // The render takes any object, also one that did not pass the parse.
    const owner = valueOrNull(a.owner);
    const due = valueOrNull(a.due);
    const meta = [
      owner && `Owner: ${oneLine(owner)}`,
      due && `Due: ${oneLine(due)}`,
    ].filter(Boolean);
    return `- ${oneLine(a.task)}${meta.length ? ` (${meta.join("; ")})` : ""}`;
  });
  return [
    `## Overview\n${paragraphs(s.overview)}`,
    `## Key Points\n${list(s.keyPoints)}`,
    `## Decisions\n${list(s.decisions)}`,
    `## Action Items\n${act.length ? act.join("\n") : "None."}`,
    `## Open Questions\n${list(s.openQuestions)}`,
  ].join("\n\n");
}

/**
 * The parts of a transcript of `tokens` at `budget` tokens for each part: 1
 * when it fits, else one part for each `budget` minus its overlap.
 */
export function plannedSummaryParts(tokens: number, budget: number): number {
  if (tokens <= budget) return 1;
  const fresh = Math.max(1, budget - overlapTokens(budget));
  return Math.ceil(tokens / fresh);
}

/** The calls of `parts` transcript parts: three per part, then the overview. */
export function summaryCallsFor(parts: number): number {
  return SUMMARY_CALLS_PER_PART * parts + 1;
}

/**
 * The calls a transcript of `tokens` costs at `budget` tokens for each part
 * (`summaryCallsFor`). A plan over `MAX_SUMMARIZE_CALLS` gives
 * `budget_exceeded`.
 */
export function plannedSummaryCalls(
  tokens: number,
  budget: number,
): { calls: number } | { error: "budget_exceeded" } {
  const calls = summaryCallsFor(plannedSummaryParts(tokens, budget));
  return calls > MAX_SUMMARIZE_CALLS ? { error: "budget_exceeded" } : { calls };
}

// ---------------------------------------------------------------------------
// Merge of the stage answers, and the owner check (code after the calls)
// ---------------------------------------------------------------------------

/** The four lists of a summary, without the overview. */
export type SummaryItems = Omit<MeetingSummary, "overview">;

/**
 * Join the answers of the extraction calls, in part order, into one set of
 * lists, and remove the duplicates (`withoutDuplicates`): the parts overlap,
 * so one item can come from two parts.
 */
export function mergeSummaryAnswers(
  answers: readonly SummaryStageAnswer[],
): SummaryItems {
  const items: SummaryItems = {
    keyPoints: answers.flatMap((a) => a.keyPoints ?? []),
    decisions: answers.flatMap((a) => a.decisions ?? []),
    actionItems: answers.flatMap((a) => a.actionItems ?? []),
    openQuestions: answers.flatMap((a) => a.openQuestions ?? []),
  };
  return withoutDuplicates(items);
}

const wordsOf = (text: string) =>
  text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * The owner of an action item when the transcript supports it, else null
 * (issue #273). An owner is supported when it is a speaker label of the
 * transcript ("Me", "Them 2", a confirmed name), or when each of its words is
 * in the transcript or in a label: a name that the speakers say. A name that
 * only the context or the title holds is not supported: they do not say which
 * label is which person.
 */
export function supportedOwner(
  owner: string | null,
  labels: readonly string[],
  transcript: string,
): string | null {
  const value = valueOrNull(owner);
  if (value === null) return null;
  const key = value.replace(/\s+/g, " ").trim().toLowerCase();
  if (labels.some((l) => l.trim().toLowerCase() === key)) return value;
  const known = new Set([...wordsOf(transcript), ...labels.flatMap(wordsOf)]);
  const words = wordsOf(value);
  return words.length > 0 && words.every((w) => known.has(w)) ? value : null;
}

/** The items with each unsupported owner set to null (`supportedOwner`). */
export function withSupportedOwners(
  items: SummaryItems,
  labels: readonly string[],
  transcript: string,
): { items: SummaryItems; dropped: number } {
  let dropped = 0;
  const actionItems = items.actionItems.map((a) => {
    const owner = supportedOwner(a.owner, labels, transcript);
    if (owner === null && valueOrNull(a.owner) !== null) dropped++;
    return { ...a, owner };
  });
  return { items: { ...items, actionItems }, dropped };
}

// ---------------------------------------------------------------------------
// Repair of a cut summary (PR #258)
// ---------------------------------------------------------------------------

type Frame = { kind: "{" | "["; expect: "key" | "colon" | "value" | "comma" };

const LITERAL = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/;

/**
 * Close a JSON text that the token limit cut. The result ends at the last
 * point where the text closes into valid JSON: after a complete element of a
 * list, or after a complete member of the top object. So a cut last item is
 * dropped, not closed half-written. Null when no such point exists (the text
 * does not start with an object, or no member is complete).
 */
export function closeCutJson(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0 || text.slice(0, start).trim() !== "") return null;
  const stack: Frame[] = [];
  let cut: { end: number; closers: string } | null = null;
  const closersOf = () =>
    stack
      .map((f) => (f.kind === "{" ? "}" : "]"))
      .reverse()
      .join("");
  /** A value ended at `end` (exclusive) in the frame on top of the stack. */
  const valueDone = (end: number) => {
    const top = stack[stack.length - 1];
    if (!top) return;
    top.expect = "comma";
    if (top.kind === "[" || stack.length === 1) {
      cut = { end, closers: closersOf() };
    }
  };
  let i = start;
  while (i < text.length) {
    const ch = text[i] as string;
    const top = stack[stack.length - 1];
    if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t") {
      i += 1;
      continue;
    }
    if (ch === '"') {
      // Find the end of the string; a cut string has none.
      let j = i + 1;
      let closed = false;
      while (j < text.length) {
        const c = text[j];
        if (c === "\\") j += 2;
        else if (c === '"') {
          closed = true;
          break;
        } else j += 1;
      }
      if (!closed) break;
      i = j + 1;
      if (top?.kind === "{" && top.expect === "key") top.expect = "colon";
      else valueDone(i);
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push({ kind: ch, expect: ch === "{" ? "key" : "value" });
      i += 1;
      continue;
    }
    if (ch === "}" || ch === "]") {
      stack.pop();
      i += 1;
      if (stack.length === 0) {
        cut = { end: i, closers: "" };
        break;
      }
      valueDone(i);
      continue;
    }
    if (ch === ":") {
      if (top) top.expect = "value";
      i += 1;
      continue;
    }
    if (ch === ",") {
      if (top) top.expect = top.kind === "{" ? "key" : "value";
      i += 1;
      continue;
    }
    const lit = LITERAL.exec(text.slice(i));
    // A literal that touches the end of the text may be cut ("tru", "12").
    if (!lit || i + lit[0].length >= text.length) break;
    i += lit[0].length;
    valueDone(i);
  }
  if (cut === null) return null;
  const { end, closers } = cut as { end: number; closers: string };
  return text.slice(start, end) + closers;
}

/**
 * The answer object of a cut stage answer, or null. It closes the JSON
 * (`closeCutJson`), gives each missing field of `lists` an empty list, and
 * checks the result with `schema`. A cut string field (the overview) cannot
 * close, so its answer stays null.
 */
export function repairCutAnswer<T>(
  text: string,
  schema: {
    safeParse(v: unknown): { success: true; data: T } | { success: false };
  },
  lists: readonly string[],
): T | null {
  const closed = closeCutJson(text);
  if (closed === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(closed);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  for (const key of lists) if (!(key in obj)) obj[key] = [];
  const parsed = schema.safeParse(obj);
  return parsed.success ? parsed.data : null;
}
