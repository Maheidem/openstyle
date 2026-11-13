import { randomUUID } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import {
  createMeetingFolderSchema,
  meetingFolderDeleteResponseSchema,
  meetingFolderErrorSchema,
  meetingFolderSchema,
  meetingFoldersResponseSchema,
  moveMeetingsResponseSchema,
  moveMeetingsSchema,
  updateMeetingFolderSchema,
} from "@openstyle/validations";
import { type Context, Hono } from "hono";
import { getDb, withTransaction } from "../lib/db.js";
import {
  folderParentId,
  IN_SCOPE_OF_F,
  meetingFolderExists,
  meetingFolderNameExists,
} from "../lib/meetings/folders.js";
import {
  stageCountColumns,
  stageCountsOf,
} from "../lib/meetings/stage-needs.js";
import { moveMeetingIndex } from "../lib/search/indexer.js";

// The stage counts come from the shared "needs stage" rules
// (specs/meeting-folder-batch.md 2), in the same query as the other facts.
// The meetings of a parent include the meetings of its children.
const folderSelect = `SELECT f.*, COUNT(m.id) AS meeting_count,
  MIN(m.started_at) AS first_meeting_at, MAX(m.started_at) AS last_meeting_at,
  COALESCE(SUM(m.duration_ms), 0) AS total_duration_ms, ${stageCountColumns},
  (SELECT COUNT(*) FROM meeting_folders c WHERE c.parent_id = f.id) AS child_count
  FROM meeting_folders f LEFT JOIN meetings m ON m.folder_id ${IN_SCOPE_OF_F}`;

type FolderRow = Record<string, unknown> & Parameters<typeof stageCountsOf>[0];

function withStageCounts(row: FolderRow) {
  return meetingFolderSchema.parse({
    ...row,
    stage_counts: stageCountsOf(row),
  });
}

function readFolder(id: string) {
  return withStageCounts(
    getDb()
      .prepare(`${folderSelect} WHERE f.id = ? GROUP BY f.id`)
      .get(id) as FolderRow,
  );
}

function folderError(
  c: Context,
  code: "folder_not_found" | "folder_name_exists" | "folder_depth_exceeded",
) {
  const [error, status] = {
    folder_not_found: ["Folder not found", 404],
    folder_name_exists: ["A folder with this name exists", 409],
    folder_depth_exceeded: ["Folders can have only 2 levels", 409],
  }[code] as [string, 404 | 409];
  return c.json(meetingFolderErrorSchema.parse({ error, code }), status);
}

/**
 * Check a parent for a folder (2 levels only). `movedId` is the folder that
 * gets the parent, or undefined for a new folder. Returns the error code, or
 * null when the parent is good. A null parent (top level) is always good.
 */
function parentProblem(
  parentId: string | null,
  movedId?: string,
): "folder_not_found" | "folder_depth_exceeded" | null {
  if (parentId === null) return null;
  if (parentId === movedId) return "folder_depth_exceeded";
  const parentOfParent = folderParentId(getDb(), parentId);
  if (parentOfParent === undefined) return "folder_not_found";
  // The target parent is itself a child.
  if (parentOfParent !== null) return "folder_depth_exceeded";
  // A folder that has children cannot become a child.
  if (
    movedId !== undefined &&
    getDb()
      .prepare("SELECT 1 FROM meeting_folders WHERE parent_id = ? LIMIT 1")
      .get(movedId)
  ) {
    return "folder_depth_exceeded";
  }
  return null;
}

function invalidRequest(result: { success: boolean }, c: Context) {
  if (!result.success) {
    return c.json(
      meetingFolderErrorSchema.parse({
        error: "Invalid request",
        code: "invalid_request",
      }),
      400,
    );
  }
  return undefined;
}

export const meetingFolders = new Hono()
  .get("/", (c) =>
    c.json(
      meetingFoldersResponseSchema.parse({
        items: (
          getDb()
            .prepare(
              `${folderSelect} GROUP BY f.id ORDER BY f.name COLLATE NOCASE, f.id`,
            )
            .all() as FolderRow[]
        ).map(withStageCounts),
      }),
    ),
  )
  .post(
    "/",
    zValidator("json", createMeetingFolderSchema, invalidRequest),
    (c) => {
      const { name, description, color } = c.req.valid("json");
      const parentId = c.req.valid("json").parent_id ?? null;
      return withTransaction(getDb(), () => {
        const problem = parentProblem(parentId);
        if (problem) return folderError(c, problem);
        if (meetingFolderNameExists(name, parentId)) {
          return folderError(c, "folder_name_exists");
        }
        const id = randomUUID();
        const now = Date.now();
        getDb()
          .prepare(`INSERT INTO meeting_folders (id, name, description, color, parent_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(
            id,
            name,
            description ?? null,
            color ?? null,
            parentId,
            now,
            now,
          );
        return c.json(readFolder(id), 201);
      });
    },
  )
  .patch(
    "/:id",
    zValidator("json", updateMeetingFolderSchema, invalidRequest),
    (c) => {
      const id = c.req.param("id");
      const input = c.req.valid("json");
      return withTransaction(getDb(), () => {
        const oldParent = folderParentId(getDb(), id);
        if (oldParent === undefined) return folderError(c, "folder_not_found");
        const parentId =
          input.parent_id === undefined ? oldParent : input.parent_id;
        if (parentId !== oldParent) {
          const problem = parentProblem(parentId, id);
          if (problem) return folderError(c, problem);
        }
        const old = readFolder(id);
        const name = input.name ?? old.name;
        // A move or a rename must not clash with a name under the parent.
        if (
          (input.name !== undefined || parentId !== oldParent) &&
          meetingFolderNameExists(name, parentId, id)
        ) {
          return folderError(c, "folder_name_exists");
        }
        // A move changes no meetings.folder_id, so the search index stays.
        getDb()
          .prepare(
            `UPDATE meeting_folders SET name = ?, description = ?, color = ?, parent_id = ?, updated_at = ? WHERE id = ?`,
          )
          .run(
            name,
            input.description === undefined
              ? old.description
              : input.description,
            input.color === undefined ? old.color : input.color,
            parentId,
            Date.now(),
            id,
          );
        return c.json(readFolder(id));
      });
    },
  )
  .delete("/:id", (c) => {
    const id = c.req.param("id");
    return withTransaction(getDb(), () => {
      if (!meetingFolderExists(id)) {
        return c.json(
          meetingFolderErrorSchema.parse({
            error: "Folder not found",
            code: "folder_not_found",
          }),
          404,
        );
      }
      const { child_count } = readFolder(id);
      if (child_count > 0) {
        return c.json(
          meetingFolderErrorSchema.parse({
            error:
              "Move or delete the child folders before you delete this folder",
            code: "folder_has_children",
            child_count,
          }),
          409,
        );
      }
      // No children, so readFolder counts only the folder's own meetings.
      const { meeting_count } = readFolder(id);
      if (meeting_count > 0) {
        return c.json(
          meetingFolderErrorSchema.parse({
            error: "Move the meetings before you delete this folder",
            code: "folder_not_empty",
            meeting_count,
          }),
          409,
        );
      }
      getDb().prepare("DELETE FROM meeting_folders WHERE id = ?").run(id);
      return c.json(meetingFolderDeleteResponseSchema.parse({ ok: true }));
    });
  });

export const meetingMoves = new Hono().post(
  "/move",
  zValidator("json", moveMeetingsSchema, invalidRequest),
  (c) => {
    const input = c.req.valid("json");
    const ids = [...new Set(input.meeting_ids)];
    const db = getDb();
    return withTransaction(db, () => {
      if (!meetingFolderExists(input.folder_id)) {
        return c.json(
          meetingFolderErrorSchema.parse({
            error: "Folder not found",
            code: "folder_not_found",
          }),
          404,
        );
      }
      const slots = ids.map(() => "?").join(", ");
      const rows = db
        .prepare(`SELECT id FROM meetings WHERE id IN (${slots})`)
        .all(...ids);
      if (rows.length !== ids.length) {
        return c.json(
          meetingFolderErrorSchema.parse({
            error: "Meeting not found",
            code: "meeting_not_found",
          }),
          404,
        );
      }
      db.prepare(
        `UPDATE meetings SET folder_id = ? WHERE id IN (${slots})`,
      ).run(input.folder_id, ...ids);
      // Search index (specs/local-semantic-search.md 6.5, S3): move the
      // stored vectors to the new partition in the same transaction. No
      // embedding call. Does nothing when search is off.
      for (const id of ids) moveMeetingIndex(db, id, input.folder_id ?? "");
      return c.json(
        moveMeetingsResponseSchema.parse({
          ok: true,
          meeting_ids: ids,
          folder_id: input.folder_id,
        }),
      );
    });
  },
);
