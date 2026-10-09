import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import { visualizer } from "rollup-plugin-visualizer";
import type { Plugin } from "vite";

const workspaceAliases = {
  "@openstyle/sdk": resolve("../../packages/sdk/src/index.ts"),
  "@openstyle/server": resolve("../server/src/index.ts"),
  "@openstyle/utils": resolve("../../packages/utils/src/index.ts"),
  "@openstyle/validations": resolve("../../packages/validations/src/index.ts"),
};

// Bundle analysis is opt-in via `ANALYZE=1` (see the `analyze` npm script).
// Each build target writes its own treemap so reports don't clobber each other.
const analyze = process.env.ANALYZE === "1";
const mkVisualizer = (name: string) =>
  visualizer({
    filename: resolve(`stats/${name}.html`),
    template: "treemap",
    gzipSize: true,
    brotliSize: true,
    emitFile: false,
  });

// Root-absolute asset URLs for the renderer (DEFECT B).
//
// electron-vite defaults the renderer `base` to `./`, so the built index.html
// emitted `./assets/…`. A hard reload of a nested route (`app://renderer/
// settings/models`) makes the browser resolve those against the CURRENT PATH —
// `app://renderer/settings/assets/index-*.js`. That URL carries an extension,
// so `registerAppProtocol()`'s extension-less SPA fallback (src/main/app-protocol.ts)
// does not catch it, no such file exists, and `net.fetch` fails
// `net::ERR_UNEXPECTED`. React never mounts: a blank window. Depth-1 routes
// (`/today`, `/remix`, `/meetings`) survived only because the fallback served
// index.html from the ROOT, where `./assets/` happens to resolve.
//
// Why this layer and not `registerAppProtocol`: rescuing a nested `*.js`/
// `*.css` miss there means a filesystem stat on every request in the hot path,
// and the only fallback it could return is index.html — which Chromium then
// rejects for a module script as a MIME mismatch, i.e. the same blank window by
// a different route. Emitting correct HTML fixes the cause, costs nothing at
// runtime, and leaves the packaging-critical protocol handler untouched.
//
// The plugin is load-bearing, not decoration: electron-vite 5.0.0 CLOBBERS
// `config.base = './'` for the renderer in production (dist/chunks/
// lib-q6ns0vZr.js:512-513) and its builtin plugins are concat'd AHEAD of user
// plugins (same file, :1601), so `base: "/"` alone is silently discarded —
// verified by rebuilding and reading `./assets/` straight back out of
// out/renderer/index.html. An `enforce: "post"` `config` hook runs after that
// preset and restores root-absolute URLs; the upstream validator explicitly
// permits `/` (same file, :555), so this does not even warn.
//
// Safe because nothing loads these files over `file://`: every window goes
// through `app://` (getDashboardURL / getPillURL / getRemixBarURL /
// getMeetingCaptureURL) and dev uses ELECTRON_RENDERER_URL.
const rendererRootBaseUrl: Plugin = {
  name: "openstyle:renderer-root-base",
  enforce: "post",
  config: () => ({ base: "/" }),
};

export default defineConfig({
  main: {
    resolve: {
      alias: workspaceAliases,
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify(
        process.env.NODE_ENV || "production",
      ),
    },
    build: {
      externalizeDeps: false,
      sourcemap: analyze,
      rollupOptions: {
        external: ["electron", "bufferutil", "utf-8-validate"],
        plugins: analyze ? [mkVisualizer("main")] : [],
      },
    },
  },
  preload: {
    build: {
      // Bundle everything except `electron` itself: the app ships without
      // node_modules (electron-builder.yml `!node_modules/**`), so a runtime
      // `require("@electron-toolkit/preload")` would resolve to nothing and
      // leave every window without `window.api` — the app-dead failure mode
      // specs/lean-audit-2026-09.md §3 T0-2 calls the landmine.
      externalizeDeps: false,
      sourcemap: analyze,
      rollupOptions: {
        input: {
          index: resolve("src/preload/index.ts"),
        },
        plugins: analyze ? [mkVisualizer("preload")] : [],
      },
    },
  },
  renderer: {
    // See `rendererRootBaseUrl` above for why this is root-absolute and why a
    // second plugin is needed to actually get it through electron-vite.
    base: "/",
    define: {
      "process.platform": JSON.stringify(process.platform),
    },
    resolve: {
      alias: {
        ...workspaceAliases,
        "@renderer": resolve("src/renderer/src"),
        "@shared": resolve("src/shared"),
      },
    },
    plugins: [react(), tailwindcss(), rendererRootBaseUrl],
    build: {
      sourcemap: analyze,
      rollupOptions: {
        input: {
          index: resolve("src/renderer/index.html"),
          pill: resolve("src/renderer/pill.html"),
          bar: resolve("src/renderer/bar.html"),
          "meeting-capture": resolve("src/renderer/meeting-capture.html"),
        },
        plugins: analyze ? [mkVisualizer("renderer")] : [],
      },
    },
  },
});
