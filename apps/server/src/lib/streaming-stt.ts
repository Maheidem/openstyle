import { getDb } from "./db.js";
import { MLX_ASR_PROVIDER_ID } from "./mlx-asr/constants.js";
import { OMLX_PROVIDER_ID } from "./streaming/providers/omlx.js";
import { getProvider, supportsSessionTransport } from "./streaming/registry.js";
import type { StreamCallbacks, StreamSession } from "./streaming/types.js";
import type { AsrVocabularyBias } from "./vocabulary-bias.js";
import { WHISPER_PROVIDER_ID } from "./whisper/constants.js";

export {
  supportsSessionTransport,
  supportsStreaming,
} from "./streaming/registry.js";
export type { StreamCallbacks, StreamSession } from "./streaming/types.js";

// Engines that need no API key: the bundled on-device workers plus a
// user-run oMLX server (localhost, keyless).
const LOCAL_STT_PROVIDERS = new Set([
  WHISPER_PROVIDER_ID,
  MLX_ASR_PROVIDER_ID,
  OMLX_PROVIDER_ID,
]);

export type VoiceProviderCategory = "local" | "byok";

export function voiceProviderCategory(
  providerId: string,
): VoiceProviderCategory {
  if (LOCAL_STT_PROVIDERS.has(providerId)) return "local";
  return "byok";
}

export function openStreamingSession(opts: {
  providerId: string;
  apiKey: string;
  model: string;
  languages?: string[];
  translate?: boolean;
  bias?: AsrVocabularyBias | null;
  appContext?: string | null;
  callbacks: StreamCallbacks;
}): StreamSession {
  const {
    providerId,
    apiKey,
    model,
    languages,
    translate,
    bias,
    appContext,
    callbacks,
  } = opts;

  const provider = getProvider(providerId);
  if (!provider) {
    throw new Error(`No transcription provider for: ${providerId}`);
  }
  if (!provider.openStreamingSession) {
    throw new Error(`Provider ${providerId} does not support streaming`);
  }
  if (!supportsSessionTransport(providerId, model)) {
    throw new Error(
      `Model ${model} on provider ${providerId} does not support session audio transport`,
    );
  }

  return provider.openStreamingSession({
    apiKey,
    model,
    languages,
    translate,
    bias,
    appContext,
    callbacks,
  });
}

export function getApiKeyForProvider(providerId: string): string | null {
  // On-device engines need no key.
  if (LOCAL_STT_PROVIDERS.has(providerId)) return "local";
  const db = getDb();
  const row = db
    .prepare("SELECT key FROM api_keys WHERE provider = ?")
    .get(providerId) as { key: string } | undefined;
  return row?.key ?? null;
}
