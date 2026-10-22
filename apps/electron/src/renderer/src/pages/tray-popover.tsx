import { useElapsedClock } from "@renderer/hooks/use-elapsed-clock";
import {
  acceleratorToCombo,
  keyDisplayLabel,
} from "@renderer/hooks/use-hotkey-recorder";
import { getClient, initApiBase } from "@renderer/lib/api";
import { IS_MAC } from "@renderer/lib/platform";
import { cn } from "@renderer/lib/utils";
import { formatClock } from "@renderer/pages/history/helpers";
import type { TrayPopoverState } from "@shared/tray-popover";
import {
  AppWindow,
  AudioLines,
  Check,
  Copy,
  Power,
  Settings,
  Square,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

// The tray popover (issue #317, design Option B). Sections, top to bottom:
// header, meeting control, next event (step 3), recent dictations, jobs
// (step 2), footer. The window never takes focus (see
// main/windows/tray-popover-window.ts), so keyboard input comes only from the
// global Escape shortcut in main.

const RECENT_COUNT = 3;
const COPIED_MS = 1500;

type MeetingStatus = "idle" | "recording" | "finalizing";

interface MeetingInfo {
  status: MeetingStatus;
  meetingId: string | null;
  startedAt: number | null;
}

interface RecentDictation {
  id: number;
  raw_text: string;
  cleaned_text: string | null;
  created_at: string;
}

/** A short hotkey label for a sentence: "Fn", "⌥Space" or "Ctrl+Alt+Space". */
function hotkeyLabel(accel: string): string {
  const combo = acceleratorToCombo(accel);
  const keys = [...combo.modifiers, ...(combo.key ? [combo.key] : [])];
  // The Fn key reads better as text than as the globe symbol.
  const labels = keys.map((k) => (k === "Fn" ? "Fn" : keyDisplayLabel(k)));
  return labels.join(IS_MAC ? "" : "+");
}

export default function TrayPopoverPage(): React.JSX.Element {
  const { t } = useTranslation();
  const [info, setInfo] = useState<TrayPopoverState | null>(null);
  const [meeting, setMeeting] = useState<MeetingInfo>({
    status: "idle",
    meetingId: null,
    startedAt: null,
  });
  const [recent, setRecent] = useState<RecentDictation[] | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const loadRecent = useCallback(async () => {
    try {
      await initApiBase();
      const query: Record<string, string> = {
        limit: String(RECENT_COUNT),
        orderBy: "-created_at",
      };
      const res = await getClient().api.history.$get({ query });
      if (res.ok) setRecent((await res.json()).items);
    } catch {
      // The server is not up yet. The next show reads again.
    }
  }, []);

  const loadAll = useCallback(async () => {
    const [state, status] = await Promise.all([
      window.api.getTrayPopoverState(),
      window.api.getMeetingStatus(),
    ]);
    setInfo(state);
    setMeeting(status);
    await loadRecent();
  }, [loadRecent]);

  useEffect(() => {
    void loadAll();
    const offShown = window.api.onTrayPopoverShown(() => void loadAll());
    const offDone = window.api.onTranscriptionDone(() => void loadRecent());
    const offMeeting = window.api.onMeetingStatusChanged(() => {
      // The event has no meeting id, so read the full status.
      void window.api.getMeetingStatus().then(setMeeting);
    });
    return () => {
      offShown();
      offDone();
      offMeeting();
    };
  }, [loadAll, loadRecent]);

  // Escape when the page has the keyboard (an E2E key press, or a platform
  // where the window can take focus). On macOS the global shortcut in main
  // does this.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") window.api.hideTrayPopover();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Main sizes the window to the content.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const report = (): void =>
      window.api.setTrayPopoverHeight(root.getBoundingClientRect().height);
    const observer = new ResizeObserver(report);
    observer.observe(root);
    report();
    return () => observer.disconnect();
  }, []);

  const recording = meeting.status === "recording";
  const hotkey = info?.hotkey ?? window.api.defaultHotkey;

  return (
    <main
      ref={rootRef}
      aria-label={t("trayPopover.label")}
      data-testid="tray-popover"
      className="flex flex-col gap-3 overflow-hidden rounded-[14px] border border-border bg-card p-3 text-card-foreground select-none"
    >
      <header className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-[9px] bg-foreground text-background"
        >
          <AudioLines className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="display text-[16px] leading-tight">Openstyle</div>
          <div
            className="truncate text-[12px] text-muted-foreground"
            data-testid="tray-popover-hotkey"
          >
            {t(
              info?.hotkeyMode === "toggle"
                ? "trayPopover.hint.press"
                : "trayPopover.hint.hold",
              { key: hotkeyLabel(hotkey) },
            )}
          </div>
        </div>
        <StatusChip
          status={
            recording ? "recording" : info?.dictating ? "dictating" : "ready"
          }
        />
      </header>

      {info?.meetingsAvailable && (
        <MeetingControl meeting={meeting} recording={recording} />
      )}

      {/* Step 3 (issue #317): the "Next event" section goes here. */}

      <RecentDictations items={recent} />

      {/* Step 2 (issue #317): the "Jobs" section goes here. */}

      <Footer info={info} />
    </main>
  );
}

function StatusChip({
  status,
}: {
  status: "ready" | "recording" | "dictating";
}): React.JSX.Element {
  const { t } = useTranslation();
  const live = status !== "ready";
  return (
    <span
      data-testid="tray-popover-status"
      data-status={status}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-[5px] px-2 py-1 text-[11px] font-medium",
        live
          ? "bg-(--live-tint) text-(--live)"
          : "bg-muted text-muted-foreground",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full",
          live ? "bg-(--live)" : "bg-muted-foreground",
        )}
      />
      {t(`trayPopover.status.${status}`)}
    </span>
  );
}

function MeetingControl({
  meeting,
  recording,
}: {
  meeting: MeetingInfo;
  recording: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  // One message per state change, never one per second.
  const [announcement, setAnnouncement] = useState("");
  const elapsed = useElapsedClock(recording ? meeting.startedAt : null);
  const wasRecording = useRef(recording);

  useEffect(() => {
    if (wasRecording.current === recording) return;
    wasRecording.current = recording;
    setAnnouncement(
      t(
        recording
          ? "trayPopover.meeting.started"
          : "trayPopover.meeting.stopped",
      ),
    );
  }, [recording, t]);

  // The meeting title, when the meeting row has one (a calendar link).
  useEffect(() => {
    setTitle(null);
    const id = meeting.meetingId;
    if (!recording || !id) return;
    let live = true;
    void (async () => {
      try {
        await initApiBase();
        const res = await getClient().api.meetings[":id"].$get({
          param: { id },
        });
        if (!res.ok) return;
        const row = (await res.json()) as { title?: string | null };
        if (live) setTitle(row.title?.trim() || null);
      } catch {
        // No title. The card shows the time only.
      }
    })();
    return () => {
      live = false;
    };
  }, [recording, meeting.meetingId]);

  const start = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // The same path as the Meetings page and the tray menu. When the
      // devices changed, the Meetings page asks the user to confirm them.
      const res = await window.api.startMeetingRecording();
      if (res.devices) {
        window.api.openFromTrayPopover("confirmMeeting");
      } else if (!res.ok) {
        setError(res.error ?? t("trayPopover.meeting.startFailed"));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const stop = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await window.api.stopMeetingRecording();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label={t("trayPopover.meeting.section")}>
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
      {recording ? (
        <div
          data-testid="tray-popover-recording"
          className="flex items-center gap-3 rounded-[10px] border border-(--live)/30 bg-(--live-tint) py-2.5 pr-2.5 pl-3"
        >
          <span
            aria-hidden="true"
            className="size-2.5 shrink-0 rounded-full bg-(--live) motion-safe:animate-pulse"
          />
          <div className="min-w-0 flex-1">
            <div
              role="timer"
              aria-label={t("trayPopover.meeting.elapsed")}
              data-testid="tray-popover-elapsed"
              className="display text-[26px] tabular-nums"
            >
              {elapsed}
            </div>
            {title && (
              <div
                className="mt-1 truncate text-[12px] text-muted-foreground"
                data-testid="tray-popover-meeting-title"
              >
                {title}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => void stop()}
            disabled={busy}
            aria-label={t("trayPopover.meeting.stopLabel")}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-foreground px-3.5 text-[13px] font-medium text-background hover:bg-foreground/90 disabled:opacity-50"
          >
            <Square aria-hidden="true" className="size-3 fill-current" />
            {t("trayPopover.meeting.stop")}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => void start()}
          disabled={busy || meeting.status === "finalizing"}
          className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-foreground text-[14px] font-medium text-background hover:bg-foreground/90 disabled:opacity-50"
        >
          <span
            aria-hidden="true"
            className="size-2 rounded-full bg-(--live)"
          />
          {t("trayPopover.meeting.start")}
        </button>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[12px] text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

function SectionTitle({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="mb-1.5 flex items-center justify-between px-0.5">
      <h2 className="text-[11px] font-bold tracking-[0.08em] text-(--muted-soft) uppercase">
        {children}
      </h2>
      {action}
    </div>
  );
}

function RecentDictations({
  items,
}: {
  items: RecentDictation[] | null;
}): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async (item: RecentDictation): Promise<void> => {
    // The main process writes the clipboard. The page has no focus, so the
    // web clipboard API is not used.
    await window.api.copyText(item.cleaned_text ?? item.raw_text);
    setCopiedId(item.id);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopiedId(null), COPIED_MS);
  };

  return (
    <section aria-labelledby="tray-popover-recent">
      <SectionTitle
        action={
          <button
            type="button"
            onClick={() => window.api.openFromTrayPopover("history")}
            className="text-[12px] text-muted-foreground hover:text-foreground"
          >
            {t("trayPopover.recent.history")}
          </button>
        }
      >
        <span id="tray-popover-recent">{t("trayPopover.recent.title")}</span>
      </SectionTitle>
      <span className="sr-only" role="status" aria-live="polite">
        {copiedId !== null ? t("trayPopover.recent.copied") : ""}
      </span>
      <div className="overflow-hidden rounded-[10px] border border-border">
        {items && items.length === 0 && (
          <p className="px-3 py-3 text-[13px] text-muted-foreground">
            {t("trayPopover.recent.empty")}
          </p>
        )}
        {items?.map((item) => {
          const text = item.cleaned_text ?? item.raw_text;
          const copied = copiedId === item.id;
          return (
            <div
              key={item.id}
              data-testid="tray-popover-dictation"
              className="flex items-start gap-2 border-border border-b px-3 py-2.5 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-[13px] leading-snug">{text}</p>
                <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">
                  {formatClock(item.created_at, i18n.language)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void copy(item)}
                aria-label={t("trayPopover.recent.copy")}
                title={t("trayPopover.recent.copy")}
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {copied ? (
                  <Check aria-hidden="true" className="size-3.5" />
                ) : (
                  <Copy aria-hidden="true" className="size-3.5" />
                )}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Footer({
  info,
}: {
  info: TrayPopoverState | null;
}): React.JSX.Element {
  const { t } = useTranslation();
  const iconButton =
    "inline-flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground";
  return (
    <footer className="flex items-center gap-1 border-border border-t pt-2.5 pl-0.5">
      <div
        className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground"
        data-testid="tray-popover-version"
      >
        {info && t("trayPopover.footer.version", { version: info.version })}
        {info && " · "}
        {info?.update === "downloaded" ? (
          // The same main-process path as "Restart & Update" in the tray
          // menu (updater:install calls restartAndUpdate in menus.ts).
          <button
            type="button"
            onClick={() => window.api.installUpdate()}
            title={t("trayPopover.footer.updateReady")}
            aria-label={`${t("trayPopover.footer.updateReady")}, ${t("trayPopover.footer.restartToUpdate")}`}
            data-testid="tray-popover-restart"
            className="font-medium text-foreground underline underline-offset-2 hover:no-underline"
          >
            {t("trayPopover.footer.restartToUpdate")}
          </button>
        ) : info?.update === "downloading" ? (
          t("trayPopover.footer.downloading")
        ) : (
          info && t("trayPopover.footer.upToDate")
        )}
      </div>
      <button
        type="button"
        onClick={() => window.api.openFromTrayPopover("app")}
        aria-label={t("trayPopover.footer.openApp")}
        title={t("trayPopover.footer.openApp")}
        className={iconButton}
      >
        <AppWindow aria-hidden="true" className="size-4" />
      </button>
      <button
        type="button"
        onClick={() => window.api.openFromTrayPopover("settings")}
        aria-label={t("trayPopover.footer.settings")}
        title={t("trayPopover.footer.settings")}
        className={iconButton}
      >
        <Settings aria-hidden="true" className="size-4" />
      </button>
      <button
        type="button"
        onClick={() => window.api.quitFromTrayPopover()}
        aria-label={t("trayPopover.footer.quit")}
        title={t("trayPopover.footer.quit")}
        className={iconButton}
      >
        <Power aria-hidden="true" className="size-4" />
      </button>
    </footer>
  );
}
