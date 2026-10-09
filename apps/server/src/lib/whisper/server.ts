import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { createAppLogger } from "@openstyle/utils";
import { SETTINGS_KEYS } from "@openstyle/validations";
import { readSetting } from "../db.js";
import {
  findWhisperServer,
  WIN_DLL_NOT_FOUND_EXIT,
  WIN_DLL_NOT_FOUND_MESSAGE,
  whisperSpawnEnv,
} from "./binary.js";
import { WHISPER_SERVER_PORT } from "./constants.js";
import { getDownloadedModelPath } from "./models.js";
import { removeWhisperPidFile, writeWhisperPidFile } from "./pid-file.js";

const log = createAppLogger("whisper");
const serverLog = createAppLogger("whisper-server");
const MAX_RESTARTS = 3;
const RESTART_COOLDOWN_MS = 3_000;
const STABILITY_THRESHOLD_MS = 30_000;
const DEFAULT_KEEP_ALIVE_MINUTES = 10;
const MAX_KEEP_ALIVE_MINUTES = 10;

let serverProcess: ChildProcess | null = null;
let currentModelId: string | null = null;
let serverReady = false;
let startPromise: Promise<void> | null = null;
let autoRestart = false;
let restartCount = 0;
let stabilityTimer: ReturnType<typeof setTimeout> | null = null;
let activePort = WHISPER_SERVER_PORT;
let activeUses = 0;
let unloadTimer: ReturnType<typeof setTimeout> | null = null;

function stopServerOnExit(): void {
  const proc = serverProcess;
  if (!proc) return;
  try {
    proc.kill(process.platform === "win32" ? undefined : "SIGTERM");
  } catch {
    // best effort during process teardown
  }
  removeWhisperPidFile(proc.pid);
}

process.once("exit", stopServerOnExit);

export function isServerRunning(): boolean {
  return serverProcess !== null && serverReady;
}

export function getServerPort(): number {
  return activePort;
}

export function getWhisperKeepAliveMinutes(): number {
  try {
    const value = readSetting(SETTINGS_KEYS.whisperKeepAliveMinutes);
    if (value === undefined) return DEFAULT_KEEP_ALIVE_MINUTES;
    const minutes = Number(value);
    if (!Number.isFinite(minutes)) return DEFAULT_KEEP_ALIVE_MINUTES;
    return Math.min(Math.max(Math.round(minutes), 0), MAX_KEEP_ALIVE_MINUTES);
  } catch {
    return DEFAULT_KEEP_ALIVE_MINUTES;
  }
}

function clearUnloadTimer(): void {
  if (!unloadTimer) return;
  clearTimeout(unloadTimer);
  unloadTimer = null;
}

function scheduleUnload(): void {
  clearUnloadTimer();
  if (!serverProcess) return;
  if (activeUses > 0 || startPromise) return;
  const delayMs = getWhisperKeepAliveMinutes() * 60_000;

  if (delayMs <= 0) {
    stopServer().catch((err: Error) => {
      log.error(`Failed to unload server: ${err.message}`);
    });
    return;
  }

  unloadTimer = setTimeout(() => {
    if (activeUses > 0) return;
    log.info("Unloading idle whisper-server");
    stopServer().catch((err: Error) => {
      log.error(`Failed to unload idle server: ${err.message}`);
    });
  }, delayMs);
  unloadTimer.unref?.();
}

export function applyWhisperRetentionPolicy(): void {
  if (!serverProcess) return;
  scheduleUnload();
}

export async function withServerUse<T>(fn: () => Promise<T>): Promise<T> {
  activeUses++;
  clearUnloadTimer();
  try {
    return await fn();
  } finally {
    activeUses--;
    scheduleUnload();
  }
}

export function startInBackground(modelId: string): void {
  if (getWhisperKeepAliveMinutes() === 0) return;
  if (serverProcess && currentModelId === modelId && serverReady) return;
  if (startPromise && currentModelId === modelId) return;

  restartCount = 0;
  autoRestart = true;

  ensureServerRunning(modelId)
    .then(() => {
      log.info(`Server ready on port ${activePort}`);
    })
    .catch((err) => {
      log.error(`Background server start failed: ${err.message}`);
    });
}

// Probe the preferred port. If another process holds it, take a free port.
// The probe closes before this returns, so the server can bind the port.
function reservePort(preferred: number): Promise<number> {
  const listen = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.unref();
      probe.once("error", reject);
      probe.listen({ port, host: "127.0.0.1" }, () => {
        const address = probe.address();
        const bound =
          typeof address === "object" && address ? address.port : preferred;
        probe.close(() => resolve(bound));
      });
    });
  return listen(preferred).catch(() => listen(0));
}

export async function ensureServerRunning(modelId: string): Promise<void> {
  if (serverProcess && currentModelId === modelId && serverReady) {
    return;
  }

  if (startPromise && currentModelId === modelId) {
    return startPromise;
  }

  await stopServer();
  autoRestart = true;

  const promise = doStart(modelId);
  startPromise = promise;
  try {
    await promise;
  } finally {
    if (startPromise === promise) {
      startPromise = null;
    }
  }
}

async function doStart(modelId: string): Promise<void> {
  const serverBinary = findWhisperServer();
  if (!serverBinary) {
    throw new Error("whisper-server binary not found");
  }

  const modelPath = getDownloadedModelPath(modelId);
  if (!modelPath) {
    throw new Error(`Whisper model "${modelId}" not downloaded`);
  }

  currentModelId = modelId;
  serverReady = false;

  activePort = await reservePort(WHISPER_SERVER_PORT);
  if (activePort !== WHISPER_SERVER_PORT) {
    log.warn(
      `Port ${WHISPER_SERVER_PORT} is in use by another process, using ${activePort}`,
    );
  }

  const args = [
    "--model",
    modelPath,
    "--port",
    String(activePort),
    "--host",
    "127.0.0.1",
  ];

  const proc = spawn(serverBinary, args, {
    stdio: ["ignore", "pipe", "pipe"],
    ...whisperSpawnEnv(serverBinary),
  });

  serverProcess = proc;
  writeWhisperPidFile(proc.pid);
  proc.once("close", () => removeWhisperPidFile(proc.pid));

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let stderr = "";
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      const lastOutput = stderr.trim().slice(-500);
      try {
        proc.kill();
      } catch {}
      reject(
        new Error(
          `whisper-server failed to start within 90 seconds. Last output:\n${lastOutput}`,
        ),
      );
    }, 90_000);

    let healthCheckInterval: ReturnType<typeof setInterval> | null = null;

    function onReady() {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (healthCheckInterval) clearInterval(healthCheckInterval);
      serverReady = true;
      resolve();
    }

    proc.stdout?.on("data", (data: Buffer) => {
      serverLog.debug(`stdout: ${data.toString().trimEnd()}`);
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      serverLog.debug(`stderr: ${text.trimEnd()}`);
    });

    // The server is ready once it answers HTTP — version-proof, unlike
    // matching startup log strings.
    healthCheckInterval = setInterval(async () => {
      if (settled) {
        if (healthCheckInterval) clearInterval(healthCheckInterval);
        return;
      }
      try {
        const res = await fetch(`http://127.0.0.1:${activePort}/`, {
          signal: AbortSignal.timeout(1000),
        });
        if (res.ok || res.status === 404 || res.status === 405) {
          onReady();
        }
      } catch {}
    }, 250);

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (healthCheckInterval) clearInterval(healthCheckInterval);
      serverProcess = null;
      currentModelId = null;
      reject(new Error(`Failed to start whisper-server: ${err.message}`));
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (healthCheckInterval) clearInterval(healthCheckInterval);
      clearStabilityTimer();
      const wasReady = serverReady;
      const modelForRestart = currentModelId;
      serverProcess = null;
      serverReady = false;

      if (!settled) {
        settled = true;
        currentModelId = null;
        if (code === WIN_DLL_NOT_FOUND_EXIT) {
          reject(
            new Error(`whisper-server failed: ${WIN_DLL_NOT_FOUND_MESSAGE}`),
          );
        } else {
          const detail = stderr.trim() || `exit code ${code}`;
          reject(new Error(`whisper-server exited unexpectedly: ${detail}`));
        }
        return;
      }

      if (wasReady && autoRestart && modelForRestart) {
        scheduleRestart(modelForRestart);
      }
    });
  });

  startStabilityTimer();
  scheduleUnload();
}

function scheduleRestart(modelId: string): void {
  restartCount++;
  if (restartCount > MAX_RESTARTS) {
    log.error(`Server crashed ${MAX_RESTARTS} times, not restarting`);
    autoRestart = false;
    currentModelId = null;
    return;
  }

  log.info(
    `Server crashed, restarting in ${RESTART_COOLDOWN_MS / 1000}s (attempt ${restartCount}/${MAX_RESTARTS})`,
  );

  setTimeout(() => {
    if (!autoRestart) return;
    ensureServerRunning(modelId).catch((err) => {
      log.error(`Restart failed: ${err.message}`);
    });
  }, RESTART_COOLDOWN_MS);
}

function startStabilityTimer(): void {
  clearStabilityTimer();
  stabilityTimer = setTimeout(() => {
    if (serverReady) {
      restartCount = 0;
    }
  }, STABILITY_THRESHOLD_MS);
}

function clearStabilityTimer(): void {
  if (stabilityTimer) {
    clearTimeout(stabilityTimer);
    stabilityTimer = null;
  }
}

// Stop the server only when it has this model loaded. The delete route
// calls this: on Windows the server holds the model file open.
export async function stopServerIfLoaded(modelId: string): Promise<void> {
  if (currentModelId === modelId) await stopServer();
}

export async function stopServer(): Promise<void> {
  autoRestart = false;
  startPromise = null;
  clearStabilityTimer();
  clearUnloadTimer();
  if (!serverProcess) return;

  const proc = serverProcess;
  serverProcess = null;
  currentModelId = null;
  serverReady = false;

  return new Promise((resolve) => {
    let done = false;
    const killTimeout = setTimeout(() => {
      if (done) return;
      try {
        proc.kill(process.platform === "win32" ? undefined : "SIGKILL");
      } catch {}
      done = true;
      resolve();
    }, 5_000);

    proc.once("close", () => {
      if (done) return;
      done = true;
      clearTimeout(killTimeout);
      resolve();
    });

    try {
      proc.kill(process.platform === "win32" ? undefined : "SIGTERM");
    } catch {
      done = true;
      clearTimeout(killTimeout);
      resolve();
    }
  });
}
