import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import { stableSwitchDialogKeys } from "./update-dialogs";

function lookup(key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      en,
    );
}

describe("stableSwitchDialogKeys", () => {
  it("says that the switch stops the recording while a meeting records", () => {
    const keys = stableSwitchDialogKeys(true);
    expect(lookup(keys.desc)).toBe(
      "A meeting is recording. Switch to Stable now? This stops the recording.",
    );
    expect(lookup(keys.action)).toBe("Stop recording and switch");
  });

  it("keeps the normal text when no meeting records", () => {
    const keys = stableSwitchDialogKeys(false);
    expect(lookup(keys.desc)).toMatch(/^Openstyle installs the current Stable/);
    expect(lookup(keys.action)).toBe("Install Stable");
  });
});
