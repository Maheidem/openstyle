/**
 * macOS click watcher for the tray popover.
 *
 * The popover is a panel that never takes focus, so it gets no blur event
 * when the user clicks in another place. The main process starts this helper
 * while the popover is open. The helper prints one line for each mouse-down
 * in any app: "DOWN <x> <y>", in Electron screen points (origin at the top
 * left of the primary display). The main process closes the popover when the
 * point is outside it.
 *
 * A global monitor of mouse events needs no Privacy permission. Only key
 * events need Accessibility. The helper exits when stdin closes, so it stops
 * with the main process.
 *
 * Output: "READY" once, then "DOWN <x> <y>" lines. "ERROR <text>" and exit 1
 * when the monitor cannot start.
 */

import Cocoa

setvbuf(stdout, nil, _IOLBF, 0)

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

let mask: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .otherMouseDown]
let monitor = NSEvent.addGlobalMonitorForEvents(matching: mask) { _ in
    // Cocoa points start at the bottom left of the primary screen.
    let point = NSEvent.mouseLocation
    let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
    print("DOWN \(Int(point.x.rounded())) \(Int((primaryHeight - point.y).rounded()))")
}

if monitor == nil {
    print("ERROR global mouse monitor did not start")
    exit(1)
}

// Stop when the parent closes stdin (the parent quit or stopped the helper).
DispatchQueue.global(qos: .utility).async {
    while readLine() != nil {}
    exit(0)
}

print("READY")
app.run()
