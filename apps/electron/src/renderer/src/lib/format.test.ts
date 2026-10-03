import { describe, expect, it } from "vitest";
import { formatClockDuration } from "./format";

describe("formatClockDuration", () => {
  it("returns 0:00 for null, zero and negative input", () => {
    expect(formatClockDuration(null)).toBe("0:00");
    expect(formatClockDuration(0)).toBe("0:00");
    expect(formatClockDuration(-5)).toBe("0:00");
  });

  it("rounds to the nearest second", () => {
    expect(formatClockDuration(59_500)).toBe("1:00");
  });

  it("shows hours only when needed", () => {
    expect(formatClockDuration(65_000)).toBe("1:05");
    expect(formatClockDuration(3_661_000)).toBe("1:01:01");
  });
});
