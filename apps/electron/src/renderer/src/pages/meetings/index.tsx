import type { MeetingDetail, MeetingListItem } from "@openstyle/validations";
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
import {
  RecordingCard,
  SystemAudioHint,
  useRecorder,
  useSystemAudioProbe,
} from "./recording";
import {
  AsrContextSettingsPopover,
  DiarizationSettingsPopover,
  EnhanceSettingsPopover,
} from "./settings-popovers";

export default function MeetingsPage(): React.JSX.Element {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    none: true,
  });
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [panelAction, setPanelAction] = useState<{
    kind: "description" | "delete";
    seq: number;
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const moving = useRef(false);
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
    refetchInterval: (query) =>
      query.state.data?.some(
        (m) => m.status === "recording" || m.status === "transcribing",
      )
        ? 2000
        : false,
  });
  const meetings = useMemo(() => listData ?? [], [listData]);
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
  const folderGroup = groups.get(selectedFolderId);

  const openFolderId = openMeeting?.folder_id;
  useEffect(() => {
    if (!activeId || openFolderId === undefined) return;
    setExpanded((old) =>
      old[openFolderId ?? "none"]
        ? old
        : { ...old, [openFolderId ?? "none"]: true },
    );
  }, [activeId, openFolderId]);

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
    setSelectedFolderId(null);
    setSelectedId(id);
    setPanelAction(null);
    setRenamingId(null);
  }, []);
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
  const explicitSelection = Boolean(selectedId || selectedFolderId);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <DragSpacer />
      {showEnhancePrompt && <EnhancePromptDialog />}
      <div
        className="responsive-page-scroll flex-1 overflow-auto pt-5"
        style={{ scrollbarWidth: "none" }}
      >
        {showAudioHint && <SystemAudioHint />}
        {actionError && (
          <p className="text-destructive mb-3 text-xs" role="alert">
            {actionError}
          </p>
        )}
        <div className="grid min-h-full grid-cols-1 gap-6 min-[900px]:grid-cols-[262px_minmax(0,1fr)]">
          <aside
            aria-label={t("meetings.folders.railLabel")}
            className={cn(
              "min-w-0 min-[900px]:border-border min-[900px]:border-r min-[900px]:pr-6",
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
            <MeetingImportRail
              onFile={meetingImport.handleFile}
              onPick={() => void meetingImport.handlePick()}
              importing={meetingImport.importing}
              error={importError}
            >
              <RecordingCard
                recorder={recorder}
                compact
                targetName={targetName}
                targetReady={targetReady}
              />
            </MeetingImportRail>
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
            className={cn(
              "min-w-0",
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
                      variant="ink"
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
            {activeFolder ? (
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
              />
            ) : activeId ? (
              <MeetingDetailView
                key={activeId}
                id={activeId}
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
