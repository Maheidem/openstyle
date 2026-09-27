// Guard for the blank-deep-route fix (DEFECT B, electron.vite.config.ts):
// every emitted renderer HTML must reference its assets with ROOT-ABSOLUTE
// URLs (`/assets/…`), never relative (`./assets/…`). electron-vite 5.0.0's
// `vite:electron-renderer-config-preset` clobbers renderer `base` to './' in
// production (dist/chunks/lib-q6ns0vZr.js:512-513) and concat's its builtin
// plugins AHEAD of user plugins (:1604), so the `base: "/"` in
// electron.vite.config.ts is silently discarded — the enforce:"post"
// `rendererRootBaseUrl` plugin is the only thing restoring it. A future
// electron-vite upgrade that defeats that hook goes back to emitting
// './assets/…' with no warning, no error and no failing test; the window just
// renders blank on a hard reload of a deep route.
//
// Run after `electron-vite build` (CI runs it in the test-electron job right
// after the bundled-require guard; locally: node scripts/check-renderer-asset-urls.mjs).
// Pass --quiet to only print violations.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const outDir = "out/renderer";

// Only tags that load a URL matter: <script src>, <link href>, <img src>,
// <source src>. CSP <meta> and inline text are deliberately not matched — they
// carry no URL to resolve.
const tagPattern = /<(?:script|link|img|source)\b[^>]*>/gi;
const attrPattern = /\b(?:src|href)\s*=\s*["']([^"']*)["']/i;

// Anything with an explicit scheme (`http:`, `data:`, `blob:`, `app:`) is not
// resolved against the current path — safe, same for a bare fragment.
const schemePattern = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

const isSafeUrl = (url) =>
  (url.startsWith("/") && !url.startsWith("//")) ||
  url.startsWith("#") ||
  schemePattern.test(url);

const quiet = process.argv.includes("--quiet");

let files;
try {
  files = readdirSync(outDir).filter((f) => f.endsWith(".html"));
} catch {
  console.error(
    `error: ${outDir} not found — run \`pnpm run build\` (electron-vite build) first`,
  );
  process.exit(2);
}

// A build that emits no HTML would make this check silently vacuous — the one
// failure mode worse than the bug it guards. Treat it as an error.
if (files.length === 0) {
  console.error(
    `error: no .html entry found in ${outDir} — run \`pnpm run build\` first`,
  );
  process.exit(2);
}

let checked = 0;
const violations = [];

for (const file of files) {
  const html = readFileSync(join(outDir, file), "utf8");
  for (const tag of html.matchAll(tagPattern)) {
    const attr = tag[0].match(attrPattern);
    if (!attr) continue;
    checked++;
    const url = attr[1];
    if (isSafeUrl(url)) continue;
    violations.push(
      `${outDir}/${file}: ${tag[0]}\n    -> "${url}" resolves against the current path, not the app root`,
    );
  }
}

if (violations.length > 0) {
  console.error(
    `error: ${violations.length} relative asset reference(s) in ${outDir}/*.html — the renderer must emit root-absolute URLs:`,
  );
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    "WHY: electron-vite rewrites renderer base to './' in production\n" +
      "(vite:electron-renderer-config-preset, dist/chunks/lib-q6ns0vZr.js:512-513)\n" +
      "and concat's its builtin plugins ahead of user plugins (:1604). The\n" +
      "enforce:'post' rendererRootBaseUrl plugin in electron.vite.config.ts must\n" +
      "survive upgrades — it is what restores base:'/'. With './assets/…' a hard\n" +
      "reload of a deep route (app://renderer/settings/models) asks the app://\n" +
      "handler for /settings/assets/index-*.js, the extension-less SPA fallback\n" +
      "does not match, and the window renders blank with no error logged: the\n" +
      "blank-deep-route regression. Fix by re-asserting base:'/' through that\n" +
      "plugin; only drop the plugin if this check passes without it.",
  );
  process.exit(1);
}

if (!quiet) {
  console.log(
    `ok: ${checked} asset reference(s) across ${files.length} renderer html entr${files.length === 1 ? "y" : "ies"} (${files.join(", ")}) — all root-absolute`,
  );
}
