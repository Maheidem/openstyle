# Link meetings to calendar events (EventKit)

Issues: #68 (read calendar through EventKit) and #74 (fill speaker names from attendees).
Branch: `feat/calendar-eventkit-68-74`.

## Owner decisions (fixed)

1. Opt-in. Settings, section "Meetings", has the toggle "Use my calendar". It is OFF by default. Turning it ON asks macOS for Calendars access. While it is OFF, nothing reads the calendar. No helper starts.
2. Matching. When a meeting recording starts, the app picks the calendar event that runs now. It prefers an event with a meeting link or attendees. It skips all-day events. The meeting screen shows the linked event with "Change" and "Unlink".
3. Data. The meeting row stores the event id, title, start, end, meeting link and attendees (name, email, organizer flag). Speaker naming reads the attendee names. The free-text context field stays for the user's own notes. If the meeting title is empty, the event title is used.

## Data model (schema v39)

New nullable columns on `meetings`:

| Column | Type | Content |
|---|---|---|
| `calendar_event_id` | TEXT | `calendarItemExternalIdentifier` |
| `calendar_title` | TEXT | event title |
| `calendar_start` | INTEGER | epoch ms |
| `calendar_end` | INTEGER | epoch ms |
| `calendar_url` | TEXT | meeting link |
| `calendar_attendees` | TEXT | JSON array of `{name, email, isOrganizer}` |

Old rows keep NULL. Default title: the app creates a meeting with `title = null`. A null or empty title takes the event title.

Server routes (`routes/meetings.ts`):
- `POST /meetings/start` accepts an optional `calendar` object.
- `PUT /meetings/:id/calendar` links or changes the event. `404` for an unknown meeting.
- `DELETE /meetings/:id/calendar` clears the six columns. It resets the title to null only when the title equals the event title (the title was inherited).
- `GET /meetings/:id` and the list return a parsed `calendar` object, or null.

## Settings key

`calendar_enabled`. Only the string `"true"` means ON. A missing key means OFF.

## Native helper: `native/macos-calendar.swift`

One JSON object on stdout. Exit code 0 for every authorization state. Exit code 1 for a crash.

```
macos-calendar status                          {"status":"notDetermined|denied|restricted|fullAccess|writeOnly"}
macos-calendar request                         {"status":"..."}   (shows the macOS dialog)
macos-calendar events --from ISO --to ISO      {"status":"fullAccess","events":[...]}
```

Event: `id`, `title`, `start`, `end`, `isAllDay`, `meetingUrl`, `meetingPlatform`, `attendees[{name,email,isOrganizer}]`.

- It uses `requestFullAccessToEvents` (macOS 14). The build sets the deployment target to 14.0.
- The meeting link comes from the event notes first, then `url`, then `location`. Patterns: `meet.google.com`, `teams.microsoft.com/l/meetup-join`, `zoom.us/j`, `webex.com`.
- The email comes from the `mailto:` URL. The helper adds the organizer when the organizer is missing from the attendees.
- The helper never returns the notes text.
- Packaging: `NSCalendarsFullAccessUsageDescription` in `electron-builder.yml`. Entitlement `com.apple.security.personal-information.calendars` in `entitlements.mac.plist`. Without the entitlement macOS denies with no dialog.

## Main process

`src/main/calendar.ts`: `calendarAuthStatus`, `requestCalendarAccess`, `listEvents`, `pickCurrentEvent` (pure), `autoLinkCurrentEvent`. Each helper call has a 3 s timeout. Any error gives `null`.
`autoLinkCurrentEvent` returns `null` when the setting is not `"true"`, before any helper starts. It reads events only when the status is `fullAccess`. It never calls `request`.
`MeetingRecorder.start()` calls it once. A failure never stops the recording.

`pickCurrentEvent`: drop all-day events; keep events with `start <= now + 5 min` and `end > now`; rank events with a link or more than one attendee first, then the latest start, then the id.

IPC: `calendar:status`, `calendar:request`, `calendar:list-today`, `calendar:open-settings`.

## Speaker naming

The attendee names never reach the LLM prompt. With or without a linked event, the enhance and speaker-suggestion prompts are byte-identical to `main` (tested).

A pure code step runs after the LLM suggestions, before the rows are saved (`lib/meetings/speaker-spelling.ts`, `fixNameSpelling`). For each suggested name of kind `name`:

- It compares the first name with each attendee's first name, ignoring case. Exact match wins; else a one-letter edit distance counts (first names of 4 letters or more only).
- If the suggestion has more than a first name, the rest must equal the attendee's rest.
- Exactly one candidate at the winning level: the name becomes that attendee's full name (cleaned: control characters, quotes and brackets removed, 80 characters). Two or more candidates, or none: no change.
- It never adds a name to a label with no suggestion. It never changes the evidence or the kind. It is deterministic.

The enhance result and the route answer carry `namesRespelled` (a count) when the step changed a name.

Why: council rounds r9 and r9b showed that the list in the prompt made chunks fail and moved names to wrong people. A wrong confident name is worse than no name. A lost self-introduced name is worse still.

## Privacy rules

- Never log attendee names, emails or notes. Logs carry counts and status only.
- Never put real calendar data in GitHub, commits, this spec or reports. Use counts and redacted shapes.
- The summary prompt is not changed in this work.

## Test plan

- Unit: `pickCurrentEvent`, `autoLinkCurrentEvent` (setting off runs no helper), recorder start, schema v39 migration, routes, prompt byte-identical with attendees, `fixNameSpelling` (exact, first name, typo, ambiguous, no suggestion, empty list).
- Live proof with the built `.app` started by `open` (the app is its own TCC responsible process): toggle off means no helper; toggle on means one Calendars dialog and events read (counts); link card, Change and Unlink on screen (also in pt); the speaker naming request does not hold the attendee names (fake model server) and the saved name is the attendee's spelling.

## Not proven (stated up front)

- Exchange and iCloud sources (only calDAV was tested in the spike).
- That a notarized build keeps the Calendars grant across updates.
- Auto-match on a live event, if no event runs during the proof.
