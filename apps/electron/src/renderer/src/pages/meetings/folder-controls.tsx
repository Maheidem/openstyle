import {
  createMeetingFolderSchema,
  type MeetingListItem,
} from "@openstyle/validations";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { cn } from "@renderer/lib/utils";
import {
  Check,
  ChevronDown,
  FileText,
  Folder,
  Inbox,
  LockKeyhole,
  MoreHorizontal,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import { ContextMenu, DropdownMenu } from "radix-ui";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { folderErrorKey, type MeetingFolder } from "./folders-model";

const menuClass =
  "bg-popover text-popover-foreground border-border z-50 max-h-[min(420px,70vh)] min-w-56 max-w-72 overflow-y-auto rounded-lg border p-1 shadow-(--shadow-card)";
const itemClass =
  "focus:bg-accent flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] outline-none data-disabled:opacity-50 [&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-muted-foreground";

export function FolderNameInput({
  initialName = "",
  onSave,
  onCancel,
}: {
  initialName?: string;
  onSave: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const saving = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const save = async () => {
    if (saving.current) return;
    const valid = createMeetingFolderSchema.safeParse({ name });
    if (!valid.success) {
      setError(t("meetings.folders.nameInvalid"));
      return;
    }
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      await onSave(valid.data.name);
    } catch (err) {
      setError(t(folderErrorKey(err)));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="min-w-0 flex-1 py-1">
      <div className="flex items-center gap-1">
        <Input
          ref={ref}
          value={name}
          disabled={busy}
          aria-label={t("meetings.folders.name")}
          aria-invalid={Boolean(error)}
          aria-describedby={hintId}
          className="h-7 min-w-0 text-[12.5px]"
          maxLength={60}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void save();
            }
            if (event.key === "Escape" && !busy) {
              event.preventDefault();
              onCancel();
            }
          }}
        />
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={busy}
          onClick={() => void save()}
          aria-label={t("meetings.save")}
        >
          <Check />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={busy}
          onClick={onCancel}
          aria-label={t("meetings.cancel")}
        >
          <X />
        </Button>
      </div>
      <p
        id={hintId}
        role={error ? "alert" : undefined}
        className={cn(
          "mt-1 text-[10.5px]",
          error ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {error ?? t("meetings.folders.nameHint")}
      </p>
    </div>
  );
}

export function FolderMenu({
  folder,
  onRename,
  onDescription,
  onDelete,
}: {
  folder: MeetingFolder;
  onRename: () => void;
  onDescription: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const focusElsewhere = useRef(false);
  const act = (action: () => void) => {
    focusElsewhere.current = true;
    action();
  };
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
          aria-label={t("meetings.folders.actions", { name: folder.name })}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className={menuClass}
          align="end"
          sideOffset={4}
          onCloseAutoFocus={(event) => {
            if (focusElsewhere.current) {
              event.preventDefault();
              focusElsewhere.current = false;
            }
          }}
        >
          <DropdownMenu.Item
            className={itemClass}
            onSelect={() => act(onRename)}
          >
            <Pencil />
            {t("meetings.folders.rename")}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={itemClass}
            onSelect={() => act(onDescription)}
          >
            <FileText />
            {t("meetings.folders.editDescription")}
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="bg-border my-1 h-px" />
          <DropdownMenu.Item
            className={cn(
              itemClass,
              folder.meeting_count
                ? "text-muted-foreground"
                : "text-destructive [&>svg]:text-destructive",
            )}
            onSelect={() => act(onDelete)}
          >
            {folder.meeting_count ? <LockKeyhole /> : <Trash2 />}
            <span className="min-w-0">
              <span className="block">{t("meetings.folders.delete")}</span>
              {folder.meeting_count > 0 && (
                <span className="text-muted-foreground block text-[10.5px]">
                  {t("meetings.folders.deleteBlockedCount", {
                    count: folder.meeting_count,
                  })}
                </span>
              )}
            </span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function MoveItems({
  meeting,
  folders,
  onMove,
  context = false,
}: {
  meeting: Pick<MeetingListItem, "id" | "folder_id">;
  folders: MeetingFolder[];
  onMove: (folderId: string | null) => void;
  context?: boolean;
}) {
  const { t } = useTranslation();
  const Menu = context ? ContextMenu : DropdownMenu;
  return (
    <>
      <Menu.Label className="eyebrow px-2 py-1.5">
        {t("meetings.folders.moveTo")}
      </Menu.Label>
      {folders.map((folder) => (
        <Menu.Item
          key={folder.id}
          className={itemClass}
          disabled={meeting.folder_id === folder.id}
          onSelect={() => onMove(folder.id)}
        >
          <Folder />
          <span className="min-w-0 flex-1 truncate">
            {folder.name}
            <span className="text-muted-foreground block text-[10.5px]">
              {t("meetings.folders.meetingCount", {
                count: folder.meeting_count,
              })}
            </span>
          </span>
          {meeting.folder_id === folder.id && <Check />}
        </Menu.Item>
      ))}
      {folders.length === 0 && (
        <Menu.Label className="text-muted-foreground px-2 py-2 text-xs">
          {t("meetings.folders.noFolders")}
        </Menu.Label>
      )}
      {meeting.folder_id !== null && (
        <>
          <Menu.Separator className="bg-border my-1 h-px" />
          <Menu.Item className={itemClass} onSelect={() => onMove(null)}>
            <Inbox />
            {t("meetings.folders.remove")}
          </Menu.Item>
        </>
      )}
    </>
  );
}

export function MeetingFolderChip({
  meeting,
  folders,
  onMove,
}: {
  meeting: Pick<MeetingListItem, "id" | "folder_id">;
  folders: MeetingFolder[];
  onMove: (folderId: string | null) => void;
}) {
  const { t } = useTranslation();
  const folder = folders.find((f) => f.id === meeting.folder_id);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          variant="outline"
          size="xs"
          className={cn(
            "min-w-0 max-w-fit shrink grow basis-28 overflow-hidden",
            !meeting.folder_id && "border-dashed text-muted-foreground",
          )}
          aria-label={t("meetings.folders.moveTo")}
        >
          {meeting.folder_id ? <Folder /> : <Inbox />}
          <span className="truncate">
            {folder?.name ??
              t(
                meeting.folder_id
                  ? "meetings.folders.title"
                  : "meetings.folders.addTo",
              )}
          </span>
          <ChevronDown />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className={menuClass}
          sideOffset={4}
          align="start"
        >
          <MoveItems meeting={meeting} folders={folders} onMove={onMove} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function MeetingContextMenu({
  meeting,
  folders,
  onOpen,
  onMove,
  children,
}: {
  meeting: MeetingListItem;
  folders: MeetingFolder[];
  onOpen: () => void;
  onMove: (folderId: string | null) => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={menuClass}>
          <ContextMenu.Item className={itemClass} onSelect={onOpen}>
            <FileText />
            {t("meetings.folders.open")}
          </ContextMenu.Item>
          <ContextMenu.Separator className="bg-border my-1 h-px" />
          <MoveItems
            meeting={meeting}
            folders={folders}
            onMove={onMove}
            context
          />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
