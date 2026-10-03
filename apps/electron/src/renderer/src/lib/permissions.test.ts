import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { pollUntil } from "./permissions";

describe("pollUntil", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls onDone once when the check passes, then stops polling", async () => {
    const check = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const onDone = vi.fn();
    pollUntil(check, onDone);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onDone).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onDone).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(check).toHaveBeenCalledTimes(2);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("stops after the 30 s timeout", async () => {
    const check = vi.fn().mockResolvedValue(false);
    const onDone = vi.fn();
    pollUntil(check, onDone);
    await vi.advanceTimersByTimeAsync(60000);
    expect(check).toHaveBeenCalledTimes(30);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("clears both timers on cancel", async () => {
    const check = vi.fn().mockResolvedValue(true);
    const onDone = vi.fn();
    const cancel = pollUntil(check, onDone);
    cancel();
    await vi.advanceTimersByTimeAsync(60000);
    expect(check).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats a throwing check as not granted", async () => {
    const check = vi
      .fn()
      .mockRejectedValueOnce(new Error("ipc"))
      .mockResolvedValue(true);
    const onDone = vi.fn();
    pollUntil(check, onDone);
    await vi.advanceTimersByTimeAsync(2000);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
