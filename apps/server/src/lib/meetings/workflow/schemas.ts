import { z } from "zod";
import type { StepSchema } from "../../llm/gateway.js";
import { FULL_SEGMENT_RULE } from "./prompts.js";
import { NAME_MAX_CHARS, QUOTE_MAX_CHARS } from "./types.js";

// The fixed answer schemas of the three LLM nodes (specs/meeting-enhance-agentic.md
// 4.2.1, 4.3.1, 4.5.1). Strict-mode rules (4.0.3): every field is required and
// `.nullable()` marks an absent value; no `.optional()`, no `.default()`, no
// size limits (exceptions: `identifySpeakersStepSchema` and
// `meetingSummaryStepSchema` with `sizeLimits` for the local MLX LLM). Field order is generation order. Code checks sizes after the
// parse. Change a schema, and bump WORKFLOW_GRAPH_VERSION (3.4).
//
// The ids and labels exception (owner decision 2026-10-20): small local models
// do not copy an id exactly. So `correctChunk` and `identifySpeakers` send a
// schema for each call, with an enum of the ids or labels that the call shows
// (`correctChunkStepSchema`, `identifySpeakersStepSchema`). The zod side
// normalizes the value; the node checks it after the parse, as before.

export const CorrectChunkSchema = z.object({
  corrections: z.array(z.object({ id: z.string(), text: z.string() })),
});
export type CorrectChunk = z.infer<typeof CorrectChunkSchema>;

export const IdentifySpeakersSchema = z.object({
  speakers: z.array(
    z.object({
      segmentId: z.string(), // the line that holds the evidence
      quote: z.string(), // one verbatim quote from that line
      label: z.string(), // "2" for "Them 2"
      kind: z.enum(["name", "role"]),
      name: z.string(), // the name, or the role descriptor
    }),
  ),
});
export type IdentifySpeakers = z.infer<typeof IdentifySpeakersSchema>;

/** Words that a model writes in place of a JSON null (any case, trimmed). */
const NO_VALUE_WORDS = new Set(["", "null", "none", "n/a", "unknown"]);

/**
 * The value, or null when it is absent: null, empty, or a placeholder word
 * such as "null" or "N/A". A small model can write the string "null" for an
 * owner that the transcript does not name.
 */
export function valueOrNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  return NO_VALUE_WORDS.has(value.trim().toLowerCase()) ? null : value;
}

/** The text of a list entry as the duplicate check compares it. */
function sameText(value: string | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** The first entry of each key, in the order of the list. */
function uniqueBy<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Short words that carry no content for the repeat check. */
const FILLER_WORDS = new Set(
  "the and for with that this will was were are has have had not but from into onto about after before their them they then than its our your who whom what when which also all any can may must should would could shall agreed agree decided decide".split(
    " ",
  ),
);

/** The content words of a list entry: lower case, 3 letters or more, no filler. */
function contentWords(value: string): Set<string> {
  const words = value
    .toLowerCase()
    .replace(/'s\b/gu, "")
    .match(/[\p{L}\p{N}]+/gu);
  return new Set(
    (words ?? []).filter((w) => w.length >= 3 && !FILLER_WORDS.has(w)),
  );
}

/** The share of task words that the decision holds, at which it repeats the task. */
const REPEAT_SHARE = 0.6;

/**
 * True when the decision only restates an action item: it holds at least
 * REPEAT_SHARE of the content words of one task ("Ana will send the deck"
 * and the task "Send the deck"). Gemma 4 wrote follow-ups in both lists
 * (#211).
 */
export function repeatsActionItem(
  decision: string,
  tasks: readonly string[],
): boolean {
  const d = contentWords(decision);
  return tasks.some((task) => {
    const t = contentWords(task);
    if (t.size === 0) return false;
    let shared = 0;
    for (const w of t) if (d.has(w)) shared++;
    return shared / t.size >= REPEAT_SHARE;
  });
}

/**
 * Remove the duplicate entries of each list; keep the order (issue #246).
 * Two entries are the same when they are equal after a change to lower case
 * and one space for each run of spaces. An action item compares task, owner
 * and due. A decision that only restates an action item goes too
 * (`repeatsActionItem`, #211): the follow-up stays in its own list.
 */
export function withoutDuplicates<
  S extends {
    keyPoints: string[];
    decisions: string[];
    actionItems: { task: string; owner: string | null; due: string | null }[];
    openQuestions: string[];
  },
>(summary: S): S {
  const tasks = summary.actionItems.map((a) => a.task);
  return {
    ...summary,
    keyPoints: uniqueBy(summary.keyPoints, sameText),
    decisions: uniqueBy(summary.decisions, sameText).filter(
      (d) => !repeatsActionItem(d, tasks),
    ),
    actionItems: uniqueBy(summary.actionItems, (a) =>
      [a.task, a.owner, a.due].map(sameText).join("\u0000"),
    ),
    openQuestions: uniqueBy(summary.openQuestions, sameText),
  };
}

/**
 * The size limits of the summary schema for a grammar engine that applies
 * them (`meetingSummaryStepSchema` with `sizeLimits`, issue #246).
 */
export const SUMMARY_SIZE_LIMITS = {
  keyPoints: 16,
  decisions: 8,
  actionItems: 10,
  openQuestions: 8,
  itemChars: 300,
  overviewChars: 1500,
  ownerDueChars: 80,
} as const;

/**
 * The summary object. With `limits`, the JSON Schema gets `maxItems` and
 * `maxLength`; the zod side accepts any size in both cases. The parse removes
 * duplicate list entries (`withoutDuplicates`).
 */
function meetingSummaryObject(limits: boolean) {
  const L = SUMMARY_SIZE_LIMITS;
  const text = (max: number) =>
    limits ? z.string().meta({ maxLength: max }) : z.string();
  const list = <T extends z.ZodType>(item: T, max: number) =>
    limits ? z.array(item).meta({ maxItems: max }) : z.array(item);
  const nullableText = () =>
    (limits ? z.string().meta({ maxLength: L.ownerDueChars }) : z.string())
      .nullable()
      .transform(valueOrNull);
  return z
    .object({
      overview: text(L.overviewChars),
      keyPoints: list(text(L.itemChars), L.keyPoints),
      decisions: list(text(L.itemChars), L.decisions),
      actionItems: list(
        z.object({
          task: text(L.itemChars),
          owner: nullableText(), // null when the transcript names no owner
          due: nullableText(), // time as spoken, e.g. "next Friday". null when none
        }),
        L.actionItems,
      ),
      openQuestions: list(text(L.itemChars), L.openQuestions),
    })
    .transform(withoutDuplicates);
}

export const MeetingSummarySchema = meetingSummaryObject(false);
export type MeetingSummary = z.infer<typeof MeetingSummarySchema>;

export const MeetingTagsSchema = z.object({
  tags: z.array(z.string()),
});
export type MeetingTags = z.infer<typeof MeetingTagsSchema>;

/** Remove spaces and one pair of surrounding brackets: "[s1]" to "s1". */
export function normalizeId(value: string): string {
  const trimmed = value.trim();
  const inner = /^\[(.*)\]$/s.exec(trimmed);
  return (inner ? inner[1]! : trimmed).trim();
}

/**
 * Normalize a speaker label to its number: "Them 1", "them 1", "Speaker 1",
 * "[1]" and " 1 " all become "1".
 */
export function normalizeLabel(value: string): string {
  return normalizeId(value)
    .replace(/^(?:them|speaker)\s*/i, "")
    .trim();
}

/**
 * A string with an enum of `values` in its JSON Schema. A strict provider can
 * then only write one of the values. The zod side normalizes the value and
 * accepts any string: the node checks each entry after the parse and drops a
 * bad one alone (`unknown_id`, `unknown_segment`, `unknown_label`), so one bad
 * entry does not fail the whole answer of a provider that only reads the
 * schema in the prompt. The
 * AI SDK converts the zod input side, and `.meta` adds the enum to that side.
 */
function enumOf(values: readonly string[], normalize: (v: string) => string) {
  return z
    .string()
    .transform(normalize)
    .meta({ enum: [...new Set(values)] });
}

/** The schemas as the gateway takes them: wire name, stored version, zod object. */
export const CORRECT_CHUNK_STEP_SCHEMA: StepSchema<CorrectChunk> = {
  name: "correct_chunk",
  version: 1,
  zod: CorrectChunkSchema,
};
/**
 * The `correctChunk` schema of one call: `corrections[].id` is an enum of the
 * ids of the segments that the call shows. Version 2 is the enum shape.
 * Version 3 adds the full-segment description on `text` (FULL_SEGMENT_RULE).
 */
export function correctChunkStepSchema(
  ids: readonly string[],
): StepSchema<CorrectChunk> {
  return {
    name: CORRECT_CHUNK_STEP_SCHEMA.name,
    version: 3,
    zod: z.object({
      corrections: z.array(
        z.object({
          id: enumOf(ids, normalizeId),
          text: z.string().describe(FULL_SEGMENT_RULE),
        }),
      ),
    }),
  };
}

export const IDENTIFY_SPEAKERS_STEP_SCHEMA: StepSchema<IdentifySpeakers> = {
  name: "identify_speakers",
  version: 1,
  zod: IdentifySpeakersSchema,
};
/**
 * The `identifySpeakers` schema of one call: `segmentId` is an enum of the ids
 * of the lines that the call shows, and `label` is an enum of the label
 * numbers to identify. Version 2 is the label enum. Version 3 adds the
 * `segmentId` enum. Version 4 adds `sizeLimits`.
 *
 * `sizeLimits`: only for a grammar engine that applies JSON Schema size
 * keywords (the local MLX LLM, llguidance). The array gets `maxItems` = the
 * number of labels, `quote` gets `maxLength` = QUOTE_MAX_CHARS and `name` gets
 * `maxLength` = NAME_MAX_CHARS. Without them a small model writes one entry
 * for each line and copies the full line, so it hits the output limit of
 * 4.3.5 and returns nothing. Cloud providers reject these keywords (4.0.3
 * rule 4), so the default schema has none. The zod side accepts any size:
 * `verifyEvidence` checks the sizes after the parse, as before.
 */
export function identifySpeakersStepSchema(
  ids: readonly string[],
  labels: readonly string[],
  opts: { sizeLimits?: boolean } = {},
): StepSchema<IdentifySpeakers> {
  const row = IdentifySpeakersSchema.shape.speakers.element;
  const limits = opts.sizeLimits === true;
  const sized = (max: number) =>
    limits ? z.string().meta({ maxLength: max }) : z.string();
  const item = row.extend({
    segmentId: enumOf(ids, normalizeId),
    quote: sized(QUOTE_MAX_CHARS),
    label: enumOf(labels, normalizeLabel),
    name: sized(NAME_MAX_CHARS),
  });
  const speakers = limits
    ? z.array(item).meta({ maxItems: new Set(labels).size })
    : z.array(item);
  return {
    name: IDENTIFY_SPEAKERS_STEP_SCHEMA.name,
    version: 4,
    zod: z.object({ speakers }),
  };
}

export const MEETING_SUMMARY_STEP_SCHEMA: StepSchema<MeetingSummary> = {
  name: "meeting_summary",
  version: 1,
  zod: MeetingSummarySchema,
};
/**
 * The `summarize` schema of one call (map, reduce and single). Version 2 adds
 * `sizeLimits` and the duplicate removal of the parse.
 *
 * `sizeLimits`: only for a grammar engine that applies JSON Schema size
 * keywords (the local MLX LLM, llguidance). Each list gets `maxItems` and
 * each string gets `maxLength` (SUMMARY_SIZE_LIMITS). Without them Gemma 4
 * E2B wrote one key point again and again until the output limit, so the
 * answer did not parse (issue #246). Cloud providers reject these keywords
 * (4.0.3 rule 4), so the default schema has none.
 */
export function meetingSummaryStepSchema(
  opts: { sizeLimits?: boolean } = {},
): StepSchema<MeetingSummary> {
  return {
    name: MEETING_SUMMARY_STEP_SCHEMA.name,
    version: 2,
    zod:
      opts.sizeLimits === true
        ? meetingSummaryObject(true)
        : MeetingSummarySchema,
  };
}

export const MEETING_TAGS_STEP_SCHEMA: StepSchema<MeetingTags> = {
  name: "meeting_tags",
  version: 1,
  zod: MeetingTagsSchema,
};
