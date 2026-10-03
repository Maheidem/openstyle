import { execFile } from "node:child_process";
import { app, screen } from "electron";
import type { OpenAppCandidate } from "../shared/open-apps";
import { isWaylandSession } from "./linux-session";

// -- Async helper: run a command without blocking the main thread --
export function execAsync(
  cmd: string,
  args: string[],
  timeoutMs: number,
  maxBuffer?: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        encoding: "utf-8",
        timeout: timeoutMs,
        ...(maxBuffer ? { maxBuffer } : {}),
      },
      (err, stdout) => {
        if (err) reject(err);
        else resolve((stdout as string).trim());
      },
    );
  });
}

export function getOpenstyleAppExclusions(): Set<string> {
  return new Set(
    // "Freestyle" is the old app name. A user upgrading from the old build may
    // still have it installed or a stale window open, and it must keep being
    // excluded from remix targeting.
    [app.name, "Freestyle", "Electron"]
      .map((name) => name?.trim().toLowerCase())
      .filter((name): name is string => Boolean(name)),
  );
}

function normalizeOpenAppCandidates(
  rawLabels: readonly string[],
): OpenAppCandidate[] {
  const exclusions = getOpenstyleAppExclusions();
  const deduped = new Map<string, OpenAppCandidate>();

  for (const rawLabel of rawLabels) {
    const label = rawLabel.replace(/\s+/g, " ").trim();
    if (!label) continue;

    const match = label.toLowerCase();
    if (exclusions.has(match)) continue;

    if (!deduped.has(match)) {
      deduped.set(match, { label, match });
    }
  }

  return [...deduped.values()].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
  );
}

function parseContextAppLabel(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { app?: string };
    return parsed.app ? [parsed.app] : [];
  } catch {
    return [raw];
  }
}

// -- macOS: Get frontmost app + browser tab context via AppleScript --
export async function getMacFrontmostApp(): Promise<string | null> {
  try {
    const appName = await execAsync(
      "osascript",
      [
        "-e",
        'tell application "System Events" to get name of first application process whose frontmost is true',
      ],
      2000,
    );

    const chromiumBrowsers = [
      "Google Chrome",
      "Arc",
      "Brave Browser",
      "Microsoft Edge",
    ];

    try {
      if (appName === "Safari") {
        const result = await execAsync(
          "osascript",
          [
            "-e",
            'tell application "Safari" to return {URL of current tab of front window, name of current tab of front window}',
          ],
          2000,
        );
        const idx = result.indexOf(", ");
        if (idx > 0) {
          return JSON.stringify({
            app: appName,
            url: result.substring(0, idx),
            title: result.substring(idx + 2),
          });
        }
      } else if (appName === "Firefox") {
        const title = await execAsync(
          "osascript",
          [
            "-e",
            'tell application "System Events" to get name of front window of application process "Firefox"',
          ],
          2000,
        );
        return JSON.stringify({ app: appName, windowTitle: title });
      } else if (chromiumBrowsers.includes(appName)) {
        const result = await execAsync(
          "osascript",
          [
            "-e",
            `tell application "${appName}" to return {URL of active tab of front window, title of active tab of front window}`,
          ],
          2000,
        );
        const idx = result.indexOf(", ");
        if (idx > 0) {
          return JSON.stringify({
            app: appName,
            url: result.substring(0, idx),
            title: result.substring(idx + 2),
          });
        }
      }
    } catch {
      // Browser tab access failed — fall back to app name only
    }

    return JSON.stringify({ app: appName });
  } catch {
    return null;
  }
}

async function getMacOpenAppCandidates(): Promise<OpenAppCandidate[]> {
  try {
    const result = await execAsync(
      "osascript",
      [
        "-e",
        'tell application "System Events" to get name of every application process whose background only is false and visible is true',
      ],
      2000,
    );

    return normalizeOpenAppCandidates(result.split(","));
  } catch {
    return [];
  }
}

// -- Windows: Get foreground window process name + title via PowerShell --
export async function getWindowsFrontmostApp(): Promise<string | null> {
  try {
    const script = `
      Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        using System.Text;
        public class Win32 {
          [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
          [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
          [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
        }
"@
      $hwnd = [Win32]::GetForegroundWindow()
      $sb = New-Object System.Text.StringBuilder 256
      [Win32]::GetWindowText($hwnd, $sb, 256) | Out-Null
      $title = $sb.ToString()
      $pid = 0
      [Win32]::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null
      $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
      "$($proc.ProcessName)|$title"
    `;
    const result = await execAsync(
      "powershell",
      ["-NoProfile", "-Command", script],
      3000,
    );

    const pipeIdx = result.indexOf("|");
    if (pipeIdx > 0) {
      const processName = result.substring(0, pipeIdx);
      const windowTitle = result.substring(pipeIdx + 1);
      return JSON.stringify({ app: processName, windowTitle });
    }
    return JSON.stringify({ app: result });
  } catch {
    return null;
  }
}

async function getWindowsOpenAppCandidates(): Promise<OpenAppCandidate[]> {
  try {
    const script = `
      $apps = Get-Process |
        Where-Object { $_.MainWindowTitle -and $_.ProcessName } |
        Select-Object -Property ProcessName |
        Sort-Object ProcessName -Unique |
        ConvertTo-Json -Compress
      $apps
    `;
    const result = await execAsync(
      "powershell",
      ["-NoProfile", "-Command", script],
      3000,
    );

    const parsed = JSON.parse(result) as
      | { ProcessName?: string }
      | Array<{ ProcessName?: string }>;
    const apps = Array.isArray(parsed) ? parsed : [parsed];

    return normalizeOpenAppCandidates(
      apps
        .map((entry) => entry.ProcessName?.trim())
        .filter((entry): entry is string => Boolean(entry)),
    );
  } catch {
    return [];
  }
}

// -- Linux: Get active window name + title (Wayland compositors + X11) --
export async function getLinuxFrontmostApp(): Promise<string | null> {
  if (isWaylandSession()) {
    return (
      (await getSwayFrontmostApp()) ??
      (await getGnomeFrontmostApp()) ??
      (await getLinuxX11FrontmostApp())
    );
  }
  return getLinuxX11FrontmostApp();
}

interface SwayNode {
  focused?: boolean;
  name?: string;
  app_id?: string | null;
  window_properties?: { class?: string };
  nodes?: SwayNode[];
  floating_nodes?: SwayNode[];
}

function findFocusedSwayNode(node: SwayNode): SwayNode | null {
  if (node.focused) return node;
  for (const child of [...(node.nodes ?? []), ...(node.floating_nodes ?? [])]) {
    const hit = findFocusedSwayNode(child);
    if (hit) return hit;
  }
  return null;
}

async function getSwayFrontmostApp(): Promise<string | null> {
  try {
    const output = await execAsync("swaymsg", ["-t", "get_tree"], 2000);
    const focused = findFocusedSwayNode(JSON.parse(output) as SwayNode);
    if (!focused) return null;
    return JSON.stringify({
      app: focused.app_id ?? focused.window_properties?.class ?? "Unknown",
      windowTitle: focused.name ?? "",
    });
  } catch {
    return null;
  }
}

async function getGnomeFrontmostApp(): Promise<string | null> {
  try {
    const output = await execAsync(
      "gdbus",
      [
        "call",
        "--session",
        "--dest",
        "org.gnome.Shell",
        "--object-path",
        "/org/gnome/Shell/Introspect",
        "--method",
        "org.gnome.Shell.Introspect.GetWindows",
      ],
      2000,
    );
    for (const win of output.split(/uint64 \d+:/).slice(1)) {
      if (!/'has-focus':\s*<true>/.test(win)) continue;
      const app =
        /'wm-class':\s*<'((?:[^'\\]|\\.)*)'>/.exec(win)?.[1] ?? "Unknown";
      const title = /'title':\s*<'((?:[^'\\]|\\.)*)'>/.exec(win)?.[1] ?? "";
      return JSON.stringify({ app, windowTitle: title });
    }
    return null;
  } catch {
    return null;
  }
}

async function getLinuxX11FrontmostApp(): Promise<string | null> {
  try {
    const windowTitle = await execAsync(
      "xdotool",
      ["getactivewindow", "getwindowname"],
      2000,
    );

    let processName = "";
    try {
      const pid = await execAsync(
        "xdotool",
        ["getactivewindow", "getwindowpid"],
        2000,
      );
      processName = await execAsync("cat", [`/proc/${pid}/comm`], 1000);
    } catch {
      // some windows don't expose PID
    }

    return JSON.stringify({
      app: processName || "Unknown",
      windowTitle,
    });
  } catch {
    return null;
  }
}

async function getLinuxOpenAppCandidates(): Promise<OpenAppCandidate[]> {
  try {
    const result = await execAsync("wmctrl", ["-lx"], 2000);
    const labels = result
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(/\s+/);
        const wmClass = parts[3] ?? "";
        return wmClass.split(".").at(-1)?.replace(/[_-]+/g, " ") ?? "";
      });

    const candidates = normalizeOpenAppCandidates(labels);
    if (candidates.length > 0) return candidates;
  } catch {
    // Fall back to the current app only when a visible window list is unavailable.
  }

  return normalizeOpenAppCandidates(
    parseContextAppLabel(await getLinuxFrontmostApp()),
  );
}

export async function getOpenAppCandidates(): Promise<OpenAppCandidate[]> {
  if (process.platform === "darwin") {
    return getMacOpenAppCandidates();
  }
  if (process.platform === "win32") {
    return getWindowsOpenAppCandidates();
  }
  if (process.platform === "linux") {
    return getLinuxOpenAppCandidates();
  }
  return [];
}

/**
 * Screen bounds (top-left origin, in screen coordinates) of the currently
 * focused *external* application window, or null if it can't be determined.
 *
 * Used to anchor the pill to the display the user is actually typing on, which
 * the cursor's display alone can't tell us: a keyboard-driven user often leaves
 * the mouse resting on a different monitor. This is intentionally async/native
 * (AppleScript / PowerShell), so it is never awaited on the pill-show hot path —
 * the pill shows immediately on the cursor's display and re-anchors here if this
 * resolves to a different one.
 */
async function getFocusedWindowBounds(): Promise<{
  x: number;
  y: number;
  width: number;
  height: number;
} | null> {
  try {
    if (process.platform === "darwin") {
      // `position`/`size` of the frontmost app's front window via Accessibility.
      const out = await execAsync(
        "osascript",
        [
          "-e",
          'tell application "System Events" to tell (first application process whose frontmost is true) to get {position, size} of front window',
        ],
        1500,
      );
      // osascript returns e.g. "12, -340, 800, 600" (x, y, w, h).
      const nums = out
        .split(",")
        .map((n) => Number.parseInt(n.trim(), 10))
        .filter((n) => Number.isFinite(n));
      if (nums.length < 4) return null;
      const [x, y, width, height] = nums;
      if (width <= 0 || height <= 0) return null;
      return { x, y, width, height };
    }

    if (process.platform === "win32") {
      const script = `
        Add-Type @"
          using System;
          using System.Runtime.InteropServices;
          public class Win32Rect {
            [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
            [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
            [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
          }
"@
        $hwnd = [Win32Rect]::GetForegroundWindow()
        $r = New-Object Win32Rect+RECT
        [Win32Rect]::GetWindowRect($hwnd, [ref]$r) | Out-Null
        "$($r.Left),$($r.Top),$($r.Right),$($r.Bottom)"
      `;
      const out = await execAsync(
        "powershell",
        ["-NoProfile", "-Command", script],
        2000,
      );
      const nums = out
        .split(",")
        .map((n) => Number.parseInt(n.trim(), 10))
        .filter((n) => Number.isFinite(n));
      if (nums.length < 4) return null;
      const [left, top, right, bottom] = nums;
      const width = right - left;
      const height = bottom - top;
      if (width <= 0 || height <= 0) return null;
      return { x: left, y: top, width, height };
    }

    // Linux compositors vary too much for a reliable synchronous rect; the
    // cursor's display is used as-is there.
    return null;
  } catch {
    return null;
  }
}

/**
 * The Electron display the focused external window is on, or null if it can't
 * be determined. Falls back to the cursor's display at call sites.
 */
export async function getFocusedWindowDisplay(): Promise<Electron.Display | null> {
  const bounds = await getFocusedWindowBounds();
  if (!bounds) return null;
  return screen.getDisplayMatching(bounds);
}

export interface FrontmostContext {
  appName: string | null;
  windowTitle: string | null;
  url: string | null;
}

export async function getFrontmostContext(): Promise<FrontmostContext> {
  try {
    let raw: string | null = null;
    if (process.platform === "darwin") raw = await getMacFrontmostApp();
    else if (process.platform === "win32") raw = await getWindowsFrontmostApp();
    else if (process.platform === "linux") raw = await getLinuxFrontmostApp();
    if (!raw) return { appName: null, windowTitle: null, url: null };
    try {
      const parsed = JSON.parse(raw) as {
        app?: string;
        windowTitle?: string;
        title?: string;
        url?: string;
      };
      return {
        appName: parsed.app?.trim() || null,
        windowTitle: parsed.windowTitle?.trim() || parsed.title?.trim() || null,
        url: parsed.url?.trim() || null,
      };
    } catch {
      return { appName: raw.trim() || null, windowTitle: null, url: null };
    }
  } catch {
    return { appName: null, windowTitle: null, url: null };
  }
}
