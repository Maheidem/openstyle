/**
 * Calendar link (specs/calendar-eventkit.md). The main process asks the
 * `macos-calendar` helper for events. Nothing here runs the helper unless the
 * user turned on "Use my calendar" (setting `calendar_enabled` = "true").
 *
 * Privacy: logs hold counts and status only. Never log titles, attendee
 * names, emails or notes.
 */

import { createAppLogger } from "@openstyle/utils";
import type {
  CalendarAttendee,
  CalendarAuthStatus,
  CalendarEvent,
} from "@openstyle/validations";
import type { ServerFetch } from "../shared/server-auth";
import { SETTINGS_KEYS } from "../shared/settings-keys";
import { execAsync } from "./active-window";
import { getNativeBinaryPath } from "./native-binary";

const log = createAppLogger("calendar");

/** A calendar event with the all-day flag the matcher needs. */
export interface ListedEvent extends CalendarEvent {
  isAllDay: boolean;
}

/** Runs the helper with args. Returns stdout, or null on any failure. */
export type HelperRunner = (
  args: string[],
  timeoutMs: number,
) => Promise<string | null>;

const HELPER_TIMEOUT_MS = 3000;
// The macOS dialog waits for the user, so `request` gets a long timeout.
const REQUEST_TIMEOUT_MS = 120_000;
// An event that starts within this window counts as running now.
const START_EARLY_MS = 5 * 60 * 1000;

const defaultRunner: HelperRunner = async (args, timeoutMs) => {
  if (process.platform !== "darwin") return null;
  const binary = getNativeBinaryPath("macos-calendar");
  if (!binary) return null;
  try {
    return await execAsync(binary, args, timeoutMs, 16 * 1024 * 1024);
  } catch {
    return null;
  }
};

function parseJson(out: string | null): Record<string, unknown> | null {
  if (out === null) return null;
  try {
    const value: unknown = JSON.parse(out);
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const STATUSES: ReadonlySet<string> = new Set([
  "notDetermined",
  "restricted",
  "denied",
  "fullAccess",
  "writeOnly",
]);

function readStatus(obj: Record<string, unknown> | null) {
  const s = obj?.status;
  return typeof s === "string" && STATUSES.has(s)
    ? (s as CalendarAuthStatus)
    : null;
}

/** Current Calendars permission. Never shows a dialog. */
export async function calendarAuthStatus(
  run: HelperRunner = defaultRunner,
): Promise<CalendarAuthStatus | null> {
  return readStatus(parseJson(await run(["status"], HELPER_TIMEOUT_MS)));
}

/** Show the macOS Calendars dialog. Call it only when the user turns the toggle on. */
export async function requestCalendarAccess(
  run: HelperRunner = defaultRunner,
): Promise<CalendarAuthStatus | null> {
  return readStatus(parseJson(await run(["request"], REQUEST_TIMEOUT_MS)));
}

function toListedEvent(raw: unknown): ListedEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const start = typeof e.start === "string" ? Date.parse(e.start) : Number.NaN;
  const end = typeof e.end === "string" ? Date.parse(e.end) : Number.NaN;
  if (typeof e.id !== "string" || !e.id) return null;
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const attendees: CalendarAttendee[] = Array.isArray(e.attendees)
    ? e.attendees.flatMap((a): CalendarAttendee[] => {
        if (!a || typeof a !== "object") return [];
        const r = a as Record<string, unknown>;
        return [
          {
            name: typeof r.name === "string" ? r.name : "",
            email: typeof r.email === "string" ? r.email : "",
            isOrganizer: r.isOrganizer === true,
          },
        ];
      })
    : [];
  return {
    id: e.id,
    title: typeof e.title === "string" ? e.title : "",
    start,
    end,
    url: typeof e.meetingUrl === "string" ? e.meetingUrl : null,
    attendees,
    isAllDay: e.isAllDay === true,
  };
}

/**
 * Events between `from` and `to` (epoch ms). Returns null when the helper
 * fails or the status is not fullAccess.
 */
export async function listEvents(
  from: number,
  to: number,
  run: HelperRunner = defaultRunner,
): Promise<ListedEvent[] | null> {
  const obj = parseJson(
    await run(
      [
        "events",
        "--from",
        new Date(from).toISOString(),
        "--to",
        new Date(to).toISOString(),
      ],
      HELPER_TIMEOUT_MS,
    ),
  );
  if (readStatus(obj) !== "fullAccess" || !Array.isArray(obj?.events)) {
    return null;
  }
  return obj.events.flatMap((raw) => {
    const e = toListedEvent(raw);
    return e ? [e] : [];
  });
}

/**
 * Pick the event that runs now. All-day events never match. An event with a
 * meeting link or several attendees wins over a plain one. Then the latest
 * start wins. The id breaks the last tie, so the result is stable.
 */
export function pickCurrentEvent(
  events: ListedEvent[],
  now: number,
): ListedEvent | null {
  const rank = (e: ListedEvent) => (e.url || e.attendees.length > 1 ? 1 : 0);
  const running = events.filter(
    (e) => !e.isAllDay && e.start <= now + START_EARLY_MS && e.end > now,
  );
  running.sort(
    (a, b) =>
      rank(b) - rank(a) || b.start - a.start || a.id.localeCompare(b.id),
  );
  return running[0] ?? null;
}

/** Start and end (epoch ms) of the local day that holds `now`. */
export function todayWindow(now: number): { from: number; to: number } {
  const d = new Date(now);
  const from = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const to = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  return { from, to };
}

/** True only when the setting holds "true". A missing setting means off. */
export async function isCalendarEnabled(
  serverFetch: ServerFetch,
): Promise<boolean> {
  try {
    const res = await serverFetch(`/settings/${SETTINGS_KEYS.calendarEnabled}`);
    if (!res.ok) return false;
    return ((await res.json()) as { value?: string }).value === "true";
  } catch {
    return false;
  }
}

export interface CalendarDeps {
  isEnabled: () => Promise<boolean>;
  run?: HelperRunner;
  now?: () => number;
}

/**
 * Today's events (not all-day), sorted by start. Returns [] when the setting
 * is off, before the helper starts. Returns [] when access is not granted.
 */
export async function listTodayEvents(
  deps: CalendarDeps,
): Promise<ListedEvent[]> {
  if (!(await deps.isEnabled())) return [];
  const run = deps.run ?? defaultRunner;
  if ((await calendarAuthStatus(run)) !== "fullAccess") return [];
  const { from, to } = todayWindow((deps.now ?? Date.now)());
  const events = await listEvents(from, to, run);
  const list = (events ?? [])
    .filter((e) => !e.isAllDay)
    .sort((a, b) => a.start - b.start);
  log.info(`calendar: ${list.length} events today`);
  return list;
}

/**
 * The event to link when a meeting recording starts. Returns null when the
 * setting is off (no helper starts), when access is not fullAccess (this
 * never shows a dialog), or on any error.
 */
export async function autoLinkCurrentEvent(
  deps: CalendarDeps,
): Promise<CalendarEvent | null> {
  try {
    const now = (deps.now ?? Date.now)();
    const events = await listTodayEvents({ ...deps, now: () => now });
    const picked = pickCurrentEvent(events, now);
    if (!picked) return null;
    const { isAllDay: _isAllDay, ...event } = picked;
    log.info(
      `calendar: linked a running event (link ${event.url ? "yes" : "no"}, attendees ${event.attendees.length})`,
    );
    return event;
  } catch {
    return null;
  }
}
