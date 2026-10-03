import { Button } from "@renderer/components/ui/button";
import { Card } from "@renderer/components/ui/card";
import { Progress } from "@renderer/components/ui/progress";
import { formatClockMs } from "@renderer/lib/format";
import { queryKeys } from "@renderer/lib/query";
import { cn } from "@renderer/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Mic,
  MonitorSpeaker,
  RefreshCw,
  Square,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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

export function useRecorder(): {
  status: RecorderStatus;
  supported: boolean;
  meetingId: string | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  error: string | null;
} {
  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [supported, setSupported] = useState(false);
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    void window.api?.getMeetingStatus?.().then((s) => {
      if (cancelled) return;
      setStatus(s.status);
      setSupported(s.supported);
      setMeetingId(s.meetingId);
    });
    const remove = window.api?.onMeetingStatusChanged?.((next) => {
      setStatus(next);
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

  const start = useCallback(async () => {
    setError(null);
    const result = await window.api?.startMeetingRecording?.();
    if (result?.ok) {
      setMeetingId(result.id ?? null);
      setStatus("recording");
      void queryClient.invalidateQueries({ queryKey: queryKeys.meetings.all });
    } else if (result?.error) {
      setError(result.error);
    }
  }, [queryClient]);

  const stop = useCallback(async () => {
    await window.api?.stopMeetingRecording?.();
    void queryClient.invalidateQueries({ queryKey: queryKeys.meetings.all });
  }, [queryClient]);

  return { status, supported, meetingId, start, stop, error };
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
}: {
  recorder: ReturnType<typeof useRecorder>;
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
  const [elapsedMs, setElapsedMs] = useState(0);
  const startedAtRef = useRef<number | null>(null);
  const recording = recorder.status === "recording";
  const finalizing = recorder.status === "finalizing";

  useEffect(() => {
    if (!recording) {
      startedAtRef.current = null;
      setElapsedMs(0);
      setMicLevel(0);
      setSystemLevel(0);
      return;
    }
    startedAtRef.current = Date.now();
    const timer = setInterval(() => {
      if (startedAtRef.current) {
        setElapsedMs(Date.now() - startedAtRef.current);
      }
    }, 1000);
    const remove = window.api?.onMeetingLevel?.((event) => {
      if (event.source === "mic") setMicLevel(event.rms);
      else setSystemLevel(event.rms);
    });
    return () => {
      clearInterval(timer);
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
              variant="ink"
              size="xs"
              onClick={() => void recorder.start()}
              disabled={!recorder.supported}
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
        {!finalizing && !recorder.supported && (
          <p className="text-muted-foreground mt-1.5 text-[10.5px] leading-[1.4]">
            {t("meetings.notSupported")}
          </p>
        )}
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
                <span className="mono text-muted-foreground text-[12px] tabular-nums">
                  {formatClockMs(elapsedMs)}
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
            variant="ink"
            size="sm"
            onClick={() => void recorder.start()}
            disabled={!recorder.supported}
          >
            <Mic data-icon="inline-start" />
            {t("meetings.start")}
          </Button>
        )}
      </div>
    </Card>
  );
}
