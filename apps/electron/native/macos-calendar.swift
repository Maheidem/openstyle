/**
 * macOS Calendar helper (EventKit, read only)
 *
 * Reads calendar events so Openstyle can link a meeting to the event that
 * runs now (specs/calendar-eventkit.md). The app starts this binary only when
 * the user turned on "Use my calendar".
 *
 * Usage:
 *   macos-calendar status
 *     Prints {"status": "..."}. Never shows a dialog.
 *   macos-calendar request
 *     Shows the macOS Calendars dialog when the status is notDetermined.
 *     Prints {"status": "..."}.
 *   macos-calendar events --from <ISO8601> --to <ISO8601>
 *     Prints {"status": "...", "events": [...]}. The list is empty unless
 *     the status is fullAccess.
 *
 * Status values: notDetermined, restricted, denied, fullAccess, writeOnly.
 *
 * Event fields: id (calendarItemExternalIdentifier), title, start, end
 * (ISO 8601), isAllDay, meetingUrl, meetingPlatform, attendees
 * [{name, email, isOrganizer}]. The notes text is used only to find the
 * meeting link. It is never printed.
 *
 * Meeting link patterns (first match wins; notes, then url, then location):
 *   meet.google.com, teams.microsoft.com/l/meetup-join, zoom.us/j, webex.com
 *
 * Exit codes:
 *   0 - success, for every authorization state
 *   1 - bad arguments or crash
 */

import EventKit
import Foundation

let store = EKEventStore()

func statusName(_ s: EKAuthorizationStatus) -> String {
    switch s {
    case .notDetermined: return "notDetermined"
    case .restricted: return "restricted"
    case .denied: return "denied"
    case .fullAccess: return "fullAccess"
    case .writeOnly: return "writeOnly"
    @unknown default: return "denied"
    }
}

func currentStatus() -> String {
    return statusName(EKEventStore.authorizationStatus(for: .event))
}

func printJSON(_ obj: Any) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
        let text = String(data: data, encoding: .utf8)
    else {
        FileHandle.standardError.write(Data("json encode failed\n".utf8))
        exit(1)
    }
    print(text)
}

let platforms: [(host: String, name: String)] = [
    ("meet.google.com", "meet"),
    ("teams.microsoft.com/l/meetup-join", "teams"),
    ("zoom.us/j", "zoom"),
    ("webex.com", "webex"),
]

let urlRegex = try! NSRegularExpression(pattern: "https?://[^\\s<>\"')\\]]+", options: [])

/// First meeting link in `text`, with its platform name.
func findMeetingLink(in text: String?) -> (url: String, platform: String)? {
    guard let text = text, !text.isEmpty else { return nil }
    let range = NSRange(text.startIndex..., in: text)
    for m in urlRegex.matches(in: text, options: [], range: range) {
        guard let r = Range(m.range, in: text) else { continue }
        let candidate = String(text[r])
        let lower = candidate.lowercased()
        for p in platforms where lower.contains(p.host) {
            return (candidate, p.name)
        }
    }
    return nil
}

func emailOf(_ p: EKParticipant) -> String {
    let url = p.url
    if url.scheme?.lowercased() == "mailto" {
        return url.absoluteString.dropFirst("mailto:".count).trimmingCharacters(in: .whitespaces)
    }
    return ""
}

func attendeeList(_ ev: EKEvent) -> [[String: Any]] {
    var out: [[String: Any]] = []
    var seen = Set<String>()
    func add(_ p: EKParticipant, isOrganizer: Bool) {
        let email = emailOf(p)
        let name = p.name ?? ""
        let key = email.isEmpty ? "n:" + name.lowercased() : "e:" + email.lowercased()
        if seen.contains(key) {
            // Mark the organizer flag on an entry already added.
            if isOrganizer, let i = out.firstIndex(where: { ($0["_key"] as? String) == key }) {
                out[i]["isOrganizer"] = true
            }
            return
        }
        seen.insert(key)
        out.append(["name": name, "email": email, "isOrganizer": isOrganizer, "_key": key])
    }
    if let org = ev.organizer { add(org, isOrganizer: true) }
    for a in ev.attendees ?? [] { add(a, isOrganizer: false) }
    return out.map { var d = $0; d.removeValue(forKey: "_key"); return d }
}

func eventObject(_ ev: EKEvent, iso: ISO8601DateFormatter) -> [String: Any] {
    var link = findMeetingLink(in: ev.notes)
    if link == nil, let u = ev.url?.absoluteString { link = findMeetingLink(in: u) }
    if link == nil { link = findMeetingLink(in: ev.location) }
    var obj: [String: Any] = [
        "id": ev.calendarItemExternalIdentifier ?? "",
        "title": ev.title ?? "",
        "start": iso.string(from: ev.startDate),
        "end": iso.string(from: ev.endDate),
        "isAllDay": ev.isAllDay,
        "attendees": attendeeList(ev),
    ]
    if let l = link {
        obj["meetingUrl"] = l.url
        obj["meetingPlatform"] = l.platform
    }
    return obj
}

func argValue(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

func parseDate(_ s: String?) -> Date? {
    guard let s = s else { return nil }
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: s) { return d }
    f.formatOptions = [.withInternetDateTime]
    return f.date(from: s)
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write(Data("usage: macos-calendar status|request|events\n".utf8))
    exit(1)
}

switch args[1] {
case "status":
    printJSON(["status": currentStatus()])
case "request":
    if EKEventStore.authorizationStatus(for: .event) == .notDetermined {
        let sem = DispatchSemaphore(value: 0)
        store.requestFullAccessToEvents { _, _ in sem.signal() }
        sem.wait()
    }
    printJSON(["status": currentStatus()])
case "events":
    guard let from = parseDate(argValue("--from")), let to = parseDate(argValue("--to")) else {
        FileHandle.standardError.write(Data("events needs --from and --to (ISO 8601)\n".utf8))
        exit(1)
    }
    let status = currentStatus()
    var events: [[String: Any]] = []
    if status == "fullAccess" {
        let iso = ISO8601DateFormatter()
        let predicate = store.predicateForEvents(withStart: from, end: to, calendars: nil)
        events = store.events(matching: predicate).map { eventObject($0, iso: iso) }
    }
    printJSON(["status": status, "events": events])
default:
    FileHandle.standardError.write(Data("unknown command\n".utf8))
    exit(1)
}
