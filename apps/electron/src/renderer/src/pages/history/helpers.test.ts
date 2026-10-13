import { SUPPORTED_LANGUAGES } from "@renderer/i18n";
import { describe, expect, it } from "vitest";
import { getDayPickerLocale } from "./day-picker-locale";
import {
  formatClock,
  formatRangeDate,
  formatRangeLabel,
  getDateGroup,
} from "./helpers";

// 15:45 UTC. The checks compare the style of the text, not the hour or day
// value, so the result does not depend on the time zone.
const AFTERNOON = "2020-03-15T15:45:00";

describe("formatClock", () => {
  it("uses the 12 hour style for en and the 24 hour style for pt", () => {
    const en = formatClock(AFTERNOON, "en");
    const pt = formatClock(AFTERNOON, "pt");
    expect(en).not.toBe(pt);
    expect(en).toMatch(/[ap]m/);
    expect(pt).not.toMatch(/[ap]m/);
  });
});

describe("formatRangeDate and formatRangeLabel", () => {
  it("gives the month name in the app language", () => {
    expect(formatRangeDate("2020-03-15", "-", "en")).toBe("15 Mar, 2020");
    expect(formatRangeDate("2020-03-15", "-", "pt")).toBe("15 mar., 2020");
    expect(formatRangeLabel("2020-03-15", "2020-09-02", "-", "pt")).toBe(
      "15 mar., 2020 - 2 set., 2020",
    );
  });

  it("gives the placeholder for an empty value", () => {
    expect(formatRangeDate("", "Select", "pt")).toBe("Select");
  });
});

describe("getDateGroup", () => {
  it("gives text in the app language for an old date", () => {
    const en = getDateGroup("2020-03-15T12:00:00", "en");
    const pt = getDateGroup("2020-03-15T12:00:00", "pt");
    expect(en).toMatch(/(Sun|Mon|Tue|Wed|Thu|Fri|Sat)/);
    expect(pt).toMatch(/(dom|seg|ter|qua|qui|sex|s[áa]b)/);
    expect(pt).toMatch(/mar/);
    expect(pt).not.toBe(en);
  });

  it("keeps the Today and Yesterday values for every language", () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86400_000);
    const iso = (d: Date): string => d.toISOString().slice(0, 19);
    for (const lang of ["en", "pt", "de", undefined]) {
      expect(getDateGroup(iso(now), lang)).toBe("Today");
      expect(getDateGroup(iso(yesterday), lang)).toBe("Yesterday");
    }
  });
});

describe("getDayPickerLocale", () => {
  it("maps app languages and falls back to English", () => {
    expect(getDayPickerLocale("pt").code).toBe("pt-BR");
    expect(getDayPickerLocale("de").code).toBe("de");
    expect(getDayPickerLocale("en").code).toBe("en-US");
    expect(getDayPickerLocale("pt-BR").code).toBe("pt-BR");
    expect(getDayPickerLocale("xx").code).toBe("en-US");
    expect(getDayPickerLocale(undefined).code).toBe("en-US");
  });

  it("has a day picker locale for every app language", () => {
    expect(SUPPORTED_LANGUAGES.length).toBeGreaterThan(1);
    for (const lang of SUPPORTED_LANGUAGES) {
      if (lang === "en") continue;
      expect(getDayPickerLocale(lang).code, lang).not.toBe("en-US");
    }
  });
});
