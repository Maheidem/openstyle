import { describe, expect, it } from "vitest";
import { formatClockDuration, formatTimestamp } from "./format";

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

describe("formatTimestamp", () => {
  // 2026-10-03 14:15 UTC. Midday, so the month is Oct in every time zone.
  const ms = Date.UTC(2026, 9, 3, 14, 15);

  it("returns an empty string for null and zero", () => {
    expect(formatTimestamp(null)).toBe("");
    expect(formatTimestamp(null, "pt")).toBe("");
    expect(formatTimestamp(0, "en")).toBe("");
  });

  it("uses the given language for the month text", () => {
    expect(formatTimestamp(ms, "en")).toContain("Oct");
    expect(formatTimestamp(ms, "pt")).toContain("out");
    expect(formatTimestamp(ms, "en")).not.toBe(formatTimestamp(ms, "pt"));
  });
});
