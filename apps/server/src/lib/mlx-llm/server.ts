import {
  clampMlxKeepAliveMinutes,
  MLX_LLM_KEEP_ALIVE_DEFAULT_MINUTES,
  SETTINGS_KEYS,
} from "@openstyle/validations";
import { readSetting } from "../db.js";
import {
  createMlxHttpWorker,
  type MlxHttpWorkerState,
} from "../mlx-asr/http-worker.js";
import { isHfSnapshotPresent } from "../mlx-asr/models.js";
import type { MlxSetupBlocker } from "../mlx-asr/python.js";
import { getMlxLlmModel } from "./constants.js";

// The LLM worker process (specs/local-mlx-llm.md 3.3). The same binary as the
// speech worker, started a second time with `--llm`. It serves an
// OpenAI-style HTTP API on 127.0.0.1:<port>. The lifecycle is the shared
// MLX HTTP worker (mlx-asr/http-worker.ts).

export type MlxLlmWorkerState = MlxHttpWorkerState;

export function getMlxLlmKeepAliveMinutes(): number {
  try {
    const value = readSetting(SETTINGS_KEYS.mlxLlmKeepAliveMinutes);
    const n = Number(value);
    if (value === undefined || value === "" || !Number.isFinite(n)) {
      return MLX_LLM_KEEP_ALIVE_DEFAULT_MINUTES;
    }
    return clampMlxKeepAliveMinutes(n);
  } catch {
    return MLX_LLM_KEEP_ALIVE_DEFAULT_MINUTES;
  }
}

const worker = createMlxHttpWorker({
  logName: "mlx-llm",
  label: "LLM",
  // TRUSTED-OPERATOR-ONLY escape hatch, same class as OPENSTYLE_MLX_ASR_WORKER:
  // spawn this binary as the LLM worker and skip the managed runtime. Tests and
  // isolated proofs use it. Never set it from untrusted input.
  overrideEnv: "OPENSTYLE_MLX_LLM_WORKER",
  getModel: getMlxLlmModel,
  isDownloaded: (def) => isHfSnapshotPresent(def.hfId),
  workerArgs: (def, port) => [
    "--llm",
    "--model",
    def.hfId,
    "--port",
    String(port),
  ],
  keepAliveMinutes: getMlxLlmKeepAliveMinutes,
});

export function mlxLlmWorkerOverride(): string | undefined {
  return worker.override();
}

/** Why the LLM worker cannot run now, or null when it can. */
export function mlxLlmSetupBlocker(): MlxSetupBlocker | null {
  return worker.setupBlocker();
}

export function getMlxLlmWorkerState(): MlxLlmWorkerState {
  return worker.getState();
}

/**
 * Start (or reuse) the worker for `modelId` and return its OpenAI base URL.
 * A different model stops the current worker first. A model that is not on
 * disk is an error, so no request goes to a missing model (G4).
 */
export async function ensureMlxLlmWorker(
  modelId: string,
): Promise<{ baseURL: string; hfId: string }> {
  const { baseURL, def } = await worker.ensure(modelId);
  return { baseURL, hfId: def.hfId };
}

/** Start the worker without waiting (POST /server/start). */
export function startMlxLlmInBackground(modelId: string): void {
  worker.startInBackground(modelId);
}

/**
 * Wrap the provider fetch: a request in flight holds the worker, and the
 * idle unload starts again after the last one ends.
 */
export function trackMlxLlmFetch(
  inner: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return worker.trackFetch(inner);
}

/** Run after a change of the keep-alive setting. */
export function applyMlxLlmRetentionPolicy(): void {
  worker.applyRetentionPolicy();
}

/** Stop the worker. It also clears the last start error. */
export function stopMlxLlmWorker(): Promise<void> {
  return worker.stop();
}
