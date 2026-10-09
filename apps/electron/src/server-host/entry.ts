// Entry of the Openstyle server utility process.
// The main process forks this file (see ../main/server-host.ts). A crash here
// ends only this process. The main process then restarts it.
//
// Messages from the parent: shutdown, prefetch-mlx, model-cache-dirs.
// Messages to the parent: ready, model-cache-dirs-result, error.
import {
  activateManagedMlxRuntimeForAppVersion,
  closeDb,
  getLocalModelCacheDirs,
  prefetchManagedMlxRuntimeForAppRelease,
  reconcileUnsupportedMlxVoiceDefault,
  startServer,
  stopMlxServer,
  stopWhisperServer,
} from "@openstyle/server";
import { createAppLogger, enableFileLogging } from "@openstyle/utils";
import { DEFAULT_SERVER_PORT } from "@openstyle/validations";

// Electron may not define process.resourcesPath in a utility process. The
// server code reads it to find bundled binaries. The parent passes the value.
const proc = process as NodeJS.Process & { resourcesPath?: string };
if (!proc.resourcesPath && process.env.OPENSTYLE_RESOURCES_PATH) {
  proc.resourcesPath = process.env.OPENSTYLE_RESOURCES_PATH;
}

if (process.env.OPENSTYLE_LOGS_DIR) {
  // Its own file. Main writes openstyle.log. Two processes must not rotate one file.
  enableFileLogging(process.env.OPENSTYLE_LOGS_DIR, "openstyle-server.log");
}
const log = createAppLogger("server-host");

const parentPort = process.parentPort;

type ParentMessage =
  | { type: "shutdown" }
  | { type: "prefetch-mlx"; version: string }
  | { type: "model-cache-dirs"; id: number };

function errorText(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

function postError(message: string): void {
  try {
    parentPort.postMessage({ type: "error", message });
  } catch {
    // The parent is gone. Nothing to tell.
  }
}

process.on("uncaughtException", (err) => {
  log.error(`Uncaught exception: ${errorText(err)}`);
  postError(errorText(err));
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  log.error(`Unhandled rejection: ${errorText(reason)}`);
});

type RunningServer = Awaited<ReturnType<typeof startServer>>;
let running: RunningServer | null = null;
let shuttingDown = false;

async function listen(port: number, allowFallback: boolean) {
  try {
    return await startServer({ port, host: "127.0.0.1" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE" && allowFallback) {
      log.warn(`Port ${port} in use, falling back to random port`);
      return startServer({ port: 0, host: "127.0.0.1" });
    }
    throw err;
  }
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await Promise.allSettled([stopWhisperServer(), stopMlxServer()]);
    const server = running?.server;
    if (server) {
      // Open WebSocket and keep-alive sockets would hold close() open.
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((done) => server.close(() => done()));
    }
    closeDb();
  } catch (err) {
    log.error(`Shutdown failed: ${errorText(err)}`);
  }
  process.exit(0);
}

parentPort.on("message", (event) => {
  const message = event.data as ParentMessage;
  switch (message.type) {
    case "shutdown":
      void shutdown();
      break;
    case "prefetch-mlx":
      void prefetchManagedMlxRuntimeForAppRelease(message.version).catch(
        (err) => log.warn(`MLX prefetch failed: ${errorText(err)}`),
      );
      break;
    case "model-cache-dirs": {
      let dirs: string[] = [];
      try {
        dirs = getLocalModelCacheDirs();
      } catch (err) {
        log.warn(`Model cache dirs failed: ${errorText(err)}`);
      }
      parentPort.postMessage({
        type: "model-cache-dirs-result",
        id: message.id,
        dirs,
      });
      break;
    }
  }
});

async function main(): Promise<void> {
  const requested = Number(process.env.OPENSTYLE_SERVER_HOST_PORT);
  const port = Number.isInteger(requested) ? requested : DEFAULT_SERVER_PORT;
  const allowFallback = process.env.OPENSTYLE_SERVER_HOST_FALLBACK === "1";

  running = await listen(port, allowFallback);
  log.info(`Server running on http://localhost:${running.port}`);
  parentPort.postMessage({ type: "ready", port: running.port });

  // After "ready" on purpose: this call can probe Python and MLX with a
  // blocking process call. It is idempotent and also runs lazily on the first
  // use of the default models.
  setImmediate(() => {
    try {
      reconcileUnsupportedMlxVoiceDefault();
    } catch (err) {
      log.warn(`MLX voice default check failed: ${errorText(err)}`);
    }
  });

  // The parent sets this variable only in a packaged build.
  const appVersion = process.env.OPENSTYLE_APP_VERSION;
  if (appVersion) {
    void activateManagedMlxRuntimeForAppVersion(appVersion).catch((err) =>
      log.warn(
        `Failed to activate MLX runtime for app ${appVersion}: ${errorText(err)}`,
      ),
    );
  }
}

main().catch((err) => {
  log.error(`Server failed to start: ${errorText(err)}`);
  postError(errorText(err));
  process.exit(1);
});
