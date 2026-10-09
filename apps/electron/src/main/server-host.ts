// Starts the local Openstyle HTTP server for the Electron main process.
// The server uses the profile database, or a pinned test port when set.
// An existing server on the default port is reused, not started again.
import { join } from "node:path";
import { is } from "@electron-toolkit/utils";
import {
  activateManagedMlxRuntimeForAppVersion,
  reconcileUnsupportedMlxVoiceDefault,
  startServer as startOpenstyleServer,
} from "@openstyle/server";
import { createAppLogger } from "@openstyle/utils";
import { DEFAULT_SERVER_PORT } from "@openstyle/validations";
import { app } from "electron";
import { state } from "./main-state";
import { probeServerHealth, setServerPort } from "./server-target";

const log = createAppLogger("electron");

export async function startServerHost({
  userDataOverride,
}: {
  userDataOverride: string | undefined;
}): Promise<void> {
  // Set database path for the server before any API calls. Server code reads
  // the OPENSTYLE_ name first and falls back to the old FREESTYLE_ name, so
  // only the OPENSTYLE_ name is set here.
  const dbPath = join(app.getPath("userData"), "freestyle.db");
  process.env.OPENSTYLE_DB_PATH = dbPath;

  if (!is.dev) {
    process.env.OPENSTYLE_MLX_ASR_RELEASE_TAG ||= app.getVersion();
  }

  // Run non-critical server startup tasks now that the DB path is set. This is
  // deferred off the boot critical path: reconcileUnsupportedMlxVoiceDefault can
  // synchronously probe Python/MLX (execFileSync) on Apple Silicon without a
  // managed runtime, which would otherwise block window creation. It is
  // idempotent and also runs lazily via getDefaultModels() on first use, so
  // deferring it by a tick is safe. Local ASR servers (whisper/mlx) are no
  // longer pre-warmed at boot — they warm on recording start via the
  // /api/transcribe/pre-warm endpoint, and start lazily at submission as a
  // fallback.
  setImmediate(() => {
    reconcileUnsupportedMlxVoiceDefault();
  });

  // Start the Hono HTTP server with WebSocket support (or reuse an existing one)
  const startServer = (port: number): void => {
    startOpenstyleServer({ port, host: "127.0.0.1" })
      .then(({ server, port: boundPort }) => {
        state.httpServer = server;
        setServerPort(boundPort);
        log.info(`Server running on http://localhost:${boundPort}`);
      })
      .catch((err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && port === DEFAULT_SERVER_PORT) {
          log.warn(
            `Port ${DEFAULT_SERVER_PORT} in use, falling back to random port`,
          );
          startServer(0);
        } else {
          log.error(`Server failed to start: ${err}`);
        }
      });
  };

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

  if (usePinnedPort) {
    setServerPort(pinnedPort);
    startServer(pinnedPort);
  } else if (existingServer) {
    setServerPort(DEFAULT_SERVER_PORT);
    log.info(
      `Reusing existing Openstyle server on http://localhost:${DEFAULT_SERVER_PORT}`,
    );
  } else {
    startServer(DEFAULT_SERVER_PORT);
  }

  if (!is.dev) {
    void activateManagedMlxRuntimeForAppVersion(app.getVersion()).catch(
      (err) => {
        log.warn(
          `Failed to activate MLX runtime for app ${app.getVersion()}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      },
    );
  }
}
