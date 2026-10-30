import type { MeetingListItem } from "@openstyle/validations";
import { Button } from "@renderer/components/ui/button";
import { formatClockDuration, formatTimestamp } from "@renderer/lib/format";
import { cn } from "@renderer/lib/utils";
import { ChevronDown, ChevronRight, Inbox, Plus } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  FolderIcon,
  FolderMenu,
  FolderNameInput,
  MeetingContextMenu,
} from "./folder-controls";
import { MEETING_DRAG_TYPE, type MeetingFolder } from "./folders-model";
import { JobBadge, StatusBadge } from "./shared";

export function FolderMeetingRow({
  meeting,
  folders,
  selected = false,
  onOpen,
  onMove,
  table = false,
  check,
}: {
  meeting: MeetingListItem;
  folders: MeetingFolder[];
  selected?: boolean;
  onOpen: () => void;
  onMove: (folderId: string | null) => void;
  table?: boolean;
  /** Selection mode of the folder page (specs/meeting-folder-batch.md): a
   * click toggles the check box instead of opening the meeting. */
  check?: { checked: boolean; onToggle: (range: boolean) => void };
}) {
  const { t, i18n } = useTranslation();
  const [dragging, setDragging] = useState(false);
  const facts = (
    <>
      <span className="min-w-0 truncate text-[12.5px] font-medium">
        {meeting.title || t("meetings.untitled")}
      </span>
      <span className="flex min-w-0 items-center justify-between gap-2">
        <span className="mono text-muted-foreground min-w-0 truncate text-[10px]">
          {formatTimestamp(meeting.started_at, i18n.language)} ·{" "}
          {formatClockDuration(meeting.duration_ms)}
        </span>
        {meeting.job ? (
          <JobBadge job={meeting.job} />
        ) : (
          <StatusBadge status={meeting.display_status ?? meeting.status} />
        )}
      </span>
    </>
  );
  if (check) {
    // A label: a click on the row or on the box toggles once. Shift-click
    // selects the range from the last click.
    return (
      // biome-ignore lint/a11y/useKeyWithClickEvents: Space on the focused check box clicks it, and that click reaches this handler
      <label
        data-testid="meeting-select-row"
        onClick={(event) => {
          event.preventDefault();
          check.onToggle(event.shiftKey);
        }}
        className={cn(
          "hover:bg-accent/50 flex w-full min-w-0 cursor-default select-none items-center gap-2.5 px-2.5 py-2 text-left transition-colors",
          check.checked &&
            "bg-[var(--accent-passive-tint)] text-[var(--accent-passive-ink)]",
          table && "border-b border-b-border last:border-b-0",
        )}
      >
        <input
          type="checkbox"
          checked={check.checked}
          onChange={() => {}}
          aria-label={meeting.title || t("meetings.untitled")}
          className="size-3.5 shrink-0 accent-[var(--accent-passive-ink)]"
        />
        <span className="flex min-w-0 flex-1 flex-col gap-1">{facts}</span>
      </label>
    );
  }
  return (
    <MeetingContextMenu
      meeting={meeting}
      folders={folders}
      onOpen={onOpen}
      onMove={onMove}
    >
      <button
        type="button"
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(MEETING_DRAG_TYPE, meeting.id);
          event.dataTransfer.effectAllowed = "move";
          setDragging(true);
        }}
        onDragEnd={() => setDragging(false)}
        onClick={onOpen}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "hover:bg-accent/50 flex w-full min-w-0 flex-col gap-1 rounded-lg border border-transparent px-2.5 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring",
          selected &&
            "bg-[var(--accent-passive-tint)] text-[var(--accent-passive-ink)]",
          dragging && "opacity-40",
          table && "rounded-none border-b border-b-border last:border-b-0",
        )}
      >
        {facts}
      </button>
    </MeetingContextMenu>
  );
}

function FolderGroup({
  name,
  folder,
  meetings,
  folders,
  expanded,
  selected,
  activeId,
  loading,
  failed,
  renaming,
  onToggle,
  onSelect,
  onOpen,
  onMove,
  onRename,
  onDescription,
  onDelete,
  onSaveName,
  onCancelName,
  onDrop,
}: {
  name: string;
  folder?: MeetingFolder;
  meetings: MeetingListItem[];
  folders: MeetingFolder[];
  expanded: boolean;
  selected: boolean;
  activeId: string | null;
  loading: boolean;
  failed: boolean;
  renaming: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onOpen: (id: string) => void;
  onMove: (meeting: MeetingListItem, folderId: string | null) => void;
  onRename: () => void;
  onDescription: () => void;
  onDelete: () => void;
  onSaveName: (name: string) => Promise<void>;
  onCancelName: () => void;
  onDrop: (meetingId: string, folderId: string | null) => void;
}) {
  const { t } = useTranslation();
  const [over, setOver] = useState(false);
  const childrenId = useId();
  return (
    <div>
      <fieldset
        aria-label={name}
        className={cn(
          "group flex min-h-9 min-w-0 items-center gap-0.5 rounded-lg border border-transparent py-0.5 hover:bg-accent/40",
          selected &&
            "bg-[var(--accent-passive-tint)] text-[var(--accent-passive-ink)]",
          over && "border-muted-foreground border-dashed bg-accent",
        )}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes(MEETING_DRAG_TYPE)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setOver(true);
          }
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setOver(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          const id = event.dataTransfer.getData(MEETING_DRAG_TYPE);
          if (id) onDrop(id, folder?.id ?? null);
        }}
      >
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={childrenId}
          aria-label={t(
            expanded ? "meetings.folders.collapse" : "meetings.folders.expand",
            { name },
          )}
        >
          {expanded ? <ChevronDown /> : <ChevronRight />}
        </Button>
        {renaming ? (
          <FolderNameInput
            initialName={name}
            onSave={onSaveName}
            onCancel={onCancelName}
          />
        ) : (
          <>
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left text-[13px] font-semibold focus-visible:outline-2 focus-visible:outline-ring"
              onClick={onSelect}
              aria-current={selected ? "true" : undefined}
            >
              {folder ? (
                <FolderIcon
                  color={folder.color}
                  className="size-3.5 shrink-0"
                />
              ) : (
                <Inbox className="text-muted-foreground size-3.5 shrink-0" />
              )}
              <span className="truncate">{name}</span>
            </button>
            <span className="mono text-muted-foreground px-1 text-[10px]">
              {folder?.meeting_count ?? meetings.length}
            </span>
            {folder ? (
              <FolderMenu
                folder={folder}
                onRename={onRename}
                onDescription={onDescription}
                onDelete={onDelete}
              />
            ) : (
              <span className="w-6" />
            )}
          </>
        )}
      </fieldset>
      {expanded && (
        <div
          id={childrenId}
          className="border-border my-1 ml-3.5 flex flex-col gap-0.5 border-l pl-2"
        >
          {loading || failed ? (
            <p
              className="text-muted-foreground px-2 py-2 text-[11.5px]"
              role={failed ? "alert" : undefined}
            >
              {t(
                failed
                  ? "meetings.folders.loadFailed"
                  : "meetings.folders.loading",
              )}
            </p>
          ) : meetings.length ? (
            meetings.map((meeting) => (
              <FolderMeetingRow
                key={meeting.id}
                meeting={meeting}
                folders={folders}
                selected={activeId === meeting.id}
                onOpen={() => onOpen(meeting.id)}
                onMove={(id) => onMove(meeting, id)}
              />
            ))
          ) : (
            <p className="text-muted-foreground px-2 py-2 text-[11.5px]">
              {t(
                folder
                  ? "meetings.folders.emptyRail"
                  : "meetings.folders.emptyUnfiled",
              )}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function FolderTree({
  folders,
  groups,
  expanded,
  selectedFolderId,
  activeId,
  creating,
  renamingId,
  onExpanded,
  onFolder,
  onOpen,
  onCreate,
  onCancelCreate,
  onNew,
  onRename,
  onSaveName,
  onCancelName,
  onAction,
  onMove,
  onDrop,
}: {
  folders: MeetingFolder[];
  groups: Map<
    string | null,
    { meetings: MeetingListItem[]; loading: boolean; failed: boolean }
  >;
  expanded: Record<string, boolean>;
  selectedFolderId: string | null;
  activeId: string | null;
  creating: boolean;
  renamingId: string | null;
  onExpanded: (id: string) => void;
  onFolder: (id: string) => void;
  onOpen: (id: string) => void;
  onCreate: (name: string) => Promise<void>;
  onCancelCreate: () => void;
  onNew: () => void;
  onRename: (id: string) => void;
  onSaveName: (id: string, name: string) => Promise<void>;
  onCancelName: () => void;
  onAction: (id: string, action: "description" | "delete") => void;
  onMove: (meeting: MeetingListItem, folderId: string | null) => void;
  onDrop: (meetingId: string, folderId: string | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="mb-1 flex min-h-7 items-center justify-between">
        <span className="eyebrow">{t("meetings.folders.title")}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onNew}
          aria-label={t("meetings.folders.new")}
        >
          <Plus />
        </Button>
      </div>
      {creating && (
        <FolderNameInput onSave={onCreate} onCancel={onCancelCreate} />
      )}
      {[...folders, undefined].map((folder) => {
        const id = folder?.id ?? "none";
        const data = groups.get(folder?.id ?? null);
        return (
          <FolderGroup
            key={id}
            folder={folder}
            name={folder?.name ?? t("meetings.folders.unfiled")}
            folders={folders}
            meetings={data?.meetings ?? []}
            loading={data?.loading ?? true}
            failed={data?.failed ?? false}
            expanded={expanded[id] ?? false}
            selected={Boolean(folder && selectedFolderId === folder.id)}
            activeId={activeId}
            renaming={folder !== undefined && renamingId === folder.id}
            onToggle={() => onExpanded(id)}
            onSelect={() => (folder ? onFolder(folder.id) : onExpanded(id))}
            onOpen={onOpen}
            onMove={onMove}
            onRename={() => folder && onRename(folder.id)}
            onDescription={() => folder && onAction(folder.id, "description")}
            onDelete={() => folder && onAction(folder.id, "delete")}
            onSaveName={(name) =>
              folder ? onSaveName(folder.id, name) : Promise.resolve()
            }
            onCancelName={onCancelName}
            onDrop={onDrop}
          />
        );
      })}
      <p className="text-muted-foreground mt-3 text-[11px] leading-relaxed">
        {t("meetings.folders.railHint")}
      </p>
    </>
  );
}
