import type { MeetingListItem } from "@openstyle/validations";
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
  }
  return "meetings.folders.requestFailed";
}

export class FolderRequestError extends Error {
  constructor(
    public code: string,
    public meetingCount = 0,
  ) {
    super(code);
  }
}
