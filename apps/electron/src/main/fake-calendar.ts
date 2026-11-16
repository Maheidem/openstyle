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
  /** Fictional people. Default: none. */
  attendees?: { name: string; email: string; isOrganizer: boolean }[];
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

/** The value after `flag` in `args`, as epoch ms, or NaN. */
function argTime(args: string[], flag: string): number {
  const i = args.indexOf(flag);
  return i >= 0 ? Date.parse(args[i + 1] ?? "") : Number.NaN;
}

/**
 * The answer of the macos-calendar helper for `args`, as JSON text. Like
 * the helper, `events` returns only the events that overlap
 * `--from`..`--to`.
 */
export function fakeCalendarOutput(args: string[]): string {
  if (args[0] !== "events") return JSON.stringify({ status: "fullAccess" });
  const from = argTime(args, "--from");
  const to = argTime(args, "--to");
  const inRange = events.filter(
    (e) =>
      (Number.isNaN(to) || e.start < to) &&
      (Number.isNaN(from) || e.end > from),
  );
  return JSON.stringify({
    status: "fullAccess",
    events: inRange.map((e) => ({
      id: e.id,
      title: e.title,
      start: new Date(e.start).toISOString(),
      end: new Date(e.end).toISOString(),
      isAllDay: false,
      meetingUrl: null,
      attendees: e.attendees ?? [],
    })),
  });
}
