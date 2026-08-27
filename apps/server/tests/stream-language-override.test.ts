import { describe, expect, it } from "vitest";
import { resolveLanguageOverride } from "../src/lib/language.js";

// stream.ts's `resolveStreamConfig()` and `connectUpstream()` are private
// closures inside the WS route's `upgradeWebSocket(() => {...})` factory —
// not exported, and not exercisable without a live socket. What IS exported
// and shared is `resolveLanguageOverride`, the exact substitution
// `resolveStreamConfig()` applies inline where it builds `languages`
// (stream.ts), and the `key` stream.ts compares to decide reuse-vs-rebuild
// is `JSON.stringify([voice, model, languages, translate, bias])` — a pure
// function of that same `languages` value. So testing that a language
// override changes `resolveLanguageOverride`'s output, and therefore changes
// a `key` built the same way stream.ts builds it, directly proves §4b's
// rebuild claim without mocking the upstream session or the socket. The
// `sameConfig`/rebuild mechanism itself is pre-existing, unchanged code
// (already exercised for provider/model/bias changes) — only its input is
// new here.

function streamConfigKey(languages: string[]): string {
  // Mirrors stream.ts's `key` construction exactly (voice/model/translate/
  // bias held constant here since only the `languages` input is under test).
  return JSON.stringify(["groq", "whisper-large-v3", languages, false, null]);
}

describe("resolveLanguageOverride (streaming config)", () => {
  it("pins `languages` to the override when it is configured", () => {
    expect(resolveLanguageOverride("pt", ["en", "pt"])).toEqual(["pt"]);
  });

  it("falls back to the full list when the override is not configured", () => {
    expect(resolveLanguageOverride("fr", ["en", "pt"])).toEqual(["en", "pt"]);
  });

  it("a language override alone changes the stream config key (forces rebuild)", () => {
    const rawLanguages = ["en", "pt"];
    const withoutOverride = resolveLanguageOverride(null, rawLanguages);
    const withOverride = resolveLanguageOverride("pt", rawLanguages);

    const keyWithoutOverride = streamConfigKey(withoutOverride);
    const keyWithOverride = streamConfigKey(withOverride);

    expect(keyWithOverride).not.toBe(keyWithoutOverride);
  });

  it("two successive overrides (PT then EN) on the same raw list each force a distinct key", () => {
    const rawLanguages = ["en", "pt"];
    const ptKey = streamConfigKey(resolveLanguageOverride("pt", rawLanguages));
    const enKey = streamConfigKey(resolveLanguageOverride("en", rawLanguages));
    const noOverrideKey = streamConfigKey(
      resolveLanguageOverride(null, rawLanguages),
    );

    // PT-hotkey dictation followed by EN-hotkey dictation on the same warm
    // connection: each "start" resolves a different `languages` value, so
    // `sameConfig` (upstreamConfigKey !== null && nextConfig?.key ===
    // upstreamConfigKey`) evaluates false both times and the existing
    // rebuild branch runs on each — the second dictation cannot silently
    // inherit the first's upstream session.
    expect(ptKey).not.toBe(enKey);
    expect(ptKey).not.toBe(noOverrideKey);
    expect(enKey).not.toBe(noOverrideKey);
  });

  it("a stale override (removed from settings mid-flight) resolves to the same key as no override", () => {
    const rawLanguages = ["en", "pt"];
    const staleOverrideKey = streamConfigKey(
      resolveLanguageOverride("de", rawLanguages),
    );
    const noOverrideKey = streamConfigKey(
      resolveLanguageOverride(null, rawLanguages),
    );
    expect(staleOverrideKey).toBe(noOverrideKey);
  });
});
