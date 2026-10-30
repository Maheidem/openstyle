import { z } from "zod";
import { calendarEventSchema } from "./meeting-calendar.js";
import type { MeetingDetail } from "./meeting-types.js";

const meetingRecordSchema = z.object({
  id: z.string(),
  folder_id: z.string().nullable(),
  title: z.string().nullable(),
  started_at: z.number().nullable(),
  ended_at: z.number().nullable(),
  duration_ms: z.number().nullable(),
  status: z.string(),
  display_status: z.string().optional(),
  language: z.string().nullable(),
  error: z.string().nullable(),
  created_at: z.number().nullable(),
  stt_provider: z.string().nullable(),
  stt_model: z.string().nullable(),
  audio_dir: z.string().nullable(),
  context: z.string().nullable(),
});

const meetingJobPhaseSchema = z.enum([
  "diarizing",
  "transcribing",
  "preparing",
  "reading",
  "speakers",
  "summarizing",
  "combining",
  "saving",
  "tags",
]);

const meetingJobKindSchema = z.enum([
  "transcribe",
  "retry-failed",
  "diarize",
  "summarize",
  "enhance",
]);

/** Set while one of the job's LLM calls waits for its lane. */
const meetingJobQueuedSchema = z
  .object({ ahead: z.number(), sinceMs: z.number() })
  .nullable()
  .optional();

export const meetingListResponseSchema = z.object({
  items: z.array(
    meetingRecordSchema.extend({
      job: z
        .object({
          kind: meetingJobKindSchema.nullable().optional(),
          phase: meetingJobPhaseSchema.optional(),
          done: z.number(),
          total: z.number(),
          queued: meetingJobQueuedSchema,
        })
        .nullable()
        .optional(),
    }),
  ),
  total: z.number().int().nonnegative(),
});

export const meetingDetailResponseSchema = meetingRecordSchema.extend({
  retention_exempt: z.boolean().optional(),
  speaker_names_lost: z.array(z.string()).optional(),
  tags: z.array(z.string()),
  calendar: calendarEventSchema.nullable(),
  job: z
    .object({
      done: z.number(),
      total: z.number(),
      failed: z.number(),
      kind: meetingJobKindSchema.nullable().optional(),
      queued: meetingJobQueuedSchema,
      phase: meetingJobPhaseSchema.optional(),
      step: z.number().nullable().optional(),
      steps: z.number().nullable().optional(),
      detail: z.string().nullable().optional(),
    })
    .nullable(),
  segment_counts: z.object({ total: z.number(), failed: z.number() }),
  track_ratio_warning: z.number().nullable(),
  track_repair: z
    .object({
      fromRate: z.number(),
      toRate: z.number(),
      repaired: z.boolean(),
    })
    .nullable(),
  summary: z
    .object({
      markdown: z.string().nullable(),
      llm_provider: z.string().nullable(),
      llm_model: z.string().nullable(),
      cost_usd: z.number().nullable(),
      created_at: z.number().nullable(),
      meeting_id: z.string().optional(),
      input_tokens: z.number().nullable().optional(),
      output_tokens: z.number().nullable().optional(),
      summary_json: z.string().nullable().optional(),
      partial: z.boolean().optional(),
    })
    .nullable(),
}) satisfies z.ZodType<MeetingDetail>;
