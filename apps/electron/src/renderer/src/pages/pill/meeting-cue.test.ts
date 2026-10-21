import { describe, expect, it } from "vitest";
import { pillSurface } from "./meeting-cue";

describe("pillSurface", () => {
  const startedAt = 1_760_000_000_000;

  it("shows nothing when no dictation runs and no meeting records", () => {
    expect(pillSurface("idle", null)).toBeNull();
  });

  it("shows the meeting Recording state while a meeting records", () => {
    expect(pillSurface("idle", startedAt)).toBe("meeting");
  });

  it.each([
    "initializing",
    "recording",
    "transcribing",
    "error",
  ] as const)("gives the pill to a dictation in state %s, also during a meeting", (state) => {
    expect(pillSurface(state, startedAt)).toBe("dictation");
    expect(pillSurface(state, null)).toBe("dictation");
  });
});
