import type { AppType } from "@openstyle/server";
import { isOpenstyleHealthBody } from "@openstyle/validations";
import { hc, type InferResponseType } from "hono/client";
import { bearerAuthHeaders } from "../../../shared/server-auth";

const HEALTH_TIMEOUT_MS = 3000;
// Port of this app's own server, from main. Null until main answers. There is
// no default port: the default port can belong to another Openstyle app (the
// installed app next to Openstyle Dev or a test app), so a request before the
// answer would read the data of that app.
let resolvedPort: number | null = null;
// Configured external server URL ("" = use the local server).
let serverUrl = "";
// Optional bearer token for a configured server ("" = none).
let serverToken = "";
let initialized = false;
// The in-flight init, shared so concurrent callers (e.g. the module-load
// prefetch and the auth provider) don't each run a redundant refreshApiBase().
let initPromise: Promise<void> | null = null;

/**
 * Base URL of the locally-run server (used when no server URL is configured).
 * Throws when main has not given the port yet. Call {@link initApiBase} first.
 */
export function getLocalApiBase(): string {
  if (resolvedPort === null) {
    throw new Error("The Openstyle server port is not known yet");
  }
  return `http://127.0.0.1:${resolvedPort}`;
}

/**
 * Base URL the app talks to: the configured server, or the local one. Throws
 * when the base is not known yet (see {@link getLocalApiBase}).
 */
export function getApiBase(): string {
  return serverUrl || getLocalApiBase();
}

/** True when {@link getApiBase} has a base URL to give. */
export function hasApiBase(): boolean {
  return !!serverUrl || resolvedPort !== null;
}

/** Bearer token for the configured server, or "" when none is set. */
export function getServerToken(): string {
  return serverToken;
}

/** True when pointed at a configured (non-loopback) server. */
export function isRemoteServer(): boolean {
  return !!serverUrl;
}

/**
 * fetch() against the configured Openstyle server: waits until the base URL is
 * known, resolves it and injects the bearer token (when set), while preserving
 * every caller init option (method, body, keepalive, signal, custom headers).
 * No request goes out before the base is known. When the lookup fails, the
 * request fails, and the next request tries the lookup again.
 *
 * The typed client of {@link getClient} sends its requests through this
 * function. Call it directly only for the few requests the typed `hc` client
 * can't express — binary bodies (the WAV upload) and fire-and-forget beacons.
 */
export async function apiFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  await initApiBase();
  const headers = new Headers(init.headers);
  // Additive — never clobber a header the caller set explicitly.
  for (const [key, value] of Object.entries(bearerAuthHeaders(serverToken))) {
    if (!headers.has(key)) headers.set(key, value);
  }
  return fetch(`${getApiBase()}${path}`, { ...init, headers });
}

export async function initApiBase(): Promise<void> {
  if (initialized) return;
  // Dedupe concurrent first-callers onto a single refreshApiBase() so startup
  // doesn't fire the server-URL/token/health probe twice in the same tick.
  if (!initPromise) {
    initPromise = refreshApiBase()
      .then(() => {
        // A failed port lookup leaves no base. Fail now, and let the next
        // caller try the lookup again.
        if (!hasApiBase()) {
          throw new Error("Could not get the Openstyle server port from main");
        }
        initialized = true;
      })
      .finally(() => {
        initPromise = null;
      });
  }
  await initPromise;
}

/**
 * Verify a Openstyle server is reachable and identifies itself at `base`.
 * `/api/health` is unauthenticated, so this checks reachability only.
 */
export async function checkServerHealth(
  base: string,
  timeoutMs = HEALTH_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const res = await hc<AppType>(base).api.health.$get(
      {},
      { init: { signal: AbortSignal.timeout(timeoutMs) } },
    );
    if (!res.ok) return false;
    const data = await res.json();
    return isOpenstyleHealthBody(data);
  } catch {
    return false;
  }
}

/**
 * Verify the bearer token is accepted by hitting an authenticated endpoint.
 * Returns true when the token is valid (or when no token is required).
 */
export async function checkServerAuth(
  base: string,
  token: string,
  timeoutMs = HEALTH_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const res = await hc<AppType>(base, {
      headers: bearerAuthHeaders(token),
    }).api.settings.$get(
      {},
      { init: { signal: AbortSignal.timeout(timeoutMs) } },
    );
    return res.ok;
  } catch {
    return false;
  }
}

/** Re-read the server location/token and verify it's reachable. */
export async function refreshApiBase(): Promise<boolean> {
  try {
    // Main returns an already-validated, normalized value.
    serverUrl = await window.api.getServerUrl();
  } catch {
    serverUrl = "";
  }
  try {
    serverToken = await window.api.getServerToken();
  } catch {
    serverToken = "";
  }
  if (!serverUrl) {
    try {
      resolvedPort = await window.api.getServerPort();
    } catch {
      // Never guess the port. Keep the last port that main gave (it is this
      // app's own port), or stay without a base when there is none.
    }
  }
  if (!hasApiBase()) return false;
  return checkServerHealth(getApiBase(), HEALTH_TIMEOUT_MS);
}

// Placeholder origin of the typed client. `apiFetch` replaces it with the
// real base when the request goes out, so a request made before the port is
// known waits for it instead of going to a wrong port.
const CLIENT_ORIGIN = "http://openstyle-server.invalid";

function clientFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input);
  return apiFetch(`${url.pathname}${url.search}`, init);
}

// One typed client for the life of the window. The base URL and the token are
// read per request in `apiFetch`, so a `server:changed` broadcast needs no
// new client.
const client = hc<AppType>(CLIENT_ORIGIN, { fetch: clientFetch });

export function getClient() {
  return client;
}

/** The typed Hono client that {@link getClient} returns. */
export type ApiClient = ReturnType<typeof getClient>;

/**
 * The 200 body of one typed-client endpoint, for example
 * `ApiRes<ApiClient["api"]["history"]["stats"]["$get"]>`. Use it in place of
 * a hand-written copy of the server type, so a route change breaks the build.
 */
export type ApiRes<T> = InferResponseType<T, 200>;
