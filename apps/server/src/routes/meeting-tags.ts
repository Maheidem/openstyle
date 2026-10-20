import { zValidator } from "@hono/zod-validator";
import {
  MAX_MEETING_TAGS,
  meetingTagErrorSchema,
  meetingTagListResponseSchema,
  meetingTagsResponseSchema,
  setMeetingTagsSchema,
  TOO_MANY_TAGS,
} from "@openstyle/validations";
import { type Context, Hono } from "hono";
import { getDb } from "../lib/db.js";
import { listTagsWithCounts, setMeetingTags } from "../lib/meetings/tags.js";

function invalidRequest(
  result: { success: boolean; error?: { issues: { message: string }[] } },
  c: Context,
) {
  if (result.success) return undefined;
  const tooMany = result.error?.issues.some((i) => i.message === TOO_MANY_TAGS);
  return c.json(
    meetingTagErrorSchema.parse(
      tooMany
        ? {
            error: `A meeting can have at most ${MAX_MEETING_TAGS} tags`,
            code: "too_many_tags",
          }
        : { error: "Invalid request", code: "invalid_request" },
    ),
    400,
  );
}

/** `GET /api/meetings/tags`: all tags with their meeting counts. Mount it
 * before `/:id`. */
export const meetingTagList = new Hono().get("/", (c) =>
  c.json(meetingTagListResponseSchema.parse({ items: listTagsWithCounts() })),
);

/** `PUT /api/meetings/:id/tags`: set the full tag list of a meeting. */
export const meetingTagEdit = new Hono().put(
  "/:id/tags",
  zValidator("json", setMeetingTagsSchema, invalidRequest),
  (c) => {
    const id = c.req.param("id");
    if (!getDb().prepare("SELECT 1 FROM meetings WHERE id = ?").get(id)) {
      return c.json(
        meetingTagErrorSchema.parse({
          error: "Meeting not found",
          code: "meeting_not_found",
        }),
        404,
      );
    }
    const { tags } = c.req.valid("json");
    return c.json(
      meetingTagsResponseSchema.parse({ tags: setMeetingTags(id, tags) }),
    );
  },
);
