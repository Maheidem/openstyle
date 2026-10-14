import { describe, expect, it, vi } from "vitest";

// calendar.ts imports modules that need Electron. The tests inject a fake
// helper runner, so these two are never called.
vi.mock("./active-window", () => ({ execAsync: vi.fn() }));
vi.mock("./native-binary", () => ({ getNativeBinaryPath: () => null }));

const {
  autoLinkCurrentEvent,
  calendarAuthStatus,
  clampEvent,
  listEvents,
  listTodayEvents,
  pickCurrentEvent,
  todayWindow,
} = await import("./calendar");
type ListedEvent = import("./calendar").ListedEvent;

const { calendarEventSchema } = await import("@openstyle/validations");

const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);
const MIN = 60 * 1000;

function ev(over: Partial<ListedEvent> & { id: string }): ListedEvent {
  return {
    title: "Fictional event",
    start: NOW - 10 * MIN,
    end: NOW + 20 * MIN,
    url: null,
    attendees: [],
    isAllDay: false,
    ...over,
  };
}

const person = (n: string) => ({
  name: n,
  email: `${n}@example.test`,
  isOrganizer: false,
});

describe("pickCurrentEvent", () => {
  it("returns null for an empty list", () => {
    expect(pickCurrentEvent([], NOW)).toBeNull();
  });

  it("skips all-day events", () => {
    expect(pickCurrentEvent([ev({ id: "a", isAllDay: true })], NOW)).toBeNull();
  });

  it("skips events that ended and events that start later than 5 minutes", () => {
    const ended = ev({ id: "ended", start: NOW - 60 * MIN, end: NOW });
    const late = ev({ id: "late", start: NOW + 6 * MIN, end: NOW + 60 * MIN });
    expect(pickCurrentEvent([ended, late], NOW)).toBeNull();
  });

  it("accepts an event that starts in 5 minutes", () => {
    const soon = ev({ id: "soon", start: NOW + 5 * MIN, end: NOW + 60 * MIN });
    expect(pickCurrentEvent([soon], NOW)?.id).toBe("soon");
  });

  it("prefers an event with a meeting link", () => {
    const plain = ev({ id: "plain", start: NOW - MIN });
    const linked = ev({ id: "linked", url: "https://meet.example.test/x" });
    expect(pickCurrentEvent([plain, linked], NOW)?.id).toBe("linked");
  });

  it("prefers an event with several attendees", () => {
    const plain = ev({ id: "plain", start: NOW - MIN });
    const group = ev({ id: "group", attendees: [person("a"), person("b")] });
    expect(pickCurrentEvent([plain, group], NOW)?.id).toBe("group");
  });

  it("an event in progress wins over one that starts in 4 minutes", () => {
    const running = ev({
      id: "running",
      start: NOW - 56 * MIN,
      end: NOW + 4 * MIN,
    });
    const next = ev({
      id: "next",
      start: NOW + 4 * MIN,
      end: NOW + 34 * MIN,
      url: "https://meet.example.test/n",
    });
    expect(pickCurrentEvent([next, running], NOW)?.id).toBe("running");
  });

  it("with equal rank, the latest start wins", () => {
    const early = ev({ id: "early", start: NOW - 30 * MIN });
    const late = ev({ id: "late", start: NOW - 5 * MIN });
    expect(pickCurrentEvent([early, late], NOW)?.id).toBe("late");
  });

  it("breaks a full tie by id, whatever the input order", () => {
    const a = ev({ id: "a" });
    const b = ev({ id: "b" });
    expect(pickCurrentEvent([b, a], NOW)?.id).toBe("a");
    expect(pickCurrentEvent([a, b], NOW)?.id).toBe("a");
  });
});

describe("clampEvent", () => {
  it("fits a huge invite to the server limits", () => {
    const big = clampEvent({
      id: "e",
      title: "t".repeat(2000),
      start: 1,
      end: 2,
      url: `https://x.example/${"u".repeat(3000)}`,
      attendees: Array.from({ length: 300 }, () => ({
        name: "n".repeat(500),
        email: "e".repeat(500),
        isOrganizer: false,
      })),
    });
    expect(calendarEventSchema.safeParse(big).success).toBe(true);
    expect(big.attendees).toHaveLength(200);
  });
});

describe("todayWindow", () => {
  it("spans one local day around now", () => {
    const { from, to } = todayWindow(NOW);
    expect(from).toBeLessThanOrEqual(NOW);
    expect(to).toBeGreaterThan(NOW);
    expect(to - from).toBeGreaterThanOrEqual(23 * 60 * MIN);
    expect(to - from).toBeLessThanOrEqual(25 * 60 * MIN);
  });
});

const helperEvent = (id: string, startOffsetMin = -10) => ({
  id,
  title: "Fictional event",
  start: new Date(NOW + startOffsetMin * MIN).toISOString(),
  end: new Date(NOW + 20 * MIN).toISOString(),
  isAllDay: false,
  meetingUrl: "https://meet.example.test/x",
  attendees: [{ name: "Ana", email: "ana@example.test", isOrganizer: true }],
});

/** A fake helper that answers each command like the real binary. */
function fakeRunner(status: string, events: unknown[] = []) {
  return vi.fn(async (args: string[]) => {
    if (args[0] === "events") return JSON.stringify({ status, events });
    return JSON.stringify({ status });
  });
}

describe("autoLinkCurrentEvent", () => {
  it("with the setting off, the helper never runs", async () => {
    const run = fakeRunner("fullAccess", [helperEvent("e1")]);
    const result = await autoLinkCurrentEvent({
      isEnabled: async () => false,
      run,
      now: () => NOW,
    });
    expect(result).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("links the running event when access is granted", async () => {
    const run = fakeRunner("fullAccess", [helperEvent("e1")]);
    const result = await autoLinkCurrentEvent({
      isEnabled: async () => true,
      run,
      now: () => NOW,
    });
    expect(result?.id).toBe("e1");
    expect(result?.url).toBe("https://meet.example.test/x");
    expect(result?.attendees).toHaveLength(1);
    expect(result).not.toHaveProperty("isAllDay");
    // One helper call: the events answer carries the status.
    const commands = run.mock.calls.map((c) => c[0][0]);
    expect(commands).toEqual(["events"]);
  });

  it("returns null and reads no events when access is not fullAccess", async () => {
    for (const status of ["notDetermined", "denied", "writeOnly"]) {
      const run = fakeRunner(status, [helperEvent("e1")]);
      const result = await autoLinkCurrentEvent({
        isEnabled: async () => true,
        run,
        now: () => NOW,
      });
      expect(result).toBeNull();
      expect(run.mock.calls.map((c) => c[0][0])).toEqual(["events"]);
    }
  });

  it("returns null on bad JSON", async () => {
    const result = await autoLinkCurrentEvent({
      isEnabled: async () => true,
      run: async () => "not json",
      now: () => NOW,
    });
    expect(result).toBeNull();
  });

  it("returns null on a helper failure or timeout (runner gives null)", async () => {
    const result = await autoLinkCurrentEvent({
      isEnabled: async () => true,
      run: async () => null,
      now: () => NOW,
    });
    expect(result).toBeNull();
  });

  it("returns null when the setting lookup throws", async () => {
    const result = await autoLinkCurrentEvent({
      isEnabled: async () => {
        throw new Error("server down");
      },
      run: fakeRunner("fullAccess"),
      now: () => NOW,
    });
    expect(result).toBeNull();
  });
});

describe("helper parsing", () => {
  it("calendarAuthStatus rejects an unknown status", async () => {
    expect(
      await calendarAuthStatus(async () => '{"status":"weird"}'),
    ).toBeNull();
    expect(await calendarAuthStatus(async () => '{"status":"denied"}')).toBe(
      "denied",
    );
  });

  it("listEvents drops events with a bad id or bad dates", async () => {
    const events = [
      helperEvent("ok"),
      { ...helperEvent("bad-date"), start: "nope" },
      { ...helperEvent(""), id: "" },
    ];
    const out = await listEvents(NOW - 1000, NOW + 1000, async () =>
      JSON.stringify({ status: "fullAccess", events }),
    );
    expect(out?.map((e) => e.id)).toEqual(["ok"]);
  });

  it("listTodayEvents returns events sorted by start, without all-day events", async () => {
    const run = fakeRunner("fullAccess", [
      helperEvent("late", 30),
      { ...helperEvent("allday"), isAllDay: true },
      helperEvent("early", -30),
    ]);
    const list = await listTodayEvents({
      isEnabled: async () => true,
      run,
      now: () => NOW,
    });
    expect(list.map((e) => e.id)).toEqual(["early", "late"]);
  });
});
