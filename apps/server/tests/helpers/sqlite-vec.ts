import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The sqlite-vec 0.1.9 build for the ON-mode search tests
 * (specs/local-semantic-search.md 12.2): the server devDependency
 * sqlite-vec-linux-x64 on Linux CI, the electron devDependency
 * sqlite-vec-darwin-arm64 on a Mac. null on other platforms: the test skips.
 * Tests only. The app never loads these paths.
 */
export function sqliteVecTestPath(): string | null {
  const root = join(__dirname, "..", "..", "..");
  const candidates: Record<string, string> = {
    "linux-x64": join(
      root,
      "server",
      "node_modules",
      "sqlite-vec-linux-x64",
      "vec0.so",
    ),
    "darwin-arm64": join(
      root,
      "electron",
      "node_modules",
      "sqlite-vec-darwin-arm64",
      "vec0.dylib",
    ),
  };
  const path = candidates[`${process.platform}-${process.arch}`];
  return path && existsSync(path) ? path : null;
}
