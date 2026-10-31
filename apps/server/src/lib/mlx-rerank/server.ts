import { totalmem } from "node:os";
import { createMlxHttpWorker } from "../mlx-asr/http-worker.js";
import { isHfSnapshotPresent } from "../mlx-asr/models.js";
import type { MlxSetupBlocker } from "../mlx-asr/python.js";
import {
  getMlxRerankModel,
  MLX_RERANK_MODEL_ID,
  type MlxRerankModelDef,
} from "./constants.js";

// The reranker worker process (specs/meeting-chat-agent.md 7.4.3). Its own
// process (`--rerank`), like the embed worker: the same binary, the same
// lifecycle (mlx-asr/http-worker.ts). It never starts for a model that is not
// on disk: a chat turn does not download.

/** Idle minutes before the unload, as the embed worker. */
const IDLE_MINUTES = 5;
/** Macs with 8 GiB RAM or less unload after 30 s idle. */
const LOW_RAM_IDLE_MINUTES = 0.5;
const LOW_RAM_BYTES = 8 * 1024 ** 3;

export function mlxRerankIdleMinutes(): number {
  return totalmem() <= LOW_RAM_BYTES ? LOW_RAM_IDLE_MINUTES : IDLE_MINUTES;
}

const worker = createMlxHttpWorker<MlxRerankModelDef>({
  logName: "mlx-rerank",
  label: "reranker",
  // TRUSTED-OPERATOR-ONLY escape hatch, same class as OPENSTYLE_MLX_EMBED_WORKER:
  // spawn this binary as the reranker worker and skip the managed runtime.
  // Tests use it. Never set it from untrusted input.
  overrideEnv: "OPENSTYLE_MLX_RERANK_WORKER",
  getModel: getMlxRerankModel,
  isDownloaded: (def) => isHfSnapshotPresent(def.hfId, def.revision),
  workerArgs: (def, port) => [
    "--rerank",
    "--model",
    def.hfId,
    "--revision",
    def.revision,
    "--port",
    String(port),
  ],
  keepAliveMinutes: mlxRerankIdleMinutes,
});

export function mlxRerankWorkerOverride(): string | undefined {
  return worker.override();
}

/** Why the reranker worker cannot run now, or null when it can. */
export function mlxRerankSetupBlocker(): MlxSetupBlocker | null {
  return worker.setupBlocker();
}

export function getMlxRerankWorkerState() {
  return worker.getState();
}

/** Start (or reuse) the worker. A model that is not on disk is an error. */
export function ensureMlxRerankWorker(
  modelId: string = MLX_RERANK_MODEL_ID,
): Promise<{ baseURL: string; def: MlxRerankModelDef }> {
  return worker.ensure(modelId);
}

/** Wrap a fetch to the worker, so a request in flight holds it. */
export function trackMlxRerankFetch(
  inner: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return worker.trackFetch(inner);
}

export function stopMlxRerankWorker(): Promise<void> {
  return worker.stop();
}
