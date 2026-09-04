import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Locale completeness for the meeting-transcribe cancel feature (T1-1,
// specs/lean-audit-2026-09.md §3) — and, for the meetings section those keys
// live in, placeholder integrity against en.json.
//
// Deliberately NOT a blanket "every template key exists in every locale"
// assertion: the locale files are allowed to lag behind template.json/en.json
// (missing keys fall back to English at runtime — 100+ keys are currently
// outstanding across the locales). What must never happen is a key that
// exists in a locale with mangled placeholders, or a key this app's own code
// renders being absent from the shipped locale set entirely.
// ---------------------------------------------------------------------------

const LOCALES_DIR = dirname(new URL(import.meta.url).pathname);

const localeFiles = readdirSync(LOCALES_DIR).filter(
  (f) => f.endsWith(".json") && f !== "template.json",
);

function load(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(LOCALES_DIR, name), "utf8")) as Record<
    string,
    unknown
  >;
}

/** Flatten nested objects to dot-paths → string values. */
function flatten(
  obj: Record<string, unknown>,
  prefix = "",
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object") {
      Object.assign(out, flatten(value as Record<string, unknown>, path));
    } else if (typeof value === "string") {
      out[path] = value;
    }
  }
  return out;
}

/** The {{placeholders}} a value carries, in sorted order. */
function placeholders(value: string): string[] {
  return [...value.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
}

describe("locale files", () => {
  it("ships all 7 languages plus the template", () => {
    expect(
      [...localeFiles, "template.json"]
        .map((f) => f.replace(".json", ""))
        .sort(),
    ).toEqual(["de", "en", "es", "fr", "it", "ja", "pt", "template"]);
  });

  // Keys introduced by the cancel-transcribe work — every locale must carry
  // them (they render on a primary surface, not an optional one).
  const CANCEL_KEYS = [
    "meetings.cancelTranscription",
    "meetings.cancellingTranscription",
    "meetings.cancelledKeptTranscript",
  ];

  for (const file of ["template.json", ...localeFiles]) {
    it(`${file}: carries the cancel-transcribe keys with intact placeholders`, () => {
      const flat = flatten(load(file));
      const en = flatten(load("en.json"));
      for (const key of CANCEL_KEYS) {
        expect(flat[key], `${file} is missing "${key}"`).toBeTruthy();
        // The README contract for translators: placeholders move, but their
        // text and syntax never change.
        expect(placeholders(flat[key])).toEqual(placeholders(en[key]));
      }
    });
  }

  // Guardrail for the section this change touched: any meetings.* key a
  // locale carries must preserve en.json's placeholders for that key. (This
  // is intentionally scoped to meetings.* — other sections have pre-existing
  // placeholder drift that is not this change's to fix.)
  for (const file of localeFiles) {
    it(`${file}: every meetings.* key preserves en.json placeholders`, () => {
      const flat = flatten(load(file));
      const en = flatten(load("en.json"));
      for (const [key, value] of Object.entries(flat)) {
        if (!key.startsWith("meetings.")) continue;
        const enValue = en[key];
        if (enValue === undefined) continue;
        expect(
          placeholders(value),
          `${file} "${key}" placeholders differ from en.json`,
        ).toEqual(placeholders(enValue));
      }
    });
  }
});
