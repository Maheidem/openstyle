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
  language: z.string().nullable(),
  error: z.string().nullable(),
  created_at: z.number().nullable(),
  stt_provider: z.string().nullable(),
  stt_model: z.string().nullable(),
  audio_dir: z.string().nullable(),
  context: z.string().nullable(),
});

export const meetingListResponseSchema = z.object({
  items: z.array(meetingRecordSchema),
  total: z.number().int().nonnegative(),
});

export const meetingDetailResponseSchema = meetingRecordSchema.extend({
  calendar: calendarEventSchema.nullable(),
  job: z
    .object({
      done: z.number(),
      total: z.number(),
      failed: z.number(),
      kind: z
        .enum(["transcribe", "retry-failed", "diarize", "summarize", "enhance"])
        .nullable()
        .optional(),
      queued: z
        .object({ ahead: z.number(), sinceMs: z.number() })
        .nullable()
        .optional(),
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
    })
    .nullable(),
}) satisfies z.ZodType<MeetingDetail>;
