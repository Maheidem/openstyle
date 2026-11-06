// The stdio bridge between an agent tool and the /mcp route of the running
// app (specs/mcp.md 7.1). Node builtins only: the launcher runs this file
// with ELECTRON_RUN_AS_NODE=1, from inside app.asar, with no node_modules.
//
// For each JSON-RPC line on stdin, the bridge reads <userData>/mcp.json again
// (the port can change after a restart), POSTs the line to
// http://127.0.0.1:<port>/mcp and writes the JSON-RPC answer to stdout. stdout
// carries JSON-RPC only. Errors go to stderr.
//
// The bridge answers the MCP handshake itself (`initialize`,
// `notifications/initialized`), so an agent connects also when the app does
// not run, agent access is off or the token is wrong. In those cases the tool
// list has one tool, `openstyle_status`, and every tool call gives the reason
// as a tool error. When the app answers again, the bridge sends
// `notifications/tools/list_changed` and the real tools come back.
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

export const NOT_RUNNING_MESSAGE =
  "Openstyle is not running. Start the app, then try again.";
export const BAD_TOKEN_MESSAGE =
  "Openstyle refused the connection key of this agent. Quit Openstyle and start it again, then try again.";

/**
 * The 2025-era protocol versions of @modelcontextprotocol/server 2.4.0
 * (SUPPORTED_PROTOCOL_VERSIONS without the 2026 era). The first one is the
 * answer for a version that is not in the list, as the SDK does
 * (Server._oninitialize). bridge.test.ts compares this list with the SDK.
 */
export const BRIDGE_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
];

/** The one tool of the fallback list. */
export const STATUS_TOOL = {
  name: "openstyle_status",
  description:
    "Explains why the Openstyle tools are not available now, and what to do. Call it, then tell the user the answer.",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

/** How often the bridge checks for the app while it uses the fallback list. */
const PROBE_MS = 5000;

/** The `_meta` key of the client info in the 2026 protocol era. */
const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
const REQUEST_TIMEOUT_MS = 120_000;

interface McpConnection {
  port: number;
  token: string;
}

type JsonRpcId = string | number | null;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * The profile folder, first match wins: `--user-data <dir>`, then
 * OPENSTYLE_USER_DATA, then ~/Library/Application Support/<bundle name>.
 */
export function resolveUserDataDir(
  argv: string[],
  env: NodeJS.ProcessEnv,
  home = homedir(),
): string {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--user-data" && argv[i + 1]) return argv[i + 1];
    if (arg.startsWith("--user-data=")) return arg.slice("--user-data=".length);
  }
  if (env.OPENSTYLE_USER_DATA) return env.OPENSTYLE_USER_DATA;
  const bundleName = env.OPENSTYLE_BUNDLE_NAME?.trim() || "Openstyle";
  return join(home, "Library", "Application Support", bundleName);
}

function readConnection(userDataDir: string): McpConnection | null {
  try {
    const raw = JSON.parse(
      readFileSync(join(userDataDir, "mcp.json"), "utf8"),
    ) as Partial<McpConnection>;
    if (typeof raw.port !== "number" || typeof raw.token !== "string") {
      return null;
    }
    return { port: raw.port, token: raw.token };
  } catch {
    return null;
  }
}

function errorAnswer(id: JsonRpcId, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

/** A request has a method and an id. A notification or a response gets no answer. */
function requestIds(body: unknown): JsonRpcId[] {
  const list = Array.isArray(body) ? body : [body];
  return list
    .filter(
      (m): m is JsonRpcMessage =>
        typeof m === "object" &&
        m !== null &&
        typeof (m as JsonRpcMessage).method === "string" &&
        (m as JsonRpcMessage).id !== undefined,
    )
    .map((m) => m.id ?? null);
}

/** The agent name for the server log: `<clientInfo.name>/<clientInfo.version>`. */
function agentFrom(message: JsonRpcMessage): string | null {
  const params = message.params;
  if (!params) return null;
  const meta = params._meta as Record<string, unknown> | undefined;
  const info = (
    message.method === "initialize"
      ? params.clientInfo
      : meta?.[CLIENT_INFO_META_KEY]
  ) as { name?: unknown; version?: unknown } | undefined;
  if (!info || typeof info.name !== "string") return null;
  return typeof info.version === "string"
    ? `${info.name}/${info.version}`
    : info.name;
}

interface HttpAnswer {
  status: number;
  contentType: string;
  body: string;
}

function post(
  connection: McpConnection,
  body: string,
  agent: string,
): Promise<HttpAnswer> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: connection.port,
        path: "/mcp",
        method: "POST",
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${connection.token}`,
          "X-Openstyle-Agent": agent,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            contentType: String(res.headers["content-type"] ?? ""),
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("The request timed out")));
    req.on("error", reject);
    req.end(body);
  });
}

/** The JSON-RPC messages in an HTTP answer: a JSON body or SSE `data:` lines. */
function messagesOf(answer: HttpAnswer): unknown[] {
  const texts = answer.contentType.includes("text/event-stream")
    ? answer.body
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
    : [answer.body];
  const messages: unknown[] = [];
  for (const text of texts) {
    if (!text) continue;
    try {
      const parsed = JSON.parse(text) as unknown;
      messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      // Not JSON-RPC.
    }
  }
  return messages.filter(
    (m) => typeof m === "object" && m !== null && "jsonrpc" in m,
  );
}

/** The error text of a refused request (the gate answers `{ error }`). */
function gateError(answer: HttpAnswer): string {
  try {
    const body = JSON.parse(answer.body) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // Not JSON.
  }
  return `Openstyle refused the request (HTTP ${answer.status}).`;
}

export interface Bridge {
  /** Handle one line of stdin. Resolves after the answer is written. */
  handleLine(line: string): Promise<void>;
  /** Check once if the app answers again (the fallback timer calls it). */
  checkNow(): Promise<void>;
  /** Stop the fallback timer. */
  close(): void;
}

/** Why the app cannot answer, or null when the failure is another error. */
function fallbackReason(answer: HttpAnswer): string | null {
  if (answer.status === 401) return BAD_TOKEN_MESSAGE;
  if (answer.status === 403) {
    try {
      const body = JSON.parse(answer.body) as { code?: unknown };
      if (body.code === "mcp_disabled") return gateError(answer);
    } catch {
      // Not JSON: another 403 (for example a foreign Host).
    }
  }
  return null;
}

function resultAnswer(id: JsonRpcId, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

/** The answer of `initialize`: the version rule of the SDK. */
export function initializeResult(
  requested: unknown,
  version: string,
): Record<string, unknown> {
  const protocolVersion =
    typeof requested === "string" &&
    BRIDGE_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : BRIDGE_PROTOCOL_VERSIONS[0];
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: true } },
    serverInfo: { name: "openstyle", version },
  };
}

export function createBridge(options: {
  userDataDir: string;
  /** Write one JSON-RPC message (one line, no newline). */
  write: (line: string) => void;
  logError?: (text: string) => void;
  /** The app version for serverInfo. */
  version?: string;
  /** The interval of the app check in fallback mode. 0 turns the timer off. */
  probeMs?: number;
}): Bridge {
  const logError = options.logError ?? (() => {});
  const version = options.version || "unknown";
  const probeMs = options.probeMs ?? PROBE_MS;
  let agent = "unknown";
  /** "real": the app gave the tool list. "fallback": only openstyle_status. */
  let mode: "unknown" | "real" | "fallback" = "unknown";
  let timer: ReturnType<typeof setInterval> | null = null;

  function setMode(next: "real" | "fallback"): void {
    const before = mode;
    mode = next;
    if (next === "fallback" && !timer && probeMs > 0) {
      timer = setInterval(() => void checkNow(), probeMs);
      timer.unref?.();
    }
    if (next === "real" && timer) {
      clearInterval(timer);
      timer = null;
    }
    // The capabilities say tools.listChanged, so the client reads the list
    // again after this notification (MCP spec, server/tools).
    if (before !== "unknown" && before !== next) {
      options.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/tools/list_changed",
        }),
      );
    }
  }

  /** The reason why the app cannot answer, or null when it answers. */
  async function send(
    text: string,
  ): Promise<{ answer: HttpAnswer } | { reason: string }> {
    const connection = readConnection(options.userDataDir);
    if (!connection) return { reason: NOT_RUNNING_MESSAGE };
    try {
      const answer = await post(connection, text, agent);
      const reason = fallbackReason(answer);
      return reason ? { reason } : { answer };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ECONNREFUSED" && code !== "ECONNRESET") {
        logError(`openstyle-mcp: request failed: ${String(err)}`);
      }
      return { reason: NOT_RUNNING_MESSAGE };
    }
  }

  async function checkNow(): Promise<void> {
    if (mode !== "fallback") return;
    const probe = JSON.stringify({
      jsonrpc: "2.0",
      id: "openstyle-bridge-probe",
      method: "ping",
    });
    const sent = await send(probe);
    if ("answer" in sent && sent.answer.status < 400) setMode("real");
  }

  /** The answer for one request when the app cannot answer. */
  function fallbackAnswer(message: JsonRpcMessage, reason: string): string {
    const id = message.id ?? null;
    if (message.method === "tools/list") {
      return resultAnswer(id, { tools: [STATUS_TOOL] });
    }
    if (message.method === "tools/call") {
      return resultAnswer(id, {
        content: [{ type: "text", text: reason }],
        isError: true,
      });
    }
    if (message.method === "ping") return resultAnswer(id, {});
    return errorAnswer(id, -32000, reason);
  }

  async function handleLine(line: string): Promise<void> {
    const text = line.trim();
    if (!text) return;
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      options.write(errorAnswer(null, -32700, "Parse error"));
      return;
    }
    for (const message of Array.isArray(body) ? body : [body]) {
      if (typeof message === "object" && message !== null) {
        agent = agentFrom(message as JsonRpcMessage) ?? agent;
      }
    }
    const single =
      !Array.isArray(body) && typeof body === "object" && body !== null
        ? (body as JsonRpcMessage)
        : null;
    // The handshake is local: the app can be down at this time.
    if (single?.method === "initialize" && single.id !== undefined) {
      options.write(
        resultAnswer(
          single.id,
          initializeResult(single.params?.protocolVersion, version),
        ),
      );
      return;
    }
    if (single?.method === "notifications/initialized") return;

    const ids = requestIds(body);
    const sent = await send(text);
    if ("reason" in sent) {
      if (single && single.id !== undefined && single.method) {
        options.write(fallbackAnswer(single, sent.reason));
        if (single.method === "tools/list" || single.method === "tools/call")
          setMode("fallback");
      } else {
        for (const id of ids)
          options.write(errorAnswer(id, -32000, sent.reason));
      }
      return;
    }
    const answer = sent.answer;
    const messages = messagesOf(answer);
    if (messages.length > 0) {
      for (const message of messages) options.write(JSON.stringify(message));
      if (single?.method === "tools/list" && answer.status < 400) {
        setMode("real");
      }
      return;
    }
    if (answer.status >= 400) {
      const reason = gateError(answer);
      logError(`openstyle-mcp: HTTP ${answer.status}: ${reason}`);
      for (const id of ids) options.write(errorAnswer(id, -32000, reason));
    }
  }

  function close(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { handleLine, checkNow, close };
}
