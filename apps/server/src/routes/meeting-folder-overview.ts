import { zValidator } from "@hono/zod-validator";
import {
  actionItemKeySchema,
  folderOverviewErrorSchema,
  folderOverviewSchema,
  setActionItemDoneResponseSchema,
  setActionItemDoneSchema,
} from "@openstyle/validations";
import { Hono } from "hono";
import { getDb } from "../lib/db.js";
import {
  buildFolderOverview,
  setActionItemDone,
} from "../lib/meetings/folder-overview.js";

// GET /api/meetings/folders/:id/overview and
// PUT /api/meetings/folders/:id/action-items/:key (issue #374,
// specs/folder-project-page.md). The Overview is computed on every read.

type ErrorCode = "folder_not_found" | "item_not_found" | "invalid_request";

function failure(error: string, code: ErrorCode) {
  return folderOverviewErrorSchema.parse({ error, code });
}

export const meetingFolderOverview = new Hono()
  .get("/:id/overview", (c) => {
    const overview = buildFolderOverview(getDb(), c.req.param("id"));
    if (!overview) {
      return c.json(failure("Folder not found", "folder_not_found"), 404);
    }
    return c.json(folderOverviewSchema.parse(overview));
  })
  .put(
    "/:id/action-items/:key",
    zValidator("json", setActionItemDoneSchema, (result, c) =>
      result.success
        ? undefined
        : c.json(failure("Invalid request", "invalid_request"), 400),
    ),
    (c) => {
      const key = actionItemKeySchema.safeParse(c.req.param("key"));
      if (!key.success) {
        return c.json(failure("Invalid request", "invalid_request"), 400);
      }
      const db = getDb();
      const folderId = c.req.param("id");
      if (
        !db.prepare("SELECT 1 FROM meeting_folders WHERE id = ?").get(folderId)
      ) {
        return c.json(failure("Folder not found", "folder_not_found"), 404);
      }
      const { done } = c.req.valid("json");
      if (!setActionItemDone(db, folderId, key.data, done, Date.now())) {
        return c.json(failure("Action item not found", "item_not_found"), 404);
      }
      return c.json(
        setActionItemDoneResponseSchema.parse({ key: key.data, done }),
      );
    },
  );
