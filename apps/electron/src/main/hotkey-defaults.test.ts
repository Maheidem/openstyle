import { describe, expect, it } from "vitest";
import { getDefaultHotkey } from "../shared/hotkey-defaults";
import {
  hotkeyFromSettings,
  hotkeyModeFromSettings,
  isValidAccelerator,
  normalizeAccelerator,
} from "./hotkey-utils";

describe("default dictation hotkey", () => {
  it("is Control+Alt on macOS and unchanged on the other platforms", () => {
    expect(getDefaultHotkey("darwin")).toBe("Control+Alt");
    expect(getDefaultHotkey("win32")).toBe("RightAlt");
    expect(getDefaultHotkey("linux")).toBe("Control+Alt+Space");
  });

  it("is a valid accelerator that normalizes to itself on macOS", () => {
    const accel = getDefaultHotkey("darwin");
    // isValidAccelerator reads process.platform only for Fn/Globe.
    expect(isValidAccelerator(accel)).toBe(true);
    expect(normalizeAccelerator(accel)).toBe(accel);
  });

  it("a fresh install has no saved hotkey, so the default and hold mode apply", () => {
    const fresh: Record<string, string> = {};
    expect(hotkeyFromSettings(fresh) ?? getDefaultHotkey("darwin")).toBe(
      "Control+Alt",
    );
    expect(hotkeyModeFromSettings(fresh)).toBe("hold");
  });

  it("a saved hotkey and a saved mode win over the default", () => {
    const saved = { hotkey: "Fn", hotkey_mode: "toggle" };
    expect(hotkeyFromSettings(saved)).toBe("Fn");
    expect(hotkeyModeFromSettings(saved)).toBe("toggle");
    expect(hotkeyFromSettings({ hotkey: "Alt+Space" })).toBe("Alt+Space");
  });
});
