import { z } from "zod";

export const meetingFolderIdSchema = z.string().min(1).max(128);
const folderNameSchema = z.string().trim().min(1).max(60);

export const createMeetingFolderSchema = z.object({
  name: folderNameSchema,
  description: z.string().nullable().optional(),
});

export const updateMeetingFolderSchema = createMeetingFolderSchema
  .partial()
  .refine((v) => v.name !== undefined || v.description !== undefined, {
    message: "Give a name or description",
  });

export const meetingFolderSchema = z.object({
  id: meetingFolderIdSchema,
  name: folderNameSchema,
  description: z.string().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  meeting_count: z.number().int().nonnegative(),
  first_meeting_at: z.number().nullable(),
  last_meeting_at: z.number().nullable(),
  total_duration_ms: z.number().nonnegative(),
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
    code: z.enum([
      "folder_not_found",
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
});

export const meetingStartResponseSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
  folder_id: meetingFolderIdSchema.nullable(),
});
