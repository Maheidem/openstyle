import { describe, expect, it } from "vitest";
import { formatShare, languageWpm, roundShares } from "./language-stats";

describe("roundShares", () => {
  it("sums to 100 with the largest remainder", () => {
    // 155,857 / 29,061 / 400 / 439 words: exact 83.9, 15.6, 0.2, 0.2.
    const shares = roundShares([155857, 29061, 400, 439]);
    expect(shares).toEqual([84, 16, 0, 0]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("gives the leftover points to the largest remainders", () => {
    expect(roundShares([1, 1, 1])).toEqual([34, 33, 33]);
    expect(roundShares([33.6, 33.3, 33.1])).toEqual([34, 33, 33]);
  });

  it("gives all zero for no words", () => {
    expect(roundShares([0, 0])).toEqual([0, 0]);
  });
});

describe("formatShare", () => {
  it("shows <1% for a small share above 0", () => {
    expect(formatShare(0, 12)).toBe("<1%");
  });

  it("shows 0% for no words and the number otherwise", () => {
    expect(formatShare(0, 0)).toBe("0%");
    expect(formatShare(84, 155857)).toBe("84%");
  });
});

describe("languageWpm", () => {
  it("is words over audio minutes", () => {
    expect(
      languageWpm({
        language: "en",
        dictations: 2,
        words: 248,
        audio_ms: 120000,
      }),
    ).toBe(124);
  });

  it("is null with no audio and for Unknown", () => {
    expect(
      languageWpm({ language: "pt", dictations: 0, words: 0, audio_ms: 0 }),
    ).toBeNull();
    expect(
      languageWpm({
        language: null,
        dictations: 3,
        words: 30,
        audio_ms: 60000,
      }),
    ).toBeNull();
  });
});
