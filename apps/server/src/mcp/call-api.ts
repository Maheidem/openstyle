// In-process calls from an MCP tool to the existing REST routes. The request
// goes through the whole Hono app (the global middleware, the zod validators
// and the side effects of the route). It carries the server bearer token, the
// same credential the global auth middleware checks.
import { getAuthToken } from "../lib/auth.js";

/** The `fetch` of the Hono app. */
export type AppFetch = (request: Request) => Response | Promise<Response>;

export interface ApiResult {
  ok: boolean;
  status: number;
  /** The parsed JSON body, or the raw text when the body is not JSON. */
  data: unknown;
}

export type ApiCaller = (
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
) => Promise<ApiResult>;

/** The error text of a failed route answer. */
export function apiErrorText(result: ApiResult): string {
  const data = result.data as { error?: unknown } | null;
  if (data && typeof data === "object" && typeof data.error === "string") {
    return data.error;
  }
  if (typeof result.data === "string" && result.data) return result.data;
  return `HTTP ${result.status}`;
}

export function createApiCaller(appFetch: AppFetch): ApiCaller {
  return async (method, path, body) => {
    const headers = new Headers();
    const token = getAuthToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (body !== undefined) headers.set("Content-Type", "application/json");
    const response = await appFetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    const text = await response.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON. Keep the text.
    }
    return { ok: response.ok, status: response.status, data };
  };
}
