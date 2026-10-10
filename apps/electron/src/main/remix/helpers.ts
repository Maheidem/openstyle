/**
 * Remix helpers. The module reads state from main-state only.
 * It holds the clipboard preview, key checks and anchor focus logic.
 */
import { setTimeout as wait } from "node:timers/promises";
import { createAppLogger } from "@openstyle/utils";
import { clipboard, nativeImage } from "electron";
import { REMIX_CLIPBOARD_PREVIEW_LIMIT } from "../../shared/remix";
import {
  getFrontmostContext,
  getOpenstyleAppExclusions,
} from "../active-window";
import { activateAnchorApp, isSecureInputActive } from "../mac-ax";
import { state } from "../main-state";
import { isRemixTargetAllowed } from "../remix-target";

const hotkeyLog = createAppLogger("hotkey");

/** Clipboard preview after selection capture restores what Copy borrowed. */
export function clipboardPreviewFields(): {
  clipboard: string | null;
  clipboardLength: number;
} {
  const text = clipboard.readText();
  return {
    clipboard: text ? text.slice(0, REMIX_CLIPBOARD_PREVIEW_LIMIT) : null,
    clipboardLength: text.length,
  };
}

const REMIX_ANCHOR_MAX_AGE_MS = 5 * 60 * 1000;

/** Whitelist of bare keycodes press_key may inject (no modifier chords). */
export const REMIX_PRESSABLE_KEYS: Record<string, number> = {
  enter: 36,
  tab: 48,
  escape: 53,
  backspace: 51,
  delete: 117,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  home: 115,
  end: 119,
};

/**
 * Run `fn` when the document can take injected input. Otherwise, report that
 * the document is not in front.
 */
export async function withFocusedAnchor<T>(
  fn: () => Promise<T>,
): Promise<T | { ok: false; reason: "document-not-in-front" }> {
  if (!(await focusAnchorForInjection())) {
    return { ok: false, reason: "document-not-in-front" };
  }
  return fn();
}

/** Yield key focus to the document before injecting; false if it can't. */
async function focusAnchorForInjection(): Promise<boolean> {
  const anchor = state.remixAnchor;
  if (
    !anchor?.appName ||
    Date.now() - anchor.capturedAt > REMIX_ANCHOR_MAX_AGE_MS
  ) {
    return false;
  }
  if (await isSecureInputActive()) {
    hotkeyLog.warn("Remix injection refused: secure input is active.");
    return false;
  }
  const pill = state.mainWindow;
  if (pill && !pill.isDestroyed() && pill.isFocused()) {
    pill.blur();
    await wait(140);
  }
  let front = await getFrontmostContext();
  const ours = getOpenstyleAppExclusions();
  // Practice mode: don't osascript-activate Openstyle (we're already there).
  if (
    front.appName &&
    !isRemixTargetAllowed(front.appName, ours, state.remixPracticeTarget)
  ) {
    await activateAnchorApp(anchor.appName);
    front = await getFrontmostContext();
  }
  return front.appName === anchor.appName;
}

const REMIX_IMAGE_MAX_BYTES = 15 * 1024 * 1024;
const REMIX_IMAGE_TIMEOUT_MS = 15_000;

export async function fetchRemixImage(
  url: string,
): Promise<Electron.NativeImage | null> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    const res = await fetch(url, {
      signal: AbortSignal.timeout(REMIX_IMAGE_TIMEOUT_MS),
      redirect: "follow",
    });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength === 0 || buffer.byteLength > REMIX_IMAGE_MAX_BYTES) {
      return null;
    }
    const image = nativeImage.createFromBuffer(buffer);
    return image.isEmpty() ? null : image;
  } catch (err) {
    hotkeyLog.warn(`Remix image fetch failed: ${err}`);
    return null;
  }
}
