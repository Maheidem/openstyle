/** What the Meetings page shows when the user leaves it. The page unmounts
 * on a switch to another sidebar page. This memory outlives the page, like
 * the set of recordings that already opened their live view. */
export interface MeetingsSelection {
  selectedId: string | null;
  selectedFolderId: string | null;
  expanded: Record<string, boolean>;
}

const initial = (): MeetingsSelection => ({
  selectedId: null,
  selectedFolderId: null,
  expanded: { none: true },
});

let remembered: MeetingsSelection = initial();

export function readMeetingsSelection(): MeetingsSelection {
  return remembered;
}

export function rememberMeetingsSelection(next: MeetingsSelection): void {
  remembered = next;
}

export function resetMeetingsSelection(): void {
  remembered = initial();
}

/** Drops a remembered meeting or folder that no longer exists. */
export function validateSelection(
  selection: Pick<MeetingsSelection, "selectedId" | "selectedFolderId">,
  meetingIds: ReadonlySet<string>,
  folderIds: ReadonlySet<string>,
): { selectedId: string | null; selectedFolderId: string | null } {
  return {
    selectedId:
      selection.selectedId && meetingIds.has(selection.selectedId)
        ? selection.selectedId
        : null,
    selectedFolderId:
      selection.selectedFolderId && folderIds.has(selection.selectedFolderId)
        ? selection.selectedFolderId
        : null,
  };
}
