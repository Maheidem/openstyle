import type { CalendarEvent } from "@openstyle/validations";
import { describe, expect, it } from "vitest";
import {
  eventKey,
  localDayWindow,
  normalizeTitle,
  rankEvents,
  titleMatchesFile,
} from "./import-calendar";

// Fictional events only.
function ev(id: string, title: string, start: number): CalendarEvent {
  return { id, title, start, end: start + 1, url: null, attendees: [] };
}

describe("normalizeTitle", () => {
  it("drops the extension and a browser copy suffix of a file name", () => {
    expect(normalizeTitle("Atlas Weekly Sync (1).webm", true)).toBe(
      "atlas weekly sync",
    );
    expect(normalizeTitle("atlas_weekly-sync.final.mkv", true)).toBe(
      "atlas weekly sync final",
    );
  });

  it("keeps a dot in an event title", () => {
    expect(normalizeTitle("Q3: Roadmap  review.")).toBe("q3 roadmap review");
  });

  it("keeps letters with accents", () => {
    expect(normalizeTitle("Reunião de equipe")).toBe("reunião de equipe");
  });
});

describe("titleMatchesFile", () => {
  it.each([
    ["Atlas Weekly Sync", "atlas-weekly-sync.webm"],
    ["Atlas Weekly Sync", "Atlas Weekly Sync (2).webm"],
    ["Atlas Weekly Sync", "2026-11-10 Atlas Weekly Sync recording.flac"],
    ["Weekly sync with the Atlas team", "Atlas.webm"],
  ])("matches %j and %j", (title, file) => {
    expect(titleMatchesFile(title, file)).toBe(true);
  });

  it.each([
    ["Design critique", "Atlas Weekly Sync.webm"],
    ["Team standup", "ab.webm"],
    ["", "Atlas.webm"],
    ["Atlas", "(1).webm"],
  ])("does not match %j and %j", (title, file) => {
    expect(titleMatchesFile(title, file)).toBe(false);
  });
});

describe("rankEvents", () => {
  it("puts matching events first, then sorts by start time", () => {
    const ranked = rankEvents(
      [
        ev("c", "Design critique", 300),
        ev("a", "Team standup", 100),
        ev("m", "Atlas Weekly Sync", 200),
      ],
      "Atlas Weekly Sync.webm",
    );
    expect(ranked.map((r) => [r.event.id, r.matches])).toEqual([
      ["m", true],
      ["a", false],
      ["c", false],
    ]);
  });

  it("sorts several matches by start time", () => {
    const ranked = rankEvents(
      [ev("late", "Atlas sync", 500), ev("early", "Atlas", 100)],
      "atlas sync.webm",
    );
    expect(ranked.map((r) => r.event.id)).toEqual(["early", "late"]);
  });
});

describe("localDayWindow", () => {
  it("returns the local day and moves it by whole days", () => {
    const at = new Date(2026, 10, 10, 10, 46).getTime();
    expect(localDayWindow(at)).toEqual({
      from: new Date(2026, 10, 10).getTime(),
      to: new Date(2026, 10, 11).getTime(),
    });
    expect(localDayWindow(at, -1).from).toBe(new Date(2026, 10, 9).getTime());
    expect(localDayWindow(at, 21).from).toBe(new Date(2026, 11, 1).getTime());
  });
});

describe("eventKey", () => {
  it("tells two instances of a recurring event apart", () => {
    expect(eventKey(ev("r", "x", 1))).not.toBe(eventKey(ev("r", "x", 2)));
  });
});
