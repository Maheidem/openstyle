import type { MeetingBatchState } from "@openstyle/validations";
import { describe, expect, it } from "vitest";
import { isBatchShown } from "./batch-model";

function state(over: Partial<MeetingBatchState>): MeetingBatchState {
  return {
    id: "batch-1",
    active: false,
    total: 6,
    done: 6,
    skipped: 0,
    failed: 0,
    cancelled: 0,
    skip_reasons: {},
    fail_reasons: {},
    current: null,
    pending: [],
    ...over,
  };
}

describe("isBatchShown", () => {
  it("shows nothing before a batch exists or for an empty one", () => {
    expect(isBatchShown(undefined, "")).toBe(false);
    expect(isBatchShown(state({ total: 0 }), "")).toBe(false);
  });

  it("shows a finished batch that is not closed", () => {
    expect(isBatchShown(state({}), "")).toBe(true);
  });

  it("keeps a closed finished batch closed", () => {
    expect(isBatchShown(state({}), "batch-1")).toBe(false);
  });

  it("shows a new batch after another one was closed, also with equal counts", () => {
    expect(isBatchShown(state({ id: "batch-2" }), "batch-1")).toBe(true);
  });

  it("never hides a running batch", () => {
    expect(isBatchShown(state({ active: true }), "batch-1")).toBe(true);
  });
});
