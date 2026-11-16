import { parseStoredLanguageList, SETTINGS_KEYS } from "@openstyle/validations";
import { readSetting, readSettings } from "./db.js";

export const ISO_LANGUAGE_NAMES: Record<string, string> = {
  ar: "Arabic",
  cs: "Czech",
  da: "Danish",
  de: "German",
  el: "Greek",
  en: "English",
  es: "Spanish",
  fa: "Persian",
  fi: "Finnish",
  fr: "French",
  hi: "Hindi",
  hu: "Hungarian",
  id: "Indonesian",
  it: "Italian",
  ja: "Japanese",
  ko: "Korean",
  mk: "Macedonian",
  ms: "Malay",
  nl: "Dutch",
  no: "Norwegian",
  pl: "Polish",
  pt: "Portuguese",
  ro: "Romanian",
  ru: "Russian",
  sv: "Swedish",
  th: "Thai",
  tr: "Turkish",
  uk: "Ukrainian",
  vi: "Vietnamese",
  zh: "Chinese",
};

/**
 * Read the canonical transcription-language list from the `languages` setting
 * (a JSON array of ISO codes). Falls back to the legacy singular `language`
 * key for users who set a language before the multi-language migration, so an
 * existing choice is never silently dropped. Returns a normalized, deduped,
 * capped list; an empty array means auto-detect.
 */
export function getLanguagesSetting(): string[] {
  const stored = readSettings([
    SETTINGS_KEYS.languages,
    SETTINGS_KEYS.language,
  ]);

  // The `languages` row is authoritative once present (including an explicit
  // empty array = auto-detect); only an absent row falls back to the legacy
  // singular `language` key, so a pre-migration choice is honored exactly once.
  return parseStoredLanguageList(
    stored.get(SETTINGS_KEYS.languages),
    stored.get(SETTINGS_KEYS.language),
  );
}

/**
 * Membership-guarded language override: a per-dictation pin (from a
 * language hotkey) is only honored when it's one of the user's currently
 * configured `languages`. Falls back to the unmodified list on a stale
 * binding (a language removed from settings after the hotkey was pressed),
 * a malformed/hand-crafted value, or when no override was given — same
 * fail-closed posture throughout, no error surfaced to the caller. The
 * override is trimmed and lower-cased here, so callers pass the raw value.
 *
 * Shared by both dictation-language-hotkey call sites: the REST transcribe
 * route's `x-dictation-language` header (`routes/transcribe.ts`) and the
 * streaming route's `"start"` message `language` field (`routes/stream.ts`)
 * — same substitution, same guard, one tested implementation.
 */
export function resolveLanguageOverride(
  override: string | null | undefined,
  languages: string[],
): string[] {
  const pin = override?.trim().toLowerCase();
  return pin && languages.includes(pin) ? [pin] : languages;
}

/**
 * Whether translate mode is enabled. Translate mode only applies when exactly
 * one language is resolved; with zero or multiple languages there is no single
 * target to enforce, so translate is off.
 * Pass `languages` when the caller already read the stored list.
 */
export function getTranslateModeSetting(
  languages: string[] = getLanguagesSetting(),
): boolean {
  if (languages.length !== 1) return false;
  return readSetting("translate_mode") === "true";
}

/**
 * The language of a hotkey pin, or null when no pin was used. A pin counts
 * only when it is one of the set languages (the same guard as
 * `resolveLanguageOverride`). The default hotkey gives null, also when the
 * request goes out with `languages[0]`.
 */
export function pinnedLanguage(
  override: string | null | undefined,
  languages: string[],
): string | null {
  const pin = override?.trim().toLowerCase();
  return pin && languages.includes(pin) ? pin : null;
}

const ISO_BY_NAME = new Map(
  Object.entries(ISO_LANGUAGE_NAMES).map(([code, name]) => [
    name.toLowerCase(),
    code,
  ]),
);

/**
 * An ASR language value as an ISO-639-1 code: "en" and "English" both give
 * "en". Unknown names (for example "Cantonese") give undefined.
 */
export function toIsoLanguage(
  value: string | null | undefined,
): string | undefined {
  const v = value?.trim().toLowerCase();
  if (!v) return undefined;
  if (/^[a-z]{2}$/.test(v)) return v;
  // A locale tag such as "en-US" or "pt_BR".
  const tag = /^([a-z]{2})[-_][a-z]{2,4}$/.exec(v);
  if (tag) return tag[1];
  return ISO_BY_NAME.get(v);
}
