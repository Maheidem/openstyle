// The stdio bridge between an agent tool and the /mcp route of the running
// app (specs/mcp.md 7.1). Node builtins only: the launcher runs this file
// with ELECTRON_RUN_AS_NODE=1, from inside app.asar, with no node_modules.
//
// For each JSON-RPC line on stdin, the bridge reads <userData>/mcp.json again
// (the port can change after a restart), POSTs the line to
// http://127.0.0.1:<port>/mcp and writes the JSON-RPC answer to stdout. stdout
// carries JSON-RPC only. Errors go to stderr.
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

export const NOT_RUNNING_MESSAGE =
  "Openstyle is not running. Start the app, then try again.";

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
}

export function createBridge(options: {
  userDataDir: string;
  /** Write one JSON-RPC message (one line, no newline). */
  write: (line: string) => void;
  logError?: (text: string) => void;
}): Bridge {
  const logError = options.logError ?? (() => {});
  let agent = "unknown";

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
    const ids = requestIds(body);
    const failAll = (message: string): void => {
      for (const id of ids) options.write(errorAnswer(id, -32000, message));
    };

    const connection = readConnection(options.userDataDir);
    if (!connection) {
      failAll(NOT_RUNNING_MESSAGE);
      return;
    }
    let answer: HttpAnswer;
    try {
      answer = await post(connection, text, agent);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ECONNREFUSED" && code !== "ECONNRESET") {
        logError(`openstyle-mcp: request failed: ${String(err)}`);
      }
      failAll(NOT_RUNNING_MESSAGE);
      return;
    }
    const messages = messagesOf(answer);
    if (messages.length > 0) {
      for (const message of messages) options.write(JSON.stringify(message));
      return;
    }
    if (answer.status >= 400) {
      const reason = gateError(answer);
      logError(`openstyle-mcp: HTTP ${answer.status}: ${reason}`);
      failAll(reason);
    }
  }

  return { handleLine };
}
