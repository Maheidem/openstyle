/**
 * Mic permission resolution that works on every platform.
 *
 * macOS and Windows report a real status from the OS privacy settings via
 * the main process. Linux has no such API, so the main process returns
 * "unknown" and we resolve the real state by briefly opening a capture
 * stream.
 */

async function probeMicAccess(): Promise<"granted" | "denied"> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return "granted";
  } catch {
    return "denied";
  }
}

export async function resolveMicStatus(): Promise<string> {
  const status = (await window.api?.checkMicPermission()) ?? "unknown";
  return status === "unknown" ? probeMicAccess() : status;
}

export async function requestMicAccess(): Promise<string> {
  const status = (await window.api?.requestMicPermission()) ?? "unknown";
  return status === "unknown" ? probeMicAccess() : status;
}

/**
 * Call `check` every `intervalMs` until it returns true, then call `onDone`
 * once. Stop after `timeoutMs` if it never does. Use it after the user opens
 * an OS privacy pane: the grant happens outside the app.
 *
 * Returns a cancel function. Cancel clears both timers. A check that is
 * still running when you cancel cannot call `onDone`.
 */
export function pollUntil(
  check: () => Promise<boolean>,
  onDone: () => void,
  opts: { intervalMs: number; timeoutMs: number } = {
    intervalMs: 1000,
    timeoutMs: 30000,
  },
): () => void {
  let cancelled = false;
  const interval = setInterval(async () => {
    let ok = false;
    try {
      ok = await check();
    } catch {}
    if (!ok || cancelled) return;
    cancel();
    onDone();
  }, opts.intervalMs);
  const timeout = setTimeout(() => cancel(), opts.timeoutMs);
  function cancel() {
    cancelled = true;
    clearInterval(interval);
    clearTimeout(timeout);
  }
  return cancel;
}
