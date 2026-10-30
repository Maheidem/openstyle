import type { TranscribeParams } from "@openstyle/stt";
import { transcribe } from "@openstyle/stt";
import type { TranscriptionModel } from "ai";
import type { AsrVocabularyBias } from "../vocabulary-bias.js";
import { providerOptionsFromBias } from "./transcribe-bias.js";
import type { TranscribeOptions, TranscribeResult } from "./types.js";
import { CLOUD_TRANSCRIBE_TIMEOUT_MS, stripProviderPrefix } from "./types.js";

type AiSdkProviderFactory = (config: { apiKey: string }) => {
  transcription: (id: string) => TranscriptionModel;
};

/** The provider-options map accepted by the AI SDK `transcribe` call. */
type TranscribeProviderOptions = NonNullable<
  TranscribeParams["providerOptions"]
>;

const LANGUAGE_OPTION_KEYS: Record<string, string> = {
  elevenlabs: "languageCode",
};

/**
 * `gpt-transcribe` and `gpt-live-transcribe` take a `languages` list and not
 * the single `language` field. The API says to send only one of the two
 * (platform.openai.com/docs/guides/speech-to-text and /realtime-transcription).
 */
export function takesLanguagesList(modelId: string): boolean {
  return /^(?:openai\/)?gpt-(?:live-)?transcribe$/.test(modelId);
}

export function aiSdkProviderOptions(
  providerId: string,
  language: string | undefined,
  bias: AsrVocabularyBias | null | undefined,
  modelId = "",
): TranscribeProviderOptions | undefined {
  const options: TranscribeProviderOptions = {
    ...providerOptionsFromBias(providerId, bias),
  };
  // The AI SDK sends only `language`. The model detects the language itself.
  const skipLanguage = providerId === "openai" && takesLanguagesList(modelId);
  if (language && language !== "auto" && !skipLanguage) {
    const key = LANGUAGE_OPTION_KEYS[providerId] ?? "language";
    options[providerId] = { ...options[providerId], [key]: language };
  }
  return Object.keys(options).length > 0 ? options : undefined;
}

export async function transcribeWithAiSdk(
  opts: TranscribeOptions,
  createProvider: AiSdkProviderFactory,
  providerId: string,
): Promise<TranscribeResult> {
  const provider = createProvider({ apiKey: opts.apiKey });
  const model = provider.transcription(stripProviderPrefix(opts.model));
  const providerOptions = aiSdkProviderOptions(
    providerId,
    opts.language,
    opts.bias,
    opts.model,
  );
  const result = await transcribe({
    model,
    audio: opts.audio,
    signal: AbortSignal.timeout(CLOUD_TRANSCRIBE_TIMEOUT_MS),
    ...(providerOptions ? { providerOptions } : {}),
  });
  return {
    text: result.text,
    durationInSeconds: result.durationInSeconds,
  };
}
