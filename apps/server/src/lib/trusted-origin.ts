import type { MiddlewareHandler } from "hono";

/**
 * True when `origin` is one the desktop app's own renderer would plausibly
 * send: the packaged app's `app://` scheme, a loopback `http(s)` dev server
 * (any port — the Vite dev server and the API server run on different
 * ports), or no Origin header at all (typical of non-browser callers like
 * the Electron main process's own `fetch` calls, or same-origin requests).
 *
 * Two independent consumers rely on this same trust boundary: the mutation
 * gate below, and — for the loopback embedded server, which now always
 * requires a bearer token — the trusted-origin auth fallback in
 * `lib/auth.ts`. Keeping one definition means those two gates can't drift
 * apart and leave a gap between "what CORS/mutations trust" and "what auth
 * trusts".
 */
export function isTrustedRendererOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  if (origin.startsWith("app://")) return true;
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    );
  } catch {
    return false;
  }
}

const PROTECTED_READ_PREFIXES = ["/api/remix"];

export const trustedOriginMiddleware: MiddlewareHandler = async (c, next) => {
  const isMutation = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
  const isWebSocket = c.req.header("upgrade")?.toLowerCase() === "websocket";
  const isProtectedRead =
    c.req.method !== "OPTIONS" &&
    PROTECTED_READ_PREFIXES.some(
      (prefix) => c.req.path === prefix || c.req.path.startsWith(`${prefix}/`),
    );
  if (
    (isMutation || isWebSocket || isProtectedRead) &&
    !isTrustedRendererOrigin(c.req.header("origin"))
  ) {
    return c.json({ error: "Forbidden" }, 403);
  }
  return next();
};
