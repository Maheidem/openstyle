import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMeetingPillExit } from "./meeting-pill-exit";

describe("createMeetingPillExit", () => {
  let canHide: boolean;
  const hide = vi.fn();
  const make = () =>
    createMeetingPillExit({ fallbackMs: 300, canHide: () => canHide, hide });

  beforeEach(() => {
    vi.useFakeTimers();
    canHide = true;
    hide.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hides when the renderer ends the exit, not before", () => {
    const exit = make();
    exit.start();
    vi.advanceTimersByTime(120);
    expect(hide).not.toHaveBeenCalled();
    exit.done();
    expect(hide).toHaveBeenCalledTimes(1);
    // The fallback does not hide a second time.
    vi.advanceTimersByTime(1000);
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it("hides after the fallback when the renderer never answers", () => {
    const exit = make();
    exit.start();
    vi.advanceTimersByTime(299);
    expect(hide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it("ignores a late message after the fallback hid the pill", () => {
    const exit = make();
    exit.start();
    vi.advanceTimersByTime(300);
    exit.done();
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it("ignores a message when no wait runs", () => {
    make().done();
    expect(hide).not.toHaveBeenCalled();
  });

  it("does not restart the wait on a second stop status", () => {
    const exit = make();
    exit.start();
    vi.advanceTimersByTime(200);
    exit.start();
    vi.advanceTimersByTime(100);
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it("never hides while a dictation owns the pill", () => {
    const exit = make();
    exit.start();
    canHide = false;
    exit.done();
    vi.advanceTimersByTime(1000);
    expect(hide).not.toHaveBeenCalled();

    exit.start();
    vi.advanceTimersByTime(300);
    expect(hide).not.toHaveBeenCalled();
  });

  it("does not hide when a new meeting records during the wait", () => {
    const exit = make();
    exit.start();
    exit.cancel();
    exit.done();
    vi.advanceTimersByTime(1000);
    expect(hide).not.toHaveBeenCalled();
  });
});
