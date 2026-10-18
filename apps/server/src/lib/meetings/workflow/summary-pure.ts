import { overlapTokens } from "./chunking.js";
import type { MeetingSummary } from "./schemas.js";

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
    const meta = [
      a.owner && `Owner: ${oneLine(a.owner)}`,
      a.due && `Due: ${oneLine(a.due)}`,
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
