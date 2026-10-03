import { MLX_ASR_PROVIDER_ID } from "../mlx-asr/constants.js";
import { WHISPER_PROVIDER_ID } from "../whisper/constants.js";

// Kept here, not in providers/omlx.ts, so that LLM modules can import this
// file without loading the STT provider code.
export const OMLX_PROVIDER_ID = "omlx";

// Engines that need no API key: the bundled on-device workers plus a
// user-run oMLX server (localhost, keyless).
export const LOCAL_STT_PROVIDERS = new Set([
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
