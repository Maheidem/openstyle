import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { createAppLogger, errorMessage } from "@openstyle/utils";
import {
  clampMlxKeepAliveMinutes,
  MLX_KEEP_ALIVE_ALWAYS,
  MLX_LLM_KEEP_ALIVE_DEFAULT_MINUTES,
  SETTINGS_KEYS,
} from "@openstyle/validations";
import { readSetting } from "../db.js";
import {
  isAppleSiliconMac,
  MLX_UNSUPPORTED_PLATFORM_REASON,
} from "../mlx-asr/constants.js";
import { isHfSnapshotPresent } from "../mlx-asr/models.js";
import {
  findPythonExecutable,
  getMlxAsrServerScriptPath,
  getMlxAsrWorkerPath,
  isMlxAudioInstalled,
  type MlxSetupBlocker,
  mlxSetupBlocker,
} from "../mlx-asr/python.js";
import { updateManagedMlxRuntimeIfNeeded } from "../mlx-asr/runtime.js";
import { getMlxLlmModel } from "./constants.js";

// The LLM worker process (specs/local-mlx-llm.md 3.3). The same binary as the
// speech worker, started a second time with `--llm`. It serves an
// OpenAI-style HTTP API on 127.0.0.1:<port>. The lifecycle follows
// mlx-asr/server.ts: one serialized start chain, a ready timeout, SIGTERM then
// SIGKILL, stop on host exit, and an idle unload.

const log = createAppLogger("mlx-llm");
const START_TIMEOUT_MS = 180_000;
const KILL_AFTER_MS = 5_000;

export type MlxLlmWorkerPhase = "stopped" | "starting" | "ready" | "error";

export interface MlxLlmWorkerState {
  /** Catalog id of the loaded or loading model. null when stopped. */
  model: string | null;
  state: MlxLlmWorkerPhase;
  port: number | null;
  /** The last start failure. Cleared by the next start. */
  error?: string;
}

let workerProcess: ChildProcess | null = null;
let currentModelId: string | null = null;
let workerPort: number | null = null;
let workerReady = false;
let startPromise: Promise<void> | null = null;
let lastError: { model: string; message: string } | null = null;
let inFlight = 0;
let unloadTimer: ReturnType<typeof setTimeout> | null = null;
let lifecyclePromise: Promise<void> = Promise.resolve();

process.once("exit", () => {
  try {
    workerProcess?.kill("SIGTERM");
  } catch {
    // Best effort during process teardown.
  }
});

/**
 * TRUSTED-OPERATOR-ONLY escape hatch, same class as OPENSTYLE_MLX_ASR_WORKER:
 * spawn this binary as the LLM worker and skip the managed runtime. Tests and
 * isolated proofs use it. Never set it from untrusted input.
 */
export function mlxLlmWorkerOverride(): string | undefined {
  return process.env.OPENSTYLE_MLX_LLM_WORKER || undefined;
}

/** Why the LLM worker cannot run now, or null when it can. */
export function mlxLlmSetupBlocker(): MlxSetupBlocker | null {
  if (!isAppleSiliconMac()) {
    return {
      code: "unsupported-platform",
      message: MLX_UNSUPPORTED_PLATFORM_REASON,
    };
  }
  const override = mlxLlmWorkerOverride();
  if (override && existsSync(override)) return null;
  return mlxSetupBlocker();
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

export function getMlxLlmWorkerState(): MlxLlmWorkerState {
  if (workerProcess && workerReady) {
    return { model: currentModelId, state: "ready", port: workerPort };
  }
  if (startPromise) {
    return { model: currentModelId, state: "starting", port: null };
  }
  if (lastError) {
    return {
      model: lastError.model,
      state: "error",
      port: null,
      error: lastError.message,
    };
  }
  return { model: null, state: "stopped", port: null };
}

/**
 * Start (or reuse) the worker for `modelId` and return its OpenAI base URL.
 * A different model stops the current worker first. A model that is not on
 * disk is an error, so no request goes to a missing model (G4).
 */
export function ensureMlxLlmWorker(
  modelId: string,
): Promise<{ baseURL: string; hfId: string }> {
  const run = lifecyclePromise.then(() => ensureLocked(modelId));
  lifecyclePromise = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function ensureLocked(
  modelId: string,
): Promise<{ baseURL: string; hfId: string }> {
  const def = getMlxLlmModel(modelId);
  if (!def) throw new Error(`Unknown local MLX LLM model: ${modelId}`);
  clearUnloadTimer();

  if (!(workerProcess && currentModelId === modelId && workerReady)) {
    await stopMlxLlmWorker();
    if (!isHfSnapshotPresent(def.hfId)) {
      throw new Error(
        `The local model ${def.displayName} is not downloaded. Download it under Models.`,
      );
    }
    currentModelId = modelId;
    lastError = null;
    const promise = startWorker(def.hfId);
    startPromise = promise;
    try {
      await promise;
    } catch (err) {
      lastError = { model: modelId, message: errorMessage(err) };
      throw err;
    } finally {
      if (startPromise === promise) startPromise = null;
    }
  }

  // Keep-alive 0 unloads after a request, not before the first one.
  if (inFlight === 0 && getMlxLlmKeepAliveMinutes() !== 0) scheduleUnload();
  return { baseURL: `http://127.0.0.1:${workerPort}/v1`, hfId: def.hfId };
}

/** Start the worker without waiting (POST /server/start). */
export function startMlxLlmInBackground(modelId: string): void {
  ensureMlxLlmWorker(modelId)
    .then(() => log.info("LLM worker ready"))
    .catch((err: Error) =>
      log.error(`LLM worker start failed: ${err.message}`),
    );
}

/**
 * Wrap the provider fetch: a request in flight holds the worker, and the
 * idle unload starts again after the last one ends.
 */
export function trackMlxLlmFetch(
  inner: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    inFlight++;
    clearUnloadTimer();
    try {
      return await inner(input, init);
    } finally {
      inFlight = Math.max(0, inFlight - 1);
      if (inFlight === 0) scheduleUnload();
    }
  };
}

/** Run after a change of the keep-alive setting. */
export function applyMlxLlmRetentionPolicy(): void {
  if (!workerProcess || inFlight > 0 || startPromise) return;
  scheduleUnload();
}

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen({ port: 0, host: "127.0.0.1" }, () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

interface LaunchCandidate {
  label: string;
  command: string;
  args: string[];
}

function launchCandidates(hfId: string, port: number): LaunchCandidate[] {
  const workerArgs = ["--llm", "--model", hfId, "--port", String(port)];
  const override = mlxLlmWorkerOverride();
  if (override && existsSync(override)) {
    log.warn(
      `OPENSTYLE_MLX_LLM_WORKER is set: running the operator binary at ${override}. Unset it for normal use.`,
    );
    return [{ label: "operator worker", command: override, args: workerArgs }];
  }

  const out: LaunchCandidate[] = [];
  const workerPath = getMlxAsrWorkerPath();
  if (workerPath && existsSync(workerPath)) {
    out.push({
      label: "bundled worker",
      command: workerPath,
      args: workerArgs,
    });
  }
  const python = findPythonExecutable();
  const script = getMlxAsrServerScriptPath();
  if (python && script && existsSync(script) && isMlxAudioInstalled(python)) {
    out.push({
      label: "python script",
      command: python,
      args: [script, ...workerArgs],
    });
  }
  return out;
}

async function startWorker(hfId: string): Promise<void> {
  if (!mlxLlmWorkerOverride()) {
    await updateManagedMlxRuntimeIfNeeded().catch((err) => {
      log.warn(
        `Failed to refresh managed runtime before LLM worker start: ${errorMessage(err)}`,
      );
    });
  }

  const port = await reservePort();
  const candidates = launchCandidates(hfId, port);
  if (candidates.length === 0) {
    throw new Error(
      mlxLlmSetupBlocker()?.message ??
        "The MLX worker for the local LLM was not found.",
    );
  }

  let lastErr: Error | null = null;
  for (const candidate of candidates) {
    try {
      await spawnAndWaitReady(candidate, port);
      log.debug(`LLM worker started via ${candidate.label} on port ${port}`);
      return;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      await stopMlxLlmWorker();
      log.debug(`${candidate.label} failed: ${lastErr.message}`);
    }
  }
  throw lastErr ?? new Error("The local LLM worker did not start.");
}

function spawnAndWaitReady(
  candidate: LaunchCandidate,
  port: number,
): Promise<void> {
  const proc = spawn(candidate.command, candidate.args, {
    stdio: ["pipe", "pipe", "pipe"],
    // The server downloads the weights. The worker loads from the cache only.
    env: { ...process.env, PYTHONUNBUFFERED: "1", HF_HUB_OFFLINE: "1" },
  });
  workerProcess = proc;
  workerReady = false;
  workerPort = port;

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let buffer = "";
    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (err) reject(err);
      else resolve();
    };

    const timeout = setTimeout(() => {
      settle(
        new Error(
          `The local LLM worker did not start within ${START_TIMEOUT_MS / 1000} seconds.`,
        ),
      );
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, START_TIMEOUT_MS);

    proc.stdout?.on("data", (data: Buffer) => {
      buffer += data.toString();
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        let message: { type?: string; error?: string; port?: number };
        try {
          message = JSON.parse(line);
        } catch {
          log.debug(line);
          continue;
        }
        if (message.type === "ready" && workerProcess === proc) {
          if (typeof message.port === "number") workerPort = message.port;
          workerReady = true;
          settle();
        } else if (message.type === "error") {
          settle(new Error(message.error ?? "The local LLM worker failed."));
        }
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString().trimEnd();
      if (text) log.warn(text);
    });

    proc.on("error", (err) => {
      settle(new Error(`Failed to start the local LLM worker: ${err.message}`));
      if (workerProcess === proc) resetState();
    });

    proc.on("close", (code) => {
      settle(new Error(`The local LLM worker exited: exit code ${code}`));
      if (workerProcess === proc) {
        if (workerReady) log.warn(`LLM worker exited: exit code ${code}`);
        resetState();
      }
    });
  });
}

function resetState(): void {
  clearUnloadTimer();
  workerProcess = null;
  currentModelId = null;
  workerPort = null;
  workerReady = false;
}

function clearUnloadTimer(): void {
  if (!unloadTimer) return;
  clearTimeout(unloadTimer);
  unloadTimer = null;
}

function scheduleUnload(): void {
  clearUnloadTimer();
  if (!workerProcess || inFlight > 0) return;
  const minutes = getMlxLlmKeepAliveMinutes();
  if (minutes === MLX_KEEP_ALIVE_ALWAYS) return;
  const stop = () => {
    if (inFlight > 0) return;
    stopMlxLlmWorker().catch((err: Error) =>
      log.error(`Failed to unload the LLM worker: ${err.message}`),
    );
  };
  if (minutes <= 0) {
    stop();
    return;
  }
  unloadTimer = setTimeout(stop, minutes * 60_000);
  unloadTimer.unref?.();
}

/** Stop the worker. It also clears the last start error. */
export async function stopMlxLlmWorker(): Promise<void> {
  lastError = null;
  const proc = workerProcess;
  if (!proc) return;
  resetState();

  await new Promise<void>((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }
    const killTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve();
    }, KILL_AFTER_MS);
    proc.once("close", () => {
      clearTimeout(killTimer);
      resolve();
    });
    try {
      proc.stdin?.end();
      proc.kill("SIGTERM");
    } catch {
      clearTimeout(killTimer);
      resolve();
    }
  });
}
