import { DeepgramTranscriptionProvider } from "./providers/deepgram.js";
import { ElevenLabsTranscriptionProvider } from "./providers/elevenlabs.js";
import { GroqTranscriptionProvider } from "./providers/groq.js";
import { MlxLocalTranscriptionProvider } from "./providers/mlx-local.js";
import { OpenAITranscriptionProvider } from "./providers/openai.js";
import { ServerTranscriptionProvider } from "./providers/server.js";
import { SonioxTranscriptionProvider } from "./providers/soniox.js";
import { WhisperLocalTranscriptionProvider } from "./providers/whisper-local.js";
import type {
  StreamingSessionOptions,
  StreamSession,
  TranscriptionProvider,
} from "./types.js";

const providers: TranscriptionProvider[] = [
  new OpenAITranscriptionProvider(),
  new DeepgramTranscriptionProvider(),
  new ElevenLabsTranscriptionProvider(),
  new GroqTranscriptionProvider(),
  new SonioxTranscriptionProvider(),
  new WhisperLocalTranscriptionProvider(),
  new MlxLocalTranscriptionProvider(),
  new ServerTranscriptionProvider(),
];

const providerMap = new Map(providers.map((p) => [p.providerId, p]));

export function getProvider(providerId: string): TranscriptionProvider | null {
  return providerMap.get(providerId) ?? null;
}

export function supportsStreaming(
  providerId: string,
  modelId: string,
): boolean {
  const provider = providerMap.get(providerId);
  if (!provider) return false;
  if (!provider.openStreamingSession) return false;
  return provider.supportsStreaming(modelId);
}

export function supportsSessionTransport(
  providerId: string,
  modelId: string,
): boolean {
  const provider = providerMap.get(providerId);
  if (!provider) return false;
  if (!provider.openStreamingSession) return false;
  return (
    provider.supportsSessionTransport?.(modelId) ??
    provider.supportsStreaming(modelId)
  );
}

export function openStreamingSession(
  opts: StreamingSessionOptions & { providerId: string },
): StreamSession {
  const { providerId, ...sessionOpts } = opts;

  const provider = getProvider(providerId);
  if (!provider) {
    throw new Error(`No transcription provider for: ${providerId}`);
  }
  if (!provider.openStreamingSession) {
    throw new Error(`Provider ${providerId} does not support streaming`);
  }
  if (!supportsSessionTransport(providerId, sessionOpts.model)) {
    throw new Error(
      `Model ${sessionOpts.model} on provider ${providerId} does not support session audio transport`,
    );
  }

  return provider.openStreamingSession(sessionOpts);
}
