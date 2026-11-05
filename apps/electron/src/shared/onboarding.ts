// The saved state of the first run (specs/onboarding.md section 6). The main
// process keeps it in the local settings file. The renderer reads it at start
// and writes it at every Continue. It never holds an API key.

/** Step numbers. 0 is the first screen, 7 the last. */
export const ONBOARDING_STEP_MIN = 0;
export const ONBOARDING_STEP_MAX = 7;

/** Where a model comes from. "later" means: no model yet. */
export type OnboardingSource = "mac" | "server" | "cloud" | "later";

export interface OnboardingDraft {
  /** The spoken languages the user picked. Empty means auto-detect. */
  languages?: string[];
  /** The user pressed the download button, so a download was started. */
  downloadStarted?: boolean;
  voiceSource?: OnboardingSource;
  /** The catalog id of the voice model, or the model name on a server or provider. */
  voiceModel?: string;
  textSource?: OnboardingSource | "none";
  textModel?: string;
  /** The typed address of an own server. Never the key. */
  voiceServerUrl?: string;
  textServerUrl?: string;
  voiceProvider?: string;
  textProvider?: string;
  /** The Enhance switch, once the user has seen that step. */
  enhance?: boolean;
}

export interface OnboardingState {
  step: number;
  draft: OnboardingDraft;
}

const SOURCES = new Set(["mac", "server", "cloud", "later"]);
const MAX_TEXT = 300;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= MAX_TEXT
    ? value
    : undefined;
}

/**
 * Keep only the known fields of a draft, with the right types. A settings file
 * can be old, edited or damaged, and the draft must never carry a key.
 */
export function sanitizeDraft(raw: unknown): OnboardingDraft {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const draft: OnboardingDraft = {};
  if (
    Array.isArray(r.languages) &&
    r.languages.length <= 12 &&
    r.languages.every((l) => typeof l === "string" && l.length <= 12)
  ) {
    draft.languages = r.languages as string[];
  }
  if (typeof r.downloadStarted === "boolean") {
    draft.downloadStarted = r.downloadStarted;
  }
  if (typeof r.voiceSource === "string" && SOURCES.has(r.voiceSource)) {
    draft.voiceSource = r.voiceSource as OnboardingSource;
  }
  if (
    typeof r.textSource === "string" &&
    (SOURCES.has(r.textSource) || r.textSource === "none")
  ) {
    draft.textSource = r.textSource as OnboardingDraft["textSource"];
  }
  for (const key of [
    "voiceModel",
    "textModel",
    "voiceServerUrl",
    "textServerUrl",
    "voiceProvider",
    "textProvider",
  ] as const) {
    const value = text(r[key]);
    if (value !== undefined) draft[key] = value;
  }
  if (typeof r.enhance === "boolean") draft.enhance = r.enhance;
  return draft;
}

/** A step number inside the range, or null for anything else. */
export function sanitizeStep(raw: unknown): number | null {
  return typeof raw === "number" &&
    Number.isInteger(raw) &&
    raw >= ONBOARDING_STEP_MIN &&
    raw <= ONBOARDING_STEP_MAX
    ? raw
    : null;
}

/** The saved state, read from the local settings file. */
export function readOnboardingState(
  settings: Record<string, unknown>,
): OnboardingState {
  return {
    step: sanitizeStep(settings.onboardingStep) ?? 0,
    draft: sanitizeDraft(settings.onboardingDraft),
  };
}

/**
 * True when the first run must show. It stays active until completion. A saved
 * step means the user started it, so a model that the user saved on the way
 * does not end it. An old profile with models and no saved step counts as done
 * (the rule before this version).
 */
export function isOnboardingActiveFor(
  settings: Record<string, unknown>,
  configuredModelCount: number,
): boolean {
  if (settings.onboardingComplete === true) return false;
  if (sanitizeStep(settings.onboardingStep) !== null) return true;
  return configuredModelCount === 0;
}
