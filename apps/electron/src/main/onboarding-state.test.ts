import { describe, expect, it } from "vitest";
import {
  isOnboardingActiveFor,
  readOnboardingState,
  sanitizeDraft,
  sanitizeStep,
} from "../shared/onboarding";

describe("isOnboardingActiveFor", () => {
  it("is off after completion", () => {
    expect(isOnboardingActiveFor({ onboardingComplete: true }, 0)).toBe(false);
    expect(
      isOnboardingActiveFor({ onboardingComplete: true, onboardingStep: 3 }, 0),
    ).toBe(false);
  });

  it("stays on while a saved step exists, also when a model is saved", () => {
    expect(isOnboardingActiveFor({ onboardingStep: 3 }, 2)).toBe(true);
    expect(isOnboardingActiveFor({ onboardingStep: 0 }, 1)).toBe(true);
  });

  it("is on for a new profile with no model", () => {
    expect(isOnboardingActiveFor({}, 0)).toBe(true);
  });

  it("counts an old profile with models and no step as done", () => {
    expect(isOnboardingActiveFor({}, 1)).toBe(false);
  });
});

describe("saved state", () => {
  it("reads the step and the draft", () => {
    expect(
      readOnboardingState({
        onboardingStep: 4,
        onboardingDraft: { voiceSource: "mac", languages: ["en"] },
      }),
    ).toEqual({
      step: 4,
      draft: { voiceSource: "mac", languages: ["en"] },
    });
  });

  it("falls back to step 0 for a missing or bad step", () => {
    expect(readOnboardingState({}).step).toBe(0);
    expect(readOnboardingState({ onboardingStep: 99 }).step).toBe(0);
    expect(readOnboardingState({ onboardingStep: "2" }).step).toBe(0);
    expect(sanitizeStep(7)).toBe(7);
    expect(sanitizeStep(-1)).toBeNull();
    expect(sanitizeStep(1.5)).toBeNull();
  });

  it("drops unknown fields, so a key never stays in the draft", () => {
    const draft = sanitizeDraft({
      voiceSource: "cloud",
      voiceProvider: "groq",
      apiKey: "gsk_secret",
      voiceKey: "gsk_secret",
      textSource: "bogus",
      voiceServerUrl: 42,
    });
    expect(draft).toEqual({ voiceSource: "cloud", voiceProvider: "groq" });
    expect(JSON.stringify(draft)).not.toContain("secret");
  });

  it("returns an empty draft for a value that is not an object", () => {
    expect(sanitizeDraft(null)).toEqual({});
    expect(sanitizeDraft("x")).toEqual({});
  });
});
