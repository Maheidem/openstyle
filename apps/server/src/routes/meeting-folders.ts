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
  meetingFolderExists,
  meetingFolderNameExists,
} from "../lib/meetings/folders.js";
import { moveMeetingIndex } from "../lib/search/indexer.js";

const folderSelect = `SELECT f.*, COUNT(m.id) AS meeting_count,
  MIN(m.started_at) AS first_meeting_at, MAX(m.started_at) AS last_meeting_at,
  COALESCE(SUM(m.duration_ms), 0) AS total_duration_ms
  FROM meeting_folders f LEFT JOIN meetings m ON m.folder_id = f.id`;

function readFolder(id: string) {
  return meetingFolderSchema.parse(
    getDb().prepare(`${folderSelect} WHERE f.id = ? GROUP BY f.id`).get(id),
  );
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
        items: getDb()
          .prepare(
            `${folderSelect} GROUP BY f.id ORDER BY f.name COLLATE NOCASE, f.id`,
          )
          .all(),
      }),
    ),
  )
  .post(
    "/",
    zValidator("json", createMeetingFolderSchema, invalidRequest),
    (c) => {
      const { name, description } = c.req.valid("json");
      if (meetingFolderNameExists(name)) {
        return c.json(
          meetingFolderErrorSchema.parse({
            error: "A folder with this name exists",
            code: "folder_name_exists",
          }),
          409,
        );
      }
      const id = randomUUID();
      const now = Date.now();
      getDb()
        .prepare(`INSERT INTO meeting_folders (id, name, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)`)
        .run(id, name, description ?? null, now, now);
      return c.json(readFolder(id), 201);
    },
  )
  .patch(
    "/:id",
    zValidator("json", updateMeetingFolderSchema, invalidRequest),
    (c) => {
      const id = c.req.param("id");
      if (!meetingFolderExists(id)) {
        return c.json(
          meetingFolderErrorSchema.parse({
            error: "Folder not found",
            code: "folder_not_found",
          }),
          404,
        );
      }
      const { name, description } = c.req.valid("json");
      if (name !== undefined && meetingFolderNameExists(name, id)) {
        return c.json(
          meetingFolderErrorSchema.parse({
            error: "A folder with this name exists",
            code: "folder_name_exists",
          }),
          409,
        );
      }
      const old = readFolder(id);
      getDb()
        .prepare(
          `UPDATE meeting_folders SET name = ?, description = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          name ?? old.name,
          description === undefined ? old.description : description,
          Date.now(),
          id,
        );
      return c.json(readFolder(id));
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
