import { z } from "zod";
import { folderStageCountsSchema } from "./meeting-batch.js";

export const meetingFolderIdSchema = z.string().min(1).max(128);
const folderNameSchema = z.string().trim().min(1).max(60);
// A folder path joins the names with "/" ("Parent/Child"), so a new name
// cannot hold "/".
const folderNameInputSchema = folderNameSchema.refine(
  (name) => !name.includes("/"),
  { message: 'A folder name cannot contain "/"' },
);

export const folderColorSchema = z.enum([
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "violet",
  "pink",
]);
export type FolderColor = z.infer<typeof folderColorSchema>;

export const createMeetingFolderSchema = z.object({
  name: folderNameInputSchema,
  description: z.string().nullable().optional(),
  color: folderColorSchema.nullable().optional(),
  /** The parent folder. Absent or null: a top-level folder. */
  parent_id: meetingFolderIdSchema.nullable().optional(),
});

export const updateMeetingFolderSchema = createMeetingFolderSchema
  .partial()
  .refine(
    (v) =>
      v.name !== undefined ||
      v.description !== undefined ||
      v.color !== undefined ||
      v.parent_id !== undefined,
    { message: "Give a name, description, color or parent_id" },
  );

export const meetingFolderSchema = z.object({
  id: meetingFolderIdSchema,
  name: folderNameSchema,
  description: z.string().nullable(),
  // A stored name outside the palette (a later palette change) reads as no
  // color, so one bad row cannot break the whole folder list.
  color: folderColorSchema.nullable().catch(null),
  /** The parent folder, or null for a top-level folder. Only 2 levels. */
  parent_id: meetingFolderIdSchema.nullable().default(null),
  /** The number of child folders. A child folder has 0. */
  child_count: z.number().int().nonnegative().default(0),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  /** The counts, dates and stage counts of a parent include its children. */
  meeting_count: z.number().int().nonnegative(),
  first_meeting_at: z.number().nullable(),
  last_meeting_at: z.number().nullable(),
  total_duration_ms: z.number().nonnegative(),
  /** What the folder's meetings still need (specs/meeting-folder-batch.md). */
  stage_counts: folderStageCountsSchema,
});

export const meetingFoldersResponseSchema = z.object({
  items: z.array(meetingFolderSchema),
});

export const meetingFolderErrorSchema = z.discriminatedUnion("code", [
  z.object({
    error: z.string(),
    code: z.literal("folder_not_empty"),
    meeting_count: z.number().int().nonnegative(),
  }),
  z.object({
    error: z.string(),
    code: z.literal("folder_has_children"),
    child_count: z.number().int().nonnegative(),
  }),
  z.object({
    error: z.string(),
    code: z.enum([
      "folder_not_found",
      "folder_depth_exceeded",
      "folder_name_exists",
      "meeting_not_found",
      "invalid_request",
    ]),
  }),
]);

export const moveMeetingsSchema = z.object({
  meeting_ids: z.array(z.string().min(1).max(128)).min(1).max(200),
  folder_id: meetingFolderIdSchema.nullable(),
});

export const moveMeetingsResponseSchema = moveMeetingsSchema.extend({
  ok: z.literal(true),
});

export const meetingFolderDeleteResponseSchema = z.object({
  ok: z.literal(true),
});

export const meetingFolderFilterSchema = z.object({
  folder_id: meetingFolderIdSchema.optional(),
  /** Page size, 1 to 200. Without it the list has the newest 200. */
  limit: z.coerce.number().int().min(1).max(200).optional(),
  /** The number of newest meetings to skip. The default is 0. */
  offset: z.coerce.number().int().min(0).optional(),
});

export const meetingStartResponseSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
  folder_id: meetingFolderIdSchema.nullable(),
});
