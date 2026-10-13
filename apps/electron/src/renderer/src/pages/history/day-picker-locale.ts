import type { Locale } from "react-day-picker";
import { de, enUS, es, fr, it, ja, ptBR } from "react-day-picker/locale";

// The app language code maps to the day picker locale. The pt.json file uses
// Brazilian Portuguese ("você", "tela", "arquivo"), so "pt" maps to ptBR.
const DAY_PICKER_LOCALES: Record<string, Locale> = {
  de,
  en: enUS,
  es,
  fr,
  it,
  ja,
  pt: ptBR,
};

/** Day picker locale for an app language. Unknown languages give English. */
export function getDayPickerLocale(lang: string | undefined): Locale {
  const base = lang?.split("-")[0] ?? "en";
  return DAY_PICKER_LOCALES[base] ?? enUS;
}
