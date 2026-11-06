// Types of the one-click agent install (specs/mcp.md 7.2). Main
// (main/agent-install.ts), the preload and the renderer share them.

/** The v1 agent tools, in the order of the UI rows. */
export const AGENT_TOOLS = ["claude", "pi", "codex"] as const;

export type AgentTool = (typeof AGENT_TOOLS)[number];

/**
 * The state that main reports. The renderer adds "adding" and "removing"
 * while an IPC call runs.
 */
export type AgentState = "not-found" | "not-added" | "added" | "failed";

export interface AgentRow {
  tool: AgentTool;
  /** The MCP server name: "openstyle" or "openstyle-dev". */
  name: string;
  found: boolean;
  state: AgentState;
  /** The absolute path of the CLI, or null when it is not found. */
  cliPath: string | null;
  /** The Terminal command of specs/mcp.md 7.3. */
  fallbackCommand: string;
  /** For "failed": the first 500 characters of the CLI output. For the log only. */
  error?: string;
}

export interface McpStatus {
  /** The port of the local server, or null when this app does not run it. */
  port: number | null;
  launcherPath: string;
  name: string;
}

export function isAgentTool(value: unknown): value is AgentTool {
  return (AGENT_TOOLS as readonly unknown[]).includes(value);
}
