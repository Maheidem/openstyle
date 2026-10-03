import type { MeetingListItem } from "@openstyle/validations";
import { DragSpacer } from "@renderer/components/drag-spacer";
import { getClient } from "@renderer/lib/api";
import { formatClockDuration, formatTimestamp } from "@renderer/lib/format";
import { configQueryOptions, queryKeys } from "@renderer/lib/query";
import { cn } from "@renderer/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate } from "react-router";
import { MeetingDetailView } from "./detail";
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
import { DiarizationSettingsPopover } from "./settings-popovers";
import { StatusBadge } from "./shared";

export default function MeetingsPage(): React.JSX.Element {
  const { t } = useTranslation();
  const recorder = useRecorder();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Import affordance (specs/meeting-import.md §4.5), shared by both layouts
  // (only one renders at a time). On success the new meeting is selected —
  // explicit selection wins over the default rail selection — and the hook
  // auto-fires the async transcribe job.
  const handleImported = useCallback((id: string) => {
    setSelectedId(id);
  }, []);
  const meetingImport = useMeetingImport(handleImported);
  const importError =
    meetingImport.state.status === "error" ? meetingImport.state : null;

  // Feature-flagged: the nav entry is already gated, but a direct URL must
  // bounce too. Wait for the config load before deciding.
  const { data: config, isLoading: configLoading } = useQuery(
    configQueryOptions(),
  );
  const enabled = config?.flags?.meetings === true;

  const { data: listData } = useQuery({
    queryKey: queryKeys.meetings.list,
    queryFn: async (): Promise<MeetingListItem[]> => {
      const res = await getClient().api.meetings.$get();
      if (!res.ok) return [];
      const body = await res.json();
      return body.items;
    },
    enabled,
    // A recording in progress or a transcription job elsewhere in the list
    // should surface without a manual refresh.
    refetchInterval: (query) =>
      query.state.data?.some(
        (m) => m.status === "recording" || m.status === "transcribing",
      )
        ? 2000
        : false,
  });

  const meetings = useMemo(() => listData ?? [], [listData]);

  // Master-detail (see below) keeps the right-hand pane non-empty by default
  // once meetings exist, so the persistent list rail never sits next to a
  // blank pane. Captured once, from the first non-empty load only — NOT
  // re-derived from `meetings[0]` on every render, because the list query
  // polls every 2s while anything is recording/transcribing and a fresh
  // recording lands at index 0 (server orders by created_at DESC). Re-deriving
  // live would silently swap the detail pane out from under a user who never
  // explicitly picked a meeting. `selectedId` (explicit, user-driven) always
  // wins over this default. The default changes only when its meeting leaves
  // the list, for example after a delete.
  const [defaultId, setDefaultId] = useState<string | null>(null);
  useEffect(() => {
    if (meetings.length > 0 && !meetings.some((m) => m.id === defaultId)) {
      setDefaultId(meetings[0].id);
    }
  }, [meetings, defaultId]);
  const activeId =
    selectedId ?? (meetings.some((m) => m.id === defaultId) ? defaultId : null);

  // Only probe ahead of the FIRST recording: list loaded, empty, recorder
  // supported and idle.
  const showAudioHint = useSystemAudioProbe(
    enabled &&
      recorder.supported &&
      recorder.status === "idle" &&
      listData !== undefined &&
      meetings.length === 0,
  );

  if (!configLoading && !enabled) {
    return <Navigate to="/today" replace />;
  }

  // Nothing to show a detail pane for yet — keep the original single-pane
  // first-run flow (hero title, record card, empty state) rather than
  // rendering a master-detail grid with an empty rail next to a lone empty
  // card. Also covers the pre-load instant, same as before this change.
  if (meetings.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <DragSpacer />
        <div
          className="responsive-page-scroll flex-1 overflow-auto pt-5"
          style={{ scrollbarWidth: "none" } as React.CSSProperties}
        >
          <div className="mx-auto max-w-[760px]">
            <div className="mb-2 flex items-start justify-between gap-3">
              <h1 className="display text-foreground m-0 text-[32px] font-medium leading-tight tracking-[-0.02em]">
                {t("meetings.titleAccent")}
              </h1>
              <div className="pt-2">
                <DiarizationSettingsPopover />
              </div>
            </div>
            <p className="text-muted-foreground mb-6 max-w-[480px] text-[13px] leading-[1.5]">
              {t("meetings.subtitle")}
            </p>

            {showAudioHint && <SystemAudioHint />}

            <RecordingCard recorder={recorder} />

            <MeetingsEmptyState
              onFile={meetingImport.handleFile}
              onPick={() => void meetingImport.handlePick()}
              importing={meetingImport.importing}
              error={importError}
            />
          </div>
        </div>
      </div>
    );
  }

  // Master-detail (mockup artboard 02): persistent list rail + detail pane at
  // >=900px (same collapse breakpoint settings.tsx already uses for its own
  // rail+content split). Below that, CSS-only collapse to the old
  // single-pane flow: `max-[899px]:hidden` on whichever pane isn't the
  // user's current focus, driven purely by `selectedId` so the narrow-width
  // behavior (land on the list, tap a row to drill in, back returns to the
  // list) is byte-for-byte what it was before this change.
  const hideListAtNarrow = Boolean(selectedId);
  const hideDetailAtNarrow = !selectedId;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DragSpacer />
      <div
        className="responsive-page-scroll flex-1 overflow-auto pt-5"
        style={{ scrollbarWidth: "none" } as React.CSSProperties}
      >
        {showAudioHint && <SystemAudioHint />}

        <div className="grid min-h-full grid-cols-1 gap-6 min-[900px]:grid-cols-[262px_minmax(0,1fr)]">
          <aside
            className={cn(
              "min-w-0 min-[900px]:border-border min-[900px]:border-r min-[900px]:pr-6",
              hideListAtNarrow && "max-[899px]:hidden",
            )}
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className="eyebrow">{t("meetings.titleAccent")}</span>
              <DiarizationSettingsPopover />
            </div>

            <MeetingImportRail
              onFile={meetingImport.handleFile}
              onPick={() => void meetingImport.handlePick()}
              importing={meetingImport.importing}
              error={importError}
            >
              <RecordingCard recorder={recorder} compact />
            </MeetingImportRail>

            <div className="flex flex-col gap-0.5">
              {meetings.map((m) => {
                const selected = selectedId === m.id;
                // Visual parity for the implicit default selection — only at
                // >=900px, where the detail pane is actually showing it. At
                // narrow widths this row hasn't really been "opened" (the
                // list is what's visible), so it stays unhighlighted there.
                const implicitlyActive = !selectedId && activeId === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setSelectedId(m.id)}
                    className={cn(
                      "flex min-w-0 flex-col gap-1 rounded-[9px] border border-transparent px-3 py-2.5 text-left transition-colors",
                      "hover:bg-card/60",
                      selected && "bg-card border-border",
                      implicitlyActive &&
                        "min-[900px]:bg-card min-[900px]:border-border",
                    )}
                  >
                    <span className="text-foreground min-w-0 truncate text-[12.5px] font-medium">
                      {m.title || t("meetings.untitled")}
                    </span>
                    <span className="flex min-w-0 items-center justify-between gap-2">
                      <span className="mono text-muted-foreground/70 min-w-0 truncate text-[10px]">
                        {formatTimestamp(m.started_at)} ·{" "}
                        {formatClockDuration(m.duration_ms)}
                      </span>
                      <StatusBadge status={m.status} />
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>

          <div
            className={cn(
              "min-w-0",
              hideDetailAtNarrow && "max-[899px]:hidden",
            )}
          >
            {activeId && (
              <MeetingDetailView
                key={activeId}
                id={activeId}
                onBack={() => setSelectedId(null)}
                onDeleted={() => setSelectedId(null)}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
