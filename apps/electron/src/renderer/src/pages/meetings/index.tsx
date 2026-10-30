import type {
  MeetingDetail,
  MeetingListItem,
  SearchHit,
} from "@openstyle/validations";
import { DragSpacer } from "@renderer/components/drag-spacer";
import { Button } from "@renderer/components/ui/button";
import { getClient } from "@renderer/lib/api";
import {
  configQueryOptions,
  queryKeys,
  settingsQueryOptions,
} from "@renderer/lib/query";
import { cn } from "@renderer/lib/utils";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Mic, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useSearchParams } from "react-router";
import { SETTINGS_KEYS } from "../../../../shared/settings-keys";
import { BatchProgressCard, batchKey, useMeetingBatch } from "./batch";
import { MeetingDetailView } from "./detail";
import { EnhancePromptDialog } from "./enhance-prompt-dialog";
import { FolderPanel } from "./folder-panel";
import { FolderTree } from "./folder-tree";
import { folderMeetingsOptions, useMeetingFolders } from "./folders-data";
import { folderErrorKey, recordingFolderId } from "./folders-model";
import {
  MeetingImportRail,
  MeetingsEmptyState,
  useMeetingImport,
} from "./import";
import { LiveView } from "./live-view";
import {
  RecordingCard,
  SystemAudioHint,
  useLiveChatEnabled,
  useRecorder,
  useSystemAudioProbe,
} from "./recording";
import {
  MeetingSearchBar,
  MeetingSearchResults,
  useSearchStatus,
} from "./search";
import {
  readMeetingsSelection,
  rememberMeetingsSelection,
  validateSelection,
} from "./selection-memory";
import {
  AsrContextSettingsPopover,
  DiarizationSettingsPopover,
  EnhanceSettingsPopover,
} from "./settings-popovers";
import type { SearchFocus } from "./types";

/** The recordings that already opened their live view. It outlives the page,
 * so a mount in the middle of a recording does not open the view again. */
const autoOpenedLive = new Set<string>();

export default function MeetingsPage(): React.JSX.Element {
  const { t } = useTranslation();
  // The selection comes back after a visit to another page.
  const [selectedId, setSelectedId] = useState<string | null>(
    () => readMeetingsSelection().selectedId,
  );
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(
    () => readMeetingsSelection().selectedFolderId,
  );
  const [expanded, setExpanded] = useState<Record<string, boolean>>(
    () => readMeetingsSelection().expanded,
  );
  useEffect(() => {
    rememberMeetingsSelection({ selectedId, selectedFolderId, expanded });
  }, [selectedId, selectedFolderId, expanded]);
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [panelAction, setPanelAction] = useState<{
    kind: "description" | "delete";
    seq: number;
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** The submitted search text. Its scope is the selected folder (D21). */
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  // Where the last search hit opens its meeting (spec 7.4).
  const [searchFocus, setSearchFocus] = useState<SearchFocus | null>(null);
  const moving = useRef(false);
  const detailColumn = useRef<HTMLDivElement>(null);
  const listColumn = useRef<HTMLElement>(null);
  // A restored selection can sit below the fold of the list. Scroll to it
  // once, when its row first renders. Later clicks do not scroll.
  const restoredSelection = useRef(
    Boolean(readMeetingsSelection().selectedId) ||
      Boolean(readMeetingsSelection().selectedFolderId),
  );
  const actionSequence = useRef(0);
  const { data: config, isLoading: configLoading } = useQuery(
    configQueryOptions(),
  );
  const enabled = config?.flags?.meetings === true;
  const folderData = useMeetingFolders(enabled);
  const folders = useMemo(() => folderData.data ?? [], [folderData.data]);
  const { data: listData, isError: listFailed } = useQuery({
    queryKey: queryKeys.meetings.list,
    queryFn: async (): Promise<MeetingListItem[]> => {
      const res = await getClient().api.meetings.$get({ query: {} });
      if (!res.ok) throw new Error("meetings_load_failed");
      return (await res.json()).items;
    },
    enabled,
    // Poll while a row records, transcribes or runs any job, so its badge
    // and percent stay current.
    refetchInterval: (query) =>
      query.state.data?.some(
        (m) =>
          m.status === "recording" ||
          m.status === "transcribing" ||
          m.job != null,
      )
        ? 2000
        : false,
  });
  const meetings = useMemo(() => listData ?? [], [listData]);
  // Once the lists load, drop a remembered meeting or folder that is gone.
  const selectionChecked = useRef(false);
  useEffect(() => {
    if (selectionChecked.current || !listData || !folderData.data) return;
    selectionChecked.current = true;
    const valid = validateSelection(
      { selectedId, selectedFolderId },
      new Set(listData.map((m) => m.id)),
      new Set(folderData.data.map((f) => f.id)),
    );
    if (valid.selectedId !== selectedId) setSelectedId(valid.selectedId);
    if (valid.selectedFolderId !== selectedFolderId)
      setSelectedFolderId(valid.selectedFolderId);
  }, [listData, folderData.data, selectedId, selectedFolderId]);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  useEffect(() => {
    if (meetings.length > 0 && !meetings.some((m) => m.id === defaultId))
      setDefaultId(meetings[0].id);
  }, [meetings, defaultId]);
  const activeId = selectedFolderId
    ? null
    : (selectedId ??
      (meetings.some((m) => m.id === defaultId) ? defaultId : null));
  const { data: openMeeting } = useQuery({
    queryKey: queryKeys.meetings.detail(activeId ?? ""),
    queryFn: async (): Promise<MeetingDetail | null> => {
      const res = await getClient().api.meetings[":id"].$get({
        param: { id: activeId! },
      });
      return res.ok ? res.json() : null;
    },
    enabled: enabled && activeId !== null,
  });
  const targetId = recordingFolderId(selectedFolderId, openMeeting);
  const targetName =
    folders.find((folder) => folder.id === targetId)?.name ??
    t("meetings.folders.unfiled");
  const targetReady =
    (!activeId || openMeeting !== undefined) &&
    (targetId === null || folders.some((folder) => folder.id === targetId));
  const recorder = useRecorder(targetId);
  // The live view (#375): the right pane shows the live transcript and the
  // chat of the recording, while the setting is on.
  const liveEnabled = useLiveChatEnabled();
  const recordingId =
    recorder.status === "recording"
      ? (recorder.meetingId ??
        meetings.find((m) => m.status === "recording")?.id ??
        null)
      : null;
  const showLive =
    liveEnabled && recordingId !== null && activeId === recordingId;
  const groupIds = useMemo(
    () => [...folders.map((folder) => folder.id), null],
    [folders],
  );
  const groupQueries = useQueries({
    queries: groupIds.map((id) => ({
      ...folderMeetingsOptions(id),
      enabled:
        enabled &&
        (id === null || Boolean(expanded[id]) || selectedFolderId === id),
    })),
  });
  const groups = new Map(
    groupIds.map((id, i) => [
      id,
      {
        meetings: groupQueries[i].data ?? [],
        loading: groupQueries[i].isPending,
        failed: groupQueries[i].isError,
      },
    ]),
  );
  const activeFolder = folders.find((folder) => folder.id === selectedFolderId);
  const searchStatus = useSearchStatus(enabled);
  // The batch queue (specs/meeting-folder-batch.md). A finished batch stays
  // in the rail until the user closes it or a new batch starts.
  const batch = useMeetingBatch(enabled);
  const [closedBatch, setClosedBatch] = useState<string | null>(null);
  const showBatch =
    batch.state !== undefined &&
    batch.state.total > 0 &&
    (batch.state.active || closedBatch !== batchKey(batch.state));
  const folderGroup = groups.get(selectedFolderId);
  // biome-ignore lint/correctness/useExhaustiveDependencies: run when the rows load
  useEffect(() => {
    if (!restoredSelection.current) return;
    const row = listColumn.current?.querySelector('[aria-current="true"]');
    if (!row) return;
    restoredSelection.current = false;
    row.scrollIntoView({ block: "nearest" });
  }, [groupQueries, folders]);

  const openFolderId = openMeeting?.folder_id;
  useEffect(() => {
    if (!activeId || openFolderId === undefined) return;
    setExpanded((old) =>
      old[openFolderId ?? "none"]
        ? old
        : { ...old, [openFolderId ?? "none"]: true },
    );
  }, [activeId, openFolderId]);

  // The detail column scrolls on its own. A new meeting, folder or search
  // starts at the top of the column.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on selection change
  useEffect(() => {
    detailColumn.current?.scrollTo({ top: 0 });
  }, [activeId, selectedFolderId, searchQuery]);

  const [searchParams, setSearchParams] = useSearchParams();
  const confirmStart = searchParams.get("confirmStart") === "1";
  const { start: startRecording, supported, status } = recorder;
  useEffect(() => {
    if (!confirmStart || !supported || status !== "idle" || !targetReady)
      return;
    setSearchParams({}, { replace: true });
    void startRecording();
  }, [
    confirmStart,
    supported,
    status,
    targetReady,
    setSearchParams,
    startRecording,
  ]);
  const open = useCallback((id: string) => {
    setSearchFocus(null);
    setSearchQuery(null);
    setSelectedFolderId(null);
    setSelectedId(id);
    setPanelAction(null);
    setRenamingId(null);
  }, []);
  // The tray popover opens a meeting with ?meeting=<id> (issue #317).
  const linkedMeeting = searchParams.get("meeting");
  useEffect(() => {
    if (!linkedMeeting) return;
    setSearchParams({}, { replace: true });
    open(linkedMeeting);
  }, [linkedMeeting, setSearchParams, open]);
  const openHit = useCallback(
    (hit: SearchHit) => {
      open(hit.meeting_id);
      setSearchFocus({
        meetingId: hit.meeting_id,
        kind: hit.kind,
        startMs: hit.start_ms,
      });
    },
    [open],
  );
  // A new recording opens its live view once. The user can click away. A
  // click on the recording row, or the link in the card, opens it again.
  useEffect(() => {
    if (!liveEnabled || !recordingId || autoOpenedLive.has(recordingId)) return;
    autoOpenedLive.add(recordingId);
    open(recordingId);
  }, [liveEnabled, recordingId, open]);
  const meetingImport = useMeetingImport(open);
  const importError =
    meetingImport.state.status === "error" ? meetingImport.state : null;
  const { data: enhanceSettings } = useQuery(settingsQueryOptions());
  const showEnhancePrompt =
    meetings.some(
      (m) => m.status === "transcribed" || m.status === "summarized",
    ) &&
    enhanceSettings !== undefined &&
    enhanceSettings[SETTINGS_KEYS.meetingEnhanceAutoRun] === undefined &&
    enhanceSettings[SETTINGS_KEYS.meetingEnhancePromptSeen] !== "true";
  const showAudioHint = useSystemAudioProbe(
    enabled &&
      recorder.supported &&
      recorder.status === "idle" &&
      listData !== undefined &&
      meetings.length === 0,
  );
  const selectFolder = (id: string) => {
    setSelectedFolderId(id);
    setSelectedId(null);
    setPanelAction(null);
    setRenamingId(null);
    setExpanded((old) => ({ ...old, [id]: true }));
  };
  const back = () => {
    setSearchQuery(null);
    setSelectedId(null);
    setSelectedFolderId(null);
    setPanelAction(null);
    setRenamingId(null);
  };
  const move = async (
    meeting: Pick<MeetingListItem, "id" | "folder_id">,
    folderId: string | null,
  ) => {
    if (moving.current) return;
    moving.current = true;
    setActionError(null);
    try {
      await folderData.move(meeting, folderId);
      setExpanded((old) => ({ ...old, [folderId ?? "none"]: true }));
    } catch (err) {
      setActionError(t(folderErrorKey(err)));
    } finally {
      moving.current = false;
    }
  };
  const drop = (id: string, folderId: string | null) => {
    const meeting = [
      ...meetings,
      ...[...groups.values()].flatMap((group) => group.meetings),
    ].find((m) => m.id === id);
    if (meeting) void move(meeting, folderId);
  };
  if (!configLoading && !enabled) return <Navigate to="/today" replace />;
  const explicitSelection = Boolean(
    selectedId || selectedFolderId || searchQuery,
  );
  // The empty state has its own import button and error. The rail shows
  // its import controls only when the empty state is not on the page.
  const showEmptyState = !activeFolder && !activeId;
  const recordingCard = (
    <RecordingCard
      recorder={recorder}
      compact
      targetName={targetName}
      targetReady={targetReady}
      onOpenLive={
        liveEnabled && recordingId ? () => open(recordingId) : undefined
      }
    />
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <DragSpacer />
      {showEnhancePrompt && <EnhancePromptDialog />}
      {/* Issue #262: at 900px and wider, the page has the height of the
          window. The list column and the detail column scroll on their own.
          Below 900px, one column shows and the page scrolls as one. */}
      <div
        className="responsive-page-scroll flex min-h-0 flex-1 flex-col overflow-auto pt-5 min-[900px]:overflow-hidden min-[900px]:pb-0"
        style={{ scrollbarWidth: "none" }}
      >
        <MeetingSearchBar
          status={searchStatus.data}
          scopeName={activeFolder?.name ?? null}
          onSearch={setSearchQuery}
        />
        {showAudioHint && <SystemAudioHint />}
        {actionError && (
          <p className="text-destructive mb-3 text-xs" role="alert">
            {actionError}
          </p>
        )}
        <div className="grid flex-1 grid-cols-1 gap-6 min-[900px]:min-h-0 min-[900px]:grid-cols-[262px_minmax(0,1fr)] min-[900px]:grid-rows-[minmax(0,1fr)]">
          <aside
            ref={listColumn}
            aria-label={t("meetings.folders.railLabel")}
            data-testid="meetings-list-column"
            style={{ scrollbarWidth: "none" }}
            className={cn(
              "min-w-0 min-[900px]:border-border min-[900px]:min-h-0 min-[900px]:overflow-y-auto min-[900px]:border-r min-[900px]:pr-6 min-[900px]:pb-8",
              explicitSelection && "max-[899px]:hidden",
            )}
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className="eyebrow">{t("meetings.titleAccent")}</span>
              <div className="flex gap-1.5">
                <DiarizationSettingsPopover />
                <EnhanceSettingsPopover />
                <AsrContextSettingsPopover />
              </div>
            </div>
            {showEmptyState ? (
              recordingCard
            ) : (
              <MeetingImportRail
                onFile={meetingImport.handleFile}
                onPick={() => void meetingImport.handlePick()}
                importing={meetingImport.importing}
                error={importError}
              >
                {recordingCard}
              </MeetingImportRail>
            )}
            {showBatch && batch.state && (
              <BatchProgressCard
                state={batch.state}
                onCancel={() => void batch.cancel()}
                onClose={() =>
                  batch.state && setClosedBatch(batchKey(batch.state))
                }
              />
            )}
            {(folderData.isError || listFailed) && (
              <p className="text-destructive mb-3 text-xs" role="alert">
                {t("meetings.folders.loadFailed")}
              </p>
            )}
            {folderData.isPending ? (
              <p className="text-muted-foreground text-xs">
                {t("meetings.folders.loading")}
              </p>
            ) : (
              <FolderTree
                folders={folders}
                groups={groups}
                expanded={expanded}
                selectedFolderId={selectedFolderId}
                activeId={activeId}
                creating={creating}
                renamingId={renamingId}
                onExpanded={(id) =>
                  setExpanded((old) => ({ ...old, [id]: !old[id] }))
                }
                onFolder={selectFolder}
                onOpen={open}
                onNew={() => {
                  setCreating(true);
                  setRenamingId(null);
                }}
                onCancelCreate={() => setCreating(false)}
                onCreate={async (name) => {
                  const folder = await folderData.create(name);
                  setCreating(false);
                  selectFolder(folder.id);
                }}
                onRename={(id) => {
                  setCreating(false);
                  setRenamingId(id);
                }}
                onCancelName={() => setRenamingId(null)}
                onSaveName={async (id, name) => {
                  await folderData.update(id, { name });
                  setRenamingId(null);
                }}
                onAction={(id, kind) => {
                  selectFolder(id);
                  setPanelAction({ kind, seq: ++actionSequence.current });
                }}
                onMove={(meeting, id) => void move(meeting, id)}
                onDrop={drop}
              />
            )}
          </aside>
          <div
            ref={detailColumn}
            data-testid="meetings-detail-column"
            style={{ scrollbarWidth: "none" }}
            className={cn(
              "min-w-0 min-[900px]:min-h-0 min-[900px]:overflow-y-auto min-[900px]:pb-8",
              !explicitSelection &&
                (activeId || activeFolder) &&
                "max-[899px]:hidden",
            )}
          >
            {explicitSelection && (
              <div className="mb-4 min-[900px]:hidden">
                {recorder.status === "idle" ? (
                  <>
                    <Button
                      size="xs"
                      disabled={
                        !recorder.supported || recorder.starting || !targetReady
                      }
                      onClick={() => void recorder.start()}
                    >
                      <Mic />
                      {t("meetings.start")}
                    </Button>
                    <p className="text-muted-foreground mt-2 text-[11.5px]">
                      {t("meetings.folders.recordsInto")}{" "}
                      <strong className="text-foreground">{targetName}</strong>
                    </p>
                  </>
                ) : (
                  <Button
                    variant="destructive"
                    size="xs"
                    disabled={recorder.status === "finalizing"}
                    onClick={() => void recorder.stop()}
                  >
                    <Square />
                    {t(
                      recorder.status === "finalizing"
                        ? "meetings.finalizing"
                        : "meetings.stop",
                    )}
                  </Button>
                )}
                {recorder.error && (
                  <p role="alert" className="text-destructive mt-2 text-xs">
                    {recorder.error}
                  </p>
                )}
              </div>
            )}
            {searchQuery ? (
              <MeetingSearchResults
                query={searchQuery}
                folderId={activeFolder?.id ?? null}
                scopeName={activeFolder?.name ?? null}
                onOpen={openHit}
                onClose={() => setSearchQuery(null)}
              />
            ) : activeFolder ? (
              <FolderPanel
                key={`${activeFolder.id}-${panelAction?.seq ?? 0}`}
                folder={activeFolder}
                folders={folders}
                meetings={folderGroup?.meetings ?? []}
                loading={folderGroup?.loading ?? true}
                failed={folderGroup?.failed ?? false}
                initialAction={panelAction?.kind}
                onUpdate={(values) =>
                  folderData.update(activeFolder.id, values)
                }
                onDelete={async () => {
                  await folderData.remove(activeFolder.id);
                  back();
                }}
                onOpen={open}
                onMove={(meeting, id) => void move(meeting, id)}
                onBack={back}
                onStartBatch={batch.start}
                autoRun={
                  enhanceSettings?.[SETTINGS_KEYS.meetingEnhanceAutoRun] ===
                  "true"
                }
              />
            ) : showLive && recordingId ? (
              <LiveView
                meetingId={recordingId}
                title={openMeeting?.title ?? null}
                startedAt={recorder.startedAt}
              />
            ) : activeId ? (
              <MeetingDetailView
                key={activeId}
                id={activeId}
                focus={
                  searchFocus?.meetingId === activeId ? searchFocus : undefined
                }
                folders={folders}
                onMove={(meeting, id) => void move(meeting, id)}
                onBack={back}
                onDeleted={back}
              />
            ) : (
              <MeetingsEmptyState
                onFile={meetingImport.handleFile}
                onPick={() => void meetingImport.handlePick()}
                importing={meetingImport.importing}
                error={importError}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
