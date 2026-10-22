/**
 * "Next event" and "Record when it starts" for the tray popover (issue #317,
 * step 3).
 *
 * - The popover reads the next event of today when it shows. Nothing reads
 *   the calendar on a timer while no watch is armed.
 * - "Record" and the armed start link the event through a pending link:
 *   the recorder asks findCurrentEvent once per start, and core-ipc.ts gives
 *   it this event first (takePendingEventLink). The start itself goes through
 *   MeetingRecorder.start(), the path of meeting:start and the tray menu, with
 *   the device confirm flow of #169.
 * - The arm lives in memory only. An app restart clears it.
 *
 * Privacy: logs hold no titles (see calendar.ts).
 */

import { createAppLogger } from "@openstyle/utils";
import type { CalendarEvent } from "@openstyle/validations";
import { dialog, ipcMain, powerMonitor } from "electron";
import type { TrayNextEvent, TrayScheduleState } from "../shared/tray-popover";
import {
  clampEvent,
  isCalendarEnabled,
  type ListedEvent,
  listTodayEvents,
} from "./calendar";
import { type FakeCalendarEvent, setFakeCalendarEvents } from "./fake-calendar";
import { state } from "./main-state";
import { MeetingDevicesChangedError } from "./meeting-recorder";
import { serverFetch } from "./server-target";
import { showSettingsWindow } from "./windows/settings-window";

const log = createAppLogger("meeting-schedule");

/** The longest wait between two checks while a watch is armed. */
const ARMED_TICK_MS = 30_000;
/** How long a pending link waits for the start of a recording. */
const PENDING_LINK_MS = 2 * 60_000;

interface Armed {
  eventId: string;
  start: number;
}

let armed: Armed | null = null;
let timer: NodeJS.Timeout | null = null;
let pendingLink: { event: CalendarEvent; until: number } | null = null;
let resumeHooked = false;

function readTodayEvents(): Promise<ListedEvent[]> {
  return listTodayEvents({ isEnabled: () => isCalendarEnabled(serverFetch) });
}

function toNextEvent(e: ListedEvent): TrayNextEvent {
  return { id: e.id, title: e.title, start: e.start, end: e.end };
}

function linkable(e: ListedEvent): CalendarEvent {
  const { isAllDay: _isAllDay, ...event } = e;
  return clampEvent(event);
}

/** Tell the popover that the arm changed. */
function notifyPopover(): void {
  state.trayPopover?.webContents.send("tray-popover:schedule-changed");
}

/**
 * The event that the next recording start links, once. The recorder calls it
 * through findCurrentEvent (core-ipc.ts). Null when none waits.
 */
export function takePendingEventLink(): CalendarEvent | null {
  const pending = pendingLink;
  pendingLink = null;
  if (!pending || pending.until < Date.now()) return null;
  return pending.event;
}

function setPendingLink(e: ListedEvent): void {
  pendingLink = { event: linkable(e), until: Date.now() + PENDING_LINK_MS };
}

export async function readScheduleState(): Promise<TrayScheduleState> {
  const now = Date.now();
  const events = await readTodayEvents();
  const next = events.find((e) => e.start > now) ?? null;
  return {
    event: next ? toNextEvent(next) : null,
    armed: armed ? { ...armed } : null,
  };
}

function clearTimer(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

function disarm(reason: string): void {
  if (!armed) return;
  armed = null;
  clearTimer();
  log.info(`Record when it starts: disarmed (${reason})`);
  notifyPopover();
}

/** Wake at the start time, or after one tick, whichever comes first. */
function scheduleCheck(): void {
  clearTimer();
  if (!armed) return;
  const delay = Math.max(0, Math.min(armed.start - Date.now(), ARMED_TICK_MS));
  timer = setTimeout(() => void check(), delay);
}

/**
 * Read the events again and act: re-schedule a moved event, disarm a deleted
 * or ended one, and fire when the start time came. Runs on the timer and on
 * powerMonitor resume, so a sleep never skips the start.
 */
async function check(): Promise<void> {
  const current = armed;
  if (!current) return;
  const events = await readTodayEvents();
  if (armed !== current) return; // The user changed the arm meanwhile.
  const event = events.find((e) => e.id === current.eventId);
  const now = Date.now();
  if (!event) {
    disarm("the event is gone");
    return;
  }
  if (event.start !== current.start) {
    armed = { eventId: event.id, start: event.start };
    log.info("Record when it starts: the event moved; scheduled again");
    notifyPopover();
  }
  if (now >= event.end) {
    disarm("the event ended before the start was seen");
    return;
  }
  if (now >= event.start) {
    await fire(event);
    return;
  }
  scheduleCheck();
}

async function fire(event: ListedEvent): Promise<void> {
  armed = null;
  clearTimer();
  notifyPopover();
  const recorder = state.meetingRecorder;
  if (!recorder) {
    log.warn("Record when it starts: fired, but no meeting recorder exists");
    return;
  }
  if (recorder.status !== "idle") {
    log.info(
      `Record when it starts: fired, but a meeting already records (${recorder.status}); no new start`,
    );
    return;
  }
  log.info("Record when it starts: fired; starting the meeting recording");
  setPendingLink(event);
  try {
    await recorder.start();
  } catch (err) {
    // The same answers as the tray menu: the Meetings page asks the user to
    // confirm changed devices (#169) and keeps the pending link.
    if (err instanceof MeetingDevicesChangedError) {
      showSettingsWindow("/meetings?confirmStart=1");
      return;
    }
    pendingLink = null;
    log.error(`Record when it starts: the start failed: ${String(err)}`);
    dialog.showErrorBox(
      "Meeting recording",
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function arm(eventId: string): Promise<TrayScheduleState> {
  const event = (await readTodayEvents()).find((e) => e.id === eventId);
  if (!event || event.start <= Date.now()) {
    log.info("Record when it starts: not armed (no such future event)");
    return readScheduleState();
  }
  armed = { eventId: event.id, start: event.start };
  log.info(
    `Record when it starts: armed for a start in ${Math.round((event.start - Date.now()) / 1000)} s`,
  );
  if (!resumeHooked) {
    resumeHooked = true;
    powerMonitor.on("resume", () => {
      if (armed) void check();
    });
  }
  scheduleCheck();
  notifyPopover();
  return readScheduleState();
}

/** IPC of the "Next event" card. Main owns the arm and the timers. */
export function registerMeetingScheduleIpc(): void {
  ipcMain.handle("tray-popover:schedule", () => readScheduleState());

  ipcMain.handle("tray-popover:arm", (_event, eventId: unknown) => {
    if (typeof eventId !== "string" || !eventId) return readScheduleState();
    return arm(eventId);
  });

  ipcMain.handle("tray-popover:disarm", () => {
    disarm("the user turned it off");
    return readScheduleState();
  });

  // "Record" on the card: link this event to the start that the page asks
  // for next (meeting:start). Returns false when the event is gone. Null
  // clears the link after a start that failed, so no later start takes it.
  ipcMain.handle(
    "tray-popover:link-next-start",
    async (_event, id: unknown) => {
      if (id === null) {
        pendingLink = null;
        return false;
      }
      if (typeof id !== "string" || !id) return false;
      const event = (await readTodayEvents()).find((e) => e.id === id);
      if (!event) return false;
      setPendingLink(event);
      return true;
    },
  );

  if ((process.env.OPENSTYLE_E2E ?? process.env.FREESTYLE_E2E) === "1") {
    // Replace the fictional events of OPENSTYLE_E2E_FAKE_CALENDAR.
    ipcMain.on("e2e:fake-calendar-set", (_event, next: FakeCalendarEvent[]) => {
      setFakeCalendarEvents(next);
    });
  }
}
