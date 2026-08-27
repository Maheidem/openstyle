import { expect, test } from "@playwright/test";
import {
  diffLanguageHotkeys,
  isLanguageHotkeyTaken,
} from "../src/main/hotkey-utils";

// Covers the pure diff/conflict logic `registerLanguageHotkeys` (index.ts)
// is built on. index.ts itself imports `electron`, which isn't resolvable
// outside a running Electron process — it's driven only by the real-app
// Playwright test (app.test.ts), never imported directly in a unit test.
// The press-state machine (`handleDictationHotkeyDown`/`Up`, generalized
// from `handleNativeHotkeyDown`/`Up`) lives in index.ts for the same reason
// and is therefore not unit-tested here; it is covered by the manual
// acceptance checklist in specs/dictation-language-hotkeys.md §10 instead.

test("diffLanguageHotkeys: unchanged map leaves everything alone", () => {
  const current = new Map([
    ["pt", "Alt+P"],
    ["en", "Alt+E"],
  ]);
  const { toRemove, toAdd } = diffLanguageHotkeys(
    { pt: "Alt+P", en: "Alt+E" },
    current,
  );
  expect(toRemove).toEqual([]);
  expect(toAdd).toEqual([]);
});

test("diffLanguageHotkeys: removing an entry tears down only that language", () => {
  const current = new Map([
    ["pt", "Alt+P"],
    ["en", "Alt+E"],
  ]);
  const { toRemove, toAdd } = diffLanguageHotkeys({ pt: "Alt+P" }, current);
  expect(toRemove).toEqual(["en"]);
  expect(toAdd).toEqual([]);
});

test("diffLanguageHotkeys: a changed accelerator tears down and re-adds that language", () => {
  const current = new Map([["pt", "Alt+P"]]);
  const { toRemove, toAdd } = diffLanguageHotkeys(
    { pt: "Alt+Shift+P" },
    current,
  );
  expect(toRemove).toEqual(["pt"]);
  expect(toAdd).toEqual([["pt", "Alt+Shift+P"]]);
});

test("diffLanguageHotkeys: a new language is added without touching existing ones", () => {
  const current = new Map([["pt", "Alt+P"]]);
  const { toRemove, toAdd } = diffLanguageHotkeys(
    { pt: "Alt+P", en: "Alt+E" },
    current,
  );
  expect(toRemove).toEqual([]);
  expect(toAdd).toEqual([["en", "Alt+E"]]);
});

test("diffLanguageHotkeys: empty desired map tears down every current entry", () => {
  const current = new Map([
    ["pt", "Alt+P"],
    ["en", "Alt+E"],
  ]);
  const { toRemove, toAdd } = diffLanguageHotkeys({}, current);
  expect(toRemove.sort()).toEqual(["en", "pt"]);
  expect(toAdd).toEqual([]);
});

test("isLanguageHotkeyTaken: clashes with the default dictation hotkey", () => {
  expect(
    isLanguageHotkeyTaken("Alt+P", {
      dictationAccel: "Alt+P",
      remixAccel: null,
      claimedLanguageAccels: [],
    }),
  ).toBe(true);
});

test("isLanguageHotkeyTaken: clashes with the remix hotkey", () => {
  expect(
    isLanguageHotkeyTaken("Alt+R", {
      dictationAccel: "Alt+D",
      remixAccel: "Alt+R",
      claimedLanguageAccels: [],
    }),
  ).toBe(true);
});

test("isLanguageHotkeyTaken: clashes with an already-claimed language hotkey", () => {
  expect(
    isLanguageHotkeyTaken("Alt+P", {
      dictationAccel: "Alt+D",
      remixAccel: "Alt+R",
      claimedLanguageAccels: ["Alt+P"],
    }),
  ).toBe(true);
});

test("isLanguageHotkeyTaken: free accelerator is not taken", () => {
  expect(
    isLanguageHotkeyTaken("Alt+P", {
      dictationAccel: "Alt+D",
      remixAccel: "Alt+R",
      claimedLanguageAccels: ["Alt+E"],
    }),
  ).toBe(false);
});

test("registration loop shape: two entries sharing the same accelerator — first wins, second is skipped", () => {
  // Mirrors the `for...of Object.entries(desired)` loop in
  // `registerLanguageHotkeys` (index.ts): claims accumulate as each entry is
  // processed in order, so a later duplicate is rejected by the entries the
  // loop already committed to, never by itself.
  const desired = { pt: "Alt+X", en: "Alt+X" };
  const claimed = new Set<string>();
  const registered: string[] = [];
  const skipped: string[] = [];

  for (const [lang, accel] of Object.entries(desired)) {
    if (
      isLanguageHotkeyTaken(accel, {
        dictationAccel: null,
        remixAccel: null,
        claimedLanguageAccels: claimed,
      })
    ) {
      skipped.push(lang);
      continue;
    }
    claimed.add(accel);
    registered.push(lang);
  }

  expect(registered).toEqual(["pt"]);
  expect(skipped).toEqual(["en"]);
});
