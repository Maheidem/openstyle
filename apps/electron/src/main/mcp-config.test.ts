import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({
  writes: [] as string[],
  renames: [] as [string, string][],
}));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    writeFileSync: (path: string, ...rest: unknown[]) => {
      spies.writes.push(path);
      return (real.writeFileSync as (...args: unknown[]) => void)(
        path,
        ...rest,
      );
    },
    renameSync: (from: string, to: string) => {
      spies.renames.push([from, to]);
      return real.renameSync(from, to);
    },
  };
});

import {
  mcpLauncherPath,
  mcpServerName,
  mintMcpToken,
  removeMcpConfig,
  writeMcpConfig,
} from "./mcp-config";

const dirs: string[] = [];
function profile(): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp-config-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
  spies.writes.length = 0;
  spies.renames.length = 0;
});

const config = {
  port: 4651,
  token: "t".repeat(64),
  name: "openstyle-dev",
  version: "3.1.0",
};

describe("writeMcpConfig", () => {
  it("writes mode 0600 through a temp file and a rename", () => {
    const dir = profile();
    writeMcpConfig(dir, config);
    const target = join(dir, "mcp.json");
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual(config);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(spies.writes).toHaveLength(1);
    expect(spies.writes[0]).not.toBe(target);
    expect(spies.writes[0].startsWith(dir)).toBe(true);
    expect(spies.renames).toEqual([[spies.writes[0], target]]);
    // No temp file stays in the folder.
    expect(readdirSync(dir)).toEqual(["mcp.json"]);
  });

  it("writes the file again with a new port", () => {
    const dir = profile();
    writeMcpConfig(dir, config);
    writeMcpConfig(dir, { ...config, port: 5000 });
    expect(JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")).port).toBe(
      5000,
    );
  });

  it("deletes the file, and a second delete is no error", () => {
    const dir = profile();
    writeMcpConfig(dir, config);
    removeMcpConfig(dir);
    expect(readdirSync(dir)).toEqual([]);
    expect(() => removeMcpConfig(dir)).not.toThrow();
  });
});

describe("mintMcpToken", () => {
  it("gives 32 random bytes as hex, new for each call", () => {
    const a = mintMcpToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(mintMcpToken()).not.toBe(a);
  });
});

describe("names", () => {
  it("is openstyle for Stable and openstyle-dev for Dev and unpackaged runs", () => {
    expect(mcpServerName({ packaged: true, devFlavor: false })).toBe(
      "openstyle",
    );
    expect(mcpServerName({ packaged: true, devFlavor: true })).toBe(
      "openstyle-dev",
    );
    expect(mcpServerName({ packaged: false, devFlavor: false })).toBe(
      "openstyle-dev",
    );
  });

  it("finds the launcher in Resources/mcp or in the repo resources", () => {
    expect(
      mcpLauncherPath({
        packaged: true,
        resourcesPath: "/Applications/Openstyle Dev.app/Contents/Resources",
        mainDir: "/x",
      }),
    ).toBe(
      "/Applications/Openstyle Dev.app/Contents/Resources/mcp/openstyle-mcp",
    );
    expect(
      mcpLauncherPath({
        packaged: false,
        resourcesPath: "",
        mainDir: "/repo/apps/electron/out/main",
      }),
    ).toBe("/repo/apps/electron/resources/mcp/openstyle-mcp");
  });
});
