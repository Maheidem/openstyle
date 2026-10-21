#!/usr/bin/env node

/**
 * Copy the sqlite-vec loadable extension into resources/bin
 * (specs/local-semantic-search.md 11.2). electron-builder ships
 * resources/bin/<platform>-<arch> as <resources>/bin (extraResources), outside
 * app.asar, where the server finds it (apps/server/src/lib/search/extension.ts).
 *
 * The source is the devDependency sqlite-vec-darwin-arm64 at an exact version.
 * The sha256 must match the pin, or the script fails. Search is macOS Apple
 * silicon only, so the script does nothing on other platforms.
 *
 * Usage (from apps/electron): node scripts/copy-sqlite-vec.mjs
 */

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SQLITE_VEC_VERSION = "0.1.9";
const SQLITE_VEC_SHA256 =
  "193e480c50b59a55977d166f4aaf0e1bc8832d6963516e5950f39e4d2ce0b793";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

if (process.platform !== "darwin" || process.arch !== "arm64") {
  console.log(
    `[sqlite-vec] ${process.platform}-${process.arch}: search is Apple silicon only, nothing to copy.`,
  );
  process.exit(0);
}

// The package "exports" hide package.json, so read the folder directly.
const pkgDir = join(ROOT, "node_modules", "sqlite-vec-darwin-arm64");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
if (pkg.version !== SQLITE_VEC_VERSION) {
  console.error(
    `[sqlite-vec] sqlite-vec-darwin-arm64 is ${pkg.version}, expected ${SQLITE_VEC_VERSION}.`,
  );
  process.exit(1);
}

const src = join(pkgDir, "vec0.dylib");
const sha = createHash("sha256").update(readFileSync(src)).digest("hex");
if (sha !== SQLITE_VEC_SHA256) {
  console.error(
    `[sqlite-vec] sha256 mismatch for ${src}: ${sha}, expected ${SQLITE_VEC_SHA256}.`,
  );
  process.exit(1);
}

const outDir = join(ROOT, "resources", "bin", "darwin-arm64");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, "vec0.dylib");
copyFileSync(src, out);
console.log(`[sqlite-vec] ${SQLITE_VEC_VERSION} (sha256 ok) -> ${out}`);
