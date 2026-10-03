import { describe, expect, it } from "vitest";
import {
  BAR_NOISE_FLOOR,
  barHeightFor,
  easeBars,
  nextJitter,
} from "./pill-waveform";

const NO_JITTER = { scale: 1, trim: 0 };

describe("barHeightFor", () => {
  it("gives zero height at or below the noise floor", () => {
    expect(barHeightFor(0, NO_JITTER)).toBe(0);
    expect(barHeightFor(BAR_NOISE_FLOOR, NO_JITTER)).toBe(0);
  });

  it("rises with the level and never reaches the ceiling", () => {
    const quiet = barHeightFor(0.2, NO_JITTER);
    const loud = barHeightFor(1, NO_JITTER);
    expect(loud).toBeGreaterThan(quiet);
    expect(loud).toBeLessThanOrEqual(0.82);
  });

  it("lowers the height by the trim", () => {
    const full = barHeightFor(1, NO_JITTER);
    const trimmed = barHeightFor(1, { scale: 1, trim: 0.1 });
    expect(trimmed).toBeCloseTo(full * 0.9, 10);
  });
});

describe("nextJitter", () => {
  it("stays inside the documented ranges", () => {
    for (let i = 0; i < 200; i++) {
      const { scale, trim } = nextJitter();
      expect(scale).toBeGreaterThanOrEqual(1 - 0.35);
      expect(scale).toBeLessThanOrEqual(1 + 0.35);
      expect(trim).toBeGreaterThanOrEqual(0);
      expect(trim).toBeLessThan(0.14);
    }
  });
});

describe("easeBars", () => {
  it("moves up at the rise rate and down at the fall rate, in place", () => {
    const bars = [0, 1];
    easeBars(bars, [1, 0], 0.5, 0.25);
    expect(bars).toEqual([0.5, 0.75]);
  });

  it("treats a missing target as zero", () => {
    const bars = [1];
    easeBars(bars, [], 0.5, 0.5);
    expect(bars).toEqual([0.5]);
  });
});
