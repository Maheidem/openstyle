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
import { Folders, folderRefArgs, resolveFolder } from "./folder-ref.js";

const parentText =
  'Folders have 2 levels: a top-level folder can hold child folders; a child folder cannot. The path of a child is "Parent/Child".';

/** A folder answer of a route, with its path. */
async function withPath<T extends { id: string }>(
  api: Parameters<typeof Folders.load>[0],
  folder: T,
) {
  return { ...folder, path: (await Folders.load(api)).pathOf(folder.id) };
}

/** A parent given as a path or an id. */
const parentRef = z
  .string()
  .min(1)
  .describe(
    'The parent folder: its path ("Parent") or its id. The parent must be a top-level folder.',
  );
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
  description: `List the meeting folders with their meeting counts and dates, one page at a time. Each folder has its id, its path and parent_id. The counts of a parent include its child folders. ${parentText} ${NEED_STAGE_TEXT}`,
  kind: "read",
  idempotent: true,
  input: z.object({ ...pageArgs }),
  run: async ({ offset, limit }, { api }) => {
    const folders = expectOk(await api("GET", "/api/meetings/folders")) as {
      items: { id: string; stage_counts?: unknown }[];
    };
    const index = await Folders.load(api);
    return {
      data: pageOf(
        folders.items.map((f) => ({
          ...withNeedStage(f),
          path: index.pathOf(f.id),
        })),
        offset,
        limit,
      ),
    };
  },
});

const createFolder = defineTool({
  name: "create_folder",
  description: `Create a meeting folder. The name must be new under its parent, and it cannot contain "/". ${parentText}`,
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
    parent: parentRef
      .optional()
      .describe(
        'The parent folder: its path ("Parent") or its id. Leave it out for a top-level folder.',
      ),
  }),
  run: async ({ parent, ...args }, { api }) => {
    const parent_id =
      parent === undefined
        ? undefined
        : (await Folders.load(api)).idOfIdOrPath(parent);
    const data = expectOk(
      await api("POST", "/api/meetings/folders", { ...args, parent_id }),
    ) as { id: string };
    return {
      data: await withPath(api, data),
      change: { kind: "folder", ids: [data.id] },
    };
  },
});

const updateFolder = defineTool({
  name: "update_folder",
  description: `Change the name, the description, the color or the parent of a folder. Give at least one field. ${parentText}`,
  kind: "write",
  idempotent: true,
  input: z.object({
    ...folderRefArgs,
    name: z.string().min(1).optional().describe("The new name."),
    description: z
      .string()
      .nullable()
      .optional()
      .describe("The new description. null clears it."),
    color,
    parent: z
      .string()
      .nullable()
      .optional()
      .describe(
        'Move the folder: the new parent as a path ("Parent") or an id. null or "" moves it to the top level. A folder with child folders cannot get a parent.',
      ),
  }),
  run: async ({ folder_id, path, parent, ...fields }, { api }) => {
    const id = await resolveFolder(api, { folder_id, path });
    const parent_id =
      parent === undefined
        ? undefined
        : parent === null || parent.trim() === ""
          ? null
          : (await Folders.load(api)).idOfIdOrPath(parent);
    const data = expectOk(
      await api("PATCH", `/api/meetings/folders/${seg(id)}`, {
        ...fields,
        parent_id,
      }),
    ) as { id: string };
    return {
      data: await withPath(api, data),
      change: { kind: "folder", ids: [id] },
    };
  },
});

const deleteFolder = defineTool({
  name: "delete_folder",
  description:
    "Delete an empty folder. Move its meetings out first (move_meetings), and move or delete its child folders. This cannot be undone.",
  kind: "delete",
  idempotent: true,
  input: z.object({ ...folderRefArgs, confirm: confirmArg }),
  run: async ({ folder_id, path }, { api }) => {
    const id = await resolveFolder(api, { folder_id, path });
    const data = expectOk(
      await api("DELETE", `/api/meetings/folders/${seg(id)}`),
    );
    return { data, change: { kind: "folder", ids: [id] } };
  },
});

const getFolderOverview = defineTool({
  name: "get_folder_overview",
  description: `Get the Overview of a folder: the action items, decisions and open questions from the summaries of its meetings. A parent folder includes its child folders. Each action item has a key for set_action_item_done. counts.with_summary counts the meetings that have a summary, also an old one. ${NEED_STAGE_TEXT}`,
  kind: "read",
  idempotent: true,
  input: z.object({ ...folderRefArgs }),
  run: async (ref, { api }) => {
    const id = await resolveFolder(api, ref);
    const overview = expectOk(
      await api("GET", `/api/meetings/folders/${seg(id)}/overview`),
    ) as {
      folder: { id: string };
      counts: { summarized?: number; stage_counts?: unknown };
    };
    const { summarized, ...counts } = withNeedStage(overview.counts);
    return {
      data: {
        ...overview,
        folder: await withPath(api, overview.folder),
        counts: { ...counts, with_summary: summarized },
      },
    };
  },
});

const setActionItemDone = defineTool({
  name: "set_action_item_done",
  description:
    "Mark an action item of a folder Overview as done or not done. On a parent folder, the mark of an item from a child folder is saved on the child folder.",
  kind: "write",
  idempotent: true,
  input: z.object({
    ...folderRefArgs,
    key: z
      .string()
      .min(1)
      .describe("The action item key (from get_folder_overview)."),
    done: z.boolean().describe("true marks it done, false marks it open."),
  }),
  run: async ({ folder_id, path, key, done }, { api }) => {
    const id = await resolveFolder(api, { folder_id, path });
    const data = expectOk(
      await api(
        "PUT",
        `/api/meetings/folders/${seg(id)}/action-items/${seg(key)}`,
        { done },
      ),
    );
    return { data, change: { kind: "folder", ids: [id] } };
  },
});

const getFolderStanding = defineTool({
  name: "get_folder_standing",
  description:
    "Get the saved standing text of a folder (where the project stands now). It does not call a model.",
  kind: "read",
  idempotent: true,
  input: z.object({ ...folderRefArgs }),
  run: async (ref, { api }) => {
    const id = await resolveFolder(api, ref);
    return {
      data: expectOk(
        await api("GET", `/api/meetings/folders/${seg(id)}/standing`),
      ),
    };
  },
});

const setFolderStanding = defineTool({
  name: "set_folder_standing",
  description:
    "Save your own standing text of a folder (where the project stands now), as bullets. It replaces the saved text and calls no model.",
  kind: "write",
  idempotent: true,
  input: z.object({
    ...folderRefArgs,
    bullets: z
      .array(z.string().min(1).max(240))
      .min(1)
      .max(FOLDER_STANDING_MAX_BULLETS)
      .describe(
        `One short line for each bullet, ${FOLDER_STANDING_MAX_BULLETS} at most, with no list marks.`,
      ),
  }),
  run: async ({ folder_id, path, bullets }, { api }) => {
    const id = await resolveFolder(api, { folder_id, path });
    const data = expectOk(
      await api("PUT", `/api/meetings/folders/${seg(id)}/standing`, {
        bullets,
      }),
    );
    return { data, change: { kind: "folder", ids: [id] } };
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
