import { totalmem } from "node:os";
import { SETTINGS_KEYS } from "@openstyle/validations";
import { readSetting } from "../db.js";
import {
  createMlxHttpWorker,
  type MlxHttpWorkerState,
} from "../mlx-asr/http-worker.js";
import { isHfSnapshotPresent } from "../mlx-asr/models.js";
import type { MlxSetupBlocker } from "../mlx-asr/python.js";
import { getMlxEmbedModel, type MlxEmbedModelDef } from "./constants.js";

// The embedding worker process (specs/local-semantic-search.md 5.4, S9). Its
// own process (`--embed`), not a route of the LLM worker: search works with
// no LLM (D6), and a search query must not wait behind a long generation.
// The lifecycle is the shared MLX HTTP worker (mlx-asr/http-worker.ts).

/** Idle minutes before the unload (spec 5.4). */
const IDLE_MINUTES = 5;
/**
 * Macs with 8 GiB RAM or less unload after 30 s idle. The LLM worker alone
 * used 3.1 GiB RSS with Qwen3.5 4B (specs/local-mlx-llm.md).
 */
const LOW_RAM_IDLE_MINUTES = 0.5;
const LOW_RAM_BYTES = 8 * 1024 ** 3;

export interface MlxEmbedWorkerState extends MlxHttpWorkerState {
  /** Vector size from the ready line of the running worker. null when not ready. */
  dims: number | null;
}

export function mlxEmbedIdleMinutes(): number {
  return totalmem() <= LOW_RAM_BYTES ? LOW_RAM_IDLE_MINUTES : IDLE_MINUTES;
}

let readyDims: number | null = null;

const worker = createMlxHttpWorker<MlxEmbedModelDef>({
  logName: "mlx-embed",
  label: "embedding",
  // TRUSTED-OPERATOR-ONLY escape hatch, same class as OPENSTYLE_MLX_LLM_WORKER:
  // spawn this binary as the embedding worker and skip the managed runtime.
  // Tests use it. Never set it from untrusted input.
  overrideEnv: "OPENSTYLE_MLX_EMBED_WORKER",
  getModel: getMlxEmbedModel,
  isDownloaded: (def) => isHfSnapshotPresent(def.hfId, def.revision),
  workerArgs: (def, port) => [
    "--embed",
    "--model",
    def.hfId,
    "--revision",
    def.revision,
    "--port",
    String(port),
  ],
  keepAliveMinutes: mlxEmbedIdleMinutes,
  onReady: (line) => {
    readyDims = typeof line.dims === "number" ? line.dims : null;
  },
});

export function mlxEmbedWorkerOverride(): string | undefined {
  return worker.override();
}

/** Why the embedding worker cannot run now, or null when it can. */
export function mlxEmbedSetupBlocker(): MlxSetupBlocker | null {
  return worker.setupBlocker();
}

export function getMlxEmbedWorkerState(): MlxEmbedWorkerState {
  const state = worker.getState();
  return { ...state, dims: state.state === "ready" ? readyDims : null };
}

/**
 * The catalog id in the setting `search_embedding_model`, or null when it is
 * empty or names a model that is not in the catalog.
 */
export function getSearchEmbeddingModelId(): string | null {
  try {
    const id = readSetting(SETTINGS_KEYS.searchEmbeddingModel);
    return id && getMlxEmbedModel(id) ? id : null;
  } catch {
    return null;
  }
}

/** Start (or reuse) the worker for `modelId`. A model that is not on disk is an error. */
export function ensureMlxEmbedWorker(
  modelId: string,
): Promise<{ baseURL: string; def: MlxEmbedModelDef }> {
  return worker.ensure(modelId);
}

/** Start the worker without waiting (the Use route loads the model once). */
export function startMlxEmbedInBackground(modelId: string): void {
  worker.startInBackground(modelId);
}

/** Wrap a fetch to the worker, so a request in flight holds it. */
export function trackMlxEmbedFetch(
  inner: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return worker.trackFetch(inner);
}

export function stopMlxEmbedWorker(): Promise<void> {
  return worker.stop();
}
