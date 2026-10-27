import { createAppLogger, errorMessage } from "@openstyle/utils";
import {
  clampMlxKeepAliveMinutes,
  LLM_TASK_IDS,
  type LlmTaskId,
  MLX_KEEP_ALIVE_ALWAYS,
  MLX_LLM_KEEP_ALIVE_DEFAULT_MINUTES,
  type MlxLlmKeepReady,
  parseMlxLlmKeepReady,
  SETTINGS_KEYS,
} from "@openstyle/validations";
import { readSetting } from "../db.js";
import {
  createMlxHttpWorker,
  type MlxHttpWorker,
  type MlxHttpWorkerState,
  mlxHttpWorkerSetupBlocker,
} from "../mlx-asr/http-worker.js";
import { isHfSnapshotPresent } from "../mlx-asr/models.js";
import type { MlxSetupBlocker } from "../mlx-asr/python.js";
import { getMlxAsrWorkerState } from "../mlx-asr/server.js";
import { stripModelPrefix } from "../model-id.js";
import {
  getMlxLlmModel,
  MLX_LLM_PROVIDER_ID,
  type MlxLlmModelDef,
} from "./constants.js";
import { fitMachine, memoryBudgetBytes } from "./fit.js";
import {
  MlxLlmPoolNoRoomError,
  type PoolMember,
  planPoolStart,
} from "./pool.js";

// The local LLM model pool (specs/llm-runtime-tuning.md section 6, owner
// decision 2026-10-26). One worker process per loaded model: the same binary
// as the speech worker, started with `--llm`. Each serves an OpenAI-style
// HTTP API on 127.0.0.1. The lifecycle of one worker is the shared MLX HTTP
// worker (mlx-asr/http-worker.ts); this file is the map of model id to worker.
//
// - Two tasks with the same model share one worker. A worker runs one
//   request at a time (the worker HTTP server is single-threaded).
// - The dictation model (task `cleanup`) is pinned while dictation uses a
//   local LLM: it is never stopped to make room.
// - Before a start, the sum of P(model) of all workers must fit the memory
//   budget. The pool stops least recently used workers that are not pinned
//   and not busy ("Keep ready" workers last). If the model still does not
//   fit, the start fails with `MlxLlmPoolNoRoomError` (no swap).
// - "Keep ready" per task: the model of that task never unloads when idle.

const log = createAppLogger("mlx-llm-pool");

// TRUSTED-OPERATOR-ONLY escape hatch, same class as OPENSTYLE_MLX_ASR_WORKER:
// spawn this binary as the LLM worker and skip the managed runtime. Tests and
// isolated proofs use it. Never set it from untrusted input.
const OVERRIDE_ENV = "OPENSTYLE_MLX_LLM_WORKER";

/** Metal memory facts from the ready line of the worker (specs/llm-runtime-tuning.md). */
export interface MlxLlmGpuInfo {
  /** The GPU ceiling that mlx-lm wires to (Metal recommendedMaxWorkingSetSize). */
  maxRecommendedWorkingSetBytes: number;
  /** The unified memory size that Metal reports. */
  memoryBytes: number | null;
}

export interface MlxLlmWorkerState extends MlxHttpWorkerState {
  /** From the worker that became ready last. null before the first start. */
  gpu: MlxLlmGpuInfo | null;
}

/** One worker of the pool, for the status API. */
export interface MlxLlmPoolWorkerState extends MlxHttpWorkerState {
  /** The model is the dictation model and dictation uses a local LLM. */
  pinned: boolean;
  /** The tasks with "Keep ready" on that use this model. */
  keepReadyTasks: LlmTaskId[];
  /** True while a request to this worker is in flight. */
  busy: boolean;
  /** The last use (ms since epoch), or null. */
  lastUsedAt: number | null;
}

/** The memory facts of the pool. */
export interface MlxLlmPoolMemory {
  /** P(model) of every loaded or starting worker. */
  usedBytes: number;
  /** The limit: the memory budget, or the GPU cap when it is smaller. */
  limitBytes: number;
}

interface PoolEntry {
  def: MlxLlmModelDef;
  worker: MlxHttpWorker<MlxLlmModelDef>;
  lastUsedAt: number;
}

/** Read the `metal` object of a ready line. Exported for tests. */
export function gpuInfoFromReadyLine(
  line: Record<string, unknown>,
): MlxLlmGpuInfo | null {
  const metal = line.metal;
  if (!metal || typeof metal !== "object") return null;
  const { max_recommended_working_set_size: cap, memory_size: mem } =
    metal as Record<string, unknown>;
  if (typeof cap !== "number" || cap <= 0) return null;
  return {
    maxRecommendedWorkingSetBytes: cap,
    memoryBytes: typeof mem === "number" ? mem : null,
  };
}

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

/** The stored "Keep ready" flags of the three tasks. */
export function getMlxLlmKeepReady(): MlxLlmKeepReady {
  try {
    return parseMlxLlmKeepReady(readSetting(SETTINGS_KEYS.mlxLlmKeepReady));
  } catch {
    return parseMlxLlmKeepReady(null);
  }
}

const pool = new Map<string, PoolEntry>();
/** The smallest GPU cap that a worker reported (section 6 item 7). */
let gpu: MlxLlmGpuInfo | null = null;
/** The catalog model of each task that uses the built-in LLM now. */
let taskModels = new Map<LlmTaskId, string>();
/** Starts (with their eviction) run one at a time. A ready worker never waits here. */
let admission: Promise<void> = Promise.resolve();

function isPinned(modelId: string): boolean {
  return (
    readSetting(SETTINGS_KEYS.llmCleanup) === "true" &&
    taskModels.get("cleanup") === modelId
  );
}

function keepReadyTasks(modelId: string): LlmTaskId[] {
  const flags = getMlxLlmKeepReady();
  return LLM_TASK_IDS.filter(
    (task) => flags[task] && taskModels.get(task) === modelId,
  );
}

/**
 * Idle minutes of one worker. A "Keep ready" model never unloads when idle.
 * The other models use the keep-alive setting.
 */
function keepAliveFor(modelId: string): number {
  return keepReadyTasks(modelId).length > 0
    ? MLX_KEEP_ALIVE_ALWAYS
    : getMlxLlmKeepAliveMinutes();
}

/**
 * Read which built-in model each task uses now. Async: the task resolution
 * imports the provider registry, which imports this file.
 */
async function refreshTaskModels(): Promise<void> {
  const { resolveTaskModel } = await import("../llm/task-profiles.js");
  const next = new Map<LlmTaskId, string>();
  for (const task of LLM_TASK_IDS) {
    try {
      const { provider, modelId } = await resolveTaskModel(task);
      if (provider === MLX_LLM_PROVIDER_ID) {
        next.set(task, stripModelPrefix(MLX_LLM_PROVIDER_ID, modelId));
      }
    } catch {
      // No model for this task: nothing to pin or keep ready.
    }
  }
  taskModels = next;
}

function workerFor(def: MlxLlmModelDef): PoolEntry {
  const existing = pool.get(def.id);
  if (existing) return existing;
  const worker = createMlxHttpWorker<MlxLlmModelDef>({
    logName: "mlx-llm",
    label: "LLM",
    overrideEnv: OVERRIDE_ENV,
    getModel: getMlxLlmModel,
    isDownloaded: (d) => isHfSnapshotPresent(d.hfId),
    // --context-tokens turns on the worker context guard: the worker refuses a
    // request whose prompt + max_tokens is more than the window, with a typed
    // HTTP 400 (specs/llm-runtime-tuning.md 7 step 4). The callers keep each
    // call inside the window first (llm/token-budget.ts), so a refusal is rare.
    workerArgs: (d, port) => [
      "--llm",
      "--model",
      d.hfId,
      "--port",
      String(port),
      "--context-tokens",
      String(d.contextTokens),
    ],
    keepAliveMinutes: () => keepAliveFor(def.id),
    onReady: (line) => {
      // Each worker reports the GPU cap. The pool uses the smallest value.
      const info = gpuInfoFromReadyLine(line);
      if (
        info &&
        (gpu === null ||
          info.maxRecommendedWorkingSetBytes <
            gpu.maxRecommendedWorkingSetBytes)
      ) {
        gpu = info;
      }
    },
  });
  const entry: PoolEntry = { def, worker, lastUsedAt: 0 };
  pool.set(def.id, entry);
  return entry;
}

function isLoaded(entry: PoolEntry): boolean {
  const state = entry.worker.getState().state;
  return state === "ready" || state === "starting";
}

/** The memory limit of the pool (section 6 item 3 and item 7). */
function poolLimitBytes(): number {
  const machine = fitMachine(gpu?.maxRecommendedWorkingSetBytes ?? null);
  const asrLoaded = getMlxAsrWorkerState().state !== "stopped";
  const budget = memoryBudgetBytes(machine.ramBytes, asrLoaded);
  return machine.gpuCapBytes == null
    ? budget
    : Math.min(budget, machine.gpuCapBytes);
}

function poolMembers(): PoolMember[] {
  const out: PoolMember[] = [];
  for (const entry of pool.values()) {
    if (!isLoaded(entry)) continue;
    out.push({
      modelId: entry.def.id,
      peakBytes: entry.def.peakBytes,
      lastUsedAt: entry.lastUsedAt,
      busy: entry.worker.busy() || entry.worker.getState().state === "starting",
      pinned: isPinned(entry.def.id),
      keepReady: keepReadyTasks(entry.def.id).length > 0,
    });
  }
  return out;
}

/** Stop workers until `def` fits, then start it. Runs inside `admission`. */
async function admitAndStart(
  entry: PoolEntry,
): Promise<{ baseURL: string; def: MlxLlmModelDef }> {
  if (entry.worker.getState().state !== "ready") {
    await refreshTaskModels();
    const plan = planPoolStart(
      poolMembers(),
      { modelId: entry.def.id, peakBytes: entry.def.peakBytes },
      poolLimitBytes(),
    );
    if (!plan.ok) {
      log.warn(
        `no room for ${entry.def.id}: ${plan.neededBytes} B needed, limit ${plan.limitBytes} B, in use: ${plan.blockers.join(", ")}`,
      );
      throw new MlxLlmPoolNoRoomError({ modelId: entry.def.id, ...plan });
    }
    for (const modelId of plan.evict) {
      log.info(`stop ${modelId} (least recently used) to load ${entry.def.id}`);
      await pool.get(modelId)?.worker.stop();
    }
  }
  return entry.worker.ensure(entry.def.id);
}

export function mlxLlmWorkerOverride(): string | undefined {
  return process.env[OVERRIDE_ENV] || undefined;
}

/** Why the LLM worker cannot run now, or null when it can. */
export function mlxLlmSetupBlocker(): MlxSetupBlocker | null {
  return mlxHttpWorkerSetupBlocker(OVERRIDE_ENV);
}

/** The state of the worker of `modelId` (stopped when the pool has none). */
function stateOf(modelId: string): MlxHttpWorkerState {
  return (
    pool.get(modelId)?.worker.getState() ?? {
      model: null,
      state: "stopped",
      port: null,
    }
  );
}

/**
 * The state of one model's worker, or, with no model, of the worker used
 * last that is not stopped (the old single-worker shape of the status API).
 */
export function getMlxLlmWorkerState(modelId?: string): MlxLlmWorkerState {
  if (modelId !== undefined) return { ...stateOf(modelId), gpu };
  const entries = [...pool.values()]
    .filter((e) => e.worker.getState().state !== "stopped")
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  const state = entries[0]?.worker.getState() ?? {
    model: null,
    state: "stopped" as const,
    port: null,
  };
  return { ...state, gpu };
}

/** Every worker of the pool that is not stopped. */
export function getMlxLlmPoolWorkers(): MlxLlmPoolWorkerState[] {
  const out: MlxLlmPoolWorkerState[] = [];
  for (const entry of pool.values()) {
    const state = entry.worker.getState();
    if (state.state === "stopped") continue;
    out.push({
      ...state,
      pinned: isPinned(entry.def.id),
      keepReadyTasks: keepReadyTasks(entry.def.id),
      busy: entry.worker.busy(),
      lastUsedAt: entry.lastUsedAt || null,
    });
  }
  return out;
}

export function getMlxLlmPoolMemory(): MlxLlmPoolMemory {
  return {
    usedBytes: poolMembers().reduce((acc, m) => acc + m.peakBytes, 0),
    limitBytes: poolLimitBytes(),
  };
}

/** True while a request to the worker of `modelId` is in flight. */
export function isMlxLlmWorkerBusy(modelId: string): boolean {
  return pool.get(modelId)?.worker.busy() ?? false;
}

/**
 * Start (or reuse) the worker for `modelId` and return its OpenAI base URL.
 * A ready worker answers at once. A start waits for the other starts, then
 * makes room (or throws `MlxLlmPoolNoRoomError`). A model that is not on disk
 * is an error, so no request goes to a missing model (G4).
 */
export async function ensureMlxLlmWorker(
  modelId: string,
): Promise<{ baseURL: string; hfId: string }> {
  const def = getMlxLlmModel(modelId);
  if (!def) throw new Error(`Unknown local MLX LLM model: ${modelId}`);
  const entry = workerFor(def);
  entry.lastUsedAt = Date.now();
  if (entry.worker.getState().state === "ready") {
    const { baseURL } = await entry.worker.ensure(modelId);
    return { baseURL, hfId: def.hfId };
  }
  const run = admission.then(() => admitAndStart(entry));
  admission = run.then(
    () => undefined,
    () => undefined,
  );
  const { baseURL } = await run;
  return { baseURL, hfId: def.hfId };
}

/** Start the worker without waiting (POST /server/start). */
export function startMlxLlmInBackground(modelId: string): void {
  ensureMlxLlmWorker(modelId)
    .then(() => log.info(`LLM worker ready: ${modelId}`))
    .catch((err) =>
      log.error(`LLM worker start failed: ${modelId}: ${errorMessage(err)}`),
    );
}

/**
 * Wrap the provider fetch of `modelId`: a request in flight holds the worker
 * (busy, never evicted), and the idle unload starts again after the last one
 * ends.
 */
export function trackMlxLlmFetch(
  modelId: string,
  inner: typeof globalThis.fetch,
): typeof globalThis.fetch {
  const def = getMlxLlmModel(modelId);
  if (!def) return inner;
  const entry = workerFor(def);
  const tracked = entry.worker.trackFetch(inner);
  return async (input, init) => {
    entry.lastUsedAt = Date.now();
    try {
      return await tracked(input, init);
    } finally {
      entry.lastUsedAt = Date.now();
    }
  };
}

/**
 * Run after a change of the keep-alive, the "Keep ready" flags or the task
 * models: each worker gets its new idle time.
 */
export function applyMlxLlmRetentionPolicy(): void {
  refreshTaskModels()
    .catch(() => {})
    .then(() => {
      for (const entry of pool.values()) entry.worker.applyRetentionPolicy();
    });
}

/**
 * Stop the worker of `modelId`, or every worker when no model is given.
 * It also clears the last start error.
 */
export async function stopMlxLlmWorker(modelId?: string): Promise<void> {
  const entries =
    modelId === undefined
      ? [...pool.values()]
      : [pool.get(modelId)].filter((e): e is PoolEntry => !!e);
  await Promise.all(entries.map((e) => e.worker.stop()));
}
