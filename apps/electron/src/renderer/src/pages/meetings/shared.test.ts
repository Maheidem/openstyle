import { describe, expect, it } from "vitest";
import { jobBadgeView } from "./shared";

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
