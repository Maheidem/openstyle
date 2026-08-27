import { parseStoredLanguageList } from "@openstyle/validations";
import { getDb } from "./db.js";

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
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'languages'")
    .get() as { value: string } | undefined;
  const legacy = db
    .prepare("SELECT value FROM settings WHERE key = 'language'")
    .get() as { value: string } | undefined;

  // The `languages` row is authoritative once present (including an explicit
  // empty array = auto-detect); only an absent row falls back to the legacy
  // singular `language` key, so a pre-migration choice is honored exactly once.
  return parseStoredLanguageList(row?.value, legacy?.value);
}

/**
 * Membership-guarded language override: a per-dictation pin (from a
 * language hotkey) is only honored when it's one of the user's currently
 * configured `languages`. Falls back to the unmodified list on a stale
 * binding (a language removed from settings after the hotkey was pressed),
 * a malformed/hand-crafted value, or when no override was given — same
 * fail-closed posture throughout, no error surfaced to the caller.
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
  return override && languages.includes(override) ? [override] : languages;
}

/**
 * Whether translate mode is enabled. Translate mode only applies when exactly
 * one language is resolved (the cloud enforces the same rule); with zero or
 * multiple languages there is no single target to enforce, so translate is off.
 */
export function getTranslateModeSetting(): boolean {
  if (getLanguagesSetting().length !== 1) return false;
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = 'translate_mode'")
    .get() as { value: string } | undefined;
  return row?.value === "true";
}
