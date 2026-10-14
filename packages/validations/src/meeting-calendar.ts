import { z } from "zod";

/** Limits for the calendar link (specs/calendar-eventkit.md). */
export const CALENDAR_MAX_ATTENDEES = 200;

export const calendarAttendeeSchema = z.object({
  name: z.string().max(200),
  email: z.string().max(320),
  isOrganizer: z.boolean(),
});

/**
 * One calendar event linked to a meeting. The main process sends it, the
 * server stores it. `start` and `end` are epoch milliseconds.
 */
export const calendarEventSchema = z.object({
  id: z.string().min(1).max(512),
  title: z.string().max(512),
  start: z.number().int(),
  end: z.number().int(),
  url: z.string().max(2048).nullable(),
  attendees: z.array(calendarAttendeeSchema).max(CALENDAR_MAX_ATTENDEES),
});

export type CalendarAttendee = z.infer<typeof calendarAttendeeSchema>;
export type CalendarEvent = z.infer<typeof calendarEventSchema>;
