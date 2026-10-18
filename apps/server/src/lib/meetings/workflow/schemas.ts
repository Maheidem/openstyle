import { z } from "zod";
import type { StepSchema } from "../../llm/gateway.js";

// The fixed answer schemas of the three LLM nodes (specs/meeting-enhance-agentic.md
// 4.2.1, 4.3.1, 4.5.1). Strict-mode rules (4.0.3): every field is required and
// `.nullable()` marks an absent value; no `.optional()`, no `.default()`, no
// size limits, no enum of ids. Field order is generation order. Code checks sizes
// after the parse. Change a schema, and bump WORKFLOW_GRAPH_VERSION (3.4).

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

/** The schemas as the gateway takes them: wire name, stored version, zod object. */
export const CORRECT_CHUNK_STEP_SCHEMA: StepSchema<CorrectChunk> = {
  name: "correct_chunk",
  version: 1,
  zod: CorrectChunkSchema,
};
export const IDENTIFY_SPEAKERS_STEP_SCHEMA: StepSchema<IdentifySpeakers> = {
  name: "identify_speakers",
  version: 1,
  zod: IdentifySpeakersSchema,
};
export const MEETING_SUMMARY_STEP_SCHEMA: StepSchema<MeetingSummary> = {
  name: "meeting_summary",
  version: 1,
  zod: MeetingSummarySchema,
};
