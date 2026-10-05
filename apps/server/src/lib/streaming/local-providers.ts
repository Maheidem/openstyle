import { SERVER_PROVIDER_ID } from "@openstyle/validations";
import { MLX_ASR_PROVIDER_ID } from "../mlx-asr/constants.js";
import { WHISPER_PROVIDER_ID } from "../whisper/constants.js";

// Engines that need no API key from the api_keys table: the bundled on-device
// workers plus the servers the user runs. A server holds its own key.
export const LOCAL_STT_PROVIDERS = new Set([
  WHISPER_PROVIDER_ID,
  MLX_ASR_PROVIDER_ID,
  SERVER_PROVIDER_ID,
]);

export type VoiceProviderCategory = "local" | "byok";

export function voiceProviderCategory(
  providerId: string,
): VoiceProviderCategory {
  if (LOCAL_STT_PROVIDERS.has(providerId)) return "local";
  return "byok";
}
