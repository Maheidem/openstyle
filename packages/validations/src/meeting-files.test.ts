import { describe, expect, it } from "vitest";
import { trackRatioWarning } from "./meeting-files.js";

const RATE = 16000;

describe("trackRatioWarning", () => {
  it("warns on the issue #170 case (system track 1/3 of the mic track)", () => {
    // 2329.8 s meeting, system.wav 776.6 s.
    const mic = 2329.8 * RATE;
    const system = 776.6 * RATE;
    expect(trackRatioWarning(mic, system, RATE)).toBeCloseTo(0.3333, 3);
  });

  it("warns when the system track is too long", () => {
    expect(trackRatioWarning(60 * RATE, 66 * RATE, RATE)).toBeCloseTo(1.1, 5);
  });

  it("accepts ratios inside 0.95..1.05, including the edges", () => {
    expect(trackRatioWarning(100 * RATE, 100 * RATE, RATE)).toBeNull();
    expect(trackRatioWarning(100 * RATE, 95 * RATE, RATE)).toBeNull();
    expect(trackRatioWarning(100 * RATE, 105 * RATE, RATE)).toBeNull();
  });

  it("warns just outside the band", () => {
    expect(trackRatioWarning(100 * RATE, 94.9 * RATE, RATE)).not.toBeNull();
    expect(trackRatioWarning(100 * RATE, 105.1 * RATE, RATE)).not.toBeNull();
  });

  it("does not check short recordings", () => {
    expect(trackRatioWarning(29 * RATE, 10 * RATE, RATE)).toBeNull();
    expect(trackRatioWarning(30 * RATE, 10 * RATE, RATE)).not.toBeNull();
  });

  it("does not check missing, zero or bad counts", () => {
    expect(trackRatioWarning(0, 60 * RATE, RATE)).toBeNull();
    expect(trackRatioWarning(60 * RATE, 0, RATE)).toBeNull();
    expect(trackRatioWarning(undefined, 60 * RATE, RATE)).toBeNull();
    expect(trackRatioWarning(60 * RATE, "x", RATE)).toBeNull();
    expect(trackRatioWarning(60 * RATE, 20 * RATE, undefined)).toBeNull();
    expect(trackRatioWarning(Number.NaN, 20 * RATE, RATE)).toBeNull();
  });
});
