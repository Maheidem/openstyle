import { describe, expect, it } from "vitest";
import { jobBadgeView, jobProgressLine, nearestSegmentId } from "./shared";

describe("jobBadgeView", () => {
  it("shows the job kind and its percent while the job runs", () => {
    expect(
      jobBadgeView({ kind: "enhance", phase: "reading", done: 1, total: 4 }),
    ).toEqual({ key: "enhance", percent: 25 });
    expect(
      jobBadgeView({
        kind: "transcribe",
        phase: "diarizing",
        done: 0,
        total: 0,
      }),
    ).toEqual({ key: "diarize", percent: null });
  });

  it("shows Queued and no percent while the job waits for the LLM lane", () => {
    expect(
      jobBadgeView({
        kind: "enhance",
        phase: "reading",
        done: 0,
        total: 4,
        queued: { ahead: 1, sinceMs: 0 },
      }),
    ).toEqual({ key: "queued", percent: null });
  });

  it("returns to the job kind when the wait ends", () => {
    expect(
      jobBadgeView({
        kind: "summarize",
        done: 1,
        total: 2,
        queued: null,
      }),
    ).toEqual({ key: "summarize", percent: 50 });
  });
});

describe("jobProgressLine", () => {
  it("puts the percent of a workflow run after the phase label", () => {
    expect(
      jobProgressLine("Reading chunk 11 of 14\u2026", {
        done: 9,
        total: 16,
        workflow: true,
      }),
    ).toBe("Reading chunk 11 of 14 · 56%");
  });

  it("puts done/total after the label of a transcription", () => {
    expect(
      jobProgressLine("Transcribing...", {
        done: 3,
        total: 7,
        workflow: false,
      }),
    ).toBe("Transcribing · 3/7");
  });

  it("keeps the label as it is with no progress", () => {
    expect(
      jobProgressLine("Waiting for the model to be free\u2026", null),
    ).toBe("Waiting for the model to be free\u2026");
    expect(
      jobProgressLine("Preparing\u2026", { done: 0, total: 0, workflow: true }),
    ).toBe("Preparing\u2026");
  });
});

describe("nearestSegmentId", () => {
  const segs = [
    { id: "a", startMs: 0 },
    { startMs: 4000 },
    { id: "b", startMs: 6000 },
    { id: "c", startMs: 12_000 },
  ];
  it("finds the segment at the hit time, else the nearest one", () => {
    expect(nearestSegmentId(segs, 6000)).toBe("b");
    expect(nearestSegmentId(segs, 8000)).toBe("b");
    expect(nearestSegmentId(segs, 11_000)).toBe("c");
    // A segment with no id is never the target.
    expect(nearestSegmentId(segs, 4000)).toBe("b");
    expect(nearestSegmentId([{ startMs: 1 }], 1)).toBeNull();
  });
});
