import { afterEach, describe, expect, it } from "vitest";
import {
  claimJob,
  getJob,
  hasJob,
  isCancelRequested,
  releaseJob,
  requestCancel,
  setJobKind,
  setProgress,
  updateProgress,
} from "../src/lib/meetings/job-registry.js";

const progress = () => ({ done: 0, total: 0, failed: 0 });

afterEach(() => {
  releaseJob("m1");
  releaseJob("m2");
});

describe("job registry claim and release", () => {
  it("claims a free slot and reports the job with its kind", () => {
    expect(claimJob("m1", "transcribe", progress())).toBe(true);
    expect(hasJob("m1")).toBe(true);
    expect(getJob("m1")).toEqual({ ...progress(), kind: "transcribe" });
  });

  it("refuses a second claim and keeps the first job", () => {
    claimJob("m1", "transcribe", progress());
    expect(claimJob("m1", "diarize", { done: 1, total: 2, failed: 0 })).toBe(
      false,
    );
    expect(getJob("m1")).toEqual({ ...progress(), kind: "transcribe" });
  });

  it("keeps slots of different meetings apart", () => {
    claimJob("m1", "transcribe", progress());
    expect(claimJob("m2", "enhance", progress())).toBe(true);
    releaseJob("m1");
    expect(hasJob("m1")).toBe(false);
    expect(hasJob("m2")).toBe(true);
  });

  it("frees the slot, the kind and the cancel flag together", () => {
    claimJob("m1", "summarize", progress());
    requestCancel("m1");
    releaseJob("m1");
    expect(getJob("m1")).toBeNull();
    expect(isCancelRequested("m1")).toBe(false);
    expect(claimJob("m1", "diarize", progress())).toBe(true);
  });
});

describe("job registry progress", () => {
  it("replaces the blob with setProgress", () => {
    claimJob("m1", "transcribe", progress());
    setProgress("m1", { done: 2, total: 5, failed: 1 });
    expect(getJob("m1")).toEqual({
      done: 2,
      total: 5,
      failed: 1,
      kind: "transcribe",
    });
  });

  it("merges a patch with updateProgress and keeps other fields", () => {
    claimJob("m1", "summarize", { done: 1, total: 3, failed: 0 });
    updateProgress("m1", { queued: { ahead: 2, sinceMs: 40 } });
    updateProgress("m1", { done: 2, total: 4 });
    expect(getJob("m1")).toEqual({
      done: 2,
      total: 4,
      failed: 0,
      queued: { ahead: 2, sinceMs: 40 },
      kind: "summarize",
    });
  });

  it("does not create a job when updateProgress finds no slot", () => {
    updateProgress("m1", { done: 1 });
    expect(hasJob("m1")).toBe(false);
  });
});

describe("job registry cancel", () => {
  it.each([
    "transcribe",
    "retry-failed",
    "summarize",
    "enhance",
  ] as const)("accepts a cancel for a %s job", (kind) => {
    claimJob("m1", kind, progress());
    expect(isCancelRequested("m1")).toBe(false);
    expect(requestCancel("m1")).toBe(true);
    expect(isCancelRequested("m1")).toBe(true);
  });

  it.each(["diarize"] as const)("refuses a cancel for a %s job", (kind) => {
    claimJob("m1", kind, progress());
    expect(requestCancel("m1")).toBe(false);
    expect(isCancelRequested("m1")).toBe(false);
  });

  it("refuses a cancel when no job holds the slot", () => {
    expect(requestCancel("m1")).toBe(false);
  });
});

describe("job registry controller and kind", () => {
  it("aborts the controller of the job on a cancel", () => {
    const controller = new AbortController();
    claimJob("m1", "enhance", progress(), controller);
    expect(controller.signal.aborted).toBe(false);
    expect(requestCancel("m1")).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it("drops the controller with the slot, so a later cancel aborts nothing", () => {
    const controller = new AbortController();
    claimJob("m1", "enhance", progress(), controller);
    releaseJob("m1");
    claimJob("m1", "enhance", progress());
    requestCancel("m1");
    expect(controller.signal.aborted).toBe(false);
  });

  it("changes the kind of a held slot with setJobKind and ignores a free slot", () => {
    claimJob("m1", "enhance", progress());
    setJobKind("m1", "summarize");
    expect(getJob("m1")?.kind).toBe("summarize");
    setJobKind("m2", "summarize");
    expect(hasJob("m2")).toBe(false);
  });
});
