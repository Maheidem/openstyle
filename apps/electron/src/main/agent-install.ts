// One-click install of the Openstyle MCP launcher into the agent tools on
// this Mac: Claude Code, pi and Codex (specs/mcp.md 7.2). The module runs the
// own CLI of each tool. It never edits ~/.claude.json or ~/.codex/config.toml.
// The one file that it reads is the pi config, for the state check.
//
// A click in the UI is the consent for one tool. Nothing runs at app start or
// in the background: the first `agents:list` call reads the shell PATH.
import { execFile } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAppLogger } from "@openstyle/utils";
import { app, ipcMain } from "electron";
import {
  AGENT_TOOLS,
  type AgentRow,
  type AgentTool,
  isAgentTool,
  type McpStatus,
} from "../shared/agents";
import { state } from "./main-state";
import { mcpLauncherPath, mcpServerName } from "./mcp-config";

const log = createAppLogger("mcp");

/** The login-shell PATH read waits at most this long. */
export const SHELL_PATH_TIMEOUT_MS = 5000;
/** One CLI call waits at most this long. */
export const CLI_TIMEOUT_MS = 20_000;
const PATH_MARKER = "__OPENSTYLE_PATH__=";

export interface RunResult {
  /** The exit code. 124 for a timeout, 127 when the file cannot start. */
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; cwd?: string },
) => Promise<RunResult>;

/** execFile with an argument array. No shell. */
export const execFileRunner: Runner = (file, args, options) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { ...options, encoding: "utf8", maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const failure = error as NodeJS.ErrnoException & { killed?: boolean };
        const code =
          typeof failure.code === "number"
            ? failure.code
            : failure.killed
              ? 124
              : 127;
        resolve({
          code,
          stdout: stdout ?? "",
          stderr: stderr || error.message,
        });
      },
    );
  });

// ---------------------------------------------------------------------------
// PATH
// ---------------------------------------------------------------------------

/** The folders that the common installers use (research [S25] [L2]). */
export function knownBinDirs(home: string): string[] {
  return [join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
}

/** The shell PATH, then the known folders, with no duplicates. */
export function mergePath(shellPath: string | null, known: string[]): string {
  const dirs: string[] = [];
  for (const dir of [...(shellPath ?? "").split(":"), ...known]) {
    if (dir && !dirs.includes(dir)) dirs.push(dir);
  }
  return dirs.join(":");
}

/**
 * Read the PATH of the login shell: `$SHELL -ilc 'echo $PATH'`. A GUI app
 * does not get it from macOS. The dotfiles of the user can print other
 * text, so the PATH comes after a marker. Null after an error or a timeout.
 */
export async function readLoginShellPath(
  run: Runner,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const shell = env.SHELL || "/bin/zsh";
  const result = await run(shell, ["-ilc", `echo "${PATH_MARKER}$PATH"`], {
    env,
    timeout: SHELL_PATH_TIMEOUT_MS,
  });
  if (result.code !== 0) return null;
  const line = result.stdout
    .split("\n")
    .reverse()
    .find((l) => l.includes(PATH_MARKER));
  if (!line) return null;
  const value = line.slice(line.indexOf(PATH_MARKER) + PATH_MARKER.length);
  return value.trim() || null;
}

/** The first executable file with this name on the PATH, or null. */
export function findOnPath(bin: string, path: string): string | null {
  for (const dir of path.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not in this folder.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Commands (specs/mcp.md 7.2 and 7.3)
// ---------------------------------------------------------------------------

export interface Registration {
  /** "openstyle" or "openstyle-dev". */
  name: string;
  /** The absolute launcher path. */
  launcher: string;
  /** ["--user-data", "<dir>"] in test mode, else []. */
  args: string[];
}

export function addArgs(tool: AgentTool, reg: Registration): string[] {
  if (tool === "claude") {
    const config = { type: "stdio", command: reg.launcher, args: reg.args };
    return ["mcp", "add-json", "-s", "user", reg.name, JSON.stringify(config)];
  }
  return ["mcp", "add", reg.name, "--", reg.launcher, ...reg.args];
}

export function removeArgs(tool: AgentTool, reg: Registration): string[] {
  return tool === "claude"
    ? ["mcp", "remove", "-s", "user", reg.name]
    : ["mcp", "remove", reg.name];
}

/** A double-quoted shell word. The path can hold a space ("Openstyle Dev.app"). */
function doubleQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** A single-quoted shell word, for the JSON of `claude mcp add-json`. */
function singleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** The command that a user can run in Terminal (specs/mcp.md 7.3). */
export function fallbackCommand(tool: AgentTool, reg: Registration): string {
  if (tool === "claude") {
    const json = JSON.stringify({
      type: "stdio",
      command: reg.launcher,
      args: reg.args,
    });
    return `claude mcp add-json -s user ${reg.name} ${singleQuote(json)}`;
  }
  const words = [reg.launcher, ...reg.args].map(doubleQuote).join(" ");
  return `${tool} mcp add ${reg.name} -- ${words}`;
}

// ---------------------------------------------------------------------------
// State checks
// ---------------------------------------------------------------------------

/** "same": an entry with this launcher. "other": an entry with another command. */
export type EntryState = "same" | "other" | "none";

/** `claude mcp get <name>`: exit 0 and the line `Command: <launcher>`. Exit 1: no entry. */
export function parseClaudeGet(
  result: RunResult,
  launcher: string,
): EntryState {
  if (result.code !== 0) return "none";
  const lines = result.stdout.split("\n").map((l) => l.trim());
  return lines.includes(`Command: ${launcher}`) ? "same" : "other";
}

/** `mcpServers.<name>.command` in the pi config. Bad JSON or no file: no entry. */
export function parsePiConfig(
  text: string | null,
  name: string,
  launcher: string,
): EntryState {
  if (text === null) return "none";
  try {
    const config = JSON.parse(text) as {
      mcpServers?: Record<string, { command?: unknown }>;
    };
    const entry = config.mcpServers?.[name];
    if (!entry) return "none";
    return entry.command === launcher ? "same" : "other";
  } catch {
    return "none";
  }
}

/** `codex mcp get <name> --json`: compare `transport.command`. Exit 1: no entry. */
export function parseCodexGet(result: RunResult, launcher: string): EntryState {
  if (result.code !== 0) return "none";
  try {
    const entry = JSON.parse(result.stdout) as {
      transport?: { command?: unknown };
    };
    return entry.transport?.command === launcher ? "same" : "other";
  } catch {
    return "other";
  }
}

/** The pi config file: `$PI_CODING_AGENT_DIR/mcp.json` or `~/.pi/agent/mcp.json`. */
export function piConfigPath(env: NodeJS.ProcessEnv, home: string): string {
  return env.PI_CODING_AGENT_DIR
    ? join(env.PI_CODING_AGENT_DIR, "mcp.json")
    : join(home, ".pi", "agent", "mcp.json");
}

// ---------------------------------------------------------------------------
// The installer
// ---------------------------------------------------------------------------

export interface AgentInstallerOptions {
  registration: Registration;
  env: NodeJS.ProcessEnv;
  home: string;
  run?: Runner;
  readText?: (path: string) => string | null;
}

function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export class AgentInstaller {
  private readonly reg: Registration;
  private readonly env: NodeJS.ProcessEnv;
  private readonly home: string;
  private readonly run: Runner;
  private readonly readText: (path: string) => string | null;
  private pathPromise: Promise<string> | null = null;
  private cliPaths: Map<AgentTool, string | null> | null = null;

  constructor(options: AgentInstallerOptions) {
    this.reg = options.registration;
    this.env = options.env;
    this.home = options.home;
    this.run = options.run ?? execFileRunner;
    this.readText = options.readText ?? readTextFile;
  }

  /**
   * The PATH for every CLI run. The login shell is read once for each app
   * run. An E2E run (OPENSTYLE_E2E=1) never reads the shell: it uses only the
   * stub folder OPENSTYLE_E2E_AGENT_BIN (when set) and the system folders.
   * So a test never finds or changes the real CLI of a tool.
   */
  path(): Promise<string> {
    if (this.pathPromise) return this.pathPromise;
    if (this.env.OPENSTYLE_E2E === "1") {
      const stubDir = this.env.OPENSTYLE_E2E_AGENT_BIN;
      this.pathPromise = Promise.resolve(
        stubDir ? `${stubDir}:/usr/bin:/bin` : "/usr/bin:/bin",
      );
    } else {
      this.pathPromise = readLoginShellPath(this.run, this.env)
        .catch(() => null)
        .then((shellPath) => {
          if (!shellPath)
            log.warn("Login shell PATH not read. Using the known folders.");
          return mergePath(shellPath, knownBinDirs(this.home));
        });
    }
    return this.pathPromise;
  }

  /** Find the CLIs again ("Check again"). The PATH stays the same. */
  async detect(): Promise<void> {
    const path = await this.path();
    const found = new Map<AgentTool, string | null>();
    for (const tool of AGENT_TOOLS) found.set(tool, findOnPath(tool, path));
    this.cliPaths = found;
  }

  private async cli(tool: AgentTool): Promise<string | null> {
    if (!this.cliPaths) await this.detect();
    return this.cliPaths?.get(tool) ?? null;
  }

  private async runCli(tool: AgentTool, args: string[]): Promise<RunResult> {
    const cli = await this.cli(tool);
    if (!cli) return { code: 127, stdout: "", stderr: `${tool} not found` };
    const env = { ...this.env, PATH: await this.path() };
    return this.run(cli, args, {
      env,
      timeout: CLI_TIMEOUT_MS,
      cwd: this.home,
    });
  }

  /** The state check of specs/mcp.md 7.2. */
  async entryState(tool: AgentTool): Promise<EntryState> {
    const { name, launcher } = this.reg;
    if (tool === "pi") {
      return parsePiConfig(
        this.readText(piConfigPath(this.env, this.home)),
        name,
        launcher,
      );
    }
    if (tool === "claude") {
      return parseClaudeGet(
        await this.runCli(tool, ["mcp", "get", name]),
        launcher,
      );
    }
    return parseCodexGet(
      await this.runCli(tool, ["mcp", "get", name, "--json"]),
      launcher,
    );
  }

  private baseRow(tool: AgentTool, cliPath: string | null): AgentRow {
    return {
      tool,
      name: this.reg.name,
      found: cliPath !== null,
      state: cliPath ? "not-added" : "not-found",
      cliPath,
      fallbackCommand: fallbackCommand(tool, this.reg),
    };
  }

  async row(tool: AgentTool): Promise<AgentRow> {
    const cliPath = await this.cli(tool);
    const row = this.baseRow(tool, cliPath);
    if (!cliPath) return row;
    const entry = await this.entryState(tool);
    return { ...row, state: entry === "same" ? "added" : "not-added" };
  }

  async list(): Promise<AgentRow[]> {
    return Promise.all(AGENT_TOOLS.map((tool) => this.row(tool)));
  }

  async rescan(): Promise<AgentRow[]> {
    await this.detect();
    return this.list();
  }

  /** Add, then check again. "added" only when the check passes. */
  async add(tool: AgentTool): Promise<AgentRow> {
    const cliPath = await this.cli(tool);
    const row = this.baseRow(tool, cliPath);
    if (!cliPath) return row;
    const before = await this.entryState(tool);
    if (before === "same") return { ...row, state: "added" };
    // `claude mcp add-json` refuses a duplicate name (research [L1]).
    if (tool === "claude" && before === "other") {
      await this.runCli(tool, removeArgs(tool, this.reg));
    }
    const result = await this.runCli(tool, addArgs(tool, this.reg));
    if ((await this.entryState(tool)) === "same") {
      log.info(`Added ${this.reg.name} to ${tool}`);
      return { ...row, state: "added" };
    }
    const error = (result.stderr || result.stdout).slice(0, 500);
    log.warn(
      `Could not add ${this.reg.name} to ${tool} (exit ${result.code}): ${error}`,
    );
    return { ...row, state: "failed", error };
  }

  async remove(tool: AgentTool): Promise<AgentRow> {
    const cliPath = await this.cli(tool);
    const row = this.baseRow(tool, cliPath);
    if (!cliPath) return row;
    const result = await this.runCli(tool, removeArgs(tool, this.reg));
    if ((await this.entryState(tool)) !== "same") {
      log.info(`Removed ${this.reg.name} from ${tool}`);
      return row;
    }
    const error = (result.stderr || result.stdout).slice(0, 500);
    log.warn(`Could not remove ${this.reg.name} from ${tool}: ${error}`);
    return { ...row, state: "added", error };
  }
}

// ---------------------------------------------------------------------------
// IPC (specs/mcp.md 7.2)
// ---------------------------------------------------------------------------

/** The name, the launcher and the args of this app run. */
function currentRegistration(): Registration {
  const packaged = app.isPackaged;
  const userDataOverride =
    process.env.OPENSTYLE_USER_DATA ?? process.env.FREESTYLE_USER_DATA;
  return {
    name: mcpServerName({ packaged, devFlavor: state.devFlavor }),
    launcher: mcpLauncherPath({
      packaged,
      resourcesPath: process.resourcesPath ?? "",
      mainDir: __dirname,
    }),
    // A test run never points an agent tool at the real profile.
    args: userDataOverride ? ["--user-data", app.getPath("userData")] : [],
  };
}

export function registerAgentInstallIpc({
  getMcpPort,
}: {
  getMcpPort: () => number | null;
}): void {
  let installer: AgentInstaller | null = null;
  const get = (): AgentInstaller => {
    installer ??= new AgentInstaller({
      registration: currentRegistration(),
      env: process.env,
      home: homedir(),
    });
    return installer;
  };
  const toolArg = (tool: unknown): AgentTool => {
    if (!isAgentTool(tool))
      throw new Error(`Unknown agent tool: ${String(tool)}`);
    return tool;
  };

  ipcMain.handle("mcp:status", (): McpStatus => {
    const reg = currentRegistration();
    return { port: getMcpPort(), launcherPath: reg.launcher, name: reg.name };
  });
  ipcMain.handle("agents:list", () => get().list());
  ipcMain.handle("agents:rescan", () => get().rescan());
  ipcMain.handle("agents:add", (_event, tool: unknown) =>
    get().add(toolArg(tool)),
  );
  ipcMain.handle("agents:remove", (_event, tool: unknown) =>
    get().remove(toolArg(tool)),
  );
}
