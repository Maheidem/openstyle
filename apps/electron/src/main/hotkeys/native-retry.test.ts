import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logInfo = vi.hoisted(() => vi.fn());
vi.mock("@openstyle/utils", () => ({
  createAppLogger: () => ({ info: logInfo, warn: vi.fn(), error: vi.fn() }),
  errorMessage: (err: unknown) => String(err),
}));

import { NATIVE_RETRY_INTERVAL_MS, startNativeRetry } from "./native-retry";

// A fake dictation owner: no real spawn. `attempt` plays the native
// listener start. `onRecovered` removes the fallback and restores hold mode.
function setup(results: boolean[]) {
  const mode = { fallback: true, hold: false };
  const attempt = vi.fn(async () => results.shift() ?? false);
  const cancel = startNativeRetry({
    label: "Dictation",
    attempt,
    onRecovered: () => {
      mode.fallback = false;
      mode.hold = true;
    },
  });
  return { mode, attempt, cancel };
}

describe("startNativeRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    logInfo.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("keeps the fallback and does not retry before 60 s", async () => {
    const { mode, attempt } = setup([true]);
    await vi.advanceTimersByTimeAsync(NATIVE_RETRY_INTERVAL_MS - 1);
    expect(attempt).not.toHaveBeenCalled();
    expect(mode).toEqual({ fallback: true, hold: false });
  });

  it("retries after 60 s and restores hold mode on READY with one log line", async () => {
    const { mode, attempt } = setup([true]);
    await vi.advanceTimersByTimeAsync(NATIVE_RETRY_INTERVAL_MS);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(mode).toEqual({ fallback: false, hold: true });
    expect(logInfo).toHaveBeenCalledTimes(1);

    // The retry stops after success.
    await vi.advanceTimersByTimeAsync(NATIVE_RETRY_INTERVAL_MS * 5);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(logInfo).toHaveBeenCalledTimes(1);
  });

  it("waits another 60 s after a failed retry", async () => {
    const { mode, attempt } = setup([false, true]);
    await vi.advanceTimersByTimeAsync(NATIVE_RETRY_INTERVAL_MS);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(mode).toEqual({ fallback: true, hold: false });
    expect(logInfo).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(NATIVE_RETRY_INTERVAL_MS - 1);
    expect(attempt).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(mode).toEqual({ fallback: false, hold: true });
    expect(logInfo).toHaveBeenCalledTimes(1);
  });

  it("treats a throwing attempt as a failure", async () => {
    const attempt = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("spawn failed"))
      .mockResolvedValueOnce(true);
    const onRecovered = vi.fn();
    startNativeRetry({ label: "Remix", attempt, onRecovered });
    await vi.advanceTimersByTimeAsync(NATIVE_RETRY_INTERVAL_MS);
    expect(onRecovered).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(NATIVE_RETRY_INTERVAL_MS);
    expect(onRecovered).toHaveBeenCalledTimes(1);
  });

  it("does not retry after cancel", async () => {
    const { attempt, cancel } = setup([true]);
    cancel();
    await vi.advanceTimersByTimeAsync(NATIVE_RETRY_INTERVAL_MS * 3);
    expect(attempt).not.toHaveBeenCalled();
  });

  it("drops the result of an attempt that cancel interrupts", async () => {
    const { mode, cancel } = setup([true]);
    await vi.advanceTimersByTimeAsync(NATIVE_RETRY_INTERVAL_MS - 1);
    cancel();
    await vi.advanceTimersByTimeAsync(NATIVE_RETRY_INTERVAL_MS);
    expect(mode).toEqual({ fallback: true, hold: false });
    expect(logInfo).not.toHaveBeenCalled();
  });
});
