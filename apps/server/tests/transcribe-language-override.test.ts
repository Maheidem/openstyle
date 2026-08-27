import { describe, expect, it } from "vitest";
import { resolveLanguageOverride } from "../src/lib/language.js";

// Exercises the membership-guarded substitution shared by the REST
// transcribe route (`x-dictation-language` header) and the streaming route
// ("start" message's `language` field) — see language.ts's
// `resolveLanguageOverride`. Both routes are thin wrappers around this one
// function, so testing it directly covers the "value substitution, not new
// branching" claim in specs/dictation-language-hotkeys.md §2 for both paths.

describe("resolveLanguageOverride", () => {
  it("pins to the override when it is a member of the configured languages", () => {
    const effective = resolveLanguageOverride("pt", ["en", "pt"]);
    expect(effective).toEqual(["pt"]);
    expect(effective[0]).toBe("pt");
  });

  it("falls back to the full list when the override is not a configured language (stale binding)", () => {
    // Simulates a language hotkey whose language was since removed from
    // settings, or a hand-crafted/corrupted header value.
    expect(resolveLanguageOverride("de", ["en", "pt"])).toEqual(["en", "pt"]);
  });

  it("returns the unmodified list when no override is given — today's exact behavior", () => {
    expect(resolveLanguageOverride(undefined, ["en", "pt"])).toEqual([
      "en",
      "pt",
    ]);
    expect(resolveLanguageOverride(null, ["en", "pt"])).toEqual(["en", "pt"]);
    expect(resolveLanguageOverride("", ["en", "pt"])).toEqual(["en", "pt"]);
  });

  it("stays auto-detect when languages is empty, even with an override present", () => {
    // A language hotkey cannot override a user who has explicitly chosen
    // auto-detect and configured no languages at all — there is nothing in
    // the configured list for the override to validate against, so it is
    // inert by construction (empty-list membership check always fails).
    expect(resolveLanguageOverride("pt", [])).toEqual([]);
  });
});
