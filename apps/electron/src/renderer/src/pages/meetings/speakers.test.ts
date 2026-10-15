import type { CalendarEvent } from "@openstyle/validations";
import { describe, expect, it } from "vitest";
import { attendeeNameOptions } from "./speakers";

function calendarWithNames(names: string[]): CalendarEvent {
  return {
    id: "event",
    title: "Meeting",
    start: 0,
    end: 1,
    url: null,
    attendees: names.map((name) => ({
      name,
      email: "private@example.com",
      isOrganizer: false,
    })),
  };
}

describe("attendeeNameOptions", () => {
  it("returns no options for a null or undefined calendar", () => {
    expect(attendeeNameOptions(null)).toEqual([]);
    expect(attendeeNameOptions(undefined)).toEqual([]);
  });

  it("drops empty names and trims whitespace", () => {
    expect(
      attendeeNameOptions(calendarWithNames(["", "  ", " Alice "])),
    ).toEqual(["Alice"]);
    expect(attendeeNameOptions(calendarWithNames([]))).toEqual([]);
  });

  it("deduplicates case-insensitively and keeps the first spelling", () => {
    expect(
      attendeeNameOptions(calendarWithNames([" Alice ", "ALICE", "alice"])),
    ).toEqual(["Alice"]);
  });

  it("keeps the original attendee order", () => {
    expect(
      attendeeNameOptions(calendarWithNames(["Zoe", "Bob", "zoe", "Alice"])),
    ).toEqual(["Zoe", "Bob", "Alice"]);
  });

  it("never includes emails or uses them for empty names", () => {
    const names = attendeeNameOptions(calendarWithNames(["Alice", ""]));
    expect(names).toEqual(["Alice"]);
    expect(names.join(" ")).not.toContain("private@example.com");
  });
});
