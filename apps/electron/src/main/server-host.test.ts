import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// server-host.ts with a fake utility process: the token env, the mcp.json
// file at "ready", the delete at stop, no file for a reused server, and the
// agent-change routing (specs/mcp.md 3.3, 9.2).

class FakeChild extends EventEmitter {
  pid = 4242;
  stdout = null;
  stderr = null;
  messages: unknown[] = [];
  postMessage(message: { type: string }): void {
    this.messages.push(message);
    if (message.type === "shutdown") setImmediate(() => this.emit("exit", 0));
  }
  kill(): void {
    this.emit("exit", 1);
  }
}

const mocks = vi.hoisted(() => ({
  userData: "",
  children: [] as FakeChild[],
  forkEnv: [] as Record<string, string>[],
  probe: false,
  applyAgentChange: vi.fn(async () => {}),
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => mocks.userData,
    getVersion: () => "3.1.0-test",
    isPackaged: true,
  },
  dialog: { showMessageBox: vi.fn() },
  utilityProcess: {
    fork: (
      _entry: string,
      _args: string[],
      options: { env: Record<string, string> },
    ) => {
      const child = new FakeChild();
      mocks.children.push(child);
      mocks.forkEnv.push(options.env);
      return child;
    },
  },
}));
vi.mock("@electron-toolkit/utils", () => ({ is: { dev: false } }));
vi.mock("./main-state", () => ({
  broadcastServerChanged: vi.fn(),
  state: { devFlavor: false, meetingRecorder: null },
}));
vi.mock("./notifications", () => ({ notifyCleanupSkipped: vi.fn() }));
vi.mock("./server-target", () => ({
  probeServerHealth: async () => mocks.probe,
  setServerPort: vi.fn(),
}));
vi.mock("./agent-changes", () => ({
  applyAgentChange: mocks.applyAgentChange,
}));

type Host = typeof import("./server-host");
let host: Host;

beforeEach(async () => {
  vi.resetModules();
  mocks.userData = mkdtempSync(join(tmpdir(), "server-host-test-"));
  mocks.children.length = 0;
  mocks.forkEnv.length = 0;
  mocks.probe = false;
  mocks.applyAgentChange.mockClear();
  delete process.env.OPENSTYLE_SERVER_PORT;
  host = await import("./server-host");
});

afterEach(() => {
  rmSync(mocks.userData, { recursive: true, force: true });
});

const mcpFile = (): string => join(mocks.userData, "mcp.json");

async function startAndReady(port: number): Promise<FakeChild> {
  const started = host.startServerHost({ userDataOverride: undefined });
  await vi.waitFor(() => expect(mocks.children).toHaveLength(1));
  const child = mocks.children[0];
  child.emit("message", { type: "ready", port });
  await started;
  return child;
}

describe("server host and mcp.json", () => {
  it("passes the token in the child env and writes mcp.json at ready", async () => {
    await startAndReady(4651);
    const token = mocks.forkEnv[0].OPENSTYLE_MCP_TOKEN;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(readFileSync(mcpFile(), "utf8"))).toEqual({
      port: 4651,
      token,
      name: "openstyle",
      version: "3.1.0-test",
    });
    expect(host.getMcpPort()).toBe(4651);
  });

  it("writes the file again with the new port after a restart, with the same token", async () => {
    const child = await startAndReady(4651);
    const token = mocks.forkEnv[0].OPENSTYLE_MCP_TOKEN;
    child.emit("message", { type: "ready", port: 4700 });
    expect(JSON.parse(readFileSync(mcpFile(), "utf8"))).toMatchObject({
      port: 4700,
      token,
    });
  });

  it("deletes mcp.json at stop", async () => {
    await startAndReady(4651);
    expect(existsSync(mcpFile())).toBe(true);
    await host.stopServerHost();
    expect(existsSync(mcpFile())).toBe(false);
    expect(host.getMcpPort()).toBeNull();
  });

  it("writes and deletes nothing for a reused server of another instance", async () => {
    mocks.probe = true;
    await host.startServerHost({ userDataOverride: undefined });
    expect(mocks.children).toHaveLength(0);
    expect(existsSync(mcpFile())).toBe(false);
    expect(host.getMcpPort()).toBeNull();
    await host.stopServerHost();
    expect(existsSync(mcpFile())).toBe(false);
  });

  it("routes an agent-change message to agent-changes.ts", async () => {
    const child = await startAndReady(4651);
    const change = {
      type: "agent-change",
      kind: "meeting",
      ids: ["m1"],
      keys: [],
    };
    child.emit("message", change);
    expect(mocks.applyAgentChange).toHaveBeenCalledWith(change);
  });
});
