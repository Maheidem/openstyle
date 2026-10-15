import type { CalendarEvent } from "@openstyle/validations";
import { Button } from "@renderer/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@renderer/components/ui/popover";
import { getClient } from "@renderer/lib/api";
import { CalendarDays, CalendarPlus, Link2, Users } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

function formatRange(start: number, end: number, lang: string): string {
  const fmt = new Intl.DateTimeFormat(lang, {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${fmt.format(start)} - ${fmt.format(end)}`;
}

/**
 * Picker for today's events (specs/calendar-eventkit.md). The list comes from
 * the main process. It is empty while the calendar toggle is off.
 */
function EventPicker({
  id,
  onChanged,
  children,
}: {
  id: string;
  onChanged: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [failed, setFailed] = useState(false);

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (next) {
      setEvents(null);
      setFailed(false);
      void (window.api?.calendarListToday?.() ?? Promise.resolve([]))
        .then(setEvents)
        .catch(() => setEvents([]));
    }
  }, []);

  const pick = useCallback(
    async (event: CalendarEvent) => {
      const res = await getClient()
        .api.meetings[":id"].calendar.$put({ param: { id }, json: event })
        .catch(() => null);
      if (res?.ok) {
        setOpen(false);
        onChanged();
      } else {
        setFailed(true);
      }
    },
    [id, onChanged],
  );

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <div className="text-muted-foreground text-[11px] font-medium">
          {t("meetings.calendar.pickTitle")}
        </div>
        {failed && (
          <div className="text-destructive py-1 text-[12px]" role="alert">
            {t("meetings.calendar.actionFailed")}
          </div>
        )}
        {events === null ? null : events.length === 0 ? (
          <div className="text-muted-foreground py-2 text-[12.5px]">
            {t("meetings.calendar.noEventsToday")}
          </div>
        ) : (
          <ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
            {events.map((e) => (
              <li key={`${e.id}@${e.start}`}>
                <button
                  type="button"
                  onClick={() => void pick(e)}
                  className="hover:bg-card w-full rounded-md px-2 py-1.5 text-left"
                >
                  <div className="text-foreground truncate text-[13px] font-medium">
                    {e.title || t("meetings.untitled")}
                  </div>
                  <div className="text-muted-foreground text-[11.5px]">
                    {formatRange(e.start, e.end, i18n.language)}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * The linked calendar event of a meeting, with Change and Unlink. Without a
 * link it shows a "Link event" button, but only while the calendar toggle is
 * on. It shows no email addresses.
 */
export function CalendarCard({
  id,
  calendar,
  enabled,
  onChanged,
}: {
  id: string;
  calendar: CalendarEvent | null;
  /** The "Use my calendar" setting. */
  enabled: boolean;
  onChanged: () => void;
}): React.JSX.Element | null {
  const { t, i18n } = useTranslation();

  const [unlinkFailed, setUnlinkFailed] = useState(false);

  const unlink = useCallback(async () => {
    const res = await getClient()
      .api.meetings[":id"].calendar.$delete({ param: { id } })
      .catch(() => null);
    if (res?.ok) {
      setUnlinkFailed(false);
      onChanged();
    } else {
      setUnlinkFailed(true);
    }
  }, [id, onChanged]);

  if (!calendar) {
    if (!enabled) return null;
    return (
      <div className="mt-1.5">
        <EventPicker id={id} onChanged={onChanged}>
          <Button variant="ghost" size="xs" className="text-muted-foreground">
            <CalendarPlus data-icon="inline-start" />
            {t("meetings.calendar.link")}
          </Button>
        </EventPicker>
      </div>
    );
  }

  return (
    <div
      className="border-border bg-card/50 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-2.5 py-1.5"
      data-testid="calendar-card"
    >
      <CalendarDays className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-foreground truncate text-[12.5px] font-medium">
          <span className="text-muted-foreground font-normal">
            {t("meetings.calendar.linked")}:{" "}
          </span>
          {calendar.title || t("meetings.untitled")}
        </div>
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-2.5 text-[11.5px]">
          <span>
            {formatRange(calendar.start, calendar.end, i18n.language)}
          </span>
          {calendar.attendees.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <Users className="h-3 w-3" />
              {t("meetings.calendar.attendees", {
                count: calendar.attendees.length,
              })}
            </span>
          )}
          {calendar.url && (
            <button
              type="button"
              onClick={() => void window.api?.openExternal?.(calendar.url!)}
              className="hover:text-foreground inline-flex items-center gap-1"
            >
              <Link2 className="h-3 w-3" />
              {t("meetings.calendar.joinLink")}
            </button>
          )}
          {unlinkFailed && (
            <span className="text-destructive" role="alert">
              {t("meetings.calendar.actionFailed")}
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1">
        <EventPicker id={id} onChanged={onChanged}>
          <Button variant="ghost" size="xs">
            {t("meetings.calendar.change")}
          </Button>
        </EventPicker>
        <Button variant="ghost" size="xs" onClick={() => void unlink()}>
          {t("meetings.calendar.unlink")}
        </Button>
      </div>
    </div>
  );
}
