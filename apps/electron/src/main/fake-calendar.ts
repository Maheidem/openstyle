/**
 * E2E seam for the calendar (issue #317). With OPENSTYLE_E2E=1 and
 * OPENSTYLE_E2E_FAKE_CALENDAR=1, the calendar helpers get their answers from
 * this file. No EventKit call and no helper process: macOS denies EventKit
 * with no dialog under Claude Code and the Test Runner, so a test cannot use
 * a real read. A run without OPENSTYLE_E2E=1 ignores the flag.
 *
 * The events are fictional. A test can replace them with the E2E-only IPC
 * "e2e:fake-calendar-set" (registered in meeting-schedule.ts).
 */

const MINUTE = 60_000;

export interface FakeCalendarEvent {
  id: string;
  title: string;
  start: number;
  end: number;
}

export function isFakeCalendar(): boolean {
  return (
    process.env.OPENSTYLE_E2E === "1" &&
    process.env.OPENSTYLE_E2E_FAKE_CALENDAR === "1"
  );
}

const bootAt = Date.now();
let events: FakeCalendarEvent[] = [
  {
    id: "e2e-roadmap-check-in",
    title: "Roadmap check-in",
    start: bootAt + 90_000,
    end: bootAt + 90_000 + 30 * MINUTE,
  },
  {
    id: "e2e-quarterly-planning",
    title: "Quarterly planning review",
    start: bootAt + 229 * MINUTE,
    end: bootAt + 259 * MINUTE,
  },
];

export function setFakeCalendarEvents(next: FakeCalendarEvent[]): void {
  events = next;
}

/** The answer of the macos-calendar helper for `args`, as JSON text. */
export function fakeCalendarOutput(args: string[]): string {
  if (args[0] !== "events") return JSON.stringify({ status: "fullAccess" });
  return JSON.stringify({
    status: "fullAccess",
    events: events.map((e) => ({
      id: e.id,
      title: e.title,
      start: new Date(e.start).toISOString(),
      end: new Date(e.end).toISOString(),
      isAllDay: false,
      meetingUrl: null,
      attendees: [],
    })),
  });
}
