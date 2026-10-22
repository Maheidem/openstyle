import { z } from "zod";
import { meetingFolderIdSchema } from "./meeting-folders.js";
import { meetingTagNameSchema } from "./meeting-tags.js";

// Meeting search (specs/local-semantic-search.md 7.4, 8.1, 9.1).

export const SEARCH_OFF_REASONS = [
  "unsupported_platform",
  "extension_missing",
  "extension_load_failed",
  "extension_version",
  "vec_table",
  "no_model",
] as const;

export const searchOffReasonSchema = z.enum(SEARCH_OFF_REASONS);
export type SearchOffReason = z.infer<typeof searchOffReasonSchema>;

export const SEARCH_QUERY_MAX_CHARS = 1000;
export const SEARCH_K_MAX = 50;

export const searchStatusSchema = z.object({
  state: z.enum(["on", "off"]),
  reason: searchOffReasonSchema.nullable(),
  model_id: z.string().nullable(),
  vec_version: z.string().nullable(),
  meetings: z.object({
    eligible: z.number().int().nonnegative(),
    indexed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
  }),
  index: z.object({
    db_bytes: z.number().int().nonnegative(),
    vector_chunks: z.number().int().nonnegative(),
    /** Chunks that this server process sent to the embedding model. */
    embedded_chunks: z.number().int().nonnegative(),
  }),
});
export type SearchStatus = z.infer<typeof searchStatusSchema>;

export const searchMeetingsRequestSchema = z.object({
  query: z.string().trim().min(1).max(SEARCH_QUERY_MAX_CHARS),
  /** A folder id, or "none" for unfiled meetings. Absent: all meetings. */
  folder_id: z.union([z.literal("none"), meetingFolderIdSchema]).optional(),
  /** Tag names. A meeting with any of them matches. */
  tags: z.array(meetingTagNameSchema).max(50).optional(),
  k: z.number().int().min(1).max(SEARCH_K_MAX).optional(),
});
export type SearchMeetingsRequest = z.infer<typeof searchMeetingsRequestSchema>;

/** What a hit holds (spec 3.2): transcript text, title and tags, summary. */
export const SEARCH_HIT_KINDS = ["transcript", "meta", "summary"] as const;
export type SearchHitKind = (typeof SEARCH_HIT_KINDS)[number];

export const searchHitSchema = z.object({
  chunk_id: z.number().int(),
  kind: z.enum(SEARCH_HIT_KINDS),
  meeting_id: z.string(),
  meeting_title: z.string().nullable(),
  started_at: z.number().nullable(),
  folder_id: z.string().nullable(),
  score: z.number(),
  start_ms: z.number().nullable(),
  end_ms: z.number().nullable(),
  snippet: z.string(),
});
export type SearchHit = z.infer<typeof searchHitSchema>;

export const searchMeetingsResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), hits: z.array(searchHitSchema) }),
  z.object({ status: z.literal("off"), reason: searchOffReasonSchema }),
]);
export type SearchMeetingsResponse = z.infer<
  typeof searchMeetingsResponseSchema
>;
