// Runs the local Openstyle HTTP server in an Electron utility process.
// The main process keeps the port choice: a pinned test port, an existing
// server on the default port (reused), or a new server on the default port.
// A server crash ends only the utility process. This file restarts it.
import { join } from "node:path";
import { is } from "@electron-toolkit/utils";
import { createAppLogger } from "@openstyle/utils";
import { DEFAULT_SERVER_PORT } from "@openstyle/validations";
import { app, dialog, type UtilityProcess, utilityProcess } from "electron";
import { broadcastServerChanged, state } from "./main-state";
import { probeServerHealth, setServerPort } from "./server-target";

const log = createAppLogger("electron");

// Parent to child.
type ParentMessage =
  | { type: "shutdown" }
  | { type: "prefetch-mlx"; version: string }
  | { type: "model-cache-dirs"; id: number };

// Child to parent.
type ChildMessage =
  | { type: "ready"; port: number }
  | { type: "model-cache-dirs-result"; id: number; dirs: string[] }
  | { type: "error"; message: string };

const RESTART_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];
const RESTART_WINDOW_MS = 60_000;
// Boot waits for the server at most this long. A restart goes on in the background.
const START_WAIT_MS = 20_000;
const MODEL_DIRS_WAIT_MS = 5000;

interface HostState {
  child: UtilityProcess | null;
  // True when main asked for the stop. No restart follows.
  stopRequested: boolean;
  restartTimes: number[];
  restartTimer: NodeJS.Timeout | null;
  // The port to ask for first. After the first start, this is the last bound port.
  port: number;
  // Allow a random port when the asked port is busy. Off for a pinned test port.
  allowFallback: boolean;
  hasBeenReady: boolean;
  // An MLX prefetch that arrived while no child ran. The next "ready" sends it.
  pendingPrefetchVersion: string | null;
  env: Record<string, string>;
  exited: Promise<void> | null;
  onFirstSettled: (() => void) | null;
  nextRequestId: number;
  modelDirRequests: Map<number, (dirs: string[]) => void>;
}

const host: HostState = {
  child: null,
  stopRequested: false,
  restartTimes: [],
  restartTimer: null,
  port: DEFAULT_SERVER_PORT,
  allowFallback: true,
  hasBeenReady: false,
  pendingPrefetchVersion: null,
  env: {},
  exited: null,
  onFirstSettled: null,
  nextRequestId: 1,
  modelDirRequests: new Map(),
};

function send(message: ParentMessage): boolean {
  if (!host.child) return false;
  host.child.postMessage(message);
  return true;
}

function pipeLines(
  stream: NodeJS.ReadableStream | null | undefined,
  target: NodeJS.WriteStream,
): void {
  // The child writes its own log file (openstyle-server.log). Its console
  // output only goes to the console of main.
  stream?.on("data", (chunk: Buffer) => target.write(chunk));
}

function settleFirstStart(): void {
  const done = host.onFirstSettled;
  host.onFirstSettled = null;
  done?.();
}

function handleMessage(message: ChildMessage): void {
  switch (message.type) {
    case "ready": {
      const portChanged = host.hasBeenReady && message.port !== host.port;
      host.port = message.port;
      setServerPort(message.port);
      log.info(`Server running on http://localhost:${message.port}`);
      const isRestart = host.hasBeenReady;
      host.hasBeenReady = true;
      if (portChanged) broadcastServerChanged();
      if (isRestart) {
        // Transcription jobs died with the old process. Mark them failed now,
        // not at the next launch. A live recording stays untouched.
        void state.meetingRecorder?.sweepOrphans({ transcribingOnly: true });
      }
      if (host.pendingPrefetchVersion) {
        send({ type: "prefetch-mlx", version: host.pendingPrefetchVersion });
        host.pendingPrefetchVersion = null;
      }
      settleFirstStart();
      break;
    }
    case "model-cache-dirs-result":
      host.modelDirRequests.get(message.id)?.(message.dirs);
      break;
    case "error":
      log.error(`Server process error: ${message.message}`);
      break;
  }
}

function spawnChild(): void {
  const entry = join(__dirname, "server-process.js");
  const child = utilityProcess.fork(entry, [], {
    serviceName: "Openstyle Server",
    env: {
      ...host.env,
      OPENSTYLE_SERVER_HOST_PORT: String(host.port),
      OPENSTYLE_SERVER_HOST_FALLBACK: host.allowFallback ? "1" : "0",
    },
    stdio: "pipe",
  });
  host.child = child;
  host.exited = new Promise<void>((resolve) => {
    child.once("exit", (code) => {
      resolve();
      if (host.child !== child) return;
      host.child = null;
      // Free any waiting model-dirs requests. They fall back to an empty list.
      for (const answer of host.modelDirRequests.values()) answer([]);
      host.modelDirRequests.clear();
      if (host.stopRequested) return;
      log.error(`Server process exited with code ${code}`);
      settleFirstStart();
      scheduleRestart();
    });
  });
  child.on("message", handleMessage);
  child.once("spawn", () => {
    log.info(`Server process started (pid ${child.pid})`);
  });
  pipeLines(child.stdout, process.stdout);
  pipeLines(child.stderr, process.stderr);
}

// The server stays down after the give-up. Tell the user, and offer a relaunch.
// A test run (OPENSTYLE_E2E) shows no dialog.
function offerRelaunch(): void {
  if (process.env.OPENSTYLE_E2E === "1") return;
  void dialog
    .showMessageBox({
      type: "error",
      title: "Openstyle",
      message: "The Openstyle server stopped and could not restart.",
      detail: "Relaunch Openstyle to use dictation and meetings again.",
      buttons: ["Relaunch", "Close"],
      defaultId: 0,
      cancelId: 1,
    })
    .then(({ response }) => {
      if (response !== 0) return;
      app.relaunch();
      app.quit();
    });
}

function scheduleRestart(): void {
  const now = Date.now();
  host.restartTimes = host.restartTimes.filter(
    (time) => now - time < RESTART_WINDOW_MS,
  );
  if (host.restartTimes.length >= RESTART_BACKOFF_MS.length) {
    log.error(
      `Server process failed ${RESTART_BACKOFF_MS.length} restarts in ${
        RESTART_WINDOW_MS / 1000
      } s. Giving up.`,
    );
    offerRelaunch();
    return;
  }
  const delay = RESTART_BACKOFF_MS[host.restartTimes.length];
  host.restartTimes.push(now);
  log.warn(`Restarting server process in ${delay / 1000} s`);
  host.restartTimer = setTimeout(() => {
    host.restartTimer = null;
    if (host.stopRequested) return;
    spawnChild();
  }, delay);
}

function buildChildEnv(): Record<string, string> {
  // The child inherits the env of main, including the E2E variables. Main sets
  // the paths here, because the server only reads them from the environment.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.OPENSTYLE_DB_PATH = join(app.getPath("userData"), "freestyle.db");
  env.OPENSTYLE_RESOURCES_PATH = process.resourcesPath ?? "";
  env.OPENSTYLE_LOGS_DIR = app.getPath("logs");
  if (!is.dev) {
    env.OPENSTYLE_MLX_ASR_RELEASE_TAG ||= app.getVersion();
    // The child activates the staged MLX runtime for this version.
    env.OPENSTYLE_APP_VERSION = app.getVersion();
  }
  return env;
}

export async function startServerHost({
  userDataOverride,
}: {
  userDataOverride: string | undefined;
}): Promise<void> {
  // Test isolation: a run with its own userData (OPENSTYLE_USER_DATA) can pin
  // its own server port with OPENSTYLE_SERVER_PORT. It then never probes or
  // reuses a server on the default port, so E2E runs next to an installed
  // app without touching its DB. Without the userData override the variable
  // is ignored: a second server on the real profile DB is never wanted.
  const pinnedPort = userDataOverride
    ? Number(process.env.OPENSTYLE_SERVER_PORT)
    : Number.NaN;
  const usePinnedPort =
    Number.isInteger(pinnedPort) && pinnedPort > 0 && pinnedPort < 65536;

  // Check if a Openstyle server is already running on the default port. The
  // 1.5s bound matters: a normal cold start fast-fails with ECONNREFUSED, but
  // without a timeout a half-open socket on the port could hang window/tray
  // creation indefinitely.
  const existingServer =
    !usePinnedPort &&
    (await probeServerHealth(`http://127.0.0.1:${DEFAULT_SERVER_PORT}`, 1500));

  if (existingServer) {
    setServerPort(DEFAULT_SERVER_PORT);
    log.info(
      `Reusing existing Openstyle server on http://localhost:${DEFAULT_SERVER_PORT}`,
    );
    return;
  }

  host.stopRequested = false;
  host.port = usePinnedPort ? pinnedPort : DEFAULT_SERVER_PORT;
  host.allowFallback = !usePinnedPort;
  host.env = buildChildEnv();
  if (usePinnedPort) setServerPort(pinnedPort);

  if (process.env.OPENSTYLE_E2E === "1") {
    // Tests read the PID of the utility process with app.evaluate().
    (globalThis as Record<string, unknown>).__openstyleServerHostPid = () =>
      host.child?.pid ?? null;
  }

  const firstSettled = new Promise<void>((resolve) => {
    host.onFirstSettled = resolve;
  });
  const timer = setTimeout(() => {
    log.warn(`Server process not ready after ${START_WAIT_MS / 1000} s`);
    settleFirstStart();
  }, START_WAIT_MS);
  spawnChild();
  await firstSettled;
  clearTimeout(timer);
}

/**
 * Ask the server process to stop, wait for it to exit, then kill it when it
 * does not exit in time. No restart follows. Safe to call more than once.
 */
export async function stopServerHost(timeoutMs = 3000): Promise<void> {
  host.stopRequested = true;
  if (host.restartTimer) {
    clearTimeout(host.restartTimer);
    host.restartTimer = null;
  }
  const child = host.child;
  const exited = host.exited;
  if (!child || !exited) return;

  send({ type: "shutdown" });
  let timer: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (!timedOut) return;

  log.warn(`Server process did not exit in ${timeoutMs} ms. Killing it.`);
  child.kill();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 1000))]);
}

/**
 * The directories of local speech models, read by the server process from its
 * own database. Returns an empty list when no local server process runs, for
 * example when main reuses a server of another instance.
 */
export async function requestModelCacheDirs(): Promise<string[]> {
  const id = host.nextRequestId++;
  const answer = new Promise<string[]>((resolve) => {
    host.modelDirRequests.set(id, resolve);
    setTimeout(() => resolve([]), MODEL_DIRS_WAIT_MS).unref();
  });
  if (!send({ type: "model-cache-dirs", id })) {
    host.modelDirRequests.delete(id);
    return [];
  }
  const dirs = await answer;
  host.modelDirRequests.delete(id);
  return dirs;
}

/** Start the download of the MLX runtime for an app release. No result. */
export function prefetchMlxRuntime(version: string): void {
  // No child runs (restart in progress): the next "ready" sends it.
  if (!send({ type: "prefetch-mlx", version })) {
    host.pendingPrefetchVersion = version;
  }
}
