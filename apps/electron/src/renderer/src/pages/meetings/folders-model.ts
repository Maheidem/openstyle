import type { ChatScope, MeetingListItem } from "@openstyle/validations";
import type { ApiClient, ApiRes } from "@renderer/lib/api";

export type MeetingFolder = ApiRes<
  ApiClient["api"]["meetings"]["folders"]["$get"]
>["items"][number];

export function recordingFolderId(
  selectedFolderId: string | null,
  meeting: Pick<MeetingListItem, "folder_id"> | null | undefined,
): string | null {
  return selectedFolderId ?? meeting?.folder_id ?? null;
}

export const MEETING_DRAG_TYPE = "application/x-openstyle-meeting";

export function folderErrorKey(error: unknown): string {
  if (error instanceof FolderRequestError) {
    if (error.code === "folder_name_exists")
      return "meetings.folders.nameExists";
    if (error.code === "invalid_request") return "meetings.folders.nameInvalid";
    if (error.code === "folder_not_found") return "meetings.folders.notFound";
    if (error.code === "folder_depth_exceeded")
      return "meetings.folders.depthExceeded";
  }
  return "meetings.folders.requestFailed";
}

export class FolderRequestError extends Error {
  constructor(
    public code: string,
    public meetingCount = 0,
    public childCount = 0,
  ) {
    super(code);
  }
}

// Sub-folders: 2 levels only. A top-level folder can hold child folders.

/** The child folders of a folder, in the server order (by name). */
export function childFolders(
  folders: readonly MeetingFolder[],
  parentId: string,
): MeetingFolder[] {
  return folders.filter((f) => f.parent_id === parentId);
}

/** The folders in tree order: each top-level folder, then its children. */
export function folderTreeOrder(
  folders: readonly MeetingFolder[],
): { folder: MeetingFolder; depth: 0 | 1 }[] {
  const ids = new Set(folders.map((f) => f.id));
  // A child of a missing parent shows at the top level.
  const top = folders.filter((f) => !f.parent_id || !ids.has(f.parent_id));
  return top.flatMap((folder) => [
    { folder, depth: 0 as const },
    ...childFolders(folders, folder.id).map((child) => ({
      folder: child,
      depth: 1 as const,
    })),
  ]);
}

/** The name of a folder with its parent: "Parent / Child". */
export function folderPath(
  folders: readonly MeetingFolder[],
  id: string | null,
): string | null {
  const folder = folders.find((f) => f.id === id);
  if (!folder) return null;
  const parent = folders.find((f) => f.id === folder.parent_id);
  return parent ? `${parent.name} / ${folder.name}` : folder.name;
}

/** A folder under this parent (null: top level) has this name already. */
export function folderNameTaken(
  folders: readonly MeetingFolder[],
  name: string,
  parentId: string | null,
  exceptId?: string,
): boolean {
  const lower = name.toLowerCase();
  return folders.some(
    (f) =>
      (f.parent_id ?? null) === parentId &&
      f.id !== exceptId &&
      f.name.toLowerCase() === lower,
  );
}

export type FolderMoveTarget = {
  /** The new parent. null: the top level. */
  parentId: string | null;
  folder: MeetingFolder | null;
  /** The folder is in this place now. */
  current: boolean;
  /** This place has a folder with the same name. */
  nameTaken: boolean;
};

/**
 * The places for "Move to…" of a folder: the top level, then each other
 * top-level folder. Empty when the folder has children (it can only stay at
 * the top level, because folders have 2 levels only).
 */
export function folderMoveTargets(
  folders: readonly MeetingFolder[],
  folder: MeetingFolder,
): FolderMoveTarget[] {
  if (childFolders(folders, folder.id).length > 0) return [];
  const here = folder.parent_id ?? null;
  const place = (target: MeetingFolder | null): FolderMoveTarget => {
    const parentId = target?.id ?? null;
    return {
      parentId,
      folder: target,
      current: parentId === here,
      nameTaken:
        parentId !== here &&
        folderNameTaken(folders, folder.name, parentId, folder.id),
    };
  };
  return [
    place(null),
    ...folders
      .filter((f) => !f.parent_id && f.id !== folder.id)
      .map((f) => place(f)),
  ];
}

/**
 * The meetings of a parent folder page in groups: the meetings of the parent
 * first, then one group for each child folder that has meetings. null when
 * the folder has no children (the page shows one flat list).
 */
export function meetingGroups(
  folders: readonly MeetingFolder[],
  folder: MeetingFolder,
  meetings: readonly MeetingListItem[],
):
  | { folder: MeetingFolder; own: boolean; meetings: MeetingListItem[] }[]
  | null {
  const children = childFolders(folders, folder.id);
  if (children.length === 0) return null;
  return [
    { folder, own: true },
    ...children.map((child) => ({ folder: child, own: false })),
  ]
    .map((group) => ({
      ...group,
      meetings: meetings.filter((m) => m.folder_id === group.folder.id),
    }))
    .filter((group) => group.meetings.length > 0);
}

/**
 * The scope one step wider (spec 6.3, D16): a meeting widens to its folder,
 * a child folder to its parent folder, an unfiled meeting and a top-level
 * folder to everything. null: nothing is wider.
 */
export function widerScope(
  scope: ChatScope,
  meetings: readonly Pick<MeetingListItem, "id" | "folder_id">[],
  folders: readonly Pick<MeetingFolder, "id" | "parent_id">[],
): ChatScope | null {
  if (scope.kind === "all") return null;
  if (scope.kind === "folder") {
    const parentId = folders.find((f) => f.id === scope.id)?.parent_id;
    return parentId ? { kind: "folder", id: parentId } : { kind: "all" };
  }
  const folderId = meetings.find((m) => m.id === scope.id)?.folder_id ?? null;
  return folderId ? { kind: "folder", id: folderId } : { kind: "all" };
}
