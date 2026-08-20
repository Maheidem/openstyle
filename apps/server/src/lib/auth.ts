import { randomBytes } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { timingSafeEqual } from "hono/utils/buffer";
import { isTrustedRendererOrigin } from "./trusted-origin.js";

// The active bearer token. Empty means no caller has configured auth at all —
// e.g. a bare `createApp()` in tests/library use, which stays open as before.
// The real runtime entrypoint, `startServer()` (see index.ts), always calls
// `setAuthToken()` with a non-empty value — generating one when none is
// configured — so auth is never silently disabled once the server is
// actually running.
let authToken = "";

// True only when startServer() bound to a loopback-only host AND no token was
// explicitly supplied (env var / options) — i.e. it minted its own. That's
// the embedded-Electron shape: the desktop app has no channel today to
// receive a freshly-minted per-boot token (see startServer's docs and the
// separation-audit notes for this fix), so a request whose Origin the app
// itself would send — or that carries no Origin at all, true of the Electron
// main process's own Node-side `fetch` calls — is let in without the token.
// A standalone/remote deployment that sets OPENSTYLE_AUTH_TOKEN, or binds to
// a non-loopback host, never sets this: bearer token is the only way in for
// those, full stop.
let allowTrustedOriginFallback = false;

export function setAuthToken(
  token: string | undefined,
  options: { allowTrustedOriginFallback?: boolean } = {},
): void {
  authToken = token?.trim() ?? "";
  // Always resets (not merged) so a later setAuthToken() call — including the
  // test suite's afterEach cleanup — can't leave a stale fallback enabled.
  allowTrustedOriginFallback = options.allowTrustedOriginFallback ?? false;
}

export function getAuthToken(): string {
  return authToken;
}

/** A cryptographically strong bearer token (256 bits, hex-encoded). */
export function generateAuthToken(): string {
  return randomBytes(32).toString("hex");
}

// Liveness endpoint stays open so Docker/health probes work without a token.
const EXEMPT_PATHS = new Set(["/api/health"]);

/**
 * Enforces bearer-token auth whenever a token is configured — always, once
 * `startServer()` has run (see module docs above). No-op only for a bare
 * `createApp()` that never called `setAuthToken()`.
 *
 * - `/api/health` is always exempt (liveness probes).
 * - When `allowTrustedOriginFallback` is set (loopback bind, no explicitly
 *   configured token), a request whose Origin the desktop app itself would
 *   send — or that carries no Origin at all — is let through without the
 *   token. See {@link isTrustedRendererOrigin}.
 * - WebSocket upgrades (e.g. `/stream`) otherwise authenticate via a
 *   `?token=` query param, since browsers can't set the `Authorization`
 *   header on a socket.
 * - Everything else uses Hono's builtin bearerAuth (`Authorization: Bearer`).
 */
export const authMiddleware: MiddlewareHandler = async (c, next) => {
  const token = getAuthToken();
  if (!token) return next();
  if (EXEMPT_PATHS.has(c.req.path)) return next();

  if (
    allowTrustedOriginFallback &&
    isTrustedRendererOrigin(c.req.header("origin"))
  ) {
    return next();
  }

  if (c.req.header("upgrade")?.toLowerCase() === "websocket") {
    // Constant-time compare, matching what bearerAuth does for the HTTP path.
    if (await timingSafeEqual(c.req.query("token") ?? "", token)) return next();
    return c.json({ error: "Unauthorized" }, 401);
  }

  return bearerAuth({ token })(c, next);
};
