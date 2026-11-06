import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createBridge,
  NOT_RUNNING_MESSAGE,
  resolveUserDataDir,
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

function bridge() {
  const out: unknown[] = [];
  const b = createBridge({
    userDataDir: dir,
    write: (line) => out.push(JSON.parse(line)),
  });
  return { b, out };
}

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
  await stopServer();
  rmSync(dir, { recursive: true, force: true });
});

describe("bridge", () => {
  it("forwards a request with the token and the agent header, and writes the answer", async () => {
    writeConfig(await startServer());
    const { b, out } = bridge();
    await b.handleLine(initialize);
    await b.handleLine(listTools);
    expect(out).toEqual([
      { jsonrpc: "2.0", id: 1, result: { ok: true } },
      { jsonrpc: "2.0", id: 2, result: { ok: true } },
    ]);
    expect(seen[0].headers.authorization).toBe("Bearer secret");
    expect(seen[0].headers.accept).toBe("application/json, text/event-stream");
    expect(seen[1].headers["x-openstyle-agent"]).toBe("claude-code/2.1.0");
    expect(seen[1].headers.origin).toBeUndefined();
    expect(JSON.parse(seen[1].body)).toEqual(JSON.parse(listTools));
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

  it("gives the gate text as a JSON-RPC error", async () => {
    writeConfig(await startServer());
    reply = () => ({
      status: 403,
      type: "application/json",
      text: JSON.stringify({ error: "Agent access is off." }),
    });
    const { b, out } = bridge();
    await b.handleLine(listTools);
    expect(out).toEqual([
      {
        jsonrpc: "2.0",
        id: 2,
        error: { code: -32000, message: "Agent access is off." },
      },
    ]);
  });

  it("answers 'not running' with no mcp.json", async () => {
    const { b, out } = bridge();
    await b.handleLine(listTools);
    expect(out).toEqual([
      {
        jsonrpc: "2.0",
        id: 2,
        error: { code: -32000, message: NOT_RUNNING_MESSAGE },
      },
    ]);
  });

  it("answers 'not running' when the port refuses, then works when the server is back", async () => {
    const port = await startServer();
    await stopServer();
    writeConfig(port);
    const { b, out } = bridge();
    await b.handleLine(listTools);
    expect(out).toEqual([
      {
        jsonrpc: "2.0",
        id: 2,
        error: { code: -32000, message: NOT_RUNNING_MESSAGE },
      },
    ]);
    // The app starts again (here: on a new port). The next request works.
    writeConfig(await startServer());
    await b.handleLine(listTools);
    expect(out[1]).toEqual({ jsonrpc: "2.0", id: 2, result: { ok: true } });
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
