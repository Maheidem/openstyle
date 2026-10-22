import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ListedEvent } from "./calendar";

// The "Record when it starts" scheduler (issue #317): the resume path, a
// moved event, a deleted event and a fire during a start. The calendar
// reader, the recorder and electron are fakes.

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  resume: [] as (() => void)[],
  events: [] as ListedEvent[],
  recorder: {
    status: "idle" as string,
    isStarting: false,
    start: vi.fn(async () => "meeting-1"),
  },
  showErrorBox: vi.fn(),
}));

vi.mock("electron", () => ({
  dialog: { showErrorBox: mocks.showErrorBox },
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(name, handler),
    on: vi.fn(),
  },
  powerMonitor: {
    on: (name: string, handler: () => void) => {
      if (name === "resume") mocks.resume.push(handler);
    },
  },
}));
vi.mock("./calendar", () => ({
  clampEvent: (e: unknown) => e,
  isCalendarEnabled: async () => true,
  listTodayEvents: async () => mocks.events.map((e) => ({ ...e })),
}));
vi.mock("./fake-calendar", () => ({ setFakeCalendarEvents: vi.fn() }));
vi.mock("./main-state", () => ({
  state: {
    trayPopover: null,
    get meetingRecorder() {
      return mocks.recorder;
    },
  },
}));
vi.mock("./meeting-recorder", () => ({
  MeetingDevicesChangedError: class extends Error {},
}));
vi.mock("./server-target", () => ({ serverFetch: vi.fn() }));
vi.mock("./windows/settings-window", () => ({ showSettingsWindow: vi.fn() }));

const MINUTE = 60_000;
const T0 = new Date(2026, 9, 22, 10, 0, 0).getTime();

function event(id: string, startIn: number): ListedEvent {
  return {
    id,
    title: id,
    start: T0 + startIn,
    end: T0 + startIn + 30 * MINUTE,
    url: null,
    attendees: [],
    isAllDay: false,
  };
}

async function invoke(name: string, ...args: unknown[]): Promise<unknown> {
  return mocks.handlers.get(name)?.({}, ...args);
}

beforeEach(async () => {
  vi.useFakeTimers({ now: T0 });
  vi.resetModules();
  mocks.handlers.clear();
  mocks.resume.length = 0;
  mocks.recorder.status = "idle";
  mocks.recorder.isStarting = false;
  mocks.recorder.start.mockClear();
  mocks.showErrorBox.mockClear();
  const { registerMeetingScheduleIpc } = await import("./meeting-schedule");
  registerMeetingScheduleIpc();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Record when it starts", () => {
  it("fires once on resume after the start time passed in sleep", async () => {
    mocks.events = [event("standup", 10 * MINUTE)];
    await invoke("tray-popover:arm", "standup");
    expect(mocks.resume).toHaveLength(1);

    // A sleep: the clock jumps past the start, and no timer ran.
    vi.setSystemTime(T0 + 11 * MINUTE);
    mocks.resume[0]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.recorder.start).toHaveBeenCalledTimes(1);

    // The arm is clear: a second resume and the timers start nothing more.
    mocks.resume[0]!();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(mocks.recorder.start).toHaveBeenCalledTimes(1);
    const state = (await invoke("tray-popover:schedule")) as {
      armed: unknown;
    };
    expect(state.armed).toBeNull();
  });

  it("re-schedules a moved event to its new start", async () => {
    mocks.events = [event("standup", 2 * MINUTE)];
    await invoke("tray-popover:arm", "standup");
    mocks.events = [event("standup", 5 * MINUTE)];

    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    expect(mocks.recorder.start).not.toHaveBeenCalled();
    const state = (await invoke("tray-popover:schedule")) as {
      armed: { start: number } | null;
    };
    expect(state.armed?.start).toBe(T0 + 5 * MINUTE);

    await vi.advanceTimersByTimeAsync(2 * MINUTE + 1_000);
    expect(mocks.recorder.start).toHaveBeenCalledTimes(1);
  });

  it("disarms when the event is deleted", async () => {
    mocks.events = [event("standup", 2 * MINUTE)];
    await invoke("tray-popover:arm", "standup");
    mocks.events = [];

    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    expect(mocks.recorder.start).not.toHaveBeenCalled();
    const state = (await invoke("tray-popover:schedule")) as {
      armed: unknown;
    };
    expect(state.armed).toBeNull();
  });

  it("does nothing, with no error box, while a start runs", async () => {
    mocks.events = [event("standup", MINUTE)];
    await invoke("tray-popover:arm", "standup");
    mocks.recorder.isStarting = true;

    await vi.advanceTimersByTimeAsync(MINUTE + 1_000);
    expect(mocks.recorder.start).not.toHaveBeenCalled();
    expect(mocks.showErrorBox).not.toHaveBeenCalled();
  });

  it("shows the armed event on the card, also after an earlier event", async () => {
    mocks.events = [event("early", 5 * MINUTE), event("late", 60 * MINUTE)];
    await invoke("tray-popover:arm", "late");
    const state = (await invoke("tray-popover:schedule")) as {
      event: { id: string } | null;
      armed: { eventId: string } | null;
    };
    expect(state.event?.id).toBe("late");
    expect(state.armed?.eventId).toBe("late");
  });
});
