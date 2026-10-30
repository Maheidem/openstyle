import { z } from "zod";

/** The stages that a batch can run (specs/meeting-folder-batch.md). */
export const meetingStageSchema = z.enum([
  "transcribe",
  "summarize",
  "enhance",
]);
export type MeetingStage = z.infer<typeof meetingStageSchema>;

/** Per stage: the meetings that need it and can run it, and the meetings
 * that need it but cannot run it (no audio for Transcribe, no AI model for
 * Summarize and Enhance). */
const stageCountSchema = z.object({
  ready: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
});

export const folderStageCountsSchema = z.object({
  transcribe: stageCountSchema,
  summarize: stageCountSchema,
  enhance: stageCountSchema,
});

/** Start a batch: every meeting of a folder that needs the stage, or the
 * meetings of an explicit list (a re-run: they run also when done). */
export const startMeetingBatchSchema = z.union([
  // The same bounds as meetingFolderIdSchema. meeting-folders.ts imports
  // this file, so an import back would be circular.
  z.object({
    stage: meetingStageSchema,
    folder_id: z.string().min(1).max(128),
  }),
  z.object({
    stage: meetingStageSchema,
    meeting_ids: z.array(z.string().min(1).max(128)).min(1).max(200),
  }),
]);

/** Why the queue skipped a meeting. */
export const batchSkipReasonSchema = z.enum([
  "gone",
  "not_needed",
  "busy",
  "no_audio",
  "no_transcript",
  "no_llm",
  "refused",
]);
export type BatchSkipReason = z.infer<typeof batchSkipReasonSchema>;

/** Why a run that started did not finish well. */
export const batchFailReasonSchema = z.enum(["run_failed", "partly_done"]);
export type BatchFailReason = z.infer<typeof batchFailReasonSchema>;

/** The state of the batch queue. The queue lives in memory only. */
export const meetingBatchStateSchema = z.object({
  /** True while an item runs or waits. */
  active: z.boolean(),
  /** The items of the current batch (since the queue was last empty). */
  total: z.number().int().nonnegative(),
  /** Items whose run ended well. */
  done: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  /** Items that started, but whose run failed or did only part of its work. */
  failed: z.number().int().nonnegative(),
  /** Items that the user cancelled before they started. */
  cancelled: z.number().int().nonnegative(),
  skip_reasons: z.partialRecord(batchSkipReasonSchema, z.number().int()),
  fail_reasons: z.partialRecord(batchFailReasonSchema, z.number().int()),
  current: z
    .object({
      meeting_id: z.string(),
      title: z.string().nullable(),
      stage: meetingStageSchema,
    })
    .nullable(),
  /** The waiting items, in queue order. */
  pending: z.array(
    z.object({ meeting_id: z.string(), stage: meetingStageSchema }),
  ),
});
export type MeetingBatchState = z.infer<typeof meetingBatchStateSchema>;

export const meetingBatchErrorSchema = z.object({
  error: z.string(),
  code: z.enum(["folder_not_found", "invalid_request"]),
});

/** One previous summary of a meeting (a version that a new summary
 * replaced). */
export const meetingSummaryVersionSchema = z.object({
  id: z.number().int(),
  markdown: z.string().nullable(),
  llm_provider: z.string().nullable(),
  llm_model: z.string().nullable(),
  created_at: z.number().nullable(),
  replaced_at: z.number(),
  partial: z.boolean(),
});

export const meetingSummaryVersionsResponseSchema = z.object({
  items: z.array(meetingSummaryVersionSchema),
});
