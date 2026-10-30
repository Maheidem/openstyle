import { Button } from "@renderer/components/ui/button";
import { Card } from "@renderer/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Progress } from "@renderer/components/ui/progress";
import { useElapsedClock } from "@renderer/hooks/use-elapsed-clock";
import { queryKeys, settingsQueryOptions } from "@renderer/lib/query";
import { cn } from "@renderer/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Folder,
  Mic,
  MonitorSpeaker,
  RefreshCw,
  Square,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type MeetingDevicePlan,
  planKeys,
} from "../../../../shared/meeting-devices";
import { SETTINGS_KEYS } from "../../../../shared/settings-keys";
import { LiveChatPanel } from "./live-chat-panel";
import { LiveTranscriptPanel } from "./live-transcript-panel";
import type { RecorderStatus } from "./types";

// ---------------------------------------------------------------------------
// First-run system-audio probe: macOS silently denies the Core Audio tap
// (zero-filled buffers, success codes), so before the first recording we run
// the real pipeline briefly via IPC. 'silent' is indeterminate (denied OR
// nothing playing) — surface a non-blocking hint, never a blocker.
// ---------------------------------------------------------------------------

export const PROBE_DONE_KEY = "meetings_system_audio_probe_done";

export function useSystemAudioProbe(shouldProbe: boolean): boolean {
  const [showHint, setShowHint] = useState(false);
  const startedRef = useRef(false);

  useEffect(() => {
    if (!shouldProbe || startedRef.current) return;
    let done = false;
    try {
      done = localStorage.getItem(PROBE_DONE_KEY) === "1";
    } catch {
      // storage unavailable — probe at most once per session via startedRef
    }
    if (done) return;
    startedRef.current = true;
    void window.api?.probeMeetingSystemAudio?.().then((result) => {
      try {
        localStorage.setItem(PROBE_DONE_KEY, "1");
      } catch {
        // best-effort
      }
      if (result === "silent") setShowHint(true);
    });
  }, [shouldProbe]);

  return showHint;
}

export function SystemAudioHint(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="border-border bg-card/60 mb-6 flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-[12px]">
      <AlertTriangle className="text-muted-foreground mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-foreground m-0 leading-[1.5]">
          {t("meetings.audioProbeHintBody")}
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="shrink-0"
        onClick={() => window.api?.openAudioCaptureSettings?.()}
      >
        {t("meetings.audioProbeHintOpenSettings")}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recording card: timer + per-channel level meters, driven by the preload
// meeting API (meeting:level IPC events).
// ---------------------------------------------------------------------------

export function useRecorder(folderId: string | null = null): {
  status: RecorderStatus;
  starting: boolean;
  supported: boolean;
  meetingId: string | null;
  /** Recording start time (epoch ms) from the main process, or null. */
  startedAt: number | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  error: string | null;
  /** The devices that the next recording uses (#169), or null. */
  devices: MeetingDevicePlan | null;
  /** Changed devices that wait for the user to confirm them. */
  pendingDevices: MeetingDevicePlan | null;
  confirmDevices: () => Promise<void>;
  dismissDevices: () => void;
} {
  const { t } = useTranslation();
  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const pendingFolderId = useRef<string | null>(null);
  const [supported, setSupported] = useState(false);
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MeetingDevicePlan | null>(null);
  const [pendingDevices, setPendingDevices] =
    useState<MeetingDevicePlan | null>(null);
  const queryClient = useQueryClient();

  // Show the devices before a recording starts. Read them again when the
  // window gets focus, because the user can change them in macOS.
  useEffect(() => {
    if (!supported || status !== "idle") return;
    let cancelled = false;
    const load = (): void => {
      void window.api?.getMeetingDevices?.().then((plan) => {
        if (!cancelled) setDevices(plan ?? null);
      });
    };
    load();
    window.addEventListener("focus", load);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", load);
    };
  }, [supported, status]);

  useEffect(() => {
    let cancelled = false;
    void window.api?.getMeetingStatus?.().then((s) => {
      if (cancelled) return;
      setStatus(s.status);
      setSupported(s.supported);
      setMeetingId(s.meetingId);
      setStartedAt(s.startedAt);
    });
    const remove = window.api?.onMeetingStatusChanged?.((next, start) => {
      setStatus(next);
      setStartedAt(start);
      if (next === "idle") {
        setMeetingId(null);
        void queryClient.invalidateQueries({
          queryKey: queryKeys.meetings.all,
        });
      }
    });
    return () => {
      cancelled = true;
      remove?.();
    };
  }, [queryClient]);

  const startWith = useCallback(
    async (plan?: MeetingDevicePlan, targetFolderId = folderId) => {
      if (startingRef.current) return;
      startingRef.current = true;
      setStarting(true);
      setError(null);
      // Keep the click target while the device dialog is open.
      pendingFolderId.current = targetFolderId;
      try {
        const result = await window.api?.startMeetingRecording?.(
          plan ? planKeys(plan) : undefined,
          targetFolderId,
        );
        if (result?.devices) {
          setDevices(result.devices);
          setPendingDevices(result.devices);
          return;
        }
        setPendingDevices(null);
        if (result?.ok) {
          setMeetingId(result.id ?? null);
          setStatus("recording");
          void queryClient.invalidateQueries({
            queryKey: queryKeys.meetings.all,
          });
        } else if (result?.code === "invalid_folder") {
          setError(t("meetings.folders.invalidTarget"));
        } else if (result?.error) {
          setError(result.error);
        }
      } catch {
        setError(t("meetings.folders.requestFailed"));
      } finally {
        startingRef.current = false;
        setStarting(false);
      }
    },
    [queryClient, folderId, t],
  );

  const start = useCallback(() => startWith(), [startWith]);
  const confirmDevices = useCallback(
    () =>
      pendingDevices
        ? startWith(pendingDevices, pendingFolderId.current)
        : Promise.resolve(),
    [pendingDevices, startWith],
  );
  const dismissDevices = useCallback(() => setPendingDevices(null), []);

  const stop = useCallback(async () => {
    await window.api?.stopMeetingRecording?.();
    void queryClient.invalidateQueries({ queryKey: queryKeys.meetings.all });
  }, [queryClient]);

  return {
    status,
    starting,
    supported,
    meetingId,
    startedAt,
    start,
    stop,
    error,
    devices,
    pendingDevices,
    confirmDevices,
    dismissDevices,
  };
}

/** The mic and output names of a plan, for the record card. */
function DeviceSummary({
  plan,
  className,
}: {
  plan: MeetingDevicePlan;
  className?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const unknown = t("meetings.devicesUnknown");
  return (
    <div
      className={cn(
        "text-muted-foreground flex min-w-0 flex-col gap-0.5 text-[10.5px] leading-[1.4]",
        className,
      )}
      data-testid="meeting-devices"
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <Mic className="h-3 w-3 shrink-0" />
        <span className="truncate">
          {t("meetings.devicesMic", { name: plan.inputName ?? unknown })}
        </span>
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        <MonitorSpeaker className="h-3 w-3 shrink-0" />
        <span className="truncate">
          {t("meetings.devicesOutput", {
            name: plan.output?.name ?? unknown,
          })}
        </span>
      </span>
    </div>
  );
}

/**
 * Ask the user to confirm the devices when they differ from the previous
 * meeting (#169). Cancel starts nothing.
 */
function DeviceConfirmDialog({
  recorder,
}: {
  recorder: ReturnType<typeof useRecorder>;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const plan = recorder.pendingDevices;
  if (!plan) return null;
  const unknown = t("meetings.devicesUnknown");
  const rows: {
    icon: React.ReactNode;
    label: string;
    now: string;
    before: string;
  }[] = [
    {
      icon: <Mic className="text-muted-foreground h-3.5 w-3.5 shrink-0" />,
      label: t("meetings.micLevel"),
      now: plan.inputName ?? unknown,
      before: plan.previous?.input?.name ?? unknown,
    },
    {
      icon: (
        <MonitorSpeaker className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
      ),
      label: t("meetings.devicesOutputLabel"),
      now: plan.output?.name ?? unknown,
      before: plan.previous?.output?.name ?? unknown,
    },
  ];
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) recorder.dismissDevices();
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("meetings.devicesChangedTitle")}</DialogTitle>
          <DialogDescription>
            {t("meetings.devicesChangedDesc")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2.5 text-[12.5px]">
          {rows.map((row) => (
            <div key={row.label} className="flex items-start gap-2.5">
              <span className="mt-0.5">{row.icon}</span>
              <div className="min-w-0 flex-1">
                <div className="text-foreground font-medium">
                  {row.label}: {row.now}
                </div>
                {row.before !== row.now && (
                  <div className="text-muted-foreground text-[11.5px]">
                    {t("meetings.devicesPrevious", { name: row.before })}
                  </div>
                )}
              </div>
            </div>
          ))}
          {plan.skippedInput && (
            <p className="text-muted-foreground m-0 text-[11.5px] leading-[1.5]">
              {t("meetings.devicesSkipped", { name: plan.skippedInput.name })}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => recorder.dismissDevices()}
          >
            {t("meetings.cancel")}
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void recorder.confirmDevices().finally(() => setBusy(false));
            }}
          >
            <Mic data-icon="inline-start" />
            {t("meetings.devicesConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function LevelMeter({
  icon,
  label,
  level,
}: {
  icon: React.ReactNode;
  label: string;
  level: number;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2.5">
      {icon}
      <span className="mono text-muted-foreground w-14 shrink-0 text-[9px] uppercase tracking-[0.14em]">
        {label}
      </span>
      <Progress
        value={Math.min(100, Math.round(level * 300))}
        className="h-1 flex-1"
      />
    </div>
  );
}

export function RecordingCard({
  recorder,
  compact = false,
  targetName,
  targetReady = true,
}: {
  recorder: ReturnType<typeof useRecorder>;
  targetName?: string;
  targetReady?: boolean;
  /** Rail context (mockup artboard 02): swap the idle/finalizing "Record a
   * meeting" card — whose title+description text wraps and collides with
   * the button at ~262px — for a slim pill. An in-progress recording still
   * gets the full Card below (timer + level meters + Stop): that layout
   * never had the wrap bug, so it's left untouched. */
  compact?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [micLevel, setMicLevel] = useState(0);
  const [systemLevel, setSystemLevel] = useState(0);
  const recording = recorder.status === "recording";
  const finalizing = recorder.status === "finalizing";
  // Live transcript and chat (issue #375): experimental, off by default.
  const { data: appSettings } = useQuery(settingsQueryOptions());
  const liveChatOn = appSettings?.[SETTINGS_KEYS.liveChatEnabled] === "true";
  // The start time comes from the main process, so this timer and the pill
  // show the same time, also after the page mounts again.
  const elapsed = useElapsedClock(recording ? recorder.startedAt : null);

  useEffect(() => {
    if (!recording) {
      setMicLevel(0);
      setSystemLevel(0);
      return;
    }
    const remove = window.api?.onMeetingLevel?.((event) => {
      if (event.source === "mic") setMicLevel(event.rms);
      else setSystemLevel(event.rms);
    });
    return () => {
      remove?.();
    };
  }, [recording]);

  if (compact && !recording) {
    return (
      <div className="mb-4">
        <div className="flex min-w-0 items-center gap-2">
          {finalizing ? (
            <Button variant="outline" size="xs" disabled>
              <RefreshCw data-icon="inline-start" className="animate-spin" />
              {t("meetings.finalizing")}
            </Button>
          ) : (
            <Button
              size="xs"
              onClick={() => void recorder.start()}
              disabled={
                !recorder.supported || recorder.starting || !targetReady
              }
            >
              <Mic data-icon="inline-start" />
              {t("meetings.start")}
            </Button>
          )}
          {!finalizing && recorder.error && (
            <span className="text-destructive min-w-0 flex-1 truncate text-[10px]">
              {recorder.error}
            </span>
          )}
        </div>
        {!finalizing && targetName && (
          <div className="border-border bg-card text-muted-foreground mt-2 flex min-w-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11.5px]">
            <Folder className="size-3 shrink-0" />
            <span className="shrink-0">
              {t("meetings.folders.recordsInto")}
            </span>
            <strong className="text-foreground min-w-0 truncate font-semibold">
              {targetName}
            </strong>
          </div>
        )}
        {!finalizing && !recorder.supported && (
          <p className="text-muted-foreground mt-1.5 text-[10.5px] leading-[1.4]">
            {t("meetings.notSupported")}
          </p>
        )}
        {!finalizing && recorder.supported && recorder.devices && (
          <DeviceSummary plan={recorder.devices} className="mt-1.5" />
        )}
        <DeviceConfirmDialog recorder={recorder} />
      </div>
    );
  }

  return (
    <Card className={cn("mb-6 p-5", compact && "mb-4 p-3.5")}>
      <div className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          {recording ? (
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center gap-2.5">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--live)]" />
                <span className="text-foreground text-[13px] font-medium">
                  {t("meetings.recording")}
                </span>
                <span
                  className="mono text-muted-foreground text-[12px] tabular-nums"
                  data-testid="meeting-recording-elapsed"
                >
                  {elapsed}
                </span>
              </div>
              <LevelMeter
                icon={<Mic className="text-muted-foreground h-3.5 w-3.5" />}
                label={t("meetings.micLevel")}
                level={micLevel}
              />
              <LevelMeter
                icon={
                  <MonitorSpeaker className="text-muted-foreground h-3.5 w-3.5" />
                }
                label={t("meetings.systemLevel")}
                level={systemLevel}
              />
            </div>
          ) : (
            <div>
              <div className="text-foreground text-[13px] font-medium">
                {t("meetings.recordTitle")}
              </div>
              <p className="text-muted-foreground mt-0.5 text-[12px] leading-snug">
                {recorder.supported
                  ? t("meetings.recordDesc")
                  : t("meetings.notSupported")}
              </p>
              {recorder.error && (
                <p className="text-destructive mt-1 text-[12px]">
                  {recorder.error}
                </p>
              )}
              {recorder.supported && recorder.devices && !finalizing && (
                <DeviceSummary plan={recorder.devices} className="mt-1.5" />
              )}
            </div>
          )}
        </div>
        {recording || recorder.status === "finalizing" ? (
          <Button
            variant="destructive"
            size="sm"
            onClick={() => void recorder.stop()}
            disabled={recorder.status === "finalizing"}
          >
            <Square data-icon="inline-start" />
            {recorder.status === "finalizing"
              ? t("meetings.finalizing")
              : t("meetings.stop")}
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={() => void recorder.start()}
            disabled={!recorder.supported || recorder.starting || !targetReady}
          >
            <Mic data-icon="inline-start" />
            {t("meetings.start")}
          </Button>
        )}
      </div>
      {recording && liveChatOn && (
        <>
          <LiveTranscriptPanel meetingId={recorder.meetingId} />
          <LiveChatPanel meetingId={recorder.meetingId} />
        </>
      )}
      {!recording && !finalizing && targetName && (
        <p className="text-muted-foreground mt-2 text-xs">
          {t("meetings.folders.recordsInto")}{" "}
          <strong className="text-foreground">{targetName}</strong>
        </p>
      )}
      <DeviceConfirmDialog recorder={recorder} />
    </Card>
  );
}
