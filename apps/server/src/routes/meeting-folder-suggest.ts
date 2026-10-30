import { createAppLogger } from "@openstyle/utils";
import {
  type FolderDescriptionSuggestErrorCode,
  folderDescriptionSuggestErrorSchema,
  folderDescriptionSuggestionSchema,
} from "@openstyle/validations";
import { Hono } from "hono";
import { getDb } from "../lib/db.js";
import { callStructured } from "../lib/llm/gateway.js";
import { ModelUnavailableError } from "../lib/llm/gateway-errors.js";
import { suggestFolderDescription } from "../lib/meetings/folder-description.js";
import { realSleep } from "../lib/meetings/workflow/context.js";

// POST /api/meetings/folders/:id/suggest-description (issue #373). It answers
// a suggestion and saves nothing: the user edits the text and saves it with
// PATCH /folders/:id. A separate file keeps the folder routes small.

const log = createAppLogger("folder-description");

function failure(error: string, code: FolderDescriptionSuggestErrorCode) {
  return folderDescriptionSuggestErrorSchema.parse({ error, code });
}

export const meetingFolderSuggest = new Hono().post(
  "/:id/suggest-description",
  async (c) => {
    const db = getDb();
    const folder = db
      .prepare("SELECT id, name FROM meeting_folders WHERE id = ?")
      .get(c.req.param("id")) as { id: string; name: string } | undefined;
    if (!folder) {
      return c.json(failure("Folder not found", "folder_not_found"), 404);
    }
    try {
      const result = await suggestFolderDescription(
        folder,
        { db, callStructured, sleep: realSleep, now: Date.now },
        c.req.raw.signal,
      );
      if (result.status === "no_summaries") {
        return c.json(
          failure(
            "No meeting in this folder has a summary yet",
            "no_summaries",
          ),
          409,
        );
      }
      return c.json(
        folderDescriptionSuggestionSchema.parse({
          description: result.description,
          meeting_count: result.meetingCount,
        }),
      );
    } catch (err) {
      if (err instanceof ModelUnavailableError) {
        return c.json(
          failure(
            "No AI model is set up. Add one in Settings > Models.",
            "no_llm",
          ),
          409,
        );
      }
      log.warn(`suggest-description failed: ${String(err)}`);
      return c.json(
        failure("The AI model could not write a description", "llm_failed"),
        502,
      );
    }
  },
);
