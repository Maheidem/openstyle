import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getMlxAsrModel, hfRepoCacheDir } from "./mlx-asr/constants.js";
import { getAllMlxModelStatuses } from "./mlx-asr/models.js";
import { MLX_EMBED_MODELS } from "./mlx-embed/constants.js";
import { getMlxEmbedModelStatus } from "./mlx-embed/models.js";
import { MLX_LLM_MODELS } from "./mlx-llm/constants.js";
import { getMlxLlmModelStatus } from "./mlx-llm/models.js";
import { getModelPath } from "./whisper/constants.js";
import { getCatalogModels, getModelStatus } from "./whisper/models.js";

/**
 * The disk use of one path, in bytes, as `du` counts it: the allocated
 * blocks (512 bytes each) of every file, folder and link under the path.
 * The walk does not follow links, and it counts a hard-linked file once.
 * A path that does not exist uses 0 bytes.
 */
export function diskUsageBytes(path: string): number {
  const seen = new Set<string>();
  const walk = (p: string): number => {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(p);
    } catch {
      return 0;
    }
    const inode = `${st.dev}:${st.ino}`;
    if (seen.has(inode)) return 0;
    seen.add(inode);
    let total = st.blocks * 512;
    if (st.isDirectory()) {
      let names: string[] = [];
      try {
        names = readdirSync(p);
      } catch {
        // An unreadable folder counts with its own blocks only.
      }
      for (const name of names) total += walk(join(p, name));
    }
    return total;
  };
  return walk(path);
}

/** The engine names are the same as `LocalEngine` in the renderer. */
export type LocalModelEngine = "whisper" | "mlx" | "mlx-llm" | "mlx-embed";

export interface ModelDiskUse {
  engine: LocalModelEngine;
  /** The catalog id of the model. */
  model: string;
  bytes: number;
}

/**
 * The disk use of every downloaded app model: the built-in LLMs, the voice
 * models (MLX and whisper) and the search models. A model that is not ready
 * (not on disk, or in a download) is not in the list. The aligner helper is
 * not a model the person picks, so it is not in the list either.
 */
export function listModelDiskUse(): {
  models: ModelDiskUse[];
  totalBytes: number;
} {
  const models: ModelDiskUse[] = [];
  const add = (engine: LocalModelEngine, model: string, path: string) => {
    models.push({ engine, model, bytes: diskUsageBytes(path) });
  };

  for (const def of MLX_LLM_MODELS) {
    if (getMlxLlmModelStatus(def.id)?.status === "ready") {
      add("mlx-llm", def.id, hfRepoCacheDir(def.hfId));
    }
  }
  for (const state of getAllMlxModelStatuses()) {
    const def = getMlxAsrModel(state.model);
    if (def && state.status === "ready") {
      add("mlx", def.id, hfRepoCacheDir(def.hfId));
    }
  }
  for (const def of MLX_EMBED_MODELS) {
    if (getMlxEmbedModelStatus(def.id)?.status === "ready") {
      add("mlx-embed", def.id, hfRepoCacheDir(def.hfId));
    }
  }
  for (const def of getCatalogModels()) {
    if (getModelStatus(def.id)?.status === "ready") {
      add("whisper", def.id, getModelPath(def));
    }
  }
  return {
    models,
    totalBytes: models.reduce((sum, m) => sum + m.bytes, 0),
  };
}
