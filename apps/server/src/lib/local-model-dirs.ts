/**
 * Every directory local speech models can occupy on disk.
 *
 * Single source of truth for the Settings → Data disk-usage line (the
 * Electron main process sizes these with an async walk). Kept in its own
 * module because it aggregates the whisper and mlx-asr path families, and
 * those both live under `model-cache.ts`, which must not import them back
 * (import cycle).
 */

import {
  getMlxCacheDir,
  LEGACY_MLX_ASR_MODELS,
  MLX_ASR_MODELS,
} from "./mlx-asr/constants.js";
import { hfRepoCacheDir } from "./mlx-asr/models.js";
import { getBinDir, getModelsDir } from "./whisper/constants.js";

/**
 * Candidate roots for "local models" storage. Missing dirs are simply absent
 * from the filesystem — the caller skips them.
 *
 * Deliberately scoped to *our* Hugging Face repo cache dirs (one per catalog
 * + legacy model) rather than sizing all of `~/.cache/huggingface`: the hub
 * cache is shared with anything else the user runs, and counting foreign
 * downloads in "Local models" would be a lie.
 */
export function getLocalModelCacheDirs(): string[] {
  return [
    // whisper.cpp models and binaries live under the shared app cache.
    getModelsDir(),
    getBinDir(),
    // The MLX ASR worker runtime (also under the shared app cache).
    getMlxCacheDir(),
    // MLX model weights land in the HF hub cache; count only our repos.
    ...[...MLX_ASR_MODELS, ...LEGACY_MLX_ASR_MODELS].map((m) =>
      hfRepoCacheDir(m.hfId),
    ),
  ];
}
