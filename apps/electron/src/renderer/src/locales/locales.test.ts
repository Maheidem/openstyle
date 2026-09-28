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

  // Keys introduced by the import progress/cancel/review work (UX-04 +
  // UX-A3) — same rule: primary surface, so every locale carries them.
  const IMPORT_PROGRESS_KEYS = [
    "import.cancel",
    "import.cancelling",
    "import.progress.elapsed",
    "import.review.transcribe",
    "import.review.chooseAnother",
    "import.review.weightWithDuration",
    "import.review.sizeOnly",
    "import.review.slow",
  ];

  for (const file of ["template.json", ...localeFiles]) {
    it(`${file}: carries the import progress keys with intact placeholders`, () => {
      const flat = flatten(load(file));
      const en = flatten(load("en.json"));
      for (const key of IMPORT_PROGRESS_KEYS) {
        expect(flat[key], `${file} is missing "${key}"`).toBeTruthy();
        expect(placeholders(flat[key])).toEqual(placeholders(en[key]));
      }
    });
  }

  // Keys introduced by the Settings → Data disk-usage line (UX-08).
  const DISK_USAGE_KEYS = [
    "settings.data.diskUsage",
    "settings.data.diskUsageDesc",
    "settings.data.diskUsageLine",
    "settings.data.diskUsageLoading",
    "settings.data.manage",
  ];

  for (const file of ["template.json", ...localeFiles]) {
    it(`${file}: carries the disk-usage keys with intact placeholders`, () => {
      const flat = flatten(load(file));
      const en = flatten(load("en.json"));
      for (const key of DISK_USAGE_KEYS) {
        expect(flat[key], `${file} is missing "${key}"`).toBeTruthy();
        expect(placeholders(flat[key])).toEqual(placeholders(en[key]));
      }
    });
  }

  // Keys introduced by preset management on the Models page (edit params /
  // rename / duplicate / delete, specs/llm-task-profiles.md §9.3). Every
  // locale carries them — they render on the only surface where a preset can
  // be destroyed, so a missing translation is a missing warning.
  const PRESET_ACTION_KEYS = [
    "models.taskProfiles.editParams",
    "models.taskProfiles.rename",
    "models.taskProfiles.duplicate",
    "models.taskProfiles.deletePreset",
    "models.taskProfiles.deletePresetAria",
    "models.taskProfiles.deletePresetTitle",
    "models.taskProfiles.deletePresetMsg",
    "models.taskProfiles.deletePresetNoTasksMsg",
    "models.taskProfiles.presetBuiltin",
    "models.taskProfiles.presetYours",
    "models.taskProfiles.builtinAutoCopyNote",
    "models.taskProfiles.renameBuiltinNote",
    "models.taskProfiles.saveCopy",
    "models.taskProfiles.presetCopyName",
    "models.taskProfiles.presetMissingBadge",
    "models.taskProfiles.presetMissingNote",
    "models.taskProfiles.presetCountMax",
    "models.taskProfiles.presetSaveFailed",
    "models.taskProfiles.presetDeleteFailed",
  ];

  for (const file of ["template.json", ...localeFiles]) {
    it(`${file}: carries the preset-management keys with intact placeholders`, () => {
      const flat = flatten(load(file));
      const en = flatten(load("en.json"));
      for (const key of PRESET_ACTION_KEYS) {
        expect(flat[key], `${file} is missing "${key}"`).toBeTruthy();
        expect(
          placeholders(flat[key]),
          `${file} "${key}" placeholders differ from en.json`,
        ).toEqual(placeholders(en[key]));
      }
    });
  }

  // Keys introduced by the `meeting_summary_timeout_seconds` setting — the one
  // knob that decides whether a local inference engine gets to finish a
  // summary at all. Settings → Data, so every locale carries them, and the
  // range/invalid copy interpolates {{min}}/{{max}} from the shared bounds.
  const SUMMARY_TIMEOUT_KEYS = [
    "settings.data.summaryTimeout",
    "settings.data.summaryTimeoutDesc",
    "settings.data.summaryTimeoutSeconds",
    "settings.data.summaryTimeoutRange",
    "settings.data.summaryTimeoutInvalid",
  ];

  for (const file of ["template.json", ...localeFiles]) {
    it(`${file}: carries the meeting-summary-timeout keys with intact placeholders`, () => {
      const flat = flatten(load(file));
      const en = flatten(load("en.json"));
      for (const key of SUMMARY_TIMEOUT_KEYS) {
        expect(flat[key], `${file} is missing "${key}"`).toBeTruthy();
        expect(
          placeholders(flat[key]),
          `${file} "${key}" placeholders differ from en.json`,
        ).toEqual(placeholders(en[key]));
      }
    });
  }

  // Keys introduced by the fix for that control's runtime defects — commit on
  // blur (not per keystroke), an explicit Reset to default, an honest hint for
  // stripped input, and a visible failed-write state. Same rule as above:
  // Settings → Data is a primary surface, so every locale carries them.
  const SUMMARY_TIMEOUT_COMMIT_KEYS = [
    "settings.data.summaryTimeoutReset",
    "settings.data.summaryTimeoutSaveFailed",
    "settings.data.summaryTimeoutStripped",
  ];

  for (const file of ["template.json", ...localeFiles]) {
    it(`${file}: carries the summary-timeout commit keys with intact placeholders`, () => {
      const flat = flatten(load(file));
      const en = flatten(load("en.json"));
      for (const key of SUMMARY_TIMEOUT_COMMIT_KEYS) {
        expect(flat[key], `${file} is missing "${key}"`).toBeTruthy();
        expect(
          placeholders(flat[key]),
          `${file} "${key}" placeholders differ from en.json`,
        ).toEqual(placeholders(en[key]));
      }
    });
  }

  // Keys introduced by async Summarize (specs/meeting-llm-queue.md §5.6–§5.7):
  // the queued/running/cancelled states of the background summarize job. The
  // progress card is a primary surface — a summarize that looks frozen on a
  // saturated local engine is indistinguishable from a hang without them — so
  // every locale carries them.
  const SUMMARIZE_JOB_KEYS = [
    "meetings.summarizeQueued",
    "meetings.summarizeQueuedAhead",
    "meetings.cancelSummarize",
    "meetings.cancellingSummarize",
    "meetings.summarizeCancelled",
  ];

  for (const file of ["template.json", ...localeFiles]) {
    it(`${file}: carries the async-summarize job keys with intact placeholders`, () => {
      const flat = flatten(load(file));
      const en = flatten(load("en.json"));
      for (const key of SUMMARIZE_JOB_KEYS) {
        expect(flat[key], `${file} is missing "${key}"`).toBeTruthy();
        expect(
          placeholders(flat[key]),
          `${file} "${key}" placeholders differ from en.json`,
        ).toEqual(placeholders(en[key]));
      }
    });
  }

  // Keys introduced by the `meeting_enhance_timeout_seconds` setting — the
  // phantom knob that shipped in 2.8.0 with a validator and no read site.
  // Settings → Data, same rule as its summarize twin: every locale carries
  // them, and the range/invalid/reset copy interpolates from the shared bounds.
  const ENHANCE_TIMEOUT_KEYS = [
    "settings.data.enhanceTimeout",
    "settings.data.enhanceTimeoutDesc",
    "settings.data.enhanceTimeoutSeconds",
    "settings.data.enhanceTimeoutRange",
    "settings.data.enhanceTimeoutInvalid",
    "settings.data.enhanceTimeoutReset",
    "settings.data.enhanceTimeoutSaveFailed",
    "settings.data.enhanceTimeoutStripped",
  ];

  for (const file of ["template.json", ...localeFiles]) {
    it(`${file}: carries the meeting-enhance-timeout keys with intact placeholders`, () => {
      const flat = flatten(load(file));
      const en = flatten(load("en.json"));
      for (const key of ENHANCE_TIMEOUT_KEYS) {
        expect(flat[key], `${file} is missing "${key}"`).toBeTruthy();
        expect(
          placeholders(flat[key]),
          `${file} "${key}" placeholders differ from en.json`,
        ).toEqual(placeholders(en[key]));
      }
    });
  }

  // The three states of an Enhance pass. "No segments needed correction" must
  // never be the only zero-correction message — every locale carries the
  // partial pass and the three named failure states, or a dead engine goes
  // back to reading as a clean transcript in that language.
  const ENHANCE_HONESTY_KEYS = [
    "meetings.enhancePartial",
    "meetings.enhanceFailedTimeout",
    "meetings.enhanceFailedParse",
    "meetings.enhanceFailedProvider",
    "meetings.retryEnhance",
  ];

  for (const file of ["template.json", ...localeFiles]) {
    it(`${file}: carries the Enhance partial/failure reporting keys with intact placeholders`, () => {
      const flat = flatten(load(file));
      const en = flatten(load("en.json"));
      for (const key of ENHANCE_HONESTY_KEYS) {
        expect(flat[key], `${file} is missing "${key}"`).toBeTruthy();
        expect(
          placeholders(flat[key]),
          `${file} "${key}" placeholders differ from en.json`,
        ).toEqual(placeholders(en[key]));
      }
      // The no-op message must still exist — it is now only the state it is
      // honest about (a completed pass that found nothing), not the default.
      expect(flat["meetings.enhanceNoneCorrected"]).toBeTruthy();
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
