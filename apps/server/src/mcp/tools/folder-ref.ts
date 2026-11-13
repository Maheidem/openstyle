// Folder references of the MCP tools (sub-folders). A tool that takes a
// folder accepts `folder_id` or `path` ("Parent/Child" or "Parent"). Every
// folder in a tool answer has its id and its path.
import { z } from "zod";
import type { ApiCaller } from "../call-api.js";
import { expectOk, ToolError } from "./define.js";

const PATH_TEXT =
  'The folder path: "Parent/Child" for a child folder, "Parent" for a top-level folder. Names match without case. Give folder_id or path, not both.';

/** The `folder_id` and `path` args of a tool that needs a folder. */
export const folderRefArgs = {
  folder_id: z
    .string()
    .min(1)
    .optional()
    .describe("The folder id (from list_folders)."),
  path: z.string().min(1).optional().describe(PATH_TEXT),
};

/** The `folder_id` and `path` args of a list filter ("none": no folder). */
export function folderFilterArgs(what: string) {
  return {
    folder_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        `${what} of this folder (from list_folders). A parent folder includes its child folders. "none" gives the meetings with no folder.`,
      ),
    path: z
      .string()
      .min(1)
      .optional()
      .describe(`${what} of this folder, by path. ${PATH_TEXT}`),
  };
}

interface FolderRow {
  id: string;
  name: string;
  parent_id?: string | null;
}

/** All folders, read once per tool call, to resolve and to name paths. */
export class Folders {
  private constructor(private readonly rows: readonly FolderRow[]) {}

  static async load(api: ApiCaller): Promise<Folders> {
    const data = expectOk(await api("GET", "/api/meetings/folders")) as {
      items: FolderRow[];
    };
    return new Folders(data.items);
  }

  /** "Parent/Child", "Name", or null for no folder or an unknown id. */
  pathOf(id: string | null | undefined): string | null {
    if (!id) return null;
    const row = this.rows.find((f) => f.id === id);
    if (!row) return null;
    const parent = row.parent_id
      ? this.rows.find((f) => f.id === row.parent_id)
      : undefined;
    return parent ? `${parent.name}/${row.name}` : row.name;
  }

  /** The id of the folder at `path`. Throws a ToolError when not one. */
  idOfPath(path: string): string {
    const parts = path.split("/").map((p) => p.trim());
    if (parts.length > 2 || parts.some((p) => p === "")) {
      throw new ToolError(
        `Bad folder path "${path}". Use "Parent" or "Parent/Child" (folders have 2 levels).`,
      );
    }
    let parentId: string | null = null;
    let id = "";
    for (const part of parts) {
      const want = part.toLowerCase();
      const hits = this.rows.filter(
        (f) =>
          (f.parent_id ?? null) === parentId && f.name.toLowerCase() === want,
      );
      if (hits.length === 0) {
        throw new ToolError(
          `Not found (404): no folder at path "${path}". Call list_folders for the paths.`,
        );
      }
      if (hits.length > 1) {
        throw new ToolError(
          `The folder path "${path}" matches ${hits.length} folders. Give folder_id (from list_folders).`,
        );
      }
      id = (hits[0] as FolderRow).id;
      parentId = id;
    }
    return id;
  }

  /** A folder id, or a path when no folder has that id. */
  idOfIdOrPath(ref: string): string {
    return this.rows.some((f) => f.id === ref) ? ref : this.idOfPath(ref);
  }
}

/** Throw when the call gives both `folder_id` and `path`. */
function oneOf(ref: { folder_id?: unknown; path?: unknown }): void {
  if (ref.folder_id !== undefined && ref.path !== undefined) {
    throw new ToolError("Give folder_id or path, not both.");
  }
}

/** The folder id of a tool that needs a folder. */
export async function resolveFolder(
  api: ApiCaller,
  ref: { folder_id?: string; path?: string },
): Promise<string> {
  oneOf(ref);
  if (ref.folder_id !== undefined) return ref.folder_id;
  if (ref.path === undefined) throw new ToolError("Give folder_id or path.");
  return (await Folders.load(api)).idOfPath(ref.path);
}

/** The folder id of a list filter, "none", or undefined for no filter. */
export async function resolveFolderFilter(
  api: ApiCaller,
  ref: { folder_id?: string; path?: string },
): Promise<string | undefined> {
  oneOf(ref);
  if (ref.path === undefined) return ref.folder_id;
  return (await Folders.load(api)).idOfPath(ref.path);
}
