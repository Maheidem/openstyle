import type { ApiClient, ApiRes } from "./api";

/** One entry of GET /api/models/available. */
export type AvailableModel = ApiRes<
  ApiClient["api"]["models"]["available"]["$get"]
>[number];

export interface WhisperModelDef {
  id: string;
  displayName: string;
  sizeBytes: number;
  ramRequired: string;
  speed: string;
  quality: string;
  quantized: boolean;
}

/** One entry of GET /api/mlx-asr/status modelDefinitions. `custom` marks a model the user added. */
export type MlxModelDef = ApiRes<
  ApiClient["api"]["mlx-asr"]["status"]["$get"]
>["modelDefinitions"][number];

/** GET /api/mlx-llm/status: the built-in local LLM (specs/local-mlx-llm.md 3.5). */
export type MlxLlmStatus = ApiRes<
  ApiClient["api"]["mlx-llm"]["status"]["$get"]
>;

/** GET /api/mlx-embed/status: the built-in search model (specs/local-semantic-search.md 5.5). */
export type MlxEmbedStatus = ApiRes<
  ApiClient["api"]["mlx-embed"]["status"]["$get"]
>;

/** The provider id of the built-in local LLM. */
export const MLX_LLM_PROVIDER_ID = "local-mlx-llm";

/** The engine of a local model row: whisper.cpp, MLX speech or the MLX LLM. */
export type LocalEngine = "whisper" | "mlx" | "mlx-llm";

export interface WhisperModelDownloadState {
  model: string;
  fileName?: string;
  sizeBytes?: number;
  displayName?: string;
  status: "not_downloaded" | "downloading" | "verifying" | "ready" | "error";
  phase?: "building_binary" | "downloading_model";
  downloadProgress?: {
    bytesDownloaded: number;
    bytesTotal: number;
    percent: number;
    speedBps: number;
  };
  error?: string;
  /** URL to open in a browser to clear a proxy/coaching interception. */
  errorSourceUrl?: string;
}

export interface WhisperStatus {
  binaryDownloading: boolean;
  models: WhisperModelDownloadState[];
  modelDefinitions: WhisperModelDef[];
}

export interface MlxAsrStatus {
  platformSupported: boolean;
  canRun: boolean;
  blockedReason: string | null;
  keepAliveMinutes: number;
  runtime?: {
    available: boolean;
    downloading: boolean;
    url: string | null;
    downloadProgress?: WhisperModelDownloadState["downloadProgress"];
    error?: string;
  };
  models: WhisperModelDownloadState[];
  modelDefinitions: MlxModelDef[];
  setupHint: string | null;
  /** The aligner helper model (spec 3.6): the meeting row's word-timing
   * status line. Never in `models`/`modelDefinitions` (not a picker item). */
  aligner?: {
    status: "not_downloaded" | "downloading" | "ready" | "error";
    downloadProgress?: {
      bytesDownloaded: number;
      bytesTotal: number;
      percent: number;
      speedBps: number;
    };
    error?: string;
  } | null;
}

/** True while any local model is downloading or verifying. */
export function hasActiveDownload(
  models: { status: string }[] | undefined | null,
): boolean {
  return !!models?.some(
    (m) => m.status === "downloading" || m.status === "verifying",
  );
}

export const CLOUD_VOICE_PROVIDERS = [
  "openai",
  "groq",
  "deepgram",
  "elevenlabs",
  "soniox",
];

export const VOICE_PROVIDERS = [
  ...CLOUD_VOICE_PROVIDERS,
  "local-whisper",
  "local-mlx",
];

export const LLM_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "groq",
  "mistral",
  "openrouter",
  "vercel",
];

export const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  groq: "Groq",
  deepgram: "Deepgram",
  elevenlabs: "ElevenLabs",
  soniox: "Soniox",
  mistral: "Mistral",
  openrouter: "OpenRouter",
  vercel: "Vercel AI Gateway",
  "local-whisper": "Local Whisper",
  "local-mlx": "Local MLX",
  "local-mlx-llm": "Local MLX",
};

/** Where to create an API key, linked from the key-entry views. */
export const PROVIDER_KEY_URLS: Record<string, string> = {
  openai: "https://platform.openai.com/api-keys",
  groq: "https://console.groq.com/keys",
  deepgram: "https://console.deepgram.com",
  elevenlabs: "https://elevenlabs.io/app/settings/api-keys",
  soniox: "https://console.soniox.com",
  anthropic: "https://console.anthropic.com/settings/keys",
  google: "https://aistudio.google.com/apikey",
  mistral: "https://console.mistral.ai/api-keys",
  openrouter: "https://openrouter.ai/keys",
  vercel: "https://vercel.com/d?to=%2F%5Bteam%5D%2F~%2Fai-gateway%2Fapi-keys",
};

export function displayProviderName(
  providerId: string,
  fallback?: string,
): string {
  return PROVIDER_DISPLAY_NAMES[providerId] ?? fallback ?? providerId;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

/** The key of one model in the disk use list: `<engine>:<catalog id>`. */
export function diskUseKey(engine: string, defId: string): string {
  return `${engine}:${defId}`;
}

/**
 * The name of the model that becomes the default after the delete of the
 * selected model: the recommended model of the type, when it is on disk and
 * is not the deleted model. Null means the type has no model after the
 * delete. The server applies the same rule.
 */
export function fallbackAfterDelete(
  items: { key: string; name: string; status?: string }[],
  recommendedKey: string | undefined,
  deletedKey: string,
): string | null {
  if (!recommendedKey || recommendedKey === deletedKey) return null;
  const item = items.find((it) => it.key === recommendedKey);
  return item?.status === "ready" ? item.name : null;
}

export function formatSpeed(bps: number): string {
  if (bps < 1_000_000) return `${(bps / 1_000).toFixed(0)} KB/s`;
  return `${(bps / 1_000_000).toFixed(1)} MB/s`;
}

export interface VoiceItem {
  key: string;
  kind: "local" | "cloud";
  /** Which on-device engine powers this row (whisper.cpp vs MLX). */
  localEngine?: "whisper" | "mlx";
  name: string;
  provider: string;
  modelId: string;
  speed?: number;
  quality?: number;
  quantized?: boolean;
  note?: string;
  /** The user added this MLX model from Hugging Face. */
  custom?: boolean;
  selected: boolean;
  defId?: string;
  sizeBytes?: number;
  ram?: string;
  state?: WhisperModelDownloadState;
  status?: WhisperModelDownloadState["status"];
  cost?: number;
  hasKey?: boolean;
  available?: AvailableModel;
}

export const VOICE_META: Record<
  string,
  {
    speed: number;
    quality: number;
    cost?: number;
    note?: string;
  }
> = {
  "groq/whisper-large-v3-turbo": {
    speed: 5,
    quality: 3,
    cost: 0.04,
    note: "Fastest and cheapest Groq Whisper option",
  },
  "groq/whisper-large-v3": {
    speed: 4,
    quality: 4,
    cost: 0.111,
    note: "Highest-accuracy Groq Whisper — supports translation",
  },
  "openai/gpt-live-transcribe": {
    speed: 5,
    quality: 5,
    cost: 1.02,
    note: "OpenAI live streaming model with the lowest delay",
  },
  "openai/gpt-transcribe": {
    speed: 3,
    quality: 5,
    cost: 0.27,
    note: "Most accurate OpenAI model for files and committed turns",
  },
  "openai/gpt-4o-transcribe": {
    speed: 3,
    quality: 4,
    cost: 0.18,
    note: "Legacy: OpenAI removes it on 2027-02-26. Use GPT Transcribe.",
  },
  "deepgram/nova-3": {
    speed: 4,
    quality: 4,
    cost: 0.26,
    note: "Fast, accurate multilingual model",
  },
  "elevenlabs/scribe_v2_realtime": {
    speed: 4,
    quality: 4,
    cost: 0.4,
    note: "Excellent across 99 languages",
  },
  "soniox/stt-rt-v5": {
    speed: 5,
    quality: 5,
    cost: 0.12,
    note: "Fast multilingual streaming",
  },
};

export const SPEED_RANK: Record<string, number> = {
  Fastest: 5,
  "Very Fast": 5,
  Fast: 4,
  Medium: 3,
  Slow: 2,
};

export const QUALITY_RANK: Record<string, number> = {
  Basic: 1,
  Good: 2,
  Better: 3,
  High: 4,
  Best: 5,
};

export const LOCAL_VOICE_NOTES: Record<string, string> = {
  "base-q5_1": "Light and quick — good for older machines",
  "small-q5_1": "Solid everyday accuracy",
  large: "Most accurate on-device option",
  "qwen3-0.6b-8bit": "Fast, accurate, runs privately on your Mac",
  "qwen3-1.7b-8bit": "Highest on-device accuracy",
  "parakeet-tdt-0.6b-v3": "Very fast · 25 languages · no custom vocabulary",
};

export function buildVoiceItems(
  available: AvailableModel[],
  whisperStatus: WhisperStatus | null,
  mlxStatus: MlxAsrStatus | null,
  ctx: {
    selectedModelId?: string;
    selectedProvider?: string;
    selectedWhisperModelId?: string;
    selectedMlxModelId?: string;
    keyProviders: Set<string>;
  },
): VoiceItem[] {
  const whisperLocal: VoiceItem[] = (whisperStatus?.modelDefinitions ?? []).map(
    (def) => {
      const state = whisperStatus?.models.find((m) => m.model === def.id);
      const modelId = `local-whisper/${def.id}`;
      return {
        key: modelId,
        kind: "local",
        localEngine: "whisper",
        name: def.displayName,
        provider: "On-device",
        modelId,
        speed: SPEED_RANK[def.speed] ?? 3,
        quality: QUALITY_RANK[def.quality] ?? 3,
        quantized: def.quantized,
        note: LOCAL_VOICE_NOTES[def.id],
        defId: def.id,
        sizeBytes: def.sizeBytes,
        ram: def.ramRequired,
        state,
        status: state?.status ?? "not_downloaded",
        selected:
          ctx.selectedWhisperModelId === def.id ||
          (ctx.selectedProvider === "local-whisper" &&
            ctx.selectedModelId === modelId),
      };
    },
  );

  const mlxLocal: VoiceItem[] =
    mlxStatus?.platformSupported === false
      ? []
      : (mlxStatus?.modelDefinitions ?? []).map((def) => {
          const modelId = `local-mlx/${def.id}`;
          const canRun = mlxStatus?.canRun ?? false;
          const state = mlxStatus?.models?.find((m) => m.model === def.id);
          const fallbackState: WhisperModelDownloadState | undefined = canRun
            ? {
                model: def.id,
                sizeBytes: def.sizeBytes,
                displayName: def.displayName,
                status: "not_downloaded",
              }
            : {
                model: def.id,
                sizeBytes: def.sizeBytes,
                displayName: def.displayName,
                status: "error" as const,
                error:
                  mlxStatus?.blockedReason ??
                  mlxStatus?.setupHint ??
                  "MLX setup required",
              };
          const resolvedState = state ?? fallbackState;
          return {
            key: modelId,
            kind: "local",
            localEngine: "mlx",
            name: def.displayName,
            provider: "On-device · MLX",
            modelId,
            speed: SPEED_RANK[def.speed] ?? 4,
            quality: QUALITY_RANK[def.quality] ?? 4,
            quantized: def.quantized,
            // A custom model has no curated note: its meta line names the repo.
            note: canRun
              ? (LOCAL_VOICE_NOTES[def.id] ??
                (def.custom ? def.hfId : undefined))
              : undefined,
            custom: def.custom !== undefined,
            defId: def.id,
            sizeBytes: def.sizeBytes,
            ram: def.ramRequired,
            status: resolvedState?.status ?? "not_downloaded",
            state: resolvedState,
            selected:
              ctx.selectedMlxModelId === def.id ||
              (ctx.selectedProvider === "local-mlx" &&
                ctx.selectedModelId === modelId),
          };
        });

  const seen = new Set<string>();
  const cloud: VoiceItem[] = [];
  for (const m of available) {
    if (m.type !== "voice") continue;
    if (m.provider_id === "local-whisper") continue;
    if (m.provider_id === "local-mlx") continue;
    if (!VOICE_PROVIDERS.includes(m.provider_id)) continue;
    if (seen.has(m.model_id)) continue;
    seen.add(m.model_id);
    const meta = VOICE_META[m.model_id];
    cloud.push({
      key: m.model_id,
      kind: "cloud",
      name: m.model_name,
      provider: displayProviderName(m.provider_id, m.provider_name),
      modelId: m.model_id,
      speed: meta?.speed,
      quality: meta?.quality,
      cost: meta?.cost,
      note: meta?.note,
      hasKey: ctx.keyProviders.has(m.provider_id),
      available: m,
      selected:
        ctx.selectedProvider === m.provider_id &&
        ctx.selectedModelId === m.model_id,
    });
  }

  cloud.sort((a, b) => {
    const am = VOICE_META[a.modelId] ? 0 : 1;
    const bm = VOICE_META[b.modelId] ? 0 : 1;
    return am - bm;
  });

  return [...whisperLocal, ...mlxLocal, ...cloud];
}

/** How well a built-in LLM fits this Mac (specs/llm-runtime-tuning.md 5). */
export type MlxLlmFit = MlxLlmStatus["models"][number]["fit"];

const GIB = 1024 ** 3;

/**
 * Memory as Apple names it on a Mac: GiB, with the label "GB". A 16 GiB Mac
 * is a "16 GB" Mac.
 */
export function formatMemoryGb(bytes: number, digits = 0): string {
  return (bytes / GIB).toFixed(digits);
}

/**
 * A "Won't fit" row waits behind "Show all models". A row that is on disk,
 * downloading, failed or selected always shows, so it can be used or deleted.
 */
export function hiddenByFit(item: {
  fit: MlxLlmFit;
  status: WhisperModelDownloadState["status"];
  selected: boolean;
}): boolean {
  return (
    item.fit.label === "wont_fit" &&
    item.status === "not_downloaded" &&
    !item.selected
  );
}

/** One row of the built-in LLM list (specs/local-mlx-llm.md section 4). */
export interface LocalLlmItem {
  key: string;
  defId: string;
  name: string;
  sizeBytes: number;
  recommended: boolean;
  selected: boolean;
  status: WhisperModelDownloadState["status"];
  state: WhisperModelDownloadState;
  fit: MlxLlmFit;
}

/**
 * The built-in LLM rows. They are empty when the Mac cannot run MLX. A row is
 * selected only when the default LLM is that model.
 */
export function buildLocalLlmItems(
  status: MlxLlmStatus | null,
  defaultLlm: { provider: string; model_id: string } | undefined,
): LocalLlmItem[] {
  if (!status?.platformSupported) return [];
  return status.models.map((m) => {
    const key = `${MLX_LLM_PROVIDER_ID}/${m.model}`;
    return {
      key,
      defId: m.model,
      name: m.displayName,
      sizeBytes: m.sizeBytes,
      recommended: m.recommended,
      selected:
        defaultLlm?.provider === MLX_LLM_PROVIDER_ID &&
        defaultLlm.model_id === key,
      status: m.status,
      state: m,
      fit: m.fit,
    };
  });
}

export interface ConfiguredModel {
  id: number;
  provider: string;
  model_id: string;
  model_name: string;
  type: string;
  is_default: number;
}

export interface ApiKeyEntry {
  provider: string;
  created_at: string;
  status: "valid" | "invalid" | "unknown";
  /** Masked last-4 preview (e.g. "…a4F2") so keys are tellable apart. */
  hint?: string;
}
