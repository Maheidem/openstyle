import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { createAppLogger, errorMessage } from "@openstyle/utils";
import { MLX_KEEP_ALIVE_ALWAYS } from "@openstyle/validations";
import {
  isAppleSiliconMac,
  MLX_UNSUPPORTED_PLATFORM_REASON,
} from "./constants.js";
import {
  findPythonExecutable,
  getMlxAsrServerScriptPath,
  getMlxAsrWorkerPath,
  isMlxAudioInstalled,
  type MlxSetupBlocker,
  mlxSetupBlocker,
} from "./python.js";
import {
  isStaleManagedWorker,
  runtimeUpdatePendingError,
  updateManagedMlxRuntimeIfNeeded,
} from "./runtime.js";

// An HTTP mode of the MLX worker binary (`--llm` in specs/local-mlx-llm.md
// 3.3, `--embed` in specs/local-semantic-search.md 5.4). The same binary as
// the speech worker, started once more in that mode. It serves an
// OpenAI-style HTTP API on 127.0.0.1:<port>. The lifecycle follows
// mlx-asr/server.ts: one serialized start chain, a reserved port,
// HF_HUB_OFFLINE=1, a ready timeout, SIGTERM then SIGKILL, stop on host exit,
// and an idle unload.

const START_TIMEOUT_MS = 180_000;
const KILL_AFTER_MS = 5_000;
/** The stderr text that a start error keeps (its last line names the cause). */
const STDERR_TAIL_CHARS = 2_000;

/**
 * The worker process ended before its ready line, for example an old worker
 * that refuses a new argument ("unrecognized arguments"). Typed, so callers
 * fail at once with a clear state and never wait or retry.
 */
export class MlxWorkerStartError extends Error {
  readonly code = "worker-start-failed";
  constructor(message: string) {
    super(message);
    this.name = "MlxWorkerStartError";
  }
}

export type MlxHttpWorkerPhase = "stopped" | "starting" | "ready" | "error";

export interface MlxHttpWorkerState {
  /** Catalog id of the loaded or loading model. null when stopped. */
  model: string | null;
  state: MlxHttpWorkerPhase;
  port: number | null;
  /** The last start failure. Cleared by the next start. */
  error?: string;
}

/** The ready line of the worker: `{"type":"ready","model":..,"port":..}` plus mode fields. */
export type MlxReadyLine = Record<string, unknown> & { port?: number };

export interface MlxHttpModelDef {
  id: string;
  hfId: string;
  displayName: string;
}

export interface MlxHttpWorkerOptions<D extends MlxHttpModelDef> {
  /** Logger name, for example "mlx-llm". */
  logName: string;
  /** The words in messages, for example "LLM" ("The local LLM worker ..."). */
  label: string;
  /** TRUSTED-OPERATOR-ONLY env var with a worker binary to run instead. */
  overrideEnv: string;
  getModel: (id: string) => D | undefined;
  isDownloaded: (def: D) => boolean;
  /** The worker arguments after the binary (or the script) for `def` on `port`. */
  workerArgs: (def: D, port: number) => string[];
  /** Idle minutes before the unload. 0 unloads after each request. */
  keepAliveMinutes: () => number;
  /** Gets the ready line of each worker that starts. */
  onReady?: (line: MlxReadyLine) => void;
}

export interface MlxHttpWorker<D extends MlxHttpModelDef> {
  override: () => string | undefined;
  setupBlocker: () => MlxSetupBlocker | null;
  getState: () => MlxHttpWorkerState;
  /** True while a request to the worker is in flight. */
  busy: () => boolean;
  /**
   * Start (or reuse) the worker for `modelId` and return its OpenAI base URL.
   * A different model stops the current worker first. A model that is not on
   * disk is an error, so no request goes to a missing model.
   */
  ensure: (modelId: string) => Promise<{ baseURL: string; def: D }>;
  startInBackground: (modelId: string) => void;
  /**
   * Wrap a fetch: a request in flight holds the worker, and the idle unload
   * starts again after the last one ends.
   */
  trackFetch: (inner: typeof globalThis.fetch) => typeof globalThis.fetch;
  /** Run after a change of the keep-alive setting. */
  applyRetentionPolicy: () => void;
  /** Stop the worker. It also clears the last start error. */
  stop: () => Promise<void>;
}

interface LaunchCandidate {
  label: string;
  command: string;
  args: string[];
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

/**
 * Why an HTTP mode worker cannot run now, or null when it can. An existing
 * binary in `overrideEnv` (TRUSTED-OPERATOR-ONLY) skips the runtime check.
 */
export function mlxHttpWorkerSetupBlocker(
  overrideEnv: string,
): MlxSetupBlocker | null {
  if (!isAppleSiliconMac()) {
    return {
      code: "unsupported-platform",
      message: MLX_UNSUPPORTED_PLATFORM_REASON,
    };
  }
  const path = process.env[overrideEnv];
  if (path && existsSync(path)) return null;
  return mlxSetupBlocker();
}

export function createMlxHttpWorker<D extends MlxHttpModelDef>(
  opts: MlxHttpWorkerOptions<D>,
): MlxHttpWorker<D> {
  const log = createAppLogger(opts.logName);
  const what = `local ${opts.label} worker`;

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

  const override = (): string | undefined =>
    process.env[opts.overrideEnv] || undefined;

  function setupBlocker(): MlxSetupBlocker | null {
    return mlxHttpWorkerSetupBlocker(opts.overrideEnv);
  }

  function getState(): MlxHttpWorkerState {
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

  function ensure(modelId: string): Promise<{ baseURL: string; def: D }> {
    const run = lifecyclePromise.then(() => ensureLocked(modelId));
    lifecyclePromise = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function ensureLocked(
    modelId: string,
  ): Promise<{ baseURL: string; def: D }> {
    const def = opts.getModel(modelId);
    if (!def)
      throw new Error(`Unknown local MLX ${opts.label} model: ${modelId}`);
    clearUnloadTimer();

    if (!(workerProcess && currentModelId === modelId && workerReady)) {
      await stop();
      if (!opts.isDownloaded(def)) {
        throw new Error(
          `The local model ${def.displayName} is not downloaded. Download it under Models.`,
        );
      }
      currentModelId = modelId;
      lastError = null;
      const promise = startWorker(def);
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
    if (inFlight === 0 && opts.keepAliveMinutes() !== 0) scheduleUnload();
    return { baseURL: `http://127.0.0.1:${workerPort}/v1`, def };
  }

  function startInBackground(modelId: string): void {
    ensure(modelId)
      .then(() => log.info(`${opts.label} worker ready`))
      .catch((err: Error) =>
        log.error(`${opts.label} worker start failed: ${err.message}`),
      );
  }

  function trackFetch(inner: typeof globalThis.fetch): typeof globalThis.fetch {
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

  function applyRetentionPolicy(): void {
    if (!workerProcess || inFlight > 0 || startPromise) return;
    scheduleUnload();
  }

  function launchCandidates(def: D, port: number): LaunchCandidate[] {
    const workerArgs = opts.workerArgs(def, port);
    const path = override();
    if (path && existsSync(path)) {
      log.warn(
        `${opts.overrideEnv} is set: running the operator binary at ${path}. Unset it for normal use.`,
      );
      return [{ label: "operator worker", command: path, args: workerArgs }];
    }

    const out: LaunchCandidate[] = [];
    const workerPath = getMlxAsrWorkerPath();
    // A managed worker of another version never starts (runtime.ts,
    // isStaleManagedWorker): it can exit on the arguments of this server.
    if (
      workerPath &&
      existsSync(workerPath) &&
      !isStaleManagedWorker(workerPath)
    ) {
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

  async function startWorker(def: D): Promise<void> {
    if (!override()) {
      await updateManagedMlxRuntimeIfNeeded().catch((err) => {
        log.warn(
          `Failed to refresh managed runtime before ${opts.label} worker start: ${errorMessage(err)}`,
        );
      });
    }

    const port = await reservePort();
    const candidates = launchCandidates(def, port);
    if (candidates.length === 0) {
      if (isStaleManagedWorker(getMlxAsrWorkerPath())) {
        throw runtimeUpdatePendingError();
      }
      throw new Error(
        setupBlocker()?.message ??
          `The MLX worker for the local ${opts.label} was not found.`,
      );
    }

    let lastErr: Error | null = null;
    for (const candidate of candidates) {
      try {
        await spawnAndWaitReady(candidate, port);
        log.debug(
          `${opts.label} worker started via ${candidate.label} on port ${port}`,
        );
        return;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        await stop();
        log.debug(`${candidate.label} failed: ${lastErr.message}`);
      }
    }
    throw lastErr ?? new Error(`The ${what} did not start.`);
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
      let stderrTail = "";
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
            `The ${what} did not start within ${START_TIMEOUT_MS / 1000} seconds.`,
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
          let message: MlxReadyLine & { type?: string; error?: string };
          try {
            message = JSON.parse(line);
          } catch {
            log.debug(line);
            continue;
          }
          if (message.type === "ready" && workerProcess === proc) {
            if (typeof message.port === "number") workerPort = message.port;
            workerReady = true;
            opts.onReady?.(message);
            settle();
          } else if (message.type === "error") {
            settle(new Error(message.error ?? `The ${what} failed.`));
          }
        }
      });

      proc.stderr?.on("data", (data: Buffer) => {
        const text = data.toString().trimEnd();
        if (!text) return;
        log.warn(text);
        stderrTail = `${stderrTail}\n${text}`.slice(-STDERR_TAIL_CHARS);
      });

      proc.on("error", (err) => {
        settle(new Error(`Failed to start the ${what}: ${err.message}`));
        if (workerProcess === proc) resetState();
      });

      proc.on("close", (code) => {
        // Before the ready line: a start error. The last stderr line names
        // the cause (for example "unrecognized arguments" of an old worker).
        const last = stderrTail.trim().split("\n").pop()?.trim() ?? "";
        settle(
          new MlxWorkerStartError(
            `The ${what} exited before it was ready: exit code ${code}${last ? ` (${last.slice(0, 200)})` : ""}`,
          ),
        );
        if (workerProcess === proc) {
          if (workerReady)
            log.warn(`${opts.label} worker exited: exit code ${code}`);
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
    const minutes = opts.keepAliveMinutes();
    if (minutes === MLX_KEEP_ALIVE_ALWAYS) return;
    const unload = () => {
      if (inFlight > 0) return;
      stop().catch((err: Error) =>
        log.error(`Failed to unload the ${opts.label} worker: ${err.message}`),
      );
    };
    if (minutes <= 0) {
      unload();
      return;
    }
    unloadTimer = setTimeout(unload, minutes * 60_000);
    unloadTimer.unref?.();
  }

  async function stop(): Promise<void> {
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

  function busy(): boolean {
    return inFlight > 0;
  }

  return {
    override,
    setupBlocker,
    getState,
    busy,
    ensure,
    startInBackground,
    trackFetch,
    applyRetentionPolicy,
    stop,
  };
}
