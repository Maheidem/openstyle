import { z } from "zod";
import type { StepSchema } from "../../llm/gateway.js";

// The fixed answer schemas of the three LLM nodes (specs/meeting-enhance-agentic.md
// 4.2.1, 4.3.1, 4.5.1). Strict-mode rules (4.0.3): every field is required and
// `.nullable()` marks an absent value; no `.optional()`, no `.default()`, no
// size limits. Field order is generation order. Code checks sizes after the
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

export const MeetingSummarySchema = z.object({
  overview: z.string(),
  keyPoints: z.array(z.string()),
  decisions: z.array(z.string()),
  actionItems: z.array(
    z.object({
      task: z.string(),
      owner: z.string().nullable(), // null when the transcript names no owner
      due: z.string().nullable(), // time as spoken, e.g. "next Friday". null when none
    }),
  ),
  openQuestions: z.array(z.string()),
});
export type MeetingSummary = z.infer<typeof MeetingSummarySchema>;

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
 * bad one alone (`unknown_id`, `unknown_label`), so one bad entry does not fail
 * the whole answer of a provider that only reads the schema in the prompt. The
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
 */
export function correctChunkStepSchema(
  ids: readonly string[],
): StepSchema<CorrectChunk> {
  return {
    name: CORRECT_CHUNK_STEP_SCHEMA.name,
    version: 2,
    zod: z.object({
      corrections: z.array(
        z.object({ id: enumOf(ids, normalizeId), text: z.string() }),
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
 * The `identifySpeakers` schema of one call: `label` is an enum of the label
 * numbers to identify, and `segmentId` loses surrounding brackets. Version 2
 * is the enum shape.
 */
export function identifySpeakersStepSchema(
  labels: readonly string[],
): StepSchema<IdentifySpeakers> {
  const row = IdentifySpeakersSchema.shape.speakers.element;
  return {
    name: IDENTIFY_SPEAKERS_STEP_SCHEMA.name,
    version: 2,
    zod: z.object({
      speakers: z.array(
        row.extend({
          segmentId: z.string().transform(normalizeId),
          label: enumOf(labels, normalizeLabel),
        }),
      ),
    }),
  };
}

export const MEETING_SUMMARY_STEP_SCHEMA: StepSchema<MeetingSummary> = {
  name: "meeting_summary",
  version: 1,
  zod: MeetingSummarySchema,
};
