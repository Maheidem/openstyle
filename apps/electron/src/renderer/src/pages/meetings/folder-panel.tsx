import {
  type MeetingListItem,
  type MeetingStage,
  SETTINGS_KEYS,
} from "@openstyle/validations";
import { Button } from "@renderer/components/ui/button";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@renderer/components/ui/tabs";
import { Textarea } from "@renderer/components/ui/textarea";
import { formatClockDuration } from "@renderer/lib/format";
import { settingsQueryOptions } from "@renderer/lib/query";
import { useQuery } from "@tanstack/react-query";
import {
  CheckSquare,
  ChevronLeft,
  LockKeyhole,
  Mic,
  Pencil,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderAskTab } from "./ask-tab";
import {
  BatchConfirmDialog,
  type BatchRequest,
  FolderStageCard,
  MeetingBulkBar,
  toggleSelection,
} from "./batch";
import { FolderIcon, FolderNameInput } from "./folder-controls";
import { SuggestDescriptionButton } from "./folder-description-suggest";
import { FolderOverviewView } from "./folder-overview";
import { FolderMeetingRow } from "./folder-tree";
import {
  FolderRequestError,
  folderErrorKey,
  type MeetingFolder,
} from "./folders-model";

export function FolderPanel({
  folder,
  folders,
  meetings,
  loading,
  failed,
  initialAction,
  onUpdate,
  onDelete,
  onOpen,
  onMove,
  onBack,
  onStartBatch,
  autoRun = false,
}: {
  folder: MeetingFolder;
  folders: MeetingFolder[];
  meetings: MeetingListItem[];
  loading: boolean;
  failed: boolean;
  initialAction?: "description" | "delete";
  onUpdate: (values: {
    name?: string;
    description?: string | null;
  }) => Promise<void>;
  onDelete: () => Promise<void>;
  onOpen: (id: string) => void;
  onMove: (meeting: MeetingListItem, folderId: string | null) => void;
  onBack: () => void;
  /** Start a batch (specs/meeting-folder-batch.md). False: it did not start. */
  onStartBatch: (request: BatchRequest) => Promise<boolean>;
  /** The setting "run Enhance after each transcript" is on. */
  autoRun?: boolean;
}) {
  const { t, i18n } = useTranslation();
  // Selection mode of the meeting list: the checked ids, the last clicked
  // id (the start of a shift-click range) and the stage of the bulk bar.
  const [tab, setTab] = useState("overview");
  const tabsRef = useRef<HTMLDivElement>(null);
  // The Ask tab (meeting chat agent, scope F) shows with the setting on and at
  // least one meeting in the folder.
  const { data: appSettings } = useQuery(settingsQueryOptions());
  const askEnabled =
    appSettings?.[SETTINGS_KEYS.meetingChatEnabled] === "true" &&
    folder.meeting_count > 0;
  const [selecting, setSelecting] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [bulkStage, setBulkStage] = useState<MeetingStage>("summarize");
  const [confirm, setConfirm] = useState<BatchRequest | null>(null);
  // Keep only the ids that are still in the list (a move or a delete).
  const visibleChecked = meetings.filter((m) => checked.has(m.id));
  const toggle = (id: string, range: boolean) => {
    setChecked(
      toggleSelection(
        meetings.map((m) => m.id),
        checked,
        anchor,
        id,
        range,
      ),
    );
    setAnchor(id);
  };
  const stopSelecting = () => {
    setSelecting(false);
    setChecked(new Set());
    setAnchor(null);
  };
  const startBatch = async (request: BatchRequest) => {
    setConfirm(null);
    setError(null);
    if (!(await onStartBatch(request))) {
      setError(t("meetings.folders.batch.startFailed"));
    } else if ("meeting_ids" in request) stopSelecting();
  };
  const [renaming, setRenaming] = useState(false);
  const [descriptionOpen, setDescriptionOpen] = useState(
    initialAction === "description",
  );
  const [description, setDescription] = useState(folder.description ?? "");
  const [notice, setNotice] = useState<"blocked" | "confirm" | null>(
    initialAction === "delete"
      ? folder.meeting_count
        ? "blocked"
        : "confirm"
      : null,
  );
  const [blockedCount, setBlockedCount] = useState(folder.meeting_count);
  const [busy, setBusy] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (descriptionOpen) descriptionRef.current?.focus();
  }, [descriptionOpen]);
  const previousCount = useRef(folder.meeting_count);
  useEffect(() => {
    if (
      previousCount.current !== folder.meeting_count &&
      notice === "blocked"
    ) {
      setBlockedCount(folder.meeting_count);
      if (!folder.meeting_count) setNotice(null);
    }
    previousCount.current = folder.meeting_count;
  }, [folder.meeting_count, notice]);
  const day = (value: number | null) =>
    value === null
      ? "—"
      : new Date(value).toLocaleDateString(i18n.language, {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
  const askDelete = () => {
    setError(null);
    setBlockedCount(folder.meeting_count);
    setNotice(folder.meeting_count ? "blocked" : "confirm");
  };
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await onDelete();
    } catch (err) {
      if (
        err instanceof FolderRequestError &&
        err.code === "folder_not_empty"
      ) {
        setBlockedCount(err.meetingCount);
        setNotice("blocked");
      } else setError(t(folderErrorKey(err)));
    } finally {
      setBusy(false);
    }
  };
  const saveDescription = async () => {
    setBusy(true);
    setError(null);
    try {
      await onUpdate({ description: description.trim() || null });
      setDescriptionOpen(false);
    } catch (err) {
      setError(t(folderErrorKey(err)));
    } finally {
      setBusy(false);
    }
  };
  const facts = [
    [String(folder.meeting_count), t("meetings.titleAccent")],
    [day(folder.last_meeting_at), t("meetings.folders.lastMeeting")],
    [
      folder.meeting_count
        ? formatClockDuration(folder.total_duration_ms)
        : "—",
      t("meetings.folders.totalDuration"),
    ],
    [day(folder.first_meeting_at), t("meetings.folders.firstMeeting")],
  ];
  return (
    <section aria-label={folder.name}>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onBack}
        aria-label={t("meetings.back")}
        className="mb-2 min-[900px]:hidden"
      >
        <ChevronLeft />
      </Button>
      <p className="eyebrow mb-2">{t("meetings.folders.folder")}</p>
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <div className="border-border bg-card flex size-10 shrink-0 items-center justify-center rounded-lg border">
          <FolderIcon color={folder.color} className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          {renaming ? (
            <FolderNameInput
              initialName={folder.name}
              onCancel={() => setRenaming(false)}
              onSave={async (name) => {
                await onUpdate({ name });
                setRenaming(false);
              }}
            />
          ) : (
            <div className="flex min-w-0 items-center gap-1">
              <h2 className="truncate text-[17px] font-semibold">
                {folder.name}
              </h2>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setRenaming(true)}
                aria-label={t("meetings.folders.rename")}
              >
                <Pencil />
              </Button>
            </div>
          )}
          <p className="mono text-muted-foreground mt-1 text-[10.5px]">
            {t("meetings.folders.created", { date: day(folder.created_at) })}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={askDelete} disabled={busy}>
          <Trash2 />
          {t("meetings.folders.delete")}
        </Button>
      </div>
      {descriptionOpen ? (
        <div className="mb-5 max-w-prose">
          <Textarea
            ref={descriptionRef}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            aria-label={t("meetings.folders.description")}
            disabled={busy || suggesting}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !busy) setDescriptionOpen(false);
            }}
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              size="xs"
              disabled={busy || suggesting}
              onClick={() => void saveDescription()}
            >
              {t("meetings.save")}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => setDescriptionOpen(false)}
            >
              {t("meetings.cancel")}
            </Button>
            <SuggestDescriptionButton
              folderId={folder.id}
              disabled={busy}
              onRunning={setSuggesting}
              onSuggestion={setDescription}
            />
          </div>
        </div>
      ) : (
        <div className="text-muted-foreground mb-5 max-w-prose whitespace-pre-wrap text-[13px] leading-relaxed">
          {folder.description || t("meetings.folders.noDescription")}{" "}
          <button
            type="button"
            className="text-foreground rounded-sm font-semibold underline decoration-border underline-offset-4"
            onClick={() => {
              setDescription(folder.description ?? "");
              setDescriptionOpen(true);
            }}
          >
            {t(
              folder.description
                ? "meetings.folders.edit"
                : "meetings.folders.addDescription",
            )}
          </button>
        </div>
      )}
      {notice && (
        <div
          role="alert"
          className={
            notice === "blocked"
              ? "border-destructive/25 bg-destructive/5 mb-5 flex gap-2.5 rounded-lg border p-3.5 text-[12.5px]"
              : "border-border bg-card mb-5 flex gap-2.5 rounded-lg border p-3.5 text-[12.5px]"
          }
        >
          {notice === "blocked" ? (
            <LockKeyhole className="text-destructive mt-0.5 size-4 shrink-0" />
          ) : (
            <Trash2 className="text-muted-foreground mt-0.5 size-4 shrink-0" />
          )}
          <div>
            <h3 className="font-semibold">
              {t(
                notice === "blocked"
                  ? "meetings.folders.cannotDelete"
                  : "meetings.folders.confirmDelete",
                { name: folder.name },
              )}
            </h3>
            <p className="text-muted-foreground mb-2 mt-1">
              {t(
                notice === "blocked"
                  ? "meetings.folders.blockedBody"
                  : "meetings.folders.deleteBody",
                { count: blockedCount },
              )}
            </p>
            <div className="flex gap-2">
              {notice === "confirm" && (
                <Button
                  variant="destructive"
                  size="xs"
                  disabled={busy}
                  onClick={() => void remove()}
                >
                  {t("meetings.folders.delete")}
                </Button>
              )}
              <Button
                variant="ghost"
                size="xs"
                disabled={busy}
                onClick={() => setNotice(null)}
              >
                {t(
                  notice === "blocked"
                    ? "meetings.folders.close"
                    : "meetings.cancel",
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
      {error && (
        <p className="text-destructive mb-4 text-xs" role="alert">
          {error}
        </p>
      )}
      <div className="mb-5 grid grid-cols-2 gap-2 min-[1100px]:grid-cols-4">
        {facts.map(([value, label]) => (
          <div
            key={label}
            className="border-border bg-card min-w-0 rounded-lg border px-3.5 py-3"
          >
            <div
              className="display truncate text-[20px] tabular-nums"
              title={value}
            >
              {value}
            </div>
            <div className="text-muted-foreground mt-1 text-[11px]">
              {label}
            </div>
          </div>
        ))}
      </div>
      <FolderStageCard
        folder={folder}
        onRun={(stage, count) =>
          setConfirm({ stage, folder_id: folder.id, count })
        }
      />
      <Tabs
        value={tab}
        onValueChange={(next) => {
          setTab(next);
          // The folder header is tall. The Ask tab brings its tab row to the
          // top of the column, so the conversation is in view.
          if (next === "ask") {
            requestAnimationFrame(() =>
              tabsRef.current?.scrollIntoView({ block: "start" }),
            );
          }
        }}
      >
        <TabsList
          ref={tabsRef}
          variant="line"
          className="border-border w-full justify-start border-b"
        >
          <TabsTrigger
            value="overview"
            data-testid="folder-tab-overview"
            className="flex-none"
          >
            {t("meetings.folderOverview.tabOverview")}
          </TabsTrigger>
          <TabsTrigger
            value="meetings"
            data-testid="folder-tab-meetings"
            className="flex-none"
          >
            {t("meetings.folderOverview.tabMeetings")}
          </TabsTrigger>
          {askEnabled && (
            <TabsTrigger
              value="ask"
              data-testid="folder-tab-ask"
              className="flex-none"
            >
              {t("meetings.ask.tab")}
            </TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="overview">
          <FolderOverviewView folderId={folder.id} onOpen={onOpen} />
        </TabsContent>
        {askEnabled && (
          <TabsContent value="ask" className="pt-4">
            <FolderAskTab folderId={folder.id} folderName={folder.name} />
          </TabsContent>
        )}
        <TabsContent value="meetings" className="pt-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="eyebrow">
              {t("meetings.folders.meetingsInFolder")}
            </h3>
            {meetings.length > 0 && !loading && !failed && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() =>
                  selecting ? stopSelecting() : setSelecting(true)
                }
                data-testid="meeting-select-toggle"
              >
                <CheckSquare />
                {t(
                  selecting
                    ? "meetings.folders.batch.selectDone"
                    : "meetings.folders.batch.select",
                )}
              </Button>
            )}
          </div>
          {selecting && (
            <p className="text-muted-foreground mt-1 text-[11px]">
              {t("meetings.folders.batch.selectHint")}
            </p>
          )}
          {loading || failed ? (
            <p
              className="text-muted-foreground py-5 text-xs"
              role={failed ? "alert" : undefined}
            >
              {t(
                failed
                  ? "meetings.folders.loadFailed"
                  : "meetings.folders.loading",
              )}
            </p>
          ) : meetings.length ? (
            <div className="border-border bg-card mb-5 mt-2 overflow-hidden rounded-lg border">
              {meetings.map((meeting) => (
                <FolderMeetingRow
                  key={meeting.id}
                  meeting={meeting}
                  folders={folders}
                  onOpen={() => onOpen(meeting.id)}
                  onMove={(id) => onMove(meeting, id)}
                  table
                  check={
                    selecting
                      ? {
                          checked: checked.has(meeting.id),
                          onToggle: (range) => toggle(meeting.id, range),
                        }
                      : undefined
                  }
                />
              ))}
            </div>
          ) : (
            <p className="border-border text-muted-foreground mb-5 mt-2 rounded-lg border border-dashed p-6 text-center text-[12.5px]">
              {t("meetings.folders.emptyPanel")}
            </p>
          )}
          {selecting && (
            <MeetingBulkBar
              count={visibleChecked.length}
              total={meetings.length}
              stage={bulkStage}
              onStage={setBulkStage}
              onRun={() =>
                setConfirm({
                  stage: bulkStage,
                  meeting_ids: visibleChecked.map((m) => m.id),
                  count: visibleChecked.length,
                })
              }
              onSelectAll={() => setChecked(new Set(meetings.map((m) => m.id)))}
              onClear={() => setChecked(new Set())}
              onDone={stopSelecting}
            />
          )}
        </TabsContent>
      </Tabs>
      <BatchConfirmDialog
        request={confirm}
        autoRun={autoRun}
        onConfirm={(request) => void startBatch(request)}
        onClose={() => setConfirm(null)}
      />
      {folder.meeting_count > meetings.length && !loading && !failed && (
        <p className="text-muted-foreground mb-5 text-xs">
          {t("meetings.folders.listLimit", {
            count: meetings.length,
            total: folder.meeting_count,
          })}
        </p>
      )}
      <div className="border-border bg-card text-muted-foreground mb-5 flex items-start gap-2 rounded-lg border px-3.5 py-2.5 text-xs">
        <Mic className="mt-0.5 size-3.5 shrink-0" />
        <span>{t("meetings.folders.recordInfo")}</span>
      </div>
    </section>
  );
}
