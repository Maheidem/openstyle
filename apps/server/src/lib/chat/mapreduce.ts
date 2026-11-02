import { estimatePromptTokens } from "../llm/token-budget.js";
import { renderSource } from "./context.js";
import type { ChatLlm } from "./llm.js";
import { MAP_MAX_TOKENS, MAP_SCHEMA, MAP_SYSTEM, mapUser } from "./prompts.js";
import type { Source } from "./types.js";

// Map step of the map-reduce synthesis (specs/meeting-chat-agent.md 11.8, D20).
// A folder or an Everything digest that does not fit the context window is
// shortened in groups. Each source keeps its label, so a cite of the final
// answer still points to a real meeting. The reduce step is the normal
// synthesis answer over the shortened sources.

/** Map calls of one turn, at most. A group beyond the cap gets the code cut. */
export const MAP_CALLS_MAX = 8;

export interface MapResult {
  sources: number;
  groups: number;
  /** Sources that kept a code cut (a failed call, or a note that added a fact). */
  fallback: number;
  calls: number;
  /** Why sources kept the code cut: a failed call, no note for the label, or a note with a number the source lacks. */
  why: { error: number; missing: number; unsafe: number };
  /** First error text of a failed call (for the trace). */
  firstError: string | null;
}

const cut = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 3)).trimEnd()}...`;
};

const digitsOf = (s: string) => s.match(/\d+(?:[.,:]\d+)*/g) ?? [];

/** A note may not hold a number that its source does not hold. */
function noteIsSafe(note: string, source: string): boolean {
  const hay = source.replace(/\s+/g, " ");
  return digitsOf(note).every((d) => hay.includes(d));
}

/** Splits sources into groups that each fit `groupTokens`. Order is kept. */
export function groupSources(
  sources: readonly Source[],
  groupTokens: number,
  maxPerGroup = Number.POSITIVE_INFINITY,
): Source[][] {
  const groups: Source[][] = [];
  let cur: Source[] = [];
  let used = 0;
  for (const s of sources) {
    const t = estimatePromptTokens(renderSource(s)) + 1;
    if (
      cur.length > 0 &&
      (used + t > groupTokens || cur.length >= maxPerGroup)
    ) {
      groups.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(s);
    used += t;
  }
  if (cur.length > 0) groups.push(cur);
  return groups;
}

/**
 * Replaces the text of each source with a short note. `noteChars` caps a note.
 * Never throws for a model error: that group keeps the code cut. A client
 * abort or the deadline is re-thrown by the caller's check (`onGroup`).
 */
export async function mapNotes(args: {
  sources: Source[];
  question: string;
  llm: ChatLlm;
  signal: AbortSignal;
  groupTokens: number;
  noteChars: number;
  /** Called before each group; the pipeline returns a stop reason to end the turn. */
  stop: () => string | null;
  onGroup?: (done: number, total: number) => void;
}): Promise<MapResult & { stopped: string | null }> {
  // The notes of one group must fit the output cap: about 2.5 characters per
  // token (a small model writes long JSON), plus the JSON around each note.
  const perNote = Math.ceil(args.noteChars / 2.5) + 30;
  const groups = groupSources(
    args.sources,
    args.groupTokens,
    Math.max(3, Math.floor((MAP_MAX_TOKENS * 0.7) / perNote)),
  );
  const result: MapResult = {
    sources: args.sources.length,
    groups: groups.length,
    fallback: 0,
    calls: 0,
    why: { error: 0, missing: 0, unsafe: 0 },
    firstError: null,
  };
  const words = Math.max(12, Math.round(args.noteChars / 6));
  let g = 0;
  for (const group of groups) {
    const why = args.stop();
    if (why) return { ...result, stopped: why };
    const original = new Map(group.map((s) => [s.label, s.text]));
    const fallbackFor = (s: Source) => {
      s.text = cut(original.get(s.label) ?? s.text, args.noteChars);
      result.fallback++;
    };
    if (result.calls >= MAP_CALLS_MAX) {
      for (const s of group) fallbackFor(s);
      continue;
    }
    result.calls++;
    args.onGroup?.(++g, groups.length);
    let notes: { label: string; note: string }[] = [];
    let failed = false;
    try {
      const r = await args.llm.structured({
        step: "chatAnswer",
        unitKey: `map/${g}`,
        schema: MAP_SCHEMA,
        system: MAP_SYSTEM,
        messages: [
          {
            role: "user",
            content: mapUser({
              sources: group.map(renderSource).join("\n"),
              question: args.question,
              words,
            }),
          },
        ],
        maxOutputTokens: MAP_MAX_TOKENS,
      });
      notes = r.object.notes;
    } catch (e) {
      if (args.signal.aborted) throw e;
      failed = true;
      result.firstError ??= ((e as Error).message ?? "error").slice(0, 100);
    }
    // The model may write "[S5]" or "S5": the label is the S and its digits.
    const byLabel = new Map(
      notes.map((n) => [n.label.match(/S\d+/)?.[0] ?? n.label, n.note.trim()]),
    );
    for (const s of group) {
      const note = byLabel.get(s.label);
      const src = original.get(s.label) ?? s.text;
      if (note && noteIsSafe(note, src)) {
        s.text = cut(note, args.noteChars);
      } else {
        result.why[failed ? "error" : note ? "unsafe" : "missing"]++;
        fallbackFor(s);
      }
    }
  }
  return { ...result, stopped: null };
}
