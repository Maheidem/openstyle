import { describe, expect, it } from "vitest";
import { nextMeetingCue, pillSurface } from "./meeting-cue";

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

describe("nextMeetingCue", () => {
  const startedAt = 1_760_000_000_000;
  const none = { startedAt: null, leaving: false };
  const live = { startedAt, leaving: false };

  it("shows a meeting that starts to record", () => {
    expect(nextMeetingCue(none, "recording", startedAt)).toEqual(live);
  });

  it("keeps the start time and plays the exit after a stop", () => {
    expect(nextMeetingCue(live, "finalizing", null)).toEqual({
      startedAt,
      leaving: true,
    });
  });

  it("does not restart the exit on a second stop status", () => {
    const leaving = nextMeetingCue(live, "finalizing", null);
    expect(nextMeetingCue(leaving, "idle", null)).toBe(leaving);
  });

  it("shows nothing for a stop when no meeting showed", () => {
    expect(nextMeetingCue(none, "idle", null)).toBe(none);
  });

  it("stops the exit when a new meeting records", () => {
    const leaving = nextMeetingCue(live, "finalizing", null);
    expect(nextMeetingCue(leaving, "recording", startedAt + 5)).toEqual({
      startedAt: startedAt + 5,
      leaving: false,
    });
  });
});
