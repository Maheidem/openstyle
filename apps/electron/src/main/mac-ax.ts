import { setTimeout as wait } from "node:timers/promises";
import { createAppLogger } from "@openstyle/utils";
import { execAsync } from "./active-window";
import { getNativeBinaryPath } from "./native-binary";

const hotkeyLog = createAppLogger("hotkey");

// Remix document access: AX when available, keyboard fallback for canvas editors.

interface AxReadResult {
  text: string;
  selStart: number;
  selLen: number;
  settable: boolean;
}

/** Run the macos-ax binary. Returns stdout, or null if it cannot run or fails. */
async function runMacAx(
  args: string[],
  timeoutMs: number,
  maxBuffer?: number,
): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const binary = getNativeBinaryPath("macos-ax");
  if (!binary) return null;
  try {
    return await execAsync(binary, args, timeoutMs, maxBuffer);
  } catch {
    return null;
  }
}

export async function runMacAxRead(): Promise<AxReadResult | null> {
  // A large document's JSON easily exceeds execFile's 1MB default buffer.
  const out = await runMacAx(["read"], 3000, 16 * 1024 * 1024);
  if (out === null) return null;
  try {
    return JSON.parse(out) as AxReadResult;
  } catch {
    return null;
  }
}

export async function runMacAxSelect(
  start: number,
  len: number,
): Promise<boolean> {
  return (
    (await runMacAx(["select", String(start), String(len)], 3000)) !== null
  );
}

export async function runMacAxCaps(): Promise<{
  settable: boolean;
  length: number;
} | null> {
  const out = await runMacAx(["caps"], 3000);
  if (out === null) return null;
  try {
    return JSON.parse(out) as { settable: boolean; length: number };
  } catch {
    return null;
  }
}

export async function isSecureInputActive(): Promise<boolean> {
  return (await runMacAx(["secure"], 1000)) === "1";
}

export async function runMacAxKey(code: number): Promise<boolean> {
  return (await runMacAx(["key", String(code)], 3000)) !== null;
}

/** Cmd+A via CGEvent binary (same AX permission as paste); osascript fallback. */
export async function sendSelectAllToFocusedApp(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const binary = getNativeBinaryPath("macos-fast-paste");
  if (binary) {
    try {
      await execAsync(binary, ["a"], 3000);
      return true;
    } catch (err) {
      hotkeyLog.warn(`Native select-all failed, trying osascript: ${err}`);
    }
  }
  return runKeystrokeScript(['keystroke "a" using {command down}']);
}

export async function sendChordToFocusedApp(
  letter: string,
  shift: boolean,
): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const binary = getNativeBinaryPath("macos-fast-paste");
  if (binary) {
    try {
      await execAsync(binary, shift ? [letter, "shift"] : [letter], 3000);
      return true;
    } catch (err) {
      hotkeyLog.warn(`Native chord ${letter} failed, trying osascript: ${err}`);
    }
  }
  return runKeystrokeScript([
    `keystroke "${letter}" using {command down${shift ? ", shift down" : ""}}`,
  ]);
}

export async function runKeystrokeScript(lines: string[]): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const script = [
    'tell application "System Events"',
    ...lines,
    "end tell",
  ].flatMap((line) => ["-e", line]);
  try {
    await execAsync("osascript", script, 8000);
    return true;
  } catch (err) {
    hotkeyLog.warn(`Keystroke script failed: ${err}`);
    return false;
  }
}

/** Bring the anchored app frontmost (macOS); settle before re-check. */
export async function activateAnchorApp(appName: string): Promise<void> {
  if (process.platform !== "darwin") return;
  try {
    await execAsync(
      "osascript",
      ["-e", `tell application ${JSON.stringify(appName)} to activate`],
      2000,
    );
    await wait(150);
  } catch (err) {
    hotkeyLog.warn(`Could not re-activate "${appName}": ${err}`);
  }
}
