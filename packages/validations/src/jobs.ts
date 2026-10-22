import { z } from "zod";

// GET /api/jobs (issue #317, tray popover step 2): the meeting jobs that run
// or wait now, and the state of the built-in MLX models. Read only.

export const MEETING_JOB_KINDS = [
  "transcribe",
  "retry-failed",
  "diarize",
  "summarize",
  "enhance",
] as const;

export const meetingJobItemSchema = z.object({
  meeting_id: z.string(),
  /** The meeting title, or null when the meeting has none. */
  title: z.string().nullable(),
  kind: z.enum(MEETING_JOB_KINDS).nullable(),
  /** The coarse phase of the job, or null. */
  phase: z.string().nullable(),
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  /** Set while the job waits for the LLM lane. `ahead` is the queue place. */
  queued: z.object({ ahead: z.number().int().nonnegative() }).nullable(),
});
export type MeetingJobItem = z.infer<typeof meetingJobItemSchema>;

export const MODEL_JOB_TYPES = ["voice", "llm", "embedding"] as const;

/**
 * `loading`: the model is on disk and its worker starts now. `ready`: on
 * disk (the worker can be stopped). `error`: the model cannot run here.
 */
export const MODEL_JOB_STATUSES = [
  "not_downloaded",
  "downloading",
  "loading",
  "ready",
  "error",
] as const;

export const modelJobItemSchema = z.object({
  type: z.enum(MODEL_JOB_TYPES),
  model: z.string(),
  display_name: z.string(),
  status: z.enum(MODEL_JOB_STATUSES),
  /** The size of the model on disk, from the catalog. */
  size_bytes: z.number().nonnegative(),
  /** Only while the status is `downloading`. */
  download: z
    .object({
      bytes_done: z.number().nonnegative(),
      bytes_total: z.number().nonnegative(),
      percent: z.number().min(0).max(100),
    })
    .nullable(),
});
export type ModelJobItem = z.infer<typeof modelJobItemSchema>;

export const jobsResponseSchema = z.object({
  meetings: z.array(meetingJobItemSchema),
  models: z.array(modelJobItemSchema),
});
export type JobsResponse = z.infer<typeof jobsResponseSchema>;
