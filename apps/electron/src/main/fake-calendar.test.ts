import { describe, expect, it } from "vitest";
import { fakeCalendarOutput, setFakeCalendarEvents } from "./fake-calendar";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 10, 9, 0, 0);
const ana = { name: "Ana", email: "ana@example.test", isOrganizer: true };

describe("fakeCalendarOutput", () => {
  it("returns only the events in --from..--to, with their attendees", () => {
    setFakeCalendarEvents([
      { id: "in", title: "In", start: T0, end: T0 + 1000, attendees: [ana] },
      { id: "next-day", title: "Next", start: T0 + DAY, end: T0 + DAY + 1 },
    ]);
    const out = JSON.parse(
      fakeCalendarOutput([
        "events",
        "--from",
        new Date(T0 - 1000).toISOString(),
        "--to",
        new Date(T0 + DAY / 2).toISOString(),
      ]),
    ) as { status: string; events: { id: string; attendees: unknown[] }[] };
    expect(out.status).toBe("fullAccess");
    expect(out.events.map((e) => e.id)).toEqual(["in"]);
    expect(out.events[0]?.attendees).toEqual([ana]);
  });

  it("returns every event when the range is missing", () => {
    setFakeCalendarEvents([
      { id: "a", title: "A", start: T0, end: T0 + 1 },
      { id: "b", title: "B", start: T0 + DAY, end: T0 + DAY + 1 },
    ]);
    const out = JSON.parse(fakeCalendarOutput(["events"])) as {
      events: { id: string; attendees: unknown[] }[];
    };
    expect(out.events.map((e) => e.id)).toEqual(["a", "b"]);
    expect(out.events[0]?.attendees).toEqual([]);
  });
});
