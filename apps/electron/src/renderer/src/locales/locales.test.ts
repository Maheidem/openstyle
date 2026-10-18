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

const en = flatten(load("en.json"));

describe("locale files", () => {
  it("ships all 7 languages plus the template", () => {
    expect(
      [...localeFiles, "template.json"]
        .map((f) => f.replace(".json", ""))
        .sort(),
    ).toEqual(["de", "en", "es", "fr", "it", "ja", "pt", "template"]);
  });

  // Each group lists keys that every locale must carry. The rule is the same
  // for all groups: the key exists and keeps the placeholders of en.json. The
  // comment above each group says why the group exists.
  const KEY_GROUPS: Record<string, string[]> = {
    "speaker-attendee-picker": ["meetings.speakerNamePickHint"],
    // The track length warning and the track repair notes (issue #170) tell
    // the user that the transcript can be wrong, so every locale carries them.
    "track-ratio-warning": [
      "meetings.trackRatioWarning",
      "meetings.trackRepaired",
      "meetings.trackRepairPending",
    ],
    // Keys introduced by the cancel-transcribe work — every locale must carry
    // them (they render on a primary surface, not an optional one).
    "cancel-transcribe": [
      "meetings.cancelTranscription",
      "meetings.cancellingTranscription",
      "meetings.cancelledKeptTranscript",
    ],
    // Keys introduced by the import progress/cancel/review work (UX-04 +
    // UX-A3) — same rule: primary surface, so every locale carries them.
    "import-progress": [
      "import.cancel",
      "import.cancelling",
      "import.progress.elapsed",
      "import.review.transcribe",
      "import.review.chooseAnother",
      "import.review.weightWithDuration",
      "import.review.sizeOnly",
      "import.review.slow",
    ],
    // Keys introduced by the Settings → Data disk-usage line (UX-08).
    "disk-usage": [
      "settings.data.diskUsage",
      "settings.data.diskUsageDesc",
      "settings.data.diskUsageLine",
      "settings.data.diskUsageLoading",
      "settings.data.manage",
    ],
    // Keys introduced by preset management on the Models page (edit params /
    // rename / duplicate / delete, specs/llm-task-profiles.md §9.3). Every
    // locale carries them — they render on the only surface where a preset can
    // be destroyed, so a missing translation is a missing warning.
    "preset-management": [
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
    ],
    // Keys introduced by the history page translation work (issue #83) and the
    // history keys that were still English in six locales. The page shows them
    // on a primary surface, so every locale carries them.
    "history-i18n": [
      "history.prevPage",
      "history.nextPage",
      "history.copyText",
      "history.delete",
      "history.subtitle",
      "history.selectDate",
      "history.dateRangeLabel",
      "history.viewLabel",
      "history.diffToggle",
      "history.diffToggleDesc",
      "history.aiEditToggle",
      "history.aiEditToggleDesc",
      "history.nerdToggle",
      "history.nerdToggleDesc",
      "history.nerdWpm",
      "history.nerdTok",
      "history.nerdCompute",
      "history.dismissHero",
    ],
    // Keys introduced by the `meeting_summary_timeout_seconds` setting — the one
    // knob that decides whether a local inference engine gets to finish a
    // summary at all. Settings → Data, so every locale carries them, and the
    // range/invalid copy interpolates {{min}}/{{max}} from the shared bounds.
    "summary-timeout": [
      "settings.data.summaryTimeout",
      "settings.data.summaryTimeoutDesc",
      "settings.data.summaryTimeoutSeconds",
      "settings.data.summaryTimeoutRange",
      "settings.data.summaryTimeoutInvalid",
    ],
    // Keys introduced by the fix for that control's runtime defects — commit on
    // blur (not per keystroke), an explicit Reset to default, an honest hint for
    // stripped input, and a visible failed-write state. Same rule as above:
    // Settings → Data is a primary surface, so every locale carries them.
    "summary-timeout-commit": [
      "settings.data.summaryTimeoutReset",
      "settings.data.summaryTimeoutSaveFailed",
      "settings.data.summaryTimeoutStripped",
    ],
    // Keys introduced by async Summarize (specs/meeting-llm-queue.md §5.6–§5.7):
    // the queued/running/cancelled states of the background summarize job. The
    // progress card is a primary surface — a summarize that looks frozen on a
    // saturated local engine is indistinguishable from a hang without them — so
    // every locale carries them.
    "summarize-job": [
      "meetings.summarizeQueued",
      "meetings.summarizeQueuedAhead",
      "meetings.cancelSummarize",
      "meetings.cancellingSummarize",
      "meetings.summarizeCancelled",
    ],
    // Keys introduced by the `meeting_enhance_timeout_seconds` setting — the
    // phantom knob that shipped in 2.8.0 with a validator and no read site.
    // Settings → Data, same rule as its summarize twin: every locale carries
    // them, and the range/invalid/reset copy interpolates from the shared bounds.
    "enhance-timeout": [
      "settings.data.enhanceTimeout",
      "settings.data.enhanceTimeoutDesc",
      "settings.data.enhanceTimeoutSeconds",
      "settings.data.enhanceTimeoutRange",
      "settings.data.enhanceTimeoutInvalid",
      "settings.data.enhanceTimeoutReset",
      "settings.data.enhanceTimeoutSaveFailed",
      "settings.data.enhanceTimeoutStripped",
    ],
    // The three states of an Enhance pass. "No segments needed correction" must
    // never be the only zero-correction message — every locale carries the
    // partial pass and the three named failure states, or a dead engine goes
    // back to reading as a clean transcript in that language.
    "enhance-honesty": [
      "meetings.enhancePartial",
      "meetings.enhanceFailedTimeout",
      "meetings.enhanceFailedParse",
      "meetings.enhanceFailedProvider",
      "meetings.retryEnhance",
      // The no-op message must still exist. It is now only the state it is
      // honest about (a completed pass that found nothing), not the default.
      "meetings.enhanceNoneCorrected",
    ],
    // Keys introduced by the translated History tutorial demo (issue #112):
    // the press-speak-release sentence, the three status labels and the sample
    // transcript. The card is the first thing on the History page.
    "history-tutorial": [
      "history.tutorial.sentence",
      "history.tutorial.ready",
      "history.tutorial.listening",
      "history.tutorial.pasted",
      "history.tutorial.sample",
    ],
    // Keys introduced by the translated aria-label and title strings (issue
    // #153): icon buttons, dialogs and sliders that a screen reader or a
    // tooltip reads aloud. A missing key shows the English text in every
    // language, so every locale carries them.
    "aria-title-i18n": [
      "common.close",
      "common.edit",
      "common.delete",
      "common.previousPage",
      "common.nextPage",
      "common.reveal.show",
      "common.reveal.hide",
      "common.reveal.value",
      "common.reveal.apiKey",
      "common.reveal.token",
      "shell.githubRepo",
      "vocabulary.selectEntry",
      "models.loading",
      "models.mlxKeepAlive",
      "models.picker.backToSimple",
      "models.removeDownloaded",
      "models.modal.addApiKey",
      "models.modal.chooseVoice",
      "models.modal.pickLlm",
      "pill.cancelDictation",
      "common.voiceWaveform",
    ],
    // Keys introduced by the translated fixed English visible strings and
    // placeholders (issue #155): the Help page, the Models page
    // lists and dialogs, the pill status words, the error boundary and the
    // 404 page. Every locale carries them, or a user sees English in the
    // middle of a translated screen.
    "fixed-english-i18n": [
      "common.done",
      "help.title",
      "help.subtitle",
      "help.getHelp.eyebrow",
      "help.getHelp.reportTitle",
      "help.getHelp.reportDesc",
      "help.contributing.eyebrow",
      "help.contributing.cardTitle",
      "help.contributing.cardDesc",
      "dictionary.usedCount",
      "vocabulary.termPlaceholder",
      "vocabulary.notesPlaceholder",
      "vocabulary.biasNote",
      "settings.recording.backgroundAudio",
      "settings.recording.backgroundAudioDesc",
      "settings.recording.backgroundAudioDescLinux",
      "settings.recording.backgroundAudioOff",
      "settings.recording.backgroundAudioDuck",
      "settings.recording.backgroundAudioPause",
      "models.list.searchPlaceholder",
      "models.list.showAll",
      "models.list.selected",
      "models.list.use",
      "models.list.download",
      "models.list.retry",
      "models.list.recommended",
      "models.list.via",
      "models.list.addKey",
      "models.list.preparingRuntime",
      "models.list.verifying",
      "models.list.noBuiltin",
      "models.list.noMatch",
      "models.modal.keyTitle",
      "models.modal.keyNeeded",
      "models.modal.keyNew",
      "models.modal.keyPlaceholder",
      "models.modal.keyStoredNote",
      "models.modal.keyGet",
      "models.modal.keyChecking",
      "models.modal.keySaveUse",
      "models.mlx.title",
      "models.mlx.coldStart",
      "models.mlx.alwaysOn",
      "models.mlx.descAlways",
      "models.mlx.descCold",
      "models.mlx.descOneMinute",
      "models.mlx.descMinutes",
      "errorBoundary.eyebrow",
      "errorBoundary.title",
      "errorBoundary.body",
      "errorBoundary.reload",
      "notFound.title",
      "notFound.goToApp",
      "pill.dismiss",
      "pill.retry",
      "pill.cardTitle",
      "pill.status.reconnecting",
      "pill.status.retrying",
      "pill.status.unavailable",
      "pill.status.warming",
      "pill.status.delivered",
      "pill.status.noAudio",
      "pill.status.preparingMic",
      "pill.status.listening",
      "pill.status.transcribing",
    ],
    // #157: pill error text (card body, live region, native dialogs). The
    // pill runs initI18n().
    "pill-errors-i18n": [
      "pill.error.timedOut",
      "pill.error.connectionLostRecording",
      "pill.error.connectionLostTranscribing",
      "pill.error.failed",
      "pill.error.failedStatus",
      "pill.error.localModelTimeout",
      "pill.error.cannotReachRemote",
      "pill.error.cannotReachLocal",
      "pill.error.hintRemote",
      "pill.error.hintLocal",
      "pill.error.recordingFailedTitle",
      "pill.error.micDenied",
      "pill.error.noAudioCaptured",
      "settings.sections.network",
    ],
    // Keys introduced by the Settings → Network panel (issue #160). The panel
    // is a primary surface in Settings, so every locale carries them.
    "settings-network-i18n": [
      "settings.network.intro",
      "settings.network.proxy",
      "settings.network.proxyDesc",
      "settings.network.proxyPlaceholder",
      "settings.network.caCert",
      "settings.network.caCertDesc",
      "settings.network.caCertPlaceholder",
      "settings.network.save",
      "settings.network.saved",
      "settings.network.invalidProxy",
      "settings.network.invalidCaCert",
      "settings.network.envNote",
      "settings.network.server",
      "settings.network.serverDesc",
      "settings.network.serverTokenPlaceholder",
      "settings.network.usingLocal",
      "settings.network.testConnection",
      "settings.network.resetToLocal",
      "settings.network.statusTesting",
      "settings.network.statusOk",
      "settings.network.statusUnreachable",
      "settings.network.statusUnauthorized",
    ],
  };

  describe.each(Object.entries(KEY_GROUPS))("%s keys", (_name, keys) => {
    it.each([
      "template.json",
      ...localeFiles,
    ])("%s carries the keys with intact placeholders", (file) => {
      const flat = flatten(load(file));
      for (const key of keys) {
        expect(flat[key], `${file} is missing "${key}"`).toBeTruthy();
        // The README contract for translators: placeholders move, but their
        // text and syntax never change.
        expect(
          placeholders(flat[key]),
          `${file} "${key}" placeholders differ from en.json`,
        ).toEqual(placeholders(en[key]));
      }
    });
  });

  // Guardrail for the section this change touched: any meetings.* key a
  // locale carries must preserve en.json's placeholders for that key. (This
  // is intentionally scoped to meetings.* — other sections have pre-existing
  // placeholder drift that is not this change's to fix.)
  for (const file of localeFiles) {
    it(`${file}: every meetings.* key preserves en.json placeholders`, () => {
      const flat = flatten(load(file));
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

  // The key-step sentence is rendered by <Trans> (model-modal.tsx). The
  // <model> tag wraps the model name, so a translation must keep it once.
  it.each([
    "template.json",
    ...localeFiles,
  ])("%s models.modal.keyNeeded keeps the <model> tag", (file) => {
    const sentence = flatten(load(file))["models.modal.keyNeeded"];
    expect(sentence.split("<model>{{name}}</model>").length - 1).toBe(1);
  });

  // The demo sentences are rendered by <Trans> (tutorial-demo.tsx for the
  // History card). Each tag maps to one
  // highlighted word or the keycap, so a translation must use every tag exactly
  // once. A missing tag drops a highlight; a repeated tag renders the keycap or
  // word twice.
  const SENTENCE_TAGS = [
    "<press>",
    "</press>",
    "<speak>",
    "</speak>",
    "<release>",
    "</release>",
  ];
  const SENTENCE_KEYS = ["history.tutorial.sentence"];
  describe.each(SENTENCE_KEYS)("%s", (key) => {
    it.each([
      "template.json",
      ...localeFiles,
    ])("%s sentence uses each tag exactly once", (file) => {
      const sentence = flatten(load(file))[key];
      for (const tag of SENTENCE_TAGS) {
        expect(
          sentence.split(tag).length - 1,
          `${file} sentence must contain ${tag} exactly once`,
        ).toBe(1);
      }
      // The keycap group is <key/> or <key>punctuation</key>, exactly once.
      expect(
        sentence.split("<key").length - 1,
        `${file} sentence must contain <key> exactly once`,
      ).toBe(1);
      expect(sentence, `${file} <key> is malformed`).toMatch(
        /<key\/>|<key>[^<]+<\/key>/,
      );
      // Tags are well-formed and non-empty: <tag>word</tag>.
      for (const name of ["press", "speak", "release"]) {
        expect(sentence, `${file} <${name}> needs a word`).toMatch(
          new RegExp(`<${name}>[^<]+</${name}>`),
        );
      }
    });
  });
});
