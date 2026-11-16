import type { CalendarEvent } from "@openstyle/validations";
import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { cn } from "@renderer/lib/utils";
import { ChevronLeft, ChevronRight, Users } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatRange } from "./calendar-card";
import { eventKey, localDayWindow, rankEvents } from "./import-calendar";

/** The file the user picked, and the events of the file's day. */
export interface ImportCalendarRequest {
  path: string;
  fileName: string;
  /** File mtime, epoch ms. The dialog opens on this day. */
  fileDate: number;
  events: CalendarEvent[];
}

/**
 * "Which meeting is this?" (issue #445). Shows before an import starts, while
 * the calendar setting is on and access is fullAccess. One day at a time,
 * with previous and next day arrows. "Import and link" links the selected
 * event, "Skip" imports with no link, X or an outside click cancels.
 */
export function ImportCalendarDialog({
  request,
  onLink,
  onSkip,
  onCancel,
}: {
  request: ImportCalendarRequest;
  onLink: (event: CalendarEvent) => void;
  onSkip: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const [offset, setOffset] = useState(0);
  const [events, setEvents] = useState<CalendarEvent[]>(request.events);
  const [selected, setSelected] = useState<string | null>(null);
  const loadSeq = useRef(0);

  const changeDay = useCallback(
    (next: number) => {
      setOffset(next);
      setSelected(null);
      setEvents([]);
      const seq = ++loadSeq.current;
      const range = localDayWindow(request.fileDate, next);
      void (window.api?.calendarListRange?.(range) ?? Promise.resolve([]))
        .catch(() => [])
        .then((list) => {
          // A late answer for a day the user already left is dropped.
          if (seq === loadSeq.current) setEvents(list ?? []);
        });
    },
    [request.fileDate],
  );

  const ranked = useMemo(
    () => rankEvents(events, request.fileName),
    [events, request.fileName],
  );
  const selectedEvent =
    ranked.find((r) => eventKey(r.event) === selected)?.event ?? null;
  const day = localDayWindow(request.fileDate, offset).from;
  const dayLabel = new Intl.DateTimeFormat(i18n.language, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(day);
  const fileDateLabel = new Intl.DateTimeFormat(i18n.language, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(request.fileDate);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent
        className="gap-4 sm:max-w-md"
        data-testid="import-calendar-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t("meetings.calendar.importDialog.title")}</DialogTitle>
          <DialogDescription>
            {t("meetings.calendar.importDialog.desc", {
              name: request.fileName,
              date: fileDateLabel,
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid="import-calendar-prev-day"
            onClick={() => changeDay(offset - 1)}
          >
            <ChevronLeft />
            <span className="sr-only">
              {t("meetings.calendar.importDialog.prevDay")}
            </span>
          </Button>
          <span
            className="text-foreground text-[13px] font-medium"
            data-testid="import-calendar-day"
          >
            {dayLabel}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid="import-calendar-next-day"
            onClick={() => changeDay(offset + 1)}
          >
            <ChevronRight />
            <span className="sr-only">
              {t("meetings.calendar.importDialog.nextDay")}
            </span>
          </Button>
        </div>

        {ranked.length === 0 ? (
          <div className="text-muted-foreground py-6 text-center text-[12.5px]">
            {t("meetings.calendar.importDialog.noEvents")}
          </div>
        ) : (
          <ul
            className="flex max-h-64 flex-col gap-0.5 overflow-y-auto"
            data-testid="import-calendar-events"
          >
            {ranked.map(({ event, matches }) => {
              const key = eventKey(event);
              const isSelected = key === selected;
              const count = event.attendees.length;
              return (
                <li key={key}>
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    data-testid="import-calendar-event"
                    onClick={() => setSelected(key)}
                    className={cn(
                      "hover:bg-card w-full rounded-md px-2 py-1.5 text-left",
                      isSelected && "bg-[var(--accent-passive-tint)]",
                    )}
                  >
                    <div className="flex min-w-0 items-center justify-between gap-2">
                      <span className="text-foreground truncate text-[13px] font-medium">
                        {event.title || t("meetings.untitled")}
                      </span>
                      {matches && (
                        <span className="shrink-0 rounded-full bg-[var(--accent-passive-tint)] px-1.5 text-[10px] font-medium text-[var(--accent-passive-ink)]">
                          {t("meetings.calendar.importDialog.matchesFileName")}
                        </span>
                      )}
                    </div>
                    <div className="text-muted-foreground flex items-center gap-2 text-[11.5px]">
                      <span>
                        {formatRange(event.start, event.end, i18n.language)}
                      </span>
                      {count > 0 && (
                        <span
                          className="inline-flex shrink-0 items-center gap-0.5"
                          title={t("meetings.calendar.attendees", { count })}
                        >
                          <Users className="size-3" />
                          {count}
                        </span>
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            data-testid="import-calendar-skip"
            onClick={onSkip}
          >
            {t("meetings.calendar.importDialog.skip")}
          </Button>
          <Button
            size="sm"
            data-testid="import-calendar-link"
            disabled={!selectedEvent}
            onClick={() => {
              if (selectedEvent) onLink(selectedEvent);
            }}
          >
            {t("meetings.calendar.importDialog.importAndLink")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
