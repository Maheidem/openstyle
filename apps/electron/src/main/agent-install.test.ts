import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, ipcMain: { handle: vi.fn() } }));
vi.mock("./main-state", () => ({ state: { devFlavor: false } }));

import {
  AgentInstaller,
  addArgs,
  fallbackCommand,
  mergePath,
  parseClaudeGet,
  parseCodexGet,
  parsePiConfig,
  type Registration,
  type Runner,
  readLoginShellPath,
  removeArgs,
} from "./agent-install";

// agent-install.ts with a fake execFile (specs/mcp.md 9.2).

const LAUNCHER =
  "/Applications/Openstyle Dev.app/Contents/Resources/mcp/openstyle-mcp";
const reg: Registration = {
  name: "openstyle-dev",
  launcher: LAUNCHER,
  args: [],
};

let root: string;
let bin: string;
let home: string;

function stub(name: string): void {
  const file = join(bin, name);
  writeFileSync(file, "#!/bin/sh\n");
  chmodSync(file, 0o755);
}

interface Call {
  file: string;
  args: string[];
  path: string | undefined;
}

/** A fake runner. `answer` gets each call and gives the result. */
function fakeRunner(
  answer: (call: Call) => { code?: number; stdout?: string; stderr?: string },
) {
  const calls: Call[] = [];
  const run: Runner = async (file, args, options) => {
    const call = { file, args, path: options.env.PATH };
    calls.push(call);
    const r = answer(call);
    return {
      code: r.code ?? 0,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
    };
  };
  return { run, calls };
}

function installer(run: Runner, env: NodeJS.ProcessEnv = {}): AgentInstaller {
  return new AgentInstaller({
    registration: reg,
    env: { OPENSTYLE_E2E: "1", OPENSTYLE_E2E_AGENT_BIN: bin, ...env },
    home,
    run,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agent-install-test-"));
  bin = join(root, "bin");
  home = join(root, "home");
  mkdirSync(bin);
  mkdirSync(home);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("PATH reader", () => {
  it("parses the shell output after the marker", async () => {
    const { run, calls } = fakeRunner(() => ({
      stdout: "Welcome to zsh\n__OPENSTYLE_PATH__=/usr/bin:/opt/homebrew/bin\n",
    }));
    const path = await readLoginShellPath(run, { SHELL: "/bin/zsh" });
    expect(path).toBe("/usr/bin:/opt/homebrew/bin");
    expect(calls[0].file).toBe("/bin/zsh");
    expect(calls[0].args).toEqual(["-ilc", 'echo "__OPENSTYLE_PATH__=$PATH"']);
  });

  it("adds the known folders with no duplicates", () => {
    expect(
      mergePath("/usr/bin:/opt/homebrew/bin", [
        "/h/.local/bin",
        "/opt/homebrew/bin",
        "/usr/local/bin",
      ]),
    ).toBe("/usr/bin:/opt/homebrew/bin:/h/.local/bin:/usr/local/bin");
  });

  it("uses only the known folders after a timeout or a shell error, and reads the shell once", async () => {
    const { run, calls } = fakeRunner(() => ({
      code: 124,
      stderr: "timed out",
    }));
    const inst = new AgentInstaller({
      registration: reg,
      env: { SHELL: "/bin/zsh" },
      home,
      run,
    });
    expect(await inst.path()).toBe(
      `${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin`,
    );
    await inst.path();
    await inst.detect();
    await inst.detect();
    expect(calls.filter((c) => c.file === "/bin/zsh")).toHaveLength(1);
  });

  it("never reads the shell in an E2E run", async () => {
    const { run, calls } = fakeRunner(() => ({}));
    expect(await installer(run).path()).toBe(`${bin}:/usr/bin:/bin`);
    expect(calls).toHaveLength(0);
  });
});

describe("command builder", () => {
  it("gives the exact argument arrays", () => {
    expect(addArgs("claude", reg)).toEqual([
      "mcp",
      "add-json",
      "-s",
      "user",
      "openstyle-dev",
      JSON.stringify({ type: "stdio", command: LAUNCHER, args: [] }),
    ]);
    expect(addArgs("pi", reg)).toEqual([
      "mcp",
      "add",
      "openstyle-dev",
      "--",
      LAUNCHER,
    ]);
    expect(addArgs("codex", reg)).toEqual([
      "mcp",
      "add",
      "openstyle-dev",
      "--",
      LAUNCHER,
    ]);
    expect(removeArgs("claude", reg)).toEqual([
      "mcp",
      "remove",
      "-s",
      "user",
      "openstyle-dev",
    ]);
    expect(removeArgs("pi", reg)).toEqual(["mcp", "remove", "openstyle-dev"]);
    expect(removeArgs("codex", reg)).toEqual([
      "mcp",
      "remove",
      "openstyle-dev",
    ]);
  });

  it("adds the --user-data args in test mode", () => {
    const test = {
      ...reg,
      name: "openstyle",
      args: ["--user-data", "/tmp/p q"],
    };
    expect(addArgs("pi", test)).toEqual([
      "mcp",
      "add",
      "openstyle",
      "--",
      LAUNCHER,
      "--user-data",
      "/tmp/p q",
    ]);
    expect(JSON.parse(addArgs("claude", test)[5])).toEqual({
      type: "stdio",
      command: LAUNCHER,
      args: ["--user-data", "/tmp/p q"],
    });
  });

  it("quotes the launcher path with a space in the fallback text", () => {
    expect(fallbackCommand("pi", reg)).toBe(
      `pi mcp add openstyle-dev -- "${LAUNCHER}"`,
    );
    expect(fallbackCommand("codex", reg)).toBe(
      `codex mcp add openstyle-dev -- "${LAUNCHER}"`,
    );
    expect(fallbackCommand("claude", reg)).toBe(
      `claude mcp add-json -s user openstyle-dev '{"type":"stdio","command":"${LAUNCHER}","args":[]}'`,
    );
  });
});

describe("state parse", () => {
  const out = (code: number, stdout = "") => ({ code, stdout, stderr: "" });

  it("claude mcp get: same path, other path, exit 1", () => {
    expect(
      parseClaudeGet(
        out(0, `openstyle-dev:\n  Scope: User\n  Command: ${LAUNCHER}\n`),
        LAUNCHER,
      ),
    ).toBe("same");
    expect(
      parseClaudeGet(out(0, "  Command: /old/openstyle-mcp\n"), LAUNCHER),
    ).toBe("other");
    expect(
      parseClaudeGet(out(1, 'No MCP server named "openstyle-dev"'), LAUNCHER),
    ).toBe("none");
  });

  it("pi mcp.json: entry, no entry, no file, bad JSON", () => {
    const config = (command: string) =>
      JSON.stringify({ mcpServers: { "openstyle-dev": { command } } });
    expect(parsePiConfig(config(LAUNCHER), "openstyle-dev", LAUNCHER)).toBe(
      "same",
    );
    expect(parsePiConfig(config("/old"), "openstyle-dev", LAUNCHER)).toBe(
      "other",
    );
    expect(
      parsePiConfig(
        JSON.stringify({ mcpServers: {} }),
        "openstyle-dev",
        LAUNCHER,
      ),
    ).toBe("none");
    expect(parsePiConfig(null, "openstyle-dev", LAUNCHER)).toBe("none");
    expect(parsePiConfig("{bad", "openstyle-dev", LAUNCHER)).toBe("none");
  });

  it("codex mcp get --json: same path, other path, exit 1", () => {
    const json = (command: string) =>
      JSON.stringify({
        name: "openstyle-dev",
        transport: { type: "stdio", command },
      });
    expect(parseCodexGet(out(0, json(LAUNCHER)), LAUNCHER)).toBe("same");
    expect(parseCodexGet(out(0, json("/old")), LAUNCHER)).toBe("other");
    expect(parseCodexGet(out(1), LAUNCHER)).toBe("none");
  });
});

describe("AgentInstaller", () => {
  it("Claude Code with another path runs remove before add-json", async () => {
    stub("claude");
    let added = false;
    const { run, calls } = fakeRunner(({ args }) => {
      if (args[1] === "get") {
        return {
          stdout: `  Command: ${added ? LAUNCHER : "/old/openstyle-mcp"}\n`,
        };
      }
      if (args[1] === "add-json") added = true;
      return {};
    });
    const row = await installer(run).add("claude");
    expect(row.state).toBe("added");
    expect(calls.map((c) => c.args[1])).toEqual([
      "get",
      "remove",
      "add-json",
      "get",
    ]);
    expect(calls[0].file).toBe(join(bin, "claude"));
    expect(calls[0].path).toBe(`${bin}:/usr/bin:/bin`);
  });

  it("does not run add when the entry is already there", async () => {
    stub("claude");
    const { run, calls } = fakeRunner(() => ({
      stdout: `  Command: ${LAUNCHER}\n`,
    }));
    expect((await installer(run).add("claude")).state).toBe("added");
    expect(calls.map((c) => c.args[1])).toEqual(["get"]);
  });

  it("gives failed when the CLI exits 0 but the state check fails", async () => {
    stub("codex");
    const { run } = fakeRunner(({ args }) =>
      args[1] === "get" ? { code: 1 } : { stdout: "Added" },
    );
    const row = await installer(run).add("codex");
    expect(row.state).toBe("failed");
    expect(row.fallbackCommand).toBe(
      `codex mcp add openstyle-dev -- "${LAUNCHER}"`,
    );
  });

  it("pi: add, then read the config file for the check", async () => {
    stub("pi");
    const piDir = join(root, "pi");
    mkdirSync(piDir);
    const { run, calls } = fakeRunner(({ args }) => {
      if (args[1] === "add") {
        writeFileSync(
          join(piDir, "mcp.json"),
          JSON.stringify({
            mcpServers: { "openstyle-dev": { command: LAUNCHER } },
          }),
        );
      }
      return {};
    });
    const inst = installer(run, { PI_CODING_AGENT_DIR: piDir });
    expect((await inst.row("pi")).state).toBe("not-added");
    expect((await inst.add("pi")).state).toBe("added");
    expect(calls.map((c) => c.args)).toEqual([
      ["mcp", "add", "openstyle-dev", "--", LAUNCHER],
    ]);
  });

  it("a missing CLI gives not-found, and no command runs", async () => {
    const { run, calls } = fakeRunner(() => ({}));
    const inst = installer(run);
    const rows = await inst.list();
    expect(rows.map((r) => [r.tool, r.state, r.found])).toEqual([
      ["claude", "not-found", false],
      ["pi", "not-found", false],
      ["codex", "not-found", false],
    ]);
    expect((await inst.add("claude")).state).toBe("not-found");
    expect(calls).toHaveLength(0);
  });

  it("Check again finds a CLI that was installed later", async () => {
    const { run } = fakeRunner(() => ({ code: 1 }));
    const inst = installer(run);
    expect((await inst.row("codex")).state).toBe("not-found");
    stub("codex");
    const rows = await inst.rescan();
    expect(rows.find((r) => r.tool === "codex")?.state).toBe("not-added");
  });

  it("remove runs the remove command and checks again", async () => {
    stub("codex");
    let present = true;
    const { run, calls } = fakeRunner(({ args }) => {
      if (args[1] === "remove") present = false;
      if (args[1] === "get") {
        return present
          ? { stdout: JSON.stringify({ transport: { command: LAUNCHER } }) }
          : { code: 1 };
      }
      return {};
    });
    expect((await installer(run).remove("codex")).state).toBe("not-added");
    expect(calls.map((c) => c.args[1])).toEqual(["remove", "get"]);
  });
});
