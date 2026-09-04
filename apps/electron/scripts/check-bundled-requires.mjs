// Guard for the packaging lean-out (specs/lean-audit-2026-09.md §3 T0-2):
// the app ships without node_modules (electron-builder.yml `!node_modules/**`),
// which is only safe while every require() in the built main/preload bundles
// resolves to Electron, a Node builtin, a sibling chunk, or one of the two
// optional ws addons. A future dependency that escapes bundling would resolve
// to nothing in the packaged app — this fails the build instead of shipping a
// dead window.api.
//
// Run after `electron-vite build` (CI runs it in the test-electron job right
// after the build step; locally: node scripts/check-bundled-requires.mjs).
// Pass --quiet to only print violations.

import { readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join } from "node:path";

// Specifiers the bundled output may require that are neither relative chunks
// nor Node builtins (both bare and `node:`-prefixed forms pass isBuiltin).
// `bufferutil`/`utf-8-validate` are ws' optional perf addons, required in
// try/catch by the bundled ws copy in out/main.
const ALLOWED_EXTERNALS = new Set(["electron", "bufferutil", "utf-8-validate"]);

const quiet = process.argv.includes("--quiet");
const outDirs = ["out/main", "out/preload"];

const requirePattern = /require\(\s*(["'])([^"'\n]+)\1\s*\)/g;

let checked = 0;
const violations = [];

for (const dir of outDirs) {
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".js"));
  } catch {
    console.error(
      `error: ${dir} not found — run \`pnpm run build\` (electron-vite build) first`,
    );
    process.exit(2);
  }

  for (const file of files) {
    const source = readFileSync(join(dir, file), "utf8");
    for (const match of source.matchAll(requirePattern)) {
      const specifier = match[2];
      checked++;
      const ok =
        ALLOWED_EXTERNALS.has(specifier) ||
        specifier.startsWith("./") ||
        specifier.startsWith("../") ||
        isBuiltin(specifier);
      if (!ok) violations.push(`${dir}/${file}: require("${specifier}")`);
    }
  }
}

if (violations.length > 0) {
  console.error(
    `error: built bundles require ${violations.length} non-allowlisted module(s):`,
  );
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    "These would resolve to nothing in the packaged app (no node_modules in the asar).\n" +
      "Bundle the dependency (externalizeDeps: false covers it) or, if it must stay\n" +
      "external, add it to ALLOWED_EXTERNALS and to electron-builder.yml.",
  );
  process.exit(1);
}

if (!quiet) {
  console.log(
    `ok: ${checked} require() call(s) in out/{main,preload} — all Electron, Node builtins, relative chunks, or allowlisted externals`,
  );
}
