// MCP tools for meeting folders, the folder Overview and the folder standing.
// Each tool calls a route of routes/meeting-folders.ts,
// routes/meeting-folder-overview.ts or routes/meeting-folder-standing.ts.
import {
  FOLDER_STANDING_MAX_BULLETS,
  folderColorSchema,
} from "@openstyle/validations";
import { z } from "zod";
import { confirmArg, defineTool, expectOk, seg } from "./define.js";

const folderId = z
  .string()
  .min(1)
  .describe("The folder id (from list_folders).");
const color = folderColorSchema
  .nullable()
  .optional()
  .describe("The folder color. null removes it.");

const listFolders = defineTool({
  name: "list_folders",
  description:
    "List the meeting folders with their meeting counts, dates and the number of meetings that need each stage.",
  kind: "read",
  idempotent: true,
  input: z.object({}),
  run: async (_args, { api }) => ({
    data: expectOk(await api("GET", "/api/meetings/folders")),
  }),
});

const createFolder = defineTool({
  name: "create_folder",
  description: "Create a meeting folder. The name must be new.",
  kind: "write",
  idempotent: false,
  input: z.object({
    name: z.string().min(1).describe("The folder name."),
    description: z
      .string()
      .nullable()
      .optional()
      .describe("What the folder is about."),
    color,
  }),
  run: async (args, { api }) => {
    const data = expectOk(await api("POST", "/api/meetings/folders", args)) as {
      id: string;
    };
    return { data, change: { kind: "folder", ids: [data.id] } };
  },
});

const updateFolder = defineTool({
  name: "update_folder",
  description:
    "Change the name, the description or the color of a folder. Give at least one field.",
  kind: "write",
  idempotent: true,
  input: z.object({
    folder_id: folderId,
    name: z.string().min(1).optional().describe("The new name."),
    description: z
      .string()
      .nullable()
      .optional()
      .describe("The new description. null clears it."),
    color,
  }),
  run: async ({ folder_id, ...fields }, { api }) => {
    const data = expectOk(
      await api("PATCH", `/api/meetings/folders/${seg(folder_id)}`, fields),
    );
    return { data, change: { kind: "folder", ids: [folder_id] } };
  },
});

const deleteFolder = defineTool({
  name: "delete_folder",
  description:
    "Delete an empty folder. Move its meetings out first (move_meetings). This cannot be undone.",
  kind: "delete",
  idempotent: true,
  input: z.object({ folder_id: folderId, confirm: confirmArg }),
  run: async ({ folder_id }, { api }) => {
    const data = expectOk(
      await api("DELETE", `/api/meetings/folders/${seg(folder_id)}`),
    );
    return { data, change: { kind: "folder", ids: [folder_id] } };
  },
});

const getFolderOverview = defineTool({
  name: "get_folder_overview",
  description:
    "Get the Overview of a folder: the action items, decisions and open questions from the summaries of its meetings. Each action item has a key for set_action_item_done.",
  kind: "read",
  idempotent: true,
  input: z.object({ folder_id: folderId }),
  run: async ({ folder_id }, { api }) => ({
    data: expectOk(
      await api("GET", `/api/meetings/folders/${seg(folder_id)}/overview`),
    ),
  }),
});

const setActionItemDone = defineTool({
  name: "set_action_item_done",
  description: "Mark an action item of a folder Overview as done or not done.",
  kind: "write",
  idempotent: true,
  input: z.object({
    folder_id: folderId,
    key: z
      .string()
      .min(1)
      .describe("The action item key (from get_folder_overview)."),
    done: z.boolean().describe("true marks it done, false marks it open."),
  }),
  run: async ({ folder_id, key, done }, { api }) => {
    const data = expectOk(
      await api(
        "PUT",
        `/api/meetings/folders/${seg(folder_id)}/action-items/${seg(key)}`,
        { done },
      ),
    );
    return { data, change: { kind: "folder", ids: [folder_id] } };
  },
});

const getFolderStanding = defineTool({
  name: "get_folder_standing",
  description:
    "Get the saved standing text of a folder (where the project stands now). It does not call a model.",
  kind: "read",
  idempotent: true,
  input: z.object({ folder_id: folderId }),
  run: async ({ folder_id }, { api }) => ({
    data: expectOk(
      await api("GET", `/api/meetings/folders/${seg(folder_id)}/standing`),
    ),
  }),
});

const setFolderStanding = defineTool({
  name: "set_folder_standing",
  description:
    "Save your own standing text of a folder (where the project stands now), as bullets. It replaces the saved text and calls no model.",
  kind: "write",
  idempotent: true,
  input: z.object({
    folder_id: folderId,
    bullets: z
      .array(z.string().min(1).max(240))
      .min(1)
      .max(FOLDER_STANDING_MAX_BULLETS)
      .describe(
        `One short line for each bullet, ${FOLDER_STANDING_MAX_BULLETS} at most, with no list marks.`,
      ),
  }),
  run: async ({ folder_id, bullets }, { api }) => {
    const data = expectOk(
      await api("PUT", `/api/meetings/folders/${seg(folder_id)}/standing`, {
        bullets,
      }),
    );
    return { data, change: { kind: "folder", ids: [folder_id] } };
  },
});

export const folderTools = [
  listFolders,
  createFolder,
  updateFolder,
  deleteFolder,
  getFolderOverview,
  setActionItemDone,
  getFolderStanding,
  setFolderStanding,
];
