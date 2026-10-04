import { setTimeout as wait } from "node:timers/promises";
import type { AppType } from "@openstyle/server";
import { createAppLogger } from "@openstyle/utils";
import {
  DEFAULT_SERVER_PORT,
  isOpenstyleHealthBody,
  serverUrlSchema,
} from "@openstyle/validations";
import { net } from "electron";
import { hc } from "hono/client";
import { bearerAuthHeaders, type ServerFetch } from "../shared/server-auth";
import { readSettings } from "./local-settings";

const log = createAppLogger("electron");

// Port of the embedded server. The boot code sets it once the server is bound.
let serverPort = DEFAULT_SERVER_PORT;

export function getServerPort(): number {
  return serverPort;
}

export function setServerPort(port: number): void {
  serverPort = port;
}

/**
 * The configured Openstyle server URL, if the user has set one. When present,
 * the app talks to that server (for server-owned data: settings, history,
 * transcription) instead of the locally-run one. Returns an empty
 * string when using the default local server.
 *
 * The local server is always started regardless, so switching back to local
 * (or between remotes) never requires a restart — see the startup block.
 */
export function getServerUrl(): string {
  const parsed = serverUrlSchema.safeParse(readSettings().serverUrl);
  return parsed.success ? parsed.data : "";
}

/** Optional bearer token sent to a configured server ("" = none). */
export function getServerToken(): string {
  const raw = readSettings().serverToken;
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Authorization headers for main-process API calls to a configured server.
 * Empty when no token is set (the default local-server case), so loopback
 * requests are unaffected.
 */
export function getServerAuthHeaders(): Record<string, string> {
  return bearerAuthHeaders(getServerToken());
}

/**
 * `fetch` bound to the current server target. `path` starts after `/api`.
 * Auth headers go first, so a header of the caller always wins.
 */
export const serverFetch: ServerFetch = (path, init) =>
  fetch(`${getServerBaseUrl()}/api${path}`, {
    ...init,
    headers: { ...getServerAuthHeaders(), ...init?.headers },
  });

/**
 * Typed `hc` client bound to the current server target (local or configured
 * remote) with auth headers — the main-process counterpart to the renderer's
 * getClient(). Reads the target per call, so it always tracks the latest
 * server:changed state without a restart.
 */
export function serverClient() {
  return hc<AppType>(getServerBaseUrl(), { headers: getServerAuthHeaders() });
}

/**
 * Base URL the app uses to reach the Openstyle server: the configured remote
 * URL, or the locally-run server on the resolved port. The DB lives behind the
 * server, so all server-owned data (settings, history) is read through it.
 */
export function getServerBaseUrl(): string {
  return getServerUrl() || `http://127.0.0.1:${serverPort}`;
}

// Per-request timeout for main-process API calls to the server.
const SERVER_SETTING_TIMEOUT_MS = 5000;
// How long boot waits for the server to answer before registering the hotkey
// with whatever it can read (falling back to the default accelerator).
const SERVER_READY_TIMEOUT_MS = 5000;

export async function putServerSetting(
  key: string,
  value: string,
): Promise<boolean> {
  try {
    const res = await serverClient().api.settings[":key"].$put(
      { param: { key }, json: { value } },
      { init: { signal: AbortSignal.timeout(SERVER_SETTING_TIMEOUT_MS) } },
    );
    return res.ok;
  } catch (err) {
    log.warn(`Failed to save setting "${key}":`, err);
    return false;
  }
}

/**
 * Read all server-owned settings in one request. Returns `null` when the server
 * is unreachable — distinct from an empty map (server reachable, nothing
 * stored) so callers don't mistake a network blip for "unset" and clobber
 * last-known-good values (e.g. reverting the hotkey mode to its default).
 *
 * All server-owned state (settings, models, history) lives behind the
 * server — local or a configured remote — so the main process reads it through
 * the API rather than opening the SQLite file directly. This keeps a single
 * source of truth and makes a configured remote server behave identically.
 */
export async function getServerSettings(): Promise<Record<
  string,
  string
> | null> {
  try {
    const res = await serverClient().api.settings.$get(
      {},
      { init: { signal: AbortSignal.timeout(SERVER_SETTING_TIMEOUT_MS) } },
    );
    if (!res.ok) return null;
    return (await res.json()) as Record<string, string>;
  } catch {
    return null;
  }
}

/** Number of configured models behind the current server (0 when unreachable). */
export async function getConfiguredModelCount(): Promise<number> {
  try {
    const res = await serverClient().api.models.configured.$get(
      {},
      { init: { signal: AbortSignal.timeout(SERVER_SETTING_TIMEOUT_MS) } },
    );
    if (!res.ok) return 0;
    const data = (await res.json()) as unknown[];
    return Array.isArray(data) ? data.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Probe `/api/health` at `baseUrl` and confirm it's actually a Openstyle server
 * (not some other service that happens to hold the port). Returns false on any
 * network error or non-matching identity.
 */
export async function probeServerHealth(
  baseUrl: string,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const res = await net.fetch(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { status?: string; name?: string };
    return isOpenstyleHealthBody(data);
  } catch {
    return false;
  }
}

/**
 * Resolve once the current server target answers `/api/health`, or after
 * `timeoutMs`. Used at boot before the first settings read, since the local
 * server starts asynchronously (fire-and-forget) and may not be listening yet.
 */
export async function waitForServerReady(
  timeoutMs = SERVER_READY_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeServerHealth(getServerBaseUrl(), 1000)) return true;
    await wait(150);
  }
  return false;
}
