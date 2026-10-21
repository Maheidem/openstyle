import { overlapTokens } from "./chunking.js";
import { type MeetingSummary, valueOrNull } from "./schemas.js";

// Pure functions of the summary (specs/meeting-enhance-agentic.md 4.5.3, 4.5.6).
// WP5a owns the full bodies, because the `save` test compares the stored
// Markdown with the real function and WP5a runs before WP6. No LangGraph, no
// database, no model.

/** Hard ceiling on the LLM calls of one Summarize run (4.5.3). */
export const MAX_SUMMARIZE_CALLS = 24;
/** Assumed size of one partial summary, for the plan (4.5.3). */
export const SUMMARY_PARTIAL_TOKENS = 800;

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
 * The calls a transcript of `tokens` costs at `budget` tokens for each call:
 * 1 for a single pass, else N map calls plus the grouped reduce calls of each
 * level until one is left. A plan over `MAX_SUMMARIZE_CALLS`, or a budget that
 * cannot hold two partials, gives `budget_exceeded`.
 */
export function plannedSummaryCalls(
  tokens: number,
  budget: number,
): { calls: number } | { error: "budget_exceeded" } {
  if (tokens <= budget) return { calls: 1 };
  const fresh = Math.max(1, budget - overlapTokens(budget));
  const perGroup = Math.floor(budget / SUMMARY_PARTIAL_TOKENS);
  if (perGroup < 2) return { error: "budget_exceeded" };
  let partials = Math.ceil(tokens / fresh);
  let calls = partials;
  for (;;) {
    const groups = Math.ceil(partials / perGroup);
    calls += groups;
    if (calls > MAX_SUMMARIZE_CALLS) return { error: "budget_exceeded" };
    if (groups === 1) break;
    partials = groups;
  }
  return { calls };
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

/** The list fields of the summary. A cut can drop the last ones. */
const SUMMARY_LIST_KEYS = [
  "keyPoints",
  "decisions",
  "actionItems",
  "openQuestions",
] as const;

/**
 * The summary object of a cut answer, or null. It closes the JSON
 * (`closeCutJson`), gives each missing list field an empty list, and checks
 * the result with `schema`. The overview must be complete and not empty: it
 * is the first field, so without it the cut kept nothing useful.
 */
export function repairCutSummary<T>(
  text: string,
  schema: {
    safeParse(v: unknown): { success: true; data: T } | { success: false };
  },
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
  if (typeof obj.overview !== "string" || obj.overview.trim() === "") {
    return null;
  }
  for (const key of SUMMARY_LIST_KEYS) if (!(key in obj)) obj[key] = [];
  const parsed = schema.safeParse(obj);
  return parsed.success ? parsed.data : null;
}
