import { homedir } from "node:os";
import { join } from "node:path";
import { modelCacheDir } from "../model-cache.js";

export const MLX_ASR_PROVIDER_ID = "local-mlx";

export const MLX_ASR_PROVIDER_NAME = "Local MLX";

export const MLX_UNSUPPORTED_PLATFORM_REASON =
  "Local MLX speech models require macOS on Apple Silicon (M1 or newer).";

export function isAppleSiliconMac(): boolean {
  return process.platform === "darwin" && process.arch === "arm64";
}

export function hfCacheRoot(): string {
  return (
    process.env.HUGGINGFACE_HUB_CACHE ??
    (process.env.HF_HOME
      ? join(process.env.HF_HOME, "hub")
      : join(homedir(), ".cache", "huggingface", "hub"))
  );
}

export function hfRepoCacheDir(hfId: string): string {
  return join(hfCacheRoot(), `models--${hfId.replaceAll("/", "--")}`);
}

/** One expected file of a custom model snapshot (path in the repo, size in bytes). */
export interface CustomMlxFile {
  path: string;
  size: number;
}

export interface MlxAsrModelDef {
  id: string;
  /** Hugging Face repo id passed to mlx-audio `load()`. */
  hfId: string;
  displayName: string;
  /** UI / registry grouping (e.g. qwen3-asr); not sent to the worker. */
  family: string;
  sizeBytes: number;
  ramRequired: string;
  speed: string;
  quality: string;
  quantized: boolean;
  /** Set only for a custom model the user added. Used by the completeness check. */
  custom?: { revision: string; files: CustomMlxFile[] };
}

/** App catalog → passed to the worker as `--model <hfId>`. Any mlx-audio STT repo works. */
export const MLX_ASR_MODELS: MlxAsrModelDef[] = [
  {
    id: "qwen3-0.6b-8bit",
    hfId: "mlx-community/Qwen3-ASR-0.6B-8bit",
    family: "qwen3-asr",
    displayName: "Qwen3 Fast",
    sizeBytes: 1_010_773_761,
    ramRequired: "~1.5 GB",
    speed: "Fast",
    quality: "Better",
    quantized: true,
  },
  {
    id: "qwen3-1.7b-8bit",
    hfId: "mlx-community/Qwen3-ASR-1.7B-8bit",
    family: "qwen3-asr",
    displayName: "Qwen3 Pro",
    sizeBytes: 2_467_859_030,
    ramRequired: "~3 GB",
    speed: "Medium",
    quality: "High",
    quantized: true,
  },
  {
    id: "sensevoice-small",
    hfId: "mlx-community/SenseVoiceSmall",
    family: "sensevoice",
    displayName: "SenseVoice",
    sizeBytes: 936_491_235,
    ramRequired: "~1.5 GB",
    speed: "Fast",
    quality: "High",
    quantized: false,
  },
  {
    id: "parakeet-tdt-0.6b-v3",
    hfId: "mlx-community/parakeet-tdt-0.6b-v3",
    family: "parakeet",
    displayName: "Parakeet",
    sizeBytes: 2_509_044_141,
    ramRequired: "~2.5 GB",
    speed: "Fast",
    quality: "High",
    quantized: false,
  },
];

/**
 * Removed from the catalog but still resolvable so existing installs that
 * picked one keep working. Listed in pickers only while downloaded.
 */
export const LEGACY_MLX_ASR_MODELS: MlxAsrModelDef[] = [
  {
    id: "qwen3-0.6b-5bit",
    hfId: "mlx-community/Qwen3-ASR-0.6B-5bit",
    family: "qwen3-asr",
    displayName: "Qwen3 ASR 0.6B (5-bit)",
    sizeBytes: 787_279_423,
    ramRequired: "~1.5 GB",
    speed: "Very Fast",
    quality: "Better",
    quantized: true,
  },
];

type CustomMlxResolver = (id: string) => MlxAsrModelDef | undefined;

let customResolver: CustomMlxResolver = () => undefined;

/**
 * `custom-models.ts` registers its table lookup here. This file cannot import
 * it, because `models.ts` imports both.
 */
export function setCustomMlxResolver(resolver: CustomMlxResolver): void {
  customResolver = resolver;
}

export function getMlxAsrModel(id: string): MlxAsrModelDef | undefined {
  return (
    MLX_ASR_MODELS.find((m) => m.id === id) ??
    LEGACY_MLX_ASR_MODELS.find((m) => m.id === id) ??
    customResolver(id)
  );
}

export function getMlxCacheDir(): string {
  return modelCacheDir("mlx-asr");
}

export function getMlxRuntimeDir(): string {
  return join(
    getMlxCacheDir(),
    "runtime",
    `${process.platform}-${process.arch}`,
  );
}

export function getManagedMlxWorkerPath(): string {
  return join(getMlxRuntimeDir(), "mlx_asr_worker", "mlx_asr_worker");
}
