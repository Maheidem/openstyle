import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type LoaderLogger,
  loadPlugins,
  resolveImportSpecifier,
  resolveLocalPackage,
} from "./loader.js";
import { pluginSlug } from "./ui.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-loader-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writePackage(slug: string, pkg: Record<string, unknown>): string {
  const pkgDir = path.join(dir, slug);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify(pkg));
  return pkgDir;
}

describe("resolveImportSpecifier", () => {
  it("converts an absolute local path to a file:// URL", () => {
    const abs = path.join(dir, "plugin.js");
    expect(resolveImportSpecifier(abs)).toBe(pathToFileURL(abs).href);
  });

  it("passes a bare/scoped npm specifier through unchanged", () => {
    expect(resolveImportSpecifier("my-plugin")).toBe("my-plugin");
    expect(resolveImportSpecifier("@scope/my-plugin")).toBe("@scope/my-plugin");
  });

  it("passes a relative specifier through unchanged", () => {
    expect(resolveImportSpecifier("./local-plugin.js")).toBe(
      "./local-plugin.js",
    );
  });

  it("rejects an http(s):// specifier", () => {
    expect(() =>
      resolveImportSpecifier("http://evil.example.com/payload.js"),
    ).toThrow(/only local file paths and bare module specifiers are allowed/i);
    expect(() =>
      resolveImportSpecifier("https://evil.example.com/payload.js"),
    ).toThrow(/only local file paths and bare module specifiers are allowed/i);
  });

  it("rejects a data: specifier (inline code, not just remote URLs)", () => {
    expect(() =>
      resolveImportSpecifier("data:text/javascript,export default () => {}"),
    ).toThrow(/only local file paths and bare module specifiers are allowed/i);
  });

  it("rejects an explicit file:// URL — plain absolute paths are the only local form allowed", () => {
    expect(() => resolveImportSpecifier("file:///etc/passwd")).toThrow(
      /only local file paths and bare module specifiers are allowed/i,
    );
  });

  it("rejects any other scheme-prefixed specifier (e.g. node:)", () => {
    expect(() => resolveImportSpecifier("node:child_process")).toThrow(
      /only local file paths and bare module specifiers are allowed/i,
    );
  });
});

describe("loadPlugins rejects remote specifiers end-to-end", () => {
  it("logs an error and skips a plugin whose specifier is a remote URL, without throwing", async () => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const logger: LoaderLogger = {
      info: () => {},
      warn: (m) => warnings.push(m),
      error: (m) => errors.push(m),
    };

    const registry = await loadPlugins({
      entries: [{ specifier: "https://evil.example.com/payload.js" }],
      buildContext: () => {
        throw new Error("buildContext must not run for a rejected specifier");
      },
      logger,
    });

    // The malicious entry never becomes a registered plugin...
    expect(registry.size).toBe(0);
    // ...and the rejection is surfaced as a clear, non-fatal error (not a
    // silent drop, and not miscategorized as an ordinary "module not found").
    expect(warnings).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/https:\/\/evil\.example\.com\/payload\.js/);
    expect(errors[0]).toMatch(
      /only local file paths and bare module specifiers are allowed/i,
    );
  });
});

describe("resolveLocalPackage", () => {
  it("resolves a scoped specifier to its slug folder + main entry", () => {
    const pkgDir = writePackage(pluginSlug("@openstyle/plugin-x"), {
      name: "@openstyle/plugin-x",
      main: "dist/index.js",
    });
    fs.mkdirSync(path.join(pkgDir, "dist"));
    fs.writeFileSync(
      path.join(pkgDir, "dist", "index.js"),
      "export default 1;",
    );

    expect(resolveLocalPackage(dir, "@openstyle/plugin-x")).toBe(
      path.join(pkgDir, "dist", "index.js"),
    );
  });

  it("defaults main to index.js", () => {
    const pkgDir = writePackage(pluginSlug("plugin-y"), { name: "plugin-y" });
    fs.writeFileSync(path.join(pkgDir, "index.js"), "export default 1;");

    expect(resolveLocalPackage(dir, "plugin-y")).toBe(
      path.join(pkgDir, "index.js"),
    );
  });

  it("returns null when the folder or entry is missing", () => {
    expect(resolveLocalPackage(dir, "@openstyle/absent")).toBeNull();

    // Folder + manifest exist, but the main file doesn't.
    writePackage(pluginSlug("plugin-z"), {
      name: "plugin-z",
      main: "dist/index.js",
    });
    expect(resolveLocalPackage(dir, "plugin-z")).toBeNull();
  });
});
