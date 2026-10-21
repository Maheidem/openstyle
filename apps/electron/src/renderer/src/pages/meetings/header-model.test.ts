import { describe, expect, it } from "vitest";
import { fitTagCount, primaryActionKey } from "./header-model";

const base = {
  failedCount: 0,
  transcribing: false,
  hasTranscript: true,
  hasEnhanced: true,
  hasSummary: true,
};

describe("primaryActionKey", () => {
  it("shows no primary button for a finished meeting", () => {
    expect(primaryActionKey(base)).toBeNull();
  });

  it("follows the steps of a meeting in order", () => {
    expect(primaryActionKey({ ...base, failedCount: 2 })).toBe("retry");
    expect(primaryActionKey({ ...base, hasTranscript: false })).toBe(
      "transcribe",
    );
    expect(primaryActionKey({ ...base, hasEnhanced: false })).toBe("enhance");
    expect(primaryActionKey({ ...base, hasSummary: false })).toBe("summarize");
  });

  it("does not offer Retry failed while a transcription runs", () => {
    expect(
      primaryActionKey({
        ...base,
        failedCount: 1,
        transcribing: true,
        hasTranscript: false,
      }),
    ).toBe("transcribe");
  });
});

describe("fitTagCount", () => {
  it("shows every tag when all fit", () => {
    expect(fitTagCount([50, 50, 50], 4, 200, 30)).toBe(3);
    expect(fitTagCount([50, 50, 50, 50], 4, 300, 30)).toBe(4);
  });

  it("keeps room for the +N chip when tags are hidden", () => {
    // 4 chips and +N need 242 px. 3 chips and +N need 188 px.
    expect(fitTagCount([50, 50, 50, 50, 50], 4, 250, 30, 0)).toBe(4);
    expect(fitTagCount([50, 50, 50, 50, 50], 4, 240, 30, 0)).toBe(3);
  });

  it("shows 3 tags when each keeps a readable width", () => {
    // Full width: only 2 fit. At 56 px each, 3 chips and +N need 206 px.
    expect(fitTagCount([90, 90, 90, 90], 4, 210, 30)).toBe(3);
  });

  it("shows fewer tags than 3 when they would get too narrow", () => {
    expect(fitTagCount([90, 90, 90, 90], 4, 150, 30)).toBe(2);
    expect(fitTagCount([90, 90, 90, 90], 4, 120, 30)).toBe(1);
    expect(fitTagCount([90, 90, 90, 90], 4, 80, 30)).toBe(0);
    expect(fitTagCount([], 4, 100, 30)).toBe(0);
  });
});
