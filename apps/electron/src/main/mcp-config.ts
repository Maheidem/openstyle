// The MCP connection file `<userData>/mcp.json` (specs/mcp.md 3.3) and the
// names that the agent tools register (specs/mcp.md 7.2). This file has no
// Electron import, so the unit tests run it in plain Node.
import { randomBytes } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The file that the stdio bridge reads for each request. */
export const MCP_CONFIG_FILE = "mcp.json";

export interface McpConfig {
  port: number;
  token: string;
  /** The MCP server name: "openstyle" or "openstyle-dev". */
  name: string;
  version: string;
}

/** One token for each boot. The same strength as generateAuthToken (32 random bytes). */
export function mintMcpToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Write `mcp.json` with mode 0600. The write goes to a temp file in the same
 * folder first, then a rename puts it in place. A reader never sees half a file.
 */
export function writeMcpConfig(userDataDir: string, config: McpConfig): void {
  const target = join(userDataDir, MCP_CONFIG_FILE);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, target);
}

/** Delete `mcp.json`. No error when the file is not there. */
export function removeMcpConfig(userDataDir: string): void {
  rmSync(join(userDataDir, MCP_CONFIG_FILE), { force: true });
}

/**
 * The MCP server name. A Stable build registers as "openstyle". The Dev flavor
 * and an unpackaged run register as "openstyle-dev", so a user can add both.
 */
export function mcpServerName(options: {
  packaged: boolean;
  devFlavor: boolean;
}): string {
  return options.packaged && !options.devFlavor ? "openstyle" : "openstyle-dev";
}

/**
 * The absolute path of the launcher script `openstyle-mcp`. A packaged app has
 * it in `Contents/Resources/mcp/` (electron-builder.yml mac.extraResources).
 * An unpackaged run uses the copy in `apps/electron/resources/mcp/`.
 */
export function mcpLauncherPath(options: {
  packaged: boolean;
  resourcesPath: string;
  /** The folder of the main bundle (`out/main`). */
  mainDir: string;
}): string {
  return options.packaged
    ? join(options.resourcesPath, "mcp", "openstyle-mcp")
    : join(options.mainDir, "..", "..", "resources", "mcp", "openstyle-mcp");
}
