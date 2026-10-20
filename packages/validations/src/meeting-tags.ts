import { z } from "zod";

/** The most tags one meeting can have (issue #231). */
export const MAX_MEETING_TAGS = 20;
/** The most tags one Enhance run can suggest (issue #231). */
export const MAX_SUGGESTED_TAGS = 5;
export const MAX_TAG_NAME_LENGTH = 40;

/** Make a tag name canonical: trim, lowercase, and join inner white space. */
export function normalizeTagName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Normalize a list of tag names, drop empty and too-long names, and remove
 * duplicates. The first position of a name is kept. */
export function normalizeTagNames(names: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of names) {
    const name = normalizeTagName(raw);
    if (name.length === 0 || name.length > MAX_TAG_NAME_LENGTH) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

export const meetingTagNameSchema = z
  .string()
  .transform(normalizeTagName)
  .pipe(z.string().min(1).max(MAX_TAG_NAME_LENGTH));

/** The issue message when a list has more than MAX_MEETING_TAGS names. */
export const TOO_MANY_TAGS = "too_many_tags";

export const setMeetingTagsSchema = z.object({
  tags: z
    .array(meetingTagNameSchema)
    .transform((names) => [...new Set(names)])
    .pipe(z.array(z.string()).max(MAX_MEETING_TAGS, TOO_MANY_TAGS)),
});

export const meetingTagsResponseSchema = z.object({
  tags: z.array(z.string()),
});

export const meetingTagSummarySchema = z.object({
  name: z.string(),
  meeting_count: z.number().int().nonnegative(),
});

export const meetingTagListResponseSchema = z.object({
  items: z.array(meetingTagSummarySchema),
});

export const meetingTagErrorSchema = z.object({
  error: z.string(),
  code: z.enum(["meeting_not_found", "too_many_tags", "invalid_request"]),
});
