// The /mcp route: MCP over Streamable HTTP, stateless, with JSON responses.
// The global auth middleware skips /mcp (lib/auth.ts EXEMPT_PATHS). This
// route does a stricter check instead:
//   1. 404 when OPENSTYLE_MCP_TOKEN is not set (MCP is not offered).
//   2. 403 when the Host header is not a loopback name.
//   3. 401 when the Bearer token is missing or wrong (timingSafeEqual).
//   4. 403 when the user turned agent access off (setting mcp_enabled).
// There is no trusted-origin fallback here: a request with no Origin and no
// token is refused. The global trustedOriginMiddleware still refuses a POST
// from a foreign Origin before this route runs.
import { createHash, timingSafeEqual } from "node:crypto";
import {
  createMcpHandler,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { SETTINGS_KEYS } from "@openstyle/validations";
import { Hono } from "hono";
import { readSetting } from "../lib/db.js";
import { type AppFetch, createApiCaller } from "./call-api.js";
import { buildMcpServer } from "./server.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const ACCESS_OFF_MESSAGE =
  "Agent access is off. Turn on Settings > Agents (MCP) in Openstyle.";

/** The host name of a Host header, without the port. */
function hostName(host: string | undefined): string {
  if (!host) return "";
  const value = host.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end === -1 ? value : value.slice(0, end + 1);
  }
  const colon = value.indexOf(":");
  return colon === -1 ? value : value.slice(0, colon);
}

/** Constant-time compare. Hashing first gives both sides the same length. */
function sameToken(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return match ? match[1].trim() : null;
}

function jsonRpcError(status: number, message: string): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null,
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

function agentOf(request: Request | undefined): string {
  return request?.headers.get("x-openstyle-agent")?.trim() || "unknown";
}

export function createMcpRoute(appFetch: AppFetch) {
  const api = createApiCaller(appFetch);
  const version = process.env.OPENSTYLE_APP_VERSION || "dev";
  const build = (request: Request | undefined) =>
    buildMcpServer({ api, agent: agentOf(request), version });
  // 2026-07-28 era clients: the SDK handler, JSON mode. It builds a new
  // server for each request.
  const modern = createMcpHandler((ctx) => build(ctx.requestInfo), {
    legacy: "reject",
    responseMode: "auto",
  });

  // 2025-era clients (an `initialize` handshake) get the stateless Streamable
  // HTTP transport with JSON responses. One builder serves both eras.
  async function serve(request: Request): Promise<Response> {
    let parsedBody: unknown;
    try {
      parsedBody = await request.clone().json();
    } catch {
      return jsonRpcError(400, "Parse error: the body is not valid JSON");
    }
    if (!(await isLegacyRequest(request, parsedBody))) {
      return modern.fetch(request, { parsedBody });
    }
    const server = build(request);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request, { parsedBody });
    } finally {
      await transport.close();
      await server.close();
    }
  }

  return new Hono()
    .use(async (c, next) => {
      const expected = process.env.OPENSTYLE_MCP_TOKEN?.trim();
      if (!expected) return c.json({ error: "Not found" }, 404);
      // @hono/node-server builds the URL from the Host header. A Request
      // built in-process has no Host header, so the URL host is the fallback.
      const host = c.req.header("host") ?? new URL(c.req.url).host;
      if (!LOOPBACK_HOSTS.has(hostName(host))) {
        return c.json({ error: "Forbidden host" }, 403);
      }
      const given = bearerToken(c.req.header("authorization"));
      if (given === null || !sameToken(given, expected)) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      if (readSetting(SETTINGS_KEYS.mcpEnabled) === "false") {
        return c.json({ error: ACCESS_OFF_MESSAGE, code: "mcp_disabled" }, 403);
      }
      return next();
    })
    .post("/", (c) => serve(c.req.raw))
    .on(["GET", "DELETE"], "/", () =>
      jsonRpcError(405, "Method not allowed. This server is stateless."),
    );
}
