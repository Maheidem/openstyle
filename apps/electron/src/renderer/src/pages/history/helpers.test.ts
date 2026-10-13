import { SUPPORTED_LANGUAGES } from "@renderer/i18n";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { loadDayPickerLocale } from "./day-picker-locale";
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

  describe("with a fixed clock and time zone", () => {
    const originalTz = process.env.TZ;

    beforeAll(() => {
      process.env.TZ = "America/New_York";
    });

    afterAll(() => {
      if (originalTz === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalTz;
      }
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    // The input is a UTC string without the "Z", like the server sends it.
    const utc = (d: Date): string => d.toISOString().slice(0, 19);

    it("keeps the Today and Yesterday values for every language", () => {
      const now = new Date(2026, 5, 15, 12, 0, 0);
      vi.useFakeTimers();
      vi.setSystemTime(now);
      const yesterday = new Date(2026, 5, 14, 12, 0, 0);
      for (const lang of ["en", "pt", "de", undefined]) {
        expect(getDateGroup(utc(now), lang)).toBe("Today");
        expect(getDateGroup(utc(yesterday), lang)).toBe("Yesterday");
      }
    });

    it("gives Yesterday on the day after a spring clock change (23 hour day)", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 2, 9, 12, 0, 0));
      expect(getDateGroup("2026-03-08T17:00:00", "en")).toBe("Yesterday");
      expect(getDateGroup(utc(new Date(2026, 2, 9, 8, 0, 0)), "en")).toBe(
        "Today",
      );
    });

    it("gives Yesterday on the day after an autumn clock change (25 hour day)", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 10, 2, 12, 0, 0));
      expect(getDateGroup(utc(new Date(2026, 10, 1, 12, 0, 0)), "en")).toBe(
        "Yesterday",
      );
      expect(getDateGroup(utc(new Date(2026, 10, 2, 8, 0, 0)), "en")).toBe(
        "Today",
      );
    });

    it("gives the weekday text for two days ago across a clock change", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 2, 9, 12, 0, 0));
      expect(getDateGroup(utc(new Date(2026, 2, 7, 12, 0, 0)), "en")).toMatch(
        /Sat/,
      );
    });
  });
});

describe("loadDayPickerLocale", () => {
  it("maps app languages and falls back to English", async () => {
    expect((await loadDayPickerLocale("pt")).code).toBe("pt-BR");
    expect((await loadDayPickerLocale("de")).code).toBe("de");
    expect((await loadDayPickerLocale("en")).code).toBe("en-US");
    expect((await loadDayPickerLocale("pt-BR")).code).toBe("pt-BR");
    expect((await loadDayPickerLocale("xx")).code).toBe("en-US");
    expect((await loadDayPickerLocale(undefined)).code).toBe("en-US");
  });

  it("has a day picker locale for every app language", async () => {
    expect(SUPPORTED_LANGUAGES.length).toBeGreaterThan(1);
    for (const lang of SUPPORTED_LANGUAGES) {
      if (lang === "en") continue;
      expect((await loadDayPickerLocale(lang)).code, lang).not.toBe("en-US");
    }
  });
});
