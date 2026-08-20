/**
 * Standalone entrypoint for running the Openstyle server outside of Electron.
 *
 * Used by the Docker image (see Dockerfile) to run the server inside a
 * container/VM. The Electron app calls `startServer()` directly instead.
 *
 * Configuration via environment variables:
 *   - OPENSTYLE_DB_PATH (required) — path to the SQLite database file. The
 *     legacy name FREESTYLE_DB_PATH is still read as a fallback.
 *   - PORT  — port to listen on (default 4649).
 *   - HOST  — interface to bind to (default 0.0.0.0, all interfaces).
 *   - OPENSTYLE_AUTH_TOKEN — bearer token required on all requests (except
 *     /api/health). Auth is always enforced: when this is unset, a random
 *     token is generated and printed to the log on startup instead. Set it
 *     explicitly when binding to 0.0.0.0 — an auto-generated token doesn't
 *     survive a restart, and printing it to logs is a fallback, not a
 *     substitute for configuring one deliberately on a network-exposed
 *     deployment. The legacy name FREESTYLE_AUTH_TOKEN is still read as a
 *     fallback.
 */

import { closeDb, disposeServerPlugins, startServer } from "./index.js";

const port = process.env.PORT ? Number(process.env.PORT) : 4649;
const host = process.env.HOST ?? "0.0.0.0";
const token =
  process.env.OPENSTYLE_AUTH_TOKEN ?? process.env.FREESTYLE_AUTH_TOKEN;
const dbPath = process.env.OPENSTYLE_DB_PATH ?? process.env.FREESTYLE_DB_PATH;

if (Number.isNaN(port)) {
  console.error(`Invalid PORT value: ${process.env.PORT}`);
  process.exit(1);
}

if (!dbPath) {
  console.error(
    "OPENSTYLE_DB_PATH environment variable is required. Set it to the desired SQLite database file path.",
  );
  process.exit(1);
}

const {
  server,
  port: boundPort,
  token: effectiveToken,
} = await startServer({
  port,
  host,
  token,
  // This entrypoint always prints an auto-generated token below, so an
  // operator on a loopback bind (HOST=127.0.0.1, no OPENSTYLE_AUTH_TOKEN)
  // has a real channel to retrieve and use it — unlike the embedded Electron
  // server. Keep this bearer-token-only rather than granting the
  // trusted-origin fallback that exists solely for Electron's benefit.
  tokenIsRetrievable: true,
}).catch((err) => {
  console.error(
    `Failed to start server: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
console.log(`Openstyle server running on http://${host}:${boundPort}`);
if (!token) {
  console.log(
    `OPENSTYLE_AUTH_TOKEN was not set — generated a random token for this run: ${effectiveToken}`,
  );
}

function shutdown(signal: string): void {
  console.log(`Received ${signal}, shutting down...`);
  void disposeServerPlugins().catch(() => {});
  server.close(() => {
    try {
      closeDb();
    } catch {
      // ignore
    }
    process.exit(0);
  });
  // Don't wait forever for in-flight connections (e.g. open WebSockets).
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
