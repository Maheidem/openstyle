import type { Locale } from "react-day-picker";
import { enUS } from "react-day-picker/locale/en-US";

export { enUS };

// The app language code maps to the day picker locale. The pt.json file uses
// Brazilian Portuguese ("você", "tela", "arquivo"), so "pt" maps to pt-BR.
// Each import path is a literal, so the bundler makes one small chunk for
// each locale. Only English is in the main bundle.
const DAY_PICKER_LOADERS: Record<string, () => Promise<Locale>> = {
  de: () => import("react-day-picker/locale/de").then((m) => m.de),
  es: () => import("react-day-picker/locale/es").then((m) => m.es),
  fr: () => import("react-day-picker/locale/fr").then((m) => m.fr),
  it: () => import("react-day-picker/locale/it").then((m) => m.it),
  ja: () => import("react-day-picker/locale/ja").then((m) => m.ja),
  pt: () => import("react-day-picker/locale/pt-BR").then((m) => m.ptBR),
};

/** Load the day picker locale for an app language. Unknown languages give English. */
export async function loadDayPickerLocale(
  lang: string | undefined,
): Promise<Locale> {
  const base = lang?.split("-")[0] ?? "en";
  const load = DAY_PICKER_LOADERS[base];
  return load ? load() : enUS;
}
