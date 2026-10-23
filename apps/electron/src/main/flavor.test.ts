import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEV_SERVER_PORT, devModelCacheDir, isDevFlavorApp } from "./flavor";

const dirs: string[] = [];
function appDir(pkg: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "flavor-test-"));
  dirs.push(dir);
  if (pkg !== null) writeFileSync(join(dir, "package.json"), pkg);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

describe("isDevFlavorApp", () => {
  it("is true for the package.json of a dev:install build", () => {
    expect(
      isDevFlavorApp(
        appDir('{"productName":"Openstyle Dev","openstyleFlavor":"dev"}'),
      ),
    ).toBe(true);
  });

  it("is false for the normal package.json", () => {
    expect(isDevFlavorApp(appDir('{"productName":"Openstyle"}'))).toBe(false);
  });

  it("is false for another flavor value, bad JSON or no file", () => {
    expect(isDevFlavorApp(appDir('{"openstyleFlavor":true}'))).toBe(false);
    expect(isDevFlavorApp(appDir("{"))).toBe(false);
    expect(isDevFlavorApp(appDir(null))).toBe(false);
  });
});

describe("dev flavor constants", () => {
  it("never uses the port or the cache of the installed app", () => {
    expect(DEV_SERVER_PORT).not.toBe(4649);
    expect(devModelCacheDir("/Users/me")).toBe(
      "/Users/me/.cache/openstyle-dev",
    );
  });
});
