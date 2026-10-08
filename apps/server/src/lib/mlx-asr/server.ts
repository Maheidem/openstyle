import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppLogger, errorMessage } from "@openstyle/utils";
import {
  clampMlxKeepAliveMinutes,
  MLX_KEEP_ALIVE_ALWAYS,
  MLX_KEEP_ALIVE_DEFAULT_MINUTES,
} from "@openstyle/validations";
import { readSetting } from "../db.js";
import {
  getMlxAsrModel,
  hfRepoCacheDir,
  MLX_ALIGNER_MODEL_ID,
} from "./constants.js";
import { hasRemoteCode } from "./custom-models.js";
import {
  describeMlxSetupBlocker,
  findPythonExecutable,
  getMlxAsrServerScriptPath,
  getMlxAsrWorkerPath,
  isMlxAudioInstalled,
} from "./python.js";
import {
  isManagedMlxRuntimeAvailable,
  markManagedMlxRuntimeSyncedForAppVersion,
  mlxAsrReleaseTagOverride,
  updateManagedMlxRuntimeIfNeeded,
} from "./runtime.js";

const log = createAppLogger("mlx-asr");
const START_TIMEOUT_MS = 120_000;
const TRANSCRIBE_TIMEOUT_MS = 300_000;
/** One forced-aligner call (specs/meeting-transcription-v2.md §3.6 step 4). */
const ALIGN_TIMEOUT_MS = 10_000;

/** One aligned word span; start/end in seconds relative to the audio start. */
export interface MlxAlignedWord {
  text: string;
  start: number;
  end: number;
}

interface WorkerResponse {
  id?: number;
  type?: string;
  text?: string;
  error?: string;
  model?: string;
  words?: MlxAlignedWord[];
}

interface PendingRequest {
  resolve: (value: string | MlxAlignedWord[]) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

let workerProcess: ChildProcess | null = null;
let currentModelId: string | null = null;
let workerReady = false;
let startPromise: Promise<void> | null = null;
let stdoutBuffer = "";
let nextRequestId = 1;
let unloadTimer: ReturnType<typeof setTimeout> | null = null;
let lifecyclePromise: Promise<void> = Promise.resolve();
const pending = new Map<number, PendingRequest>();

let readyResolve: (() => void) | null = null;
let readyReject: ((err: Error) => void) | null = null;

function stopWorkerOnExit(): void {
  const proc = workerProcess;
  if (!proc) return;
  try {
    proc.stdin?.write(`${JSON.stringify({ type: "shutdown" })}\n`);
  } catch {
    // best effort during process teardown
  }
  try {
    proc.kill(process.platform === "win32" ? undefined : "SIGTERM");
  } catch {
    // best effort during process teardown
  }
}

process.once("exit", stopWorkerOnExit);

export function isMlxServerRunning(): boolean {
  return workerProcess !== null && workerReady;
}

export { canRunMlxAsr } from "./python.js";

export function getMlxAsrKeepAliveMinutes(): number {
  try {
    const value = readSetting("mlx_asr_keep_alive_minutes");
    if (value === undefined) return MLX_KEEP_ALIVE_DEFAULT_MINUTES;
    return clampMlxKeepAliveMinutes(Number(value));
  } catch {
    return MLX_KEEP_ALIVE_DEFAULT_MINUTES;
  }
}

export function startMlxInBackground(modelId: string): void {
  if (getMlxAsrKeepAliveMinutes() === 0) return;
  if (workerProcess && currentModelId === modelId && workerReady) return;
  if (startPromise && currentModelId === modelId) return;

  ensureMlxServerRunning(modelId)
    .then(() => {
      log.info("Worker ready");
    })
    .catch((err: Error) => {
      log.error(`Background worker start failed: ${err.message}`);
    });
}

export function applyMlxAsrRetentionPolicy(): void {
  if (!workerProcess) return;
  if (pending.size > 0 || startPromise) return;
  scheduleUnload();
}

export function ensureMlxServerRunning(modelId: string): Promise<void> {
  const run = lifecyclePromise.then(() =>
    ensureMlxServerRunningLocked(modelId),
  );
  lifecyclePromise = run.catch(() => undefined);
  return run;
}

async function ensureMlxServerRunningLocked(modelId: string): Promise<void> {
  clearUnloadTimer();
  if (workerProcess && currentModelId === modelId && workerReady) {
    return;
  }
  if (startPromise && currentModelId === modelId) {
    return startPromise;
  }

  await stopMlxServer();
  currentModelId = modelId;

  const promise = startWorker(modelId);
  startPromise = promise;
  try {
    await promise;
  } finally {
    if (startPromise === promise) {
      startPromise = null;
    }
  }
}

export async function transcribeWithMlxAsr(opts: {
  modelId: string;
  audio: Uint8Array;
  /** Set for raw 16-bit PCM audio. Leave unset for a WAV file. */
  pcmSampleRate?: number;
  language?: string;
  context?: string;
  deferUnload?: boolean;
}): Promise<string> {
  await ensureMlxServerRunning(opts.modelId);

  const isPcm = opts.pcmSampleRate !== undefined;
  const dir = join(tmpdir(), "openstyle-mlx-asr");
  await mkdir(dir, { recursive: true });
  const audioPath = join(dir, `${randomUUID()}.${isPcm ? "pcm" : "wav"}`);
  await writeFile(audioPath, opts.audio);

  try {
    return await sendTranscribeRequest({
      audioPath,
      ...(isPcm
        ? { audioFormat: "pcm_s16le", sampleRate: opts.pcmSampleRate }
        : {}),
      language: opts.language,
      context: opts.context,
    });
  } finally {
    await unlink(audioPath).catch(() => undefined);
    if (!opts.deferUnload) scheduleUnload();
  }
}

export async function alignWithMlxAsr(opts: {
  /** The aligner model (default: the helper aligner, 3.6). */
  modelId?: string;
  audio: Uint8Array;
  /** Set for raw 16-bit PCM audio. Leave unset for a WAV file. */
  pcmSampleRate?: number;
  /** The text to align against the audio (the chunk's own transcription). */
  text: string;
  /** The aligner's language name (e.g. "English", "Portuguese"). */
  language?: string;
  /** Per-call timeout in ms (default 10 s, 3.6 step 4). */
  timeoutMs?: number;
  deferUnload?: boolean;
}): Promise<MlxAlignedWord[]> {
  const modelId = opts.modelId ?? MLX_ALIGNER_MODEL_ID;
  await ensureMlxServerRunning(modelId);

  const isPcm = opts.pcmSampleRate !== undefined;
  const dir = join(tmpdir(), "openstyle-mlx-asr");
  await mkdir(dir, { recursive: true });
  const audioPath = join(dir, `${randomUUID()}.${isPcm ? "pcm" : "wav"}`);
  await writeFile(audioPath, opts.audio);

  try {
    return await sendAlignRequest({
      audioPath,
      ...(isPcm
        ? { audioFormat: "pcm_s16le", sampleRate: opts.pcmSampleRate }
        : {}),
      text: opts.text,
      language: opts.language,
      timeoutMs: opts.timeoutMs ?? ALIGN_TIMEOUT_MS,
    });
  } finally {
    await unlink(audioPath).catch(() => undefined);
    if (!opts.deferUnload) scheduleUnload();
  }
}

function sendAlignRequest(opts: {
  audioPath: string;
  audioFormat?: "wav" | "pcm_s16le";
  sampleRate?: number;
  text: string;
  language?: string;
  timeoutMs: number;
}): Promise<MlxAlignedWord[]> {
  clearUnloadTimer();

  const proc = workerProcess;
  if (!proc?.stdin || !workerReady) {
    return Promise.reject(new Error("mlx-asr worker is not running"));
  }

  const id = nextRequestId++;
  const payload = {
    id,
    type: "align",
    audio_path: opts.audioPath,
    audio_format: opts.audioFormat ?? "wav",
    sample_rate: opts.sampleRate,
    text: opts.text,
    language: opts.language,
  };

  return new Promise<MlxAlignedWord[]>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error("MLX ASR alignment timed out."));
    }, opts.timeoutMs);

    pending.set(id, {
      resolve: resolve as (v: string | MlxAlignedWord[]) => void,
      reject,
      timeout,
    });
    proc.stdin?.write(`${JSON.stringify(payload)}\n`, (err) => {
      if (!err) return;
      const req = pending.get(id);
      if (!req) return;
      pending.delete(id);
      clearTimeout(req.timeout);
      req.reject(
        new Error(`Failed to write to mlx-asr worker: ${err.message}`),
      );
    });
  });
}

interface WorkerLaunchCandidate {
  label: string;
  command: string;
  spawnArgs: string[];
}

function workerLaunchCandidates(modelHfId: string): WorkerLaunchCandidate[] {
  const modelArgs = ["--model", modelHfId];
  const candidates: WorkerLaunchCandidate[] = [];

  const workerPath = getMlxAsrWorkerPath();
  if (workerPath && existsSync(workerPath)) {
    candidates.push({
      label: "bundled worker",
      command: workerPath,
      spawnArgs: modelArgs,
    });
  }

  const python = findPythonExecutable();
  const scriptPath = getMlxAsrServerScriptPath();
  if (
    python &&
    scriptPath &&
    existsSync(scriptPath) &&
    isMlxAudioInstalled(python)
  ) {
    candidates.push({
      label: "python script",
      command: python,
      spawnArgs: [scriptPath, ...modelArgs],
    });
  }

  return candidates;
}

async function spawnWorkerProcess(
  command: string,
  spawnArgs: string[],
  extraEnv: NodeJS.ProcessEnv,
): Promise<void> {
  const proc = spawn(command, spawnArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PYTHONUNBUFFERED: "1", ...extraEnv },
  });

  workerProcess = proc;
  workerReady = false;
  stdoutBuffer = "";

  proc.stdout?.on("data", (data: Buffer) => {
    stdoutBuffer += data.toString();
    let newline = stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line) handleWorkerLine(line);
      newline = stdoutBuffer.indexOf("\n");
    }
  });

  proc.stderr?.on("data", (data: Buffer) => {
    const text = data.toString().trimEnd();
    if (!text) return;
    log.warn(text);
  });

  proc.on("error", (err) => {
    if (workerProcess !== proc) return;
    failWorker(new Error(`Failed to start mlx-asr worker: ${err.message}`));
  });

  proc.on("close", (code) => {
    if (workerProcess !== proc) return;
    failWorker(
      new Error(`mlx-asr worker exited unexpectedly: exit code ${code}`),
    );
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      const err = new Error(
        "mlx-asr worker failed to start within 120 seconds.",
      );
      readyResolve = null;
      readyReject = null;
      failWorker(err);
      try {
        proc.kill(process.platform === "win32" ? undefined : "SIGKILL");
      } catch {
        // ignore
      }
      reject(err);
    }, START_TIMEOUT_MS);

    readyResolve = () => {
      clearTimeout(timeout);
      resolve();
    };
    readyReject = (err) => {
      clearTimeout(timeout);
      reject(err);
    };
  });
}

async function startWorker(modelId: string): Promise<void> {
  const def = getMlxAsrModel(modelId);
  if (!def) {
    throw new Error(`Unknown MLX ASR model: ${modelId}`);
  }

  // The files on disk are the ones the worker loads. A repo that gained code
  // files after the add step must not start (spec section 11).
  if (def.custom && hasRemoteCode(hfRepoCacheDir(def.hfId))) {
    throw new Error(
      `The custom model ${def.hfId} holds its own code files, so it will not start. Delete it.`,
    );
  }

  await updateManagedMlxRuntimeIfNeeded().catch((err) => {
    log.warn(
      `Failed to refresh managed runtime before worker start: ${errorMessage(
        err,
      )}`,
    );
  });

  const candidates = workerLaunchCandidates(def.hfId);
  if (candidates.length === 0) {
    throw new Error(
      describeMlxSetupBlocker() ??
        "Bundled MLX ASR worker or Python 3 with mlx-audio not found.",
    );
  }

  // A custom model was checked at add time only. The worker must not fetch
  // other repos for it (spec section 11), so it loads from the cache alone.
  const extraEnv = def.custom ? { HF_HUB_OFFLINE: "1" } : {};

  let lastError: Error | null = null;

  for (const candidate of candidates) {
    try {
      await spawnWorkerProcess(
        candidate.command,
        candidate.spawnArgs,
        extraEnv,
      );
      const releaseTag = mlxAsrReleaseTagOverride();
      if (releaseTag && isManagedMlxRuntimeAvailable()) {
        markManagedMlxRuntimeSyncedForAppVersion(releaseTag);
      }
      log.debug(`started via ${candidate.label}`);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      await stopMlxServer().catch(() => undefined);
      log.debug(`${candidate.label} failed: ${lastError.message}`);
    }
  }

  if (def.custom && lastError) {
    throw new Error(
      `Could not load the custom model ${def.hfId}. Its files may be incomplete. Delete it and add it again. (${lastError.message})`,
    );
  }
  throw (
    lastError ??
    new Error("MLX ASR worker failed to start with every launch method.")
  );
}

function handleWorkerLine(line: string): void {
  let message: WorkerResponse;
  try {
    message = JSON.parse(line) as WorkerResponse;
  } catch {
    log.debug(line);
    return;
  }

  if (message.type === "ready") {
    workerReady = true;
    readyResolve?.();
    readyResolve = null;
    readyReject = null;
    return;
  }

  if (typeof message.id !== "number") return;
  const req = pending.get(message.id);
  if (!req) return;

  if (message.type && message.type !== "final" && message.type !== "aligned") {
    return;
  }

  pending.delete(message.id);
  clearTimeout(req.timeout);
  if (message.error) {
    req.reject(new Error(message.error));
    return;
  }
  if (message.type === "aligned") {
    req.resolve(
      (message.words ?? []).filter(
        (w) =>
          typeof w.text === "string" &&
          Number.isFinite(w.start) &&
          Number.isFinite(w.end),
      ),
    );
    return;
  }
  req.resolve(message.text ?? "");
}

function sendTranscribeRequest(opts: {
  audioPath: string;
  audioFormat?: "wav" | "pcm_s16le";
  sampleRate?: number;
  language?: string;
  context?: string;
}): Promise<string> {
  clearUnloadTimer();

  const proc = workerProcess;
  if (!proc?.stdin || !workerReady) {
    return Promise.reject(new Error("mlx-asr worker is not running"));
  }

  const id = nextRequestId++;
  const payload = {
    id,
    type: "transcribe",
    audio_path: opts.audioPath,
    audio_format: opts.audioFormat ?? "wav",
    sample_rate: opts.sampleRate,
    language: opts.language,
    context: opts.context,
  };

  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error("MLX ASR inference timed out."));
    }, TRANSCRIBE_TIMEOUT_MS);

    pending.set(id, {
      resolve: resolve as (v: string | MlxAlignedWord[]) => void,
      reject,
      timeout,
    });
    proc.stdin?.write(`${JSON.stringify(payload)}\n`, (err) => {
      if (!err) return;
      const req = pending.get(id);
      if (!req) return;
      pending.delete(id);
      clearTimeout(req.timeout);
      req.reject(
        new Error(`Failed to write to mlx-asr worker: ${err.message}`),
      );
    });
  });
}

function failWorker(err: Error): void {
  clearUnloadTimer();
  if (readyReject) readyReject(err);
  readyResolve = null;
  readyReject = null;

  for (const [id, req] of pending) {
    pending.delete(id);
    clearTimeout(req.timeout);
    req.reject(err);
  }

  workerProcess = null;
  currentModelId = null;
  workerReady = false;
  startPromise = null;
}

function clearUnloadTimer(): void {
  if (!unloadTimer) return;
  clearTimeout(unloadTimer);
  unloadTimer = null;
}

function scheduleUnload(): void {
  clearUnloadTimer();
  if (!workerProcess) return;
  if (pending.size > 0) return;
  const minutes = getMlxAsrKeepAliveMinutes();

  if (minutes === MLX_KEEP_ALIVE_ALWAYS) {
    // "Always on": keep the model resident indefinitely; never schedule unload.
    return;
  }

  const delayMs = minutes * 60_000;

  if (delayMs <= 0) {
    stopMlxServer().catch((err: Error) => {
      log.error(`Failed to unload worker: ${err.message}`);
    });
    return;
  }

  unloadTimer = setTimeout(() => {
    if (pending.size > 0) return;
    stopMlxServer().catch((err: Error) => {
      log.error(`Failed to unload idle worker: ${err.message}`);
    });
  }, delayMs);
  unloadTimer.unref?.();
}

export async function stopMlxServer(): Promise<void> {
  if (!workerProcess) return;
  clearUnloadTimer();

  const proc = workerProcess;
  workerProcess = null;
  currentModelId = null;
  workerReady = false;
  startPromise = null;

  readyReject?.(new Error("mlx-asr worker stopped"));
  readyResolve = null;
  readyReject = null;

  for (const [id, req] of pending) {
    pending.delete(id);
    clearTimeout(req.timeout);
    req.reject(new Error("mlx-asr worker stopped"));
  }

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };

    const killTimeout = setTimeout(() => {
      try {
        proc.kill(process.platform === "win32" ? undefined : "SIGKILL");
      } catch {
        // ignore
      }
      finish();
    }, 5_000);

    proc.once("close", () => {
      clearTimeout(killTimeout);
      finish();
    });

    try {
      proc.stdin?.write(`${JSON.stringify({ type: "shutdown" })}\n`, () => {
        proc.stdin?.end();
        try {
          proc.kill(process.platform === "win32" ? undefined : "SIGTERM");
        } catch {
          // Process may have already exited after reading the shutdown message.
        }
      });
    } catch {
      clearTimeout(killTimeout);
      finish();
    }
  });
}
