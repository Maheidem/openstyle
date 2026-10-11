/**
 * Unit tests for the dictation-priority lease (`waitForDictationIdle`).
 * The abort option lets a caller (the meeting align pass on cancel) end
 * the wait while dictation is still active.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetDictationIdleStateForTests,
  waitForDictationIdle,
} from "../src/lib/dictation-activity.js";

beforeEach(() => {
  __resetDictationIdleStateForTests();
});

describe("waitForDictationIdle — shouldAbort", () => {
  it("ends the wait at once and returns true while dictation stays active", async () => {
    let polls = 0;
    let abort = false;
    const aborted = await waitForDictationIdle({
      isDictationActive: () => true,
      pollMs: 1,
      sleep: async () => {
        polls++;
        if (polls >= 2) abort = true;
      },
      shouldAbort: () => abort,
    });
    expect(aborted).toBe(true);
    expect(polls).toBe(2);
  });

  it("returns false when the lease is free and shouldAbort stays false", async () => {
    const aborted = await waitForDictationIdle({
      isDictationActive: () => false,
      shouldAbort: () => false,
    });
    expect(aborted).toBe(false);
  });

  it("returns false with no options (no-op wait)", async () => {
    expect(await waitForDictationIdle()).toBe(false);
  });
});
