import { z } from "zod";
import { folderStageCountsSchema } from "./meeting-batch.js";
import { folderColorSchema } from "./meeting-folders.js";

// The Overview of a folder (issue #374, specs/folder-project-page.md). Code
// computes it from stored data on every read. It holds no LLM text.

/** A meeting that a list entry comes from. */
export const overviewSourceSchema = z.object({
  meeting_id: z.string(),
  title: z.string().nullable(),
  started_at: z.number().nullable(),
});
export type OverviewSource = z.infer<typeof overviewSourceSchema>;

export const overviewDecisionSchema = z.object({
  text: z.string(),
  sources: z.array(overviewSourceSchema).min(1),
});

export const overviewActionItemSchema = z.object({
  /** The key of the oldest member. The done route takes it. */
  key: z.string(),
  text: z.string(),
  owner: z.string().nullable(),
  due: z.string().nullable(),
  done: z.boolean(),
  sources: z.array(overviewSourceSchema).min(1),
});
export type OverviewActionItem = z.infer<typeof overviewActionItemSchema>;

export const overviewTimelineEntrySchema = z.object({
  meeting_id: z.string(),
  title: z.string().nullable(),
  started_at: z.number().nullable(),
  duration_ms: z.number().nullable(),
  /** One line from the summary, or null when the meeting has no summary. */
  gist: z.string().nullable(),
});

export const folderOverviewSchema = z.object({
  folder: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    color: folderColorSchema.nullable().catch(null),
  }),
  counts: z.object({
    meetings: z.number().int().nonnegative(),
    summarized: z.number().int().nonnegative(),
    total_duration_ms: z.number().nonnegative(),
    first_meeting_at: z.number().nullable(),
    last_meeting_at: z.number().nullable(),
    stage_counts: folderStageCountsSchema,
  }),
  timeline: z.array(overviewTimelineEntrySchema),
  decisions: z.array(overviewDecisionSchema),
  action_items: z.array(overviewActionItemSchema),
  open_questions: z.array(overviewDecisionSchema),
  people: z.array(
    z.object({ name: z.string(), meeting_count: z.number().int().positive() }),
  ),
  tags: z.array(
    z.object({ name: z.string(), meeting_count: z.number().int().positive() }),
  ),
  /** The newest of: a meeting start and a summary save. */
  last_activity: z.number().nullable(),
});
export type FolderOverview = z.infer<typeof folderOverviewSchema>;

export const setActionItemDoneSchema = z.object({ done: z.boolean() });

export const actionItemKeySchema = z.string().regex(/^[0-9a-f]{16}$/);

export const setActionItemDoneResponseSchema = z.object({
  key: z.string(),
  done: z.boolean(),
});

export const folderOverviewErrorSchema = z.object({
  error: z.string(),
  code: z.enum(["folder_not_found", "item_not_found", "invalid_request"]),
});
