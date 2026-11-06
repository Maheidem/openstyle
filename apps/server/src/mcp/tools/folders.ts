// MCP tools for meeting folders, the folder Overview and the folder standing.
// Each tool calls a route of routes/meeting-folders.ts,
// routes/meeting-folder-overview.ts or routes/meeting-folder-standing.ts.
import {
  FOLDER_STANDING_MAX_BULLETS,
  folderColorSchema,
} from "@openstyle/validations";
import { z } from "zod";
import {
  confirmArg,
  defineTool,
  expectOk,
  pageArgs,
  pageOf,
  seg,
} from "./define.js";

const folderId = z
  .string()
  .min(1)
  .describe("The folder id (from list_folders).");
const color = folderColorSchema
  .nullable()
  .optional()
  .describe("The folder color. null removes it.");

/**
 * The text that explains need_stage. The route calls it `stage_counts`. An
 * agent read `stage_counts.summarize.ready` as "summarized" (issue #433).
 */
const NEED_STAGE_TEXT =
  "need_stage.<stage>.ready counts the meetings that need that stage and can run it now; blocked counts the ones that need it but cannot run it (no audio, or no AI model). A meeting that was transcribed again after its summary has a summary and also needs summarize.";

/** Rename `stage_counts` to `need_stage`. */
function withNeedStage<T extends { stage_counts?: unknown }>(row: T) {
  const { stage_counts, ...rest } = row;
  return { ...rest, need_stage: stage_counts };
}

const listFolders = defineTool({
  name: "list_folders",
  description: `List the meeting folders with their meeting counts and dates, one page at a time. ${NEED_STAGE_TEXT}`,
  kind: "read",
  idempotent: true,
  input: z.object({ ...pageArgs }),
  run: async ({ offset, limit }, { api }) => {
    const folders = expectOk(await api("GET", "/api/meetings/folders")) as {
      items: { stage_counts?: unknown }[];
    };
    return {
      data: pageOf(folders.items.map(withNeedStage), offset, limit),
    };
  },
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
  description: `Get the Overview of a folder: the action items, decisions and open questions from the summaries of its meetings. Each action item has a key for set_action_item_done. counts.with_summary counts the meetings that have a summary, also an old one. ${NEED_STAGE_TEXT}`,
  kind: "read",
  idempotent: true,
  input: z.object({ folder_id: folderId }),
  run: async ({ folder_id }, { api }) => {
    const overview = expectOk(
      await api("GET", `/api/meetings/folders/${seg(folder_id)}/overview`),
    ) as { counts: { summarized?: number; stage_counts?: unknown } };
    const { summarized, ...counts } = withNeedStage(overview.counts);
    return {
      data: { ...overview, counts: { ...counts, with_summary: summarized } },
    };
  },
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
