import { createAppLogger } from "@openstyle/utils";
import {
  type FolderStandingErrorCode,
  folderStandingErrorSchema,
  folderStandingSchema,
  folderStandingStateSchema,
} from "@openstyle/validations";
import { Hono } from "hono";
import { getDb } from "../lib/db.js";
import { callStructured } from "../lib/llm/gateway.js";
import { ModelUnavailableError } from "../lib/llm/gateway-errors.js";
import {
  readStanding,
  writeFolderStanding,
} from "../lib/meetings/folder-standing.js";
import { realSleep } from "../lib/meetings/workflow/context.js";

// GET and POST /api/meetings/folders/:id/standing (issue #374,
// specs/folder-project-page.md 6). GET reads the saved text and never calls
// a model. POST writes a new text (the Refresh button) and saves it.

const log = createAppLogger("folder-standing");

function failure(error: string, code: FolderStandingErrorCode) {
  return folderStandingErrorSchema.parse({ error, code });
}

function findFolder(id: string) {
  return getDb()
    .prepare("SELECT id, name FROM meeting_folders WHERE id = ?")
    .get(id) as { id: string; name: string } | undefined;
}

export const meetingFolderStanding = new Hono()
  .get("/:id/standing", (c) => {
    const folder = findFolder(c.req.param("id"));
    if (!folder) {
      return c.json(failure("Folder not found", "folder_not_found"), 404);
    }
    return c.json(
      folderStandingStateSchema.parse(readStanding(getDb(), folder.id)),
    );
  })
  .post("/:id/standing", async (c) => {
    const folder = findFolder(c.req.param("id"));
    if (!folder) {
      return c.json(failure("Folder not found", "folder_not_found"), 404);
    }
    try {
      const result = await writeFolderStanding(
        folder,
        { db: getDb(), callStructured, sleep: realSleep, now: Date.now },
        c.req.raw.signal,
      );
      if (result.status === "no_content") {
        return c.json(
          failure(
            "This folder has no open task, decision or question yet",
            "no_content",
          ),
          409,
        );
      }
      return c.json(folderStandingSchema.parse(result.standing));
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
      log.warn(`standing failed: ${String(err)}`);
      return c.json(
        failure("The AI model could not write the text", "llm_failed"),
        502,
      );
    }
  });
