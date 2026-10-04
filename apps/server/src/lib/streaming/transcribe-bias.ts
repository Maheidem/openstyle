import { parseAppContext } from "@openstyle/sdk";
import type { AsrVocabularyBias } from "../vocabulary-bias.js";

export function providerOptionsFromBias(
  providerId: string,
  bias: AsrVocabularyBias | null | undefined,
): Record<string, Record<string, string>> | undefined {
  if (!bias || bias.kind !== "prompt") return undefined;
  if (providerId === "openai" || providerId === "groq") {
    return { [providerId]: { prompt: bias.text } };
  }
  return undefined;
}

export function appendDeepgramBiasToParams(
  params: URLSearchParams,
  bias: AsrVocabularyBias | null | undefined,
): void {
  if (!bias) return;
  if (bias.kind === "deepgram-keyterms") {
    for (const term of bias.terms) {
      params.append("keyterm", term);
    }
  } else if (bias.kind === "deepgram-keywords") {
    for (const word of bias.terms) {
      params.append("keywords", `${word}:1.5`);
    }
  }
}

export function appendElevenLabsBiasToParams(
  params: URLSearchParams,
  bias: AsrVocabularyBias | null | undefined,
): void {
  if (!bias || bias.kind !== "elevenlabs-keyterms") return;
  for (const term of bias.terms) {
    params.append("keyterms", term);
  }
}

/** Soniox WebSocket session `context` object (terms + optional background text). */
export function sonioxContextFromBias(
  bias: AsrVocabularyBias | null | undefined,
): { terms?: string[]; text?: string } | undefined {
  if (!bias || bias.kind !== "soniox-context") return undefined;
  const context: { terms?: string[]; text?: string } = {};
  if (bias.terms.length > 0) context.terms = bias.terms;
  if (bias.text?.trim()) context.text = bias.text.trim();
  return Object.keys(context).length > 0 ? context : undefined;
}

export interface SonioxGeneralEntry {
  key: string;
  value: string;
}

const SONIOX_GENERAL_VALUE_MAX_CHARS = 256;

export function sonioxGeneralFromAppContext(
  appContext: string | null | undefined,
): SonioxGeneralEntry[] | undefined {
  const parsed = parseAppContext(appContext);
  if (!parsed) return undefined;
  const entries: SonioxGeneralEntry[] = [];
  const push = (key: string, value: string | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed) return;
    entries.push({
      key,
      value: trimmed.slice(0, SONIOX_GENERAL_VALUE_MAX_CHARS),
    });
  };
  push("application", parsed.appName);
  push("window title", parsed.windowTitle);
  push("url", parsed.url);
  return entries.length > 0 ? entries : undefined;
}
