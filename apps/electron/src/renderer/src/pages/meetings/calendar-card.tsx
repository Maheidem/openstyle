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

/** A short time range for the chip, for example "10:00 – 10:30 AM". */
function formatShortRange(start: number, end: number, lang: string): string {
  const fmt = new Intl.DateTimeFormat(lang, {
    hour: "numeric",
    minute: "2-digit",
  });
  return start < end ? fmt.formatRange(start, end) : fmt.format(start);
}

/**
 * The linked event as one short chip in the meta row (issue #262), for
 * example "ecoATM · 10:00 – 10:30 AM · 2". The title truncates first; the
 * time and the attendee count stay. The tooltip holds the full text. A
 * click opens a popover with the meeting link, Change and Unlink. Without a
 * link the chip is "Link event", but only while the calendar toggle is on.
 * It shows no email addresses.
 */
export function CalendarChip({
  id,
  calendar,
  enabled,
  onChanged,
}: {
  id: string;
  calendar: CalendarEvent | null;
  enabled: boolean;
  onChanged: () => void;
}): React.JSX.Element | null {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [unlinkFailed, setUnlinkFailed] = useState(false);

  const unlink = useCallback(async () => {
    const res = await getClient()
      .api.meetings[":id"].calendar.$delete({ param: { id } })
      .catch(() => null);
    if (res?.ok) {
      setUnlinkFailed(false);
      setOpen(false);
      onChanged();
    } else {
      setUnlinkFailed(true);
    }
  }, [id, onChanged]);

  if (!calendar) {
    if (!enabled) return null;
    return (
      <EventPicker id={id} onChanged={onChanged}>
        <Button
          variant="outline"
          size="xs"
          className="text-muted-foreground border-dashed"
        >
          <CalendarPlus data-icon="inline-start" />
          {t("meetings.calendar.link")}
        </Button>
      </EventPicker>
    );
  }

  const title = calendar.title || t("meetings.untitled");
  const range = formatShortRange(calendar.start, calendar.end, i18n.language);
  const attendees = calendar.attendees.length;
  const fullText = [
    `${t("meetings.calendar.linked")}: ${title}`,
    range,
    attendees > 0
      ? t("meetings.calendar.attendees", { count: attendees })
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="xs"
          className="min-w-0 max-w-fit shrink grow basis-56 overflow-hidden"
          data-testid="calendar-card"
          title={fullText}
          aria-label={fullText}
        >
          <CalendarDays data-icon="inline-start" />
          <span className="min-w-8 truncate">{title}</span>
          <span className="text-muted-foreground shrink-0">· {range}</span>
          {attendees > 0 && (
            <span className="text-muted-foreground inline-flex shrink-0 items-center gap-0.5">
              <Users className="size-3" />
              {attendees}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <div className="text-muted-foreground text-[11px] font-medium">
          {t("meetings.calendar.linked")}
        </div>
        <div className="text-foreground mt-0.5 text-[13px] font-medium">
          {title}
        </div>
        <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2.5 text-[11.5px]">
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
        </div>
        {unlinkFailed && (
          <div className="text-destructive pt-1 text-[12px]" role="alert">
            {t("meetings.calendar.actionFailed")}
          </div>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {calendar.url && (
            <Button
              variant="outline"
              size="xs"
              onClick={() => void window.api?.openExternal?.(calendar.url!)}
            >
              <Link2 data-icon="inline-start" />
              {t("meetings.calendar.joinLink")}
            </Button>
          )}
          <div className="flex-1" />
          <EventPicker id={id} onChanged={onChanged}>
            <Button variant="ghost" size="xs">
              {t("meetings.calendar.change")}
            </Button>
          </EventPicker>
          <Button variant="ghost" size="xs" onClick={() => void unlink()}>
            {t("meetings.calendar.unlink")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
