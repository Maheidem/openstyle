// The dictation guard of the Ask bubble hotkey (specs/meeting-chat-agent.md
// 11.6.2). A fake clock drives the 150 ms window. No electron, no native key.
import { describe, expect, it, vi } from "vitest";
import { chatHotkeyFromSettings, isChordPrefix } from "../hotkey-utils";
import { CHAT_CHORD_GUARD_MS, DictationStartGuard } from "./chat-guard";

const DICTATION = "Control+Alt";
const CHAT = "Control+Alt+K";

function setup(dictating = () => false) {
  vi.useFakeTimers();
  const guard = new DictationStartGuard({ isDictating: dictating });
  guard.setChatAccel(CHAT);
  const start = vi.fn();
  return { guard, start };
}

describe("DictationStartGuard", () => {
  it("path 1: K inside the window opens the bubble and starts no dictation", () => {
    const { guard, start } = setup();
    guard.press(DICTATION, start);
    expect(start).not.toHaveBeenCalled();
    expect(guard.waiting).toBe(true);
    vi.advanceTimersByTime(CHAT_CHORD_GUARD_MS - 50);
    expect(guard.chatKeyDown()).toBe(true);
    expect(guard.waiting).toBe(false);
    // The window would have ended here. The cancelled start never runs.
    vi.advanceTimersByTime(1000);
    expect(start).not.toHaveBeenCalled();
    // The release of Control+Option after the bubble opened starts nothing.
    guard.release();
    expect(start).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("path 2: with no K in 150 ms, dictation starts once", () => {
    const { guard, start } = setup();
    guard.press(DICTATION, start);
    vi.advanceTimersByTime(CHAT_CHORD_GUARD_MS - 1);
    expect(start).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(guard.waiting).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(start).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("K after the window, while the dictation runs, is ignored", () => {
    const dictating = { value: false };
    const { guard, start } = setup(() => dictating.value);
    guard.press(DICTATION, () => {
      dictating.value = true;
      start();
    });
    vi.advanceTimersByTime(CHAT_CHORD_GUARD_MS);
    expect(start).toHaveBeenCalledTimes(1);
    expect(guard.chatKeyDown()).toBe(false);
    vi.useRealTimers();
  });

  it("a release inside the window starts the dictation at once (a short tap)", () => {
    const { guard, start } = setup();
    guard.press(DICTATION, start);
    vi.advanceTimersByTime(40);
    guard.release();
    expect(start).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(start).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("the chat key with no waiting dictation opens the bubble", () => {
    const { guard } = setup();
    expect(guard.chatKeyDown()).toBe(true);
    vi.useRealTimers();
  });

  it("the chat hotkey off: dictation starts at once, with no wait", () => {
    vi.useFakeTimers();
    const guard = new DictationStartGuard({ isDictating: () => false });
    const start = vi.fn();
    guard.press(DICTATION, start);
    expect(start).toHaveBeenCalledTimes(1);
    expect(guard.waiting).toBe(false);
    vi.useRealTimers();
  });

  it("a dictation hotkey that is not a prefix of the chat hotkey starts at once", () => {
    const { guard, start } = setup();
    guard.press("Control+Shift", start);
    expect(start).toHaveBeenCalledTimes(1);
    const other = vi.fn();
    guard.press("Command+Shift", other);
    expect(other).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("turning the chat hotkey off while a start waits runs the start", () => {
    const { guard, start } = setup();
    guard.press(DICTATION, start);
    guard.setChatAccel(null);
    expect(start).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("cancel drops a waiting start", () => {
    const { guard, start } = setup();
    guard.press(DICTATION, start);
    guard.cancel();
    vi.advanceTimersByTime(1000);
    expect(start).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("a second press while one waits does not lose the first", () => {
    const { guard, start } = setup();
    const second = vi.fn();
    guard.press(DICTATION, start);
    guard.press(DICTATION, second);
    expect(start).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(CHAT_CHORD_GUARD_MS);
    expect(second).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe("isChordPrefix", () => {
  it("Control+Alt is a prefix of Control+Alt+K", () => {
    expect(isChordPrefix("Control+Alt", "Control+Alt+K")).toBe(true);
    expect(isChordPrefix("Control+Option", "Control+Alt+K")).toBe(true);
    expect(isChordPrefix("Alt", "Control+Alt+K")).toBe(true);
  });

  it("is false when a modifier is missing in the chat hotkey, or a key is involved", () => {
    expect(isChordPrefix("Control+Alt", "Control+Shift+K")).toBe(false);
    expect(isChordPrefix("Control+Alt+Space", "Control+Alt+K")).toBe(false);
    expect(isChordPrefix("Control+Alt", "Control+Alt")).toBe(false);
    expect(isChordPrefix("MouseButton4", "Control+Alt+K")).toBe(false);
    expect(isChordPrefix("Fn", "Control+Alt+K")).toBe(false);
  });
});

describe("chatHotkeyFromSettings", () => {
  const on = { meeting_chat_enabled: "true" };

  it("is off while the switch is off or missing", () => {
    expect(chatHotkeyFromSettings({}, "darwin")).toBeNull();
    expect(
      chatHotkeyFromSettings({ meeting_chat_enabled: "false" }, "darwin"),
    ).toBeNull();
  });

  it("is Control+Alt+K by default on macOS when the switch is on", () => {
    expect(chatHotkeyFromSettings(on, "darwin")).toBe("Control+Alt+K");
    expect(chatHotkeyFromSettings({ ...on, chat_hotkey: "" }, "darwin")).toBe(
      "Control+Alt+K",
    );
  });

  it("takes the saved hotkey, normalized", () => {
    expect(
      chatHotkeyFromSettings({ ...on, chat_hotkey: "ctrl+option+J" }, "darwin"),
    ).toBe("Control+Alt+J");
  });

  it("refuses a chord with no key and a bad value", () => {
    expect(
      chatHotkeyFromSettings({ ...on, chat_hotkey: "Control+Alt" }, "darwin"),
    ).toBeNull();
    expect(
      chatHotkeyFromSettings({ ...on, chat_hotkey: "K" }, "darwin"),
    ).toBeNull();
  });
});
