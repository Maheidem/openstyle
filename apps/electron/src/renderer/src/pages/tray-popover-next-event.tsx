import { Switch } from "@renderer/components/ui/switch";
import { formatTimeOfDay } from "@renderer/pages/history/helpers";
import type { TrayScheduleState } from "@shared/tray-popover";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

// The "Next event" card of the tray popover (issue #317, step 3). Main reads
// the calendar when the popover shows, and owns the "Record when it starts"
// arm and its timer (main/meeting-schedule.ts). This card reads no calendar
// on a timer: only the "in 3 h 49 min" text moves, from the clock.

const CLOCK_TICK_MS = 30_000;

export function NextEventSection({
  visible,
  canRecord,
  onRecord,
  title,
}: {
  /** True while the popover shows. The card reads again on each show. */
  visible: boolean;
  /** False while a meeting records or ends. */
  canRecord: boolean;
  /** Start a meeting now with this event linked. */
  onRecord: (eventId: string) => Promise<void>;
  title: React.ReactNode;
}): React.JSX.Element | null {
  const { t, i18n } = useTranslation();
  const [schedule, setSchedule] = useState<TrayScheduleState | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setSchedule(await window.api.getTraySchedule());
    setNow(Date.now());
  }, []);

  useEffect(() => {
    if (!visible) return;
    void load();
    const offChanged = window.api.onTrayScheduleChanged(() => void load());
    const tick = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => {
      offChanged();
      clearInterval(tick);
    };
  }, [visible, load]);

  const event = schedule?.event ?? null;
  if (!event) return null;
  const armed = schedule?.armed?.eventId === event.id;
  const lang = i18n.language;
  const minutes = Math.max(1, Math.ceil((event.start - now) / 60_000));
  const until =
    minutes >= 60
      ? t("trayPopover.nextEvent.inHours", {
          hours: Math.floor(minutes / 60),
          minutes: minutes % 60,
        })
      : t("trayPopover.nextEvent.inMinutes", { minutes });
  const startClock = formatTimeOfDay(event.start, lang);

  const toggle = async (on: boolean): Promise<void> => {
    setSchedule(
      on
        ? await window.api.armRecordWhenItStarts(event.id)
        : await window.api.disarmRecordWhenItStarts(),
    );
  };

  const record = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await onRecord(event.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-labelledby="tray-popover-next-event"
      data-testid="tray-popover-next-event"
    >
      {title}
      <span className="sr-only" role="status" aria-live="polite">
        {armed
          ? t("trayPopover.nextEvent.willStart", { time: startClock })
          : ""}
      </span>
      <div className="overflow-hidden rounded-[10px] border border-border">
        <div className="flex items-center gap-2 px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div
              className="truncate text-[14px] font-semibold"
              data-testid="tray-popover-event-title"
            >
              {event.title}
            </div>
            <div
              className="mt-0.5 text-[12px] text-muted-foreground tabular-nums"
              data-testid="tray-popover-event-time"
            >
              {`${startClock} – ${formatTimeOfDay(event.end, lang)} · ${until}`}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void record()}
            disabled={busy || !canRecord}
            aria-label={t("trayPopover.nextEvent.recordLabel", {
              title: event.title,
            })}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-muted px-3 text-[13px] font-medium hover:bg-accent disabled:opacity-50"
          >
            <span
              aria-hidden="true"
              className="size-2 rounded-full bg-(--live)"
            />
            {t("trayPopover.nextEvent.record")}
          </button>
        </div>
        <div className="flex items-center justify-between gap-2 border-border border-t px-3 py-2.5 text-[13px]">
          <label htmlFor="tray-popover-arm">
            {t("trayPopover.nextEvent.recordWhenItStarts")}
          </label>
          <Switch
            id="tray-popover-arm"
            checked={armed}
            onCheckedChange={(on) => void toggle(on)}
            aria-label={t("trayPopover.nextEvent.recordWhenItStartsLabel", {
              title: event.title,
            })}
            data-testid="tray-popover-record-when-it-starts"
          />
        </div>
        {armed && (
          <p
            className="border-border border-t px-3 py-2 text-[12px] text-muted-foreground"
            data-testid="tray-popover-armed"
          >
            {t("trayPopover.nextEvent.willStart", { time: startClock })}
          </p>
        )}
      </div>
    </section>
  );
}
