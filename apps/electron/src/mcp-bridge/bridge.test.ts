import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BAD_TOKEN_MESSAGE,
  BRIDGE_PROTOCOL_VERSIONS,
  createBridge,
  NOT_RUNNING_MESSAGE,
  resolveUserDataDir,
  STATUS_TOOL,
} from "./bridge";

// The stdio bridge against a fake /mcp server (specs/mcp.md 7.1, 9.2).

interface Seen {
  headers: IncomingMessage["headers"];
  body: string;
}

let dir: string;
let server: Server | null = null;
let seen: Seen[] = [];
let reply: (body: unknown) => { status: number; type: string; text: string };

function startServer(port = 0): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        seen.push({ headers: req.headers, body });
        const answer = reply(JSON.parse(body));
        res.writeHead(answer.status, { "Content-Type": answer.type });
        res.end(answer.text);
      });
    });
    server.listen(port, "127.0.0.1", () =>
      resolve((server?.address() as AddressInfo).port),
    );
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
    server = null;
  });
}

function writeConfig(port: number): void {
  writeFileSync(
    join(dir, "mcp.json"),
    JSON.stringify({ port, token: "secret" }),
  );
}

const bridges: { close(): void }[] = [];
function bridge() {
  const out: unknown[] = [];
  const b = createBridge({
    userDataDir: dir,
    write: (line) => out.push(JSON.parse(line)),
    version: "3.1.0-test",
    probeMs: 0,
  });
  bridges.push(b);
  return { b, out };
}

const callStatus = JSON.stringify({
  jsonrpc: "2.0",
  id: 4,
  method: "tools/call",
  params: { name: "openstyle_status", arguments: {} },
});
const LIST_CHANGED = {
  jsonrpc: "2.0",
  method: "notifications/tools/list_changed",
};
const fallbackList = (id: number) => ({
  jsonrpc: "2.0",
  id,
  result: { tools: [STATUS_TOOL] },
});
const toolError = (id: number, text: string) => ({
  jsonrpc: "2.0",
  id,
  result: { content: [{ type: "text", text }], isError: true },
});

const initialize = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "claude-code", version: "2.1.0" },
  },
});
const listTools = JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/list",
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-bridge-test-"));
  seen = [];
  reply = (body) => ({
    status: 200,
    type: "application/json",
    text: JSON.stringify({
      jsonrpc: "2.0",
      id: (body as { id: number }).id,
      result: { ok: true },
    }),
  });
});

afterEach(async () => {
  for (const b of bridges.splice(0)) b.close();
  await stopServer();
  rmSync(dir, { recursive: true, force: true });
});

describe("bridge", () => {
  it("forwards a request with the token and the agent header, and writes the answer", async () => {
    writeConfig(await startServer());
    const { b, out } = bridge();
    await b.handleLine(initialize);
    await b.handleLine(listTools);
    expect(out[1]).toEqual({ jsonrpc: "2.0", id: 2, result: { ok: true } });
    // initialize is local, so only tools/list reaches the app.
    expect(seen).toHaveLength(1);
    expect(seen[0].headers.authorization).toBe("Bearer secret");
    expect(seen[0].headers.accept).toBe("application/json, text/event-stream");
    expect(seen[0].headers["x-openstyle-agent"]).toBe("claude-code/2.1.0");
    expect(seen[0].headers.origin).toBeUndefined();
    expect(JSON.parse(seen[0].body)).toEqual(JSON.parse(listTools));
  });

  it("reads the client info from _meta (2026 protocol era)", async () => {
    writeConfig(await startServer());
    const { b } = bridge();
    await b.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/clientInfo": {
              name: "pi",
              version: "1.4.0",
            },
          },
        },
      }),
    );
    expect(seen[0].headers["x-openstyle-agent"]).toBe("pi/1.4.0");
  });

  it("writes nothing for a notification", async () => {
    writeConfig(await startServer());
    reply = () => ({ status: 202, type: "application/json", text: "" });
    const { b, out } = bridge();
    await b.handleLine(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    expect(seen).toHaveLength(0);
    await b.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 9 },
      }),
    );
    expect(seen).toHaveLength(1);
    expect(out).toEqual([]);
  });

  it("reads an SSE answer", async () => {
    writeConfig(await startServer());
    reply = (body) => ({
      status: 200,
      type: "text/event-stream",
      text: `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: (body as { id: number }).id, result: {} })}\n\n`,
    });
    const { b, out } = bridge();
    await b.handleLine(listTools);
    expect(out).toEqual([{ jsonrpc: "2.0", id: 2, result: {} }]);
  });

  it("gives another gate refusal as a JSON-RPC error", async () => {
    writeConfig(await startServer());
    reply = () => ({
      status: 403,
      type: "application/json",
      text: JSON.stringify({ error: "Forbidden host" }),
    });
    const { b, out } = bridge();
    await b.handleLine(listTools);
    expect(out).toEqual([
      {
        jsonrpc: "2.0",
        id: 2,
        error: { code: -32000, message: "Forbidden host" },
      },
    ]);
  });

  it("answers initialize itself with the SDK version rule, also with no app", async () => {
    const { b, out } = bridge();
    await b.handleLine(initialize);
    await b.handleLine(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    await b.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "initialize",
        params: { protocolVersion: "1999-01-01", capabilities: {} },
      }),
    );
    expect(out).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "openstyle", version: "3.1.0-test" },
        },
      },
      {
        jsonrpc: "2.0",
        id: 5,
        result: expect.objectContaining({ protocolVersion: "2025-11-25" }),
      },
    ]);
    // The 2025-era versions of the SDK (2026-era clients send no initialize).
    expect(BRIDGE_PROTOCOL_VERSIONS).toEqual(
      SUPPORTED_PROTOCOL_VERSIONS.filter((v) => v < "2026"),
    );
  });

  it("lists openstyle_status and gives 'not running' as a tool error with no mcp.json", async () => {
    const { b, out } = bridge();
    await b.handleLine(listTools);
    await b.handleLine(callStatus);
    await b.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "list_meetings", arguments: {} },
      }),
    );
    expect(out).toEqual([
      fallbackList(2),
      toolError(4, NOT_RUNNING_MESSAGE),
      toolError(6, NOT_RUNNING_MESSAGE),
    ]);
  });

  it("gives the access-off text of the server", async () => {
    writeConfig(await startServer());
    const text =
      "Agent access is off. Turn on Settings > Agents (MCP) in Openstyle.";
    reply = () => ({
      status: 403,
      type: "application/json",
      text: JSON.stringify({ error: text, code: "mcp_disabled" }),
    });
    const { b, out } = bridge();
    await b.handleLine(listTools);
    await b.handleLine(callStatus);
    expect(out).toEqual([fallbackList(2), toolError(4, text)]);
  });

  it("gives a clear text for a wrong token", async () => {
    writeConfig(await startServer());
    reply = () => ({
      status: 401,
      type: "application/json",
      text: JSON.stringify({ error: "Unauthorized" }),
    });
    const { b, out } = bridge();
    await b.handleLine(listTools);
    await b.handleLine(callStatus);
    expect(out).toEqual([fallbackList(2), toolError(4, BAD_TOKEN_MESSAGE)]);
  });

  it("goes back to the real tools when the app answers again", async () => {
    const port = await startServer();
    await stopServer();
    writeConfig(port);
    const { b, out } = bridge();
    await b.handleLine(listTools);
    expect(out).toEqual([fallbackList(2)]);
    // Still down: the check changes nothing.
    await b.checkNow();
    expect(out).toHaveLength(1);
    // The app starts again (here: on a new port).
    writeConfig(await startServer());
    await b.checkNow();
    expect(out[1]).toEqual(LIST_CHANGED);
    expect(JSON.parse(seen[0].body)).toMatchObject({ method: "ping" });
    await b.handleLine(listTools);
    expect(out[2]).toEqual({ jsonrpc: "2.0", id: 2, result: { ok: true } });
    // The app goes away again: the next call gives the reason, and the
    // client hears that the tool list changed.
    await stopServer();
    await b.handleLine(callStatus);
    expect(out.slice(3)).toEqual([
      toolError(4, NOT_RUNNING_MESSAGE),
      LIST_CHANGED,
    ]);
  });

  it("answers a parse error for a line that is not JSON", async () => {
    const { b, out } = bridge();
    await b.handleLine("not json");
    expect(out).toEqual([
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      },
    ]);
  });
});

describe("resolveUserDataDir", () => {
  it("uses --user-data, then OPENSTYLE_USER_DATA, then the bundle name folder", () => {
    expect(
      resolveUserDataDir(["--user-data", "/a"], { OPENSTYLE_USER_DATA: "/b" }),
    ).toBe("/a");
    expect(resolveUserDataDir(["--user-data=/c"], {})).toBe("/c");
    expect(resolveUserDataDir([], { OPENSTYLE_USER_DATA: "/b" })).toBe("/b");
    expect(
      resolveUserDataDir(
        [],
        { OPENSTYLE_BUNDLE_NAME: "Openstyle Dev" },
        "/Users/x",
      ),
    ).toBe("/Users/x/Library/Application Support/Openstyle Dev");
    expect(resolveUserDataDir([], {}, "/Users/x")).toBe(
      "/Users/x/Library/Application Support/Openstyle",
    );
  });
});
