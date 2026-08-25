import { type ServerType, serve } from "@hono/node-server";
import { createAppLogger } from "@openstyle/utils";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { requestId } from "hono/request-id";
import { timeout } from "hono/timeout";
import { WebSocketServer } from "ws";
import { authMiddleware, generateAuthToken, setAuthToken } from "./lib/auth.js";
import { formatError } from "./lib/format-error.js";
import {
  startHistoryRetentionSweep,
  stopHistoryRetentionSweep,
} from "./lib/history-store.js";
import {
  startMeetingRetentionSweep,
  stopMeetingRetentionSweep,
} from "./lib/meetings/retention.js";
import { reconcileUnsupportedMlxVoiceDefault } from "./lib/mlx-asr/reconcile.js";
import {
  activateManagedMlxRuntimeForAppVersion,
  prefetchManagedMlxRuntimeForAppRelease,
} from "./lib/mlx-asr/runtime.js";
import { configureNetwork } from "./lib/network.js";
import { pluginApiGuard } from "./lib/plugin-api-guard.js";
import {
  disposeServerPlugins,
  initServerPlugins,
  plugins,
} from "./lib/plugins/index.js";
import { runInTraceScope } from "./lib/trace.js";
import {
  isTrustedRendererOrigin,
  trustedOriginMiddleware,
} from "./lib/trusted-origin.js";
import routes from "./routes";

const httpLog = createAppLogger("http");

// Lightweight CRUD routers get a request timeout. Transcription, post-process,
// and model downloads (whisper/mlx-asr) are intentionally excluded — they can
// legitimately run longer than this window.
const REQUEST_TIMEOUT_MS = 30_000;
const TIMEOUT_PREFIXES = [
  "/api/settings",
  "/api/keys",
  "/api/dictionary",
  "/api/dismissed-notifications",
  "/api/vocabulary",
  "/api/history",
  "/api/models",
  "/api/plugins",
  "/api/remix/thread",
  "/api/remix/runs",
];

async function shutdownServer(): Promise<void> {
  stopHistoryRetentionSweep();
  stopMeetingRetentionSweep();
  await disposeServerPlugins().catch(() => {});
}

process.on("SIGINT", () => shutdownServer().finally(() => process.exit(0)));
process.on("SIGTERM", () => shutdownServer().finally(() => process.exit(0)));

/**
 * A stable middleware that dispatches the *current* plugin middleware chain
 * (read from the live registry on every request) in resolved order. Mounting
 * this once at construction — instead of spreading the middleware array in —
 * means a runtime `reloadServerPlugins()` is observed immediately: a
 * newly-enabled plugin's routes become reachable, and a disabled plugin's stop
 * responding, all without reconstructing the app or restarting the server.
 *
 * Each plugin middleware may short-circuit (return a `Response`) or call its
 * own `next()` to defer to the following one; when the whole chain defers, the
 * outer `next()` hands off to the app's routes.
 */
const pluginMiddlewareDispatcher: MiddlewareHandler = async (c, next) => {
  const chain = plugins().collectMiddleware();
  if (chain.length === 0) return next();

  // Compose the chain so `next` at position i runs handler i+1, and the final
  // `next` falls through to the app's own routes (the outer `next`).
  const dispatch = (index: number): Promise<void> => {
    if (index >= chain.length) return next() as Promise<void>;
    return chain[index](c, () => dispatch(index + 1)) as Promise<void>;
  };
  return dispatch(0);
};

/**
 * Build the Hono app. Plugin middleware is dispatched from the *live* registry
 * per request (see {@link pluginMiddlewareDispatcher}) rather than baked in at
 * construction, so enabling/installing a plugin at runtime (via
 * `reloadServerPlugins()`) mounts its contributed routes without a restart.
 */
function createApp() {
  const base = new Hono()
    .use(trustedOriginMiddleware)
    // Confine plugin-UI-originated requests to their own plugin namespace, so a
    // same-origin plugin page can't reach keys/auth/settings or other plugins.
    .use(pluginApiGuard)
    // CORS allowlist for renderer requests: only an Origin the desktop app's
    // own renderer would plausibly send — app://, or a loopback http(s) dev
    // server — gets echoed back as Access-Control-Allow-Origin (see
    // isTrustedRendererOrigin; the same trust boundary trustedOriginMiddleware
    // already applies to mutations). Any other Origin gets no CORS header, so
    // a browser can't read the response even for a "simple" GET that isn't
    // preflighted — that's what closes "any web page can read /api/settings"
    // (authMiddleware is the actual gate on the request itself).
    //
    // Must run BEFORE auth: the desktop renderer talks to a remote server
    // cross-origin (app:// -> http://remote), so any request with an
    // Authorization header triggers an OPTIONS preflight that carries no
    // token. cors() answers the preflight and short-circuits it, so auth
    // never rejects it; real requests still fall through to auth.
    .use(
      cors({
        origin: (origin) =>
          origin && isTrustedRendererOrigin(origin) ? origin : undefined,
      }),
    )
    // Bearer-token auth — always in effect once startServer() has run (see
    // its docs and lib/auth.ts). A no-op only for a bare createApp() that
    // never went through startServer() (tests / library use).
    .use(authMiddleware)
    // Correlation id per request (also surfaced via the X-Request-Id header).
    .use(requestId())
    // Correlation scope for the raw request/response trace log. One scope per
    // request is enough to tie a dictation together: for the batch path both
    // traced boundaries (STT and the cleanup LLM call) happen while serving a
    // single POST /api/transcribe. The id is only materialised if something
    // inside actually writes a trace entry.
    .use((_c, next) => runInTraceScope(next))
    // Access log — routed through the app logger at debug level, so it shows in
    // dev but stays quiet in production. Only method/path/status are logged.
    .use(
      logger((message, ...rest) => httpLog.debug([message, ...rest].join(" "))),
    );

  // Request timeout on lightweight CRUD routers only (see TIMEOUT_PREFIXES).
  for (const prefix of TIMEOUT_PREFIXES) {
    base.use(prefix, timeout(REQUEST_TIMEOUT_MS));
    base.use(`${prefix}/*`, timeout(REQUEST_TIMEOUT_MS));
  }

  // Dispatch plugin middleware from the live registry, so a runtime reload
  // (enable/disable/install) takes effect on the next request without a restart.
  base.use(pluginMiddlewareDispatcher);

  const app = base
    .onError((err, c) => {
      // Let Hono's own exceptions (e.g. bearerAuth's 401) keep their response,
      // but still report genuine server errors.
      if (err instanceof HTTPException) {
        if (err.status >= 500) {
          httpLog.error(
            `${c.req.method} ${c.req.path} -> ${err.status}: ${formatError(err)}`,
          );
        }
        const res = err.getResponse();
        // Preserve CORS so a cross-origin renderer can read auth errors — but
        // only for a trusted origin. cors() never reaches this response (it
        // short-circuits into onError, bypassing the normal middleware
        // chain's return path), so without this check bearerAuth's 401 would
        // echo back *any* Origin header verbatim here, handing a foreign page
        // CORS read-access this same handler's success path already denies it.
        const origin = c.req.header("origin");
        if (origin && isTrustedRendererOrigin(origin)) {
          res.headers.set("Access-Control-Allow-Origin", origin);
        }
        return res;
      }
      // Always log the failure locally so it's visible in dev and captured in
      // the diagnostics log file — otherwise a 500 only shows as a status code
      // in the access log with no detail.
      httpLog.error(
        `${c.req.method} ${c.req.path} -> 500: ${formatError(err)}`,
      );
      return c.json({ error: "Internal server error" }, 500);
    })
    .get("/", (c) => c.text("Openstyle API"))
    .route("/", routes);

  return app;
}

export interface StartServerOptions {
  /** Port to listen on. Defaults to 4649. Use 0 for a random free port. */
  port?: number;
  /**
   * Host/interface to bind to. Defaults to "127.0.0.1" (loopback only).
   * Set to "0.0.0.0" to accept connections from outside the machine
   * (e.g. when running the server standalone inside a container/VM).
   */
  host?: string;
  /**
   * Optional bearer token required on all requests (except `/api/health`).
   * Auth is always in effect once the server starts: when this is
   * empty/undefined, a strong random token is generated instead of disabling
   * auth (see lib/auth.ts's `generateAuthToken`). Set it explicitly for
   * standalone/remote deployments exposed on a network.
   *
   * A loopback bind (the default `host`) with no token supplied here *and*
   * `tokenIsRetrievable` left false also enables the trusted-origin auth
   * fallback — see `authMiddleware`'s `allowTrustedOriginFallback` — so the
   * embedded Electron desktop app, which has no channel today to receive
   * this minted token, keeps working unauthenticated-but-origin-checked. Any
   * non-loopback bind, a bind with a token supplied here, or a bind that
   * sets `tokenIsRetrievable`, is bearer-token-only with no fallback.
   */
  token?: string;
  /**
   * Set by a caller that has a real channel to hand an auto-generated token
   * to whoever needs it (e.g. printing it to the operator's console — see
   * startup.ts). When true, an auto-generated token is bearer-only even on a
   * loopback bind: the trusted-origin fallback only exists because the
   * embedded Electron server has *no* such channel, so a caller that does
   * have one should not get it — the token it was just handed is not
   * decorative. Defaults to false.
   */
  tokenIsRetrievable?: boolean;
}

export interface RunningServer {
  server: ServerType;
  /** The actual port bound (useful when `port` was 0). */
  port: number;
  /** The bearer token now required on this server's API — see `StartServerOptions.token`. */
  token: string;
}

/**
 * Start the Openstyle HTTP server.
 *
 * Shared by the Electron main process (loopback, in-process) and the
 * standalone container entrypoint (see startup.ts).
 *
 * Plugins are loaded first so their contributed middleware is available when the
 * Hono app is constructed. User plugins are discovered from settings + disk.
 */
export async function startServer(
  options: StartServerOptions = {},
): Promise<RunningServer> {
  const { port = 4649, host = "127.0.0.1" } = options;

  // Bearer-token auth is always in effect once the server actually starts: an
  // explicitly supplied token is used verbatim, otherwise a strong random one
  // is minted so auth is never silently disabled (see lib/auth.ts). Configure
  // it before the app is built so authMiddleware picks it up. A loopback bind
  // with no explicitly supplied token also enables the trusted-origin
  // fallback — see StartServerOptions.token and lib/auth.ts.
  const explicitToken = options.token?.trim();
  const token = explicitToken || generateAuthToken();
  const isLoopbackHost =
    host === "127.0.0.1" || host === "localhost" || host === "::1";
  setAuthToken(token, {
    allowTrustedOriginFallback:
      isLoopbackHost && !explicitToken && !options.tokenIsRetrievable,
  });

  // Install the global network dispatcher (corporate proxy + custom CA) before
  // anything issues a fetch, so model downloads and cloud/API calls honor it.
  configureNetwork();

  // Load plugins (built-in + user) before serving. The app dispatches plugin
  // middleware from the live registry per request, so later runtime reloads
  // (enable/disable/install) take effect without reconstructing the app.
  await initServerPlugins();

  const app = createApp();

  startHistoryRetentionSweep();
  startMeetingRetentionSweep();

  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ noServer: true });
    const server = serve(
      {
        fetch: app.fetch,
        port,
        hostname: host,
        websocket: { server: wss },
      },
      (info) => {
        resolve({ server, port: info.port, token });
      },
    );
    // Reject if the server fails to bind (e.g. EADDRINUSE) before listening.
    server.once("error", reject);
  });
}

export { closeDb, writeSetting } from "./lib/db.js";
export { stopMlxServer } from "./lib/mlx-asr/server.js";
export { configureNetwork } from "./lib/network.js";
export {
  disposeServerPlugins,
  reloadServerPlugins,
} from "./lib/plugins/index.js";
export {
  type InstalledPackage,
  installPackage,
  type ResolvedPackage,
  resolvePackage,
  uninstallPackage,
} from "./lib/plugins/installer.js";
export { stopServer as stopWhisperServer } from "./lib/whisper/server.js";
export {
  activateManagedMlxRuntimeForAppVersion,
  prefetchManagedMlxRuntimeForAppRelease,
  reconcileUnsupportedMlxVoiceDefault,
};

export type AppType = ReturnType<typeof createApp>;

export default createApp;
